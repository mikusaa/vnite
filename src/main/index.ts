import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from 'electron'
import log from 'electron-log/main'
import windowStateKeeper from 'electron-window-state'
import { join } from 'path'
import { baseDBManager, runDatabaseMigrations } from '~/core/database'
import { isDatabaseOperationRunning, startSync } from '~/features/database'
import { hasPendingGameSaveOperations } from '~/features/game'
import { hasActiveGameMonitors } from '~/features/monitor'
import {
  getAppRootPath,
  getDataPath,
  getLogsPath,
  setupScreenshotService,
  setupTempDirectory
} from '~/features/system'
import icon from '../../resources/icon.png?asset'
import { ipcManager, setupIPC } from './core/ipc'
import { nativeCleanup, setupNativeModule } from './core/native'
import { AuthManager, handleAuthCallback } from './features/account'
import { GameScannerManager } from './features/adder'
import { setupScraper } from './features/scraper'
import { primeGoogleImageSearchSession } from './features/scraper/providers/google/common'
import {
  checkPortableMode,
  initI18n,
  acceptStartupArguments,
  bootstrapStartup,
  markStartupReady,
  portableStore,
  setStartupRuntime,
  shouldHideStartupWindow,
  setupAutoStart,
  setupContextMenu,
  setupProtocols,
  setupProxy,
  setupTray,
  TrayManager
} from './features/system'
import { setupAutoUpdater } from './features/updater'
import { pluginService } from './plugins'
import {
  checkAdminPermissions,
  checkIfDirectoryNeedsAdminRights,
  cleanupPowerShell,
  parseGameIdFromUrl
} from './utils'

export let mainWindow: BrowserWindow

export let trayManager: TrayManager

// Track whether game data has been loaded
let gamesLoaded = false
let cleanupPromise: Promise<void> | undefined
let cleanupFinished = false
let windowReady: Promise<void>
let syncInitializing = false

async function cleanupApplication(): Promise<void> {
  cleanupPromise ??= (async () => {
    GameScannerManager.stopScan()
    GameScannerManager.stopPeriodicScan()
    cleanupPowerShell()
    await nativeCleanup()
    await pluginService.shutdown()
    await baseDBManager.closeAllDatabases()
    trayManager?.destroy()
    cleanupFinished = true
  })()
  return cleanupPromise
}

export async function restartApplication(): Promise<void> {
  await cleanupApplication()
  // Initial protocol URLs have already been consumed and must not be replayed.
  app.relaunch({ args: [] })
  app.quit()
}

// Export function to check if games are loaded
export function isGamesLoaded(): boolean {
  return gamesLoaded
}

log.initialize()

global.fetch = net.fetch as typeof global.fetch

const pendingGameLaunchIds: string[] = []

function drainPendingGameLaunches(): void {
  if (
    !gamesLoaded ||
    !mainWindow ||
    mainWindow.isDestroyed() ||
    pendingGameLaunchIds.length === 0
  ) {
    return
  }

  const gameIds = pendingGameLaunchIds.splice(0)
  gameIds.forEach((gameId) => {
    ipcManager.sendTo(mainWindow.webContents, 'game:start-from-url', gameId)
  })
}

function findGameId(commandLine: string[]): string | null {
  for (const arg of commandLine) {
    const gameId = parseGameIdFromUrl(arg)
    if (gameId) {
      return gameId
    }
  }

  return null
}

function enqueueGameLaunch(gameId: string): void {
  if (!pendingGameLaunchIds.includes(gameId)) {
    log.info('[Protocol] Queuing game launch with ID:', gameId)
    pendingGameLaunchIds.push(gameId)
  }

  drainPendingGameLaunches()
}

const initialGameId = findGameId(process.argv)
if (initialGameId) {
  enqueueGameLaunch(initialGameId)
}

function createWindow(): void {
  const mainWindowState = windowStateKeeper({
    defaultWidth: 1400,
    defaultHeight: 900,
    maximize: false,
    fullScreen: false
  })

  // Create the browser window.
  mainWindow = new BrowserWindow({
    x: mainWindowState.x,
    y: mainWindowState.y,
    width: mainWindowState.width,
    height: mainWindowState.height,
    minWidth: 770,
    minHeight: 420,
    show: false,
    frame: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' || is.dev ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      webSecurity: false
    }
  })

  mainWindowState.manage(mainWindow)

  mainWindow.on('maximize', () => {
    ipcManager.send('window:maximized')
  })

  mainWindow.on('unmaximize', () => {
    ipcManager.send('window:unmaximized')
  })

  mainWindow.once('ready-to-show', () => {
    const isHidden = shouldHideStartupWindow()
    if (!isHidden) {
      mainWindow.show()
    }
  })
  windowReady = new Promise((resolve) => mainWindow.once('ready-to-show', resolve))

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'attachment',
    privileges: {
      standard: true,
      supportFetchAPI: true,
      corsEnabled: true,
      bypassCSP: true
    }
  }
])

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app
  .whenReady()
  .then(async () => {
    electronApp.setAppUserModelId('vnite')
    if (await bootstrapStartup(process.argv)) {
      app.exit(Number(process.exitCode ?? 0))
      return
    }

    // Set app user model id for windows
    electronApp.setAppUserModelId('vnite')

    // Default open or close DevTools by F12 in development
    // and ignore CommandOrControl + R in production.
    // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    // IPC test
    ipcMain.on('ping', () => console.log('pong'))

    // Set the userData directory to a different location in development
    if (!app.isPackaged) {
      app.setPath('userData', join(getAppRootPath(), 'dev'))
    }

    log.transports.file.resolvePathFn = (): string => getLogsPath()

    log.info('[App] App is starting...')
    log.info(`[App] System: ${process.platform} ${process.arch}`)

    await checkPortableMode()

    // Check if the app is running in portable mode
    if (portableStore.isPortableMode) {
      if (await checkAdminPermissions()) {
        log.info('[App] Running in portable mode with admin permissions')
      } else {
        if (await checkIfDirectoryNeedsAdminRights(getDataPath())) {
          dialog.showErrorBox(
            'Vnite',
            'The portable data directory is not writable. Open Vnite as administrator to configure administrator startup, or restore write access to the existing data directory.'
          )
          app.exit(1)
          return
        } else {
          log.info('[App] Running in portable mode without admin permissions')
        }
      }
    } else {
      if (await checkAdminPermissions()) {
        log.info('[App] Running in normal mode with admin permissions')
      } else {
        log.info('[App] Running in normal mode without admin permissions')
      }
    }

    const gotTheLock = app.requestSingleInstanceLock()

    if (!gotTheLock) {
      // If it's not the first instance, just exit
      app.quit()
      return
    }

    // Handling the startup of the second instance
    app.on('second-instance', (_event, commandLine) => {
      if (commandLine.some((argument) => argument.startsWith('--vnite-admin-request='))) {
        void acceptStartupArguments(commandLine).catch((error) => {
          log.error('[AutoStart] Failed to accept launch request:', error)
        })
        return
      }
      // If the main window exists, activate it
      if (mainWindow && !commandLine.includes('--hidden')) {
        if (mainWindow.isMinimized()) {
          mainWindow.restore()
        }
        mainWindow.focus()

        if (!mainWindow.isVisible()) {
          mainWindow.show()
        }

        // Temporary placement to draw attention to
        mainWindow.setAlwaysOnTop(true)
        setTimeout(() => {
          mainWindow.setAlwaysOnTop(false)
        }, 300)
      }

      // Check for protocol URLs
      const gameId = findGameId(commandLine)
      if (gameId) {
        // Processing Protocol URL
        enqueueGameLaunch(gameId)
      }
      // Check for auth callback URLs specifically
      const authUrl = commandLine.find((arg) => arg.startsWith('vnite://auth/callback'))
      if (authUrl) {
        // Processing auth callback URL
        handleAuthCallback(authUrl)
      }
    })

    setupProtocols()

    // Setup scraper providers
    setupScraper()

    baseDBManager.initAllDatabases()
    await runDatabaseMigrations(app.getVersion())
    await setupAutoStart()

    // Setup proxy config
    await setupProxy()

    setupIPC()

    setStartupRuntime({
      isBusy: () =>
        hasActiveGameMonitors() ||
        hasPendingGameSaveOperations() ||
        isDatabaseOperationRunning() ||
        syncInitializing ||
        GameScannerManager.getScanProgress().status === 'scanning',
      restart: restartApplication,
      deliver: async (request) => {
        if (request.showWindow && mainWindow && !mainWindow.isDestroyed()) {
          if (mainWindow.isMinimized()) mainWindow.restore()
          mainWindow.show()
          mainWindow.focus()
        }
        for (const url of request.urls ?? []) {
          const gameId = parseGameIdFromUrl(url)
          if (gameId) enqueueGameLaunch(gameId)
          else if (url.startsWith('vnite://auth/callback')) await handleAuthCallback(url)
        }
      }
    })

    ipcManager.on('db:games-loaded', (event) => {
      if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
        return
      }

      const isFirstLoad = !gamesLoaded
      gamesLoaded = true
      drainPendingGameLaunches()

      if (!isFirstLoad) {
        return
      }

      log.info('[App] Games DB loaded, starting scanner...')
      GameScannerManager.startScan().catch((err) => {
        log.error('[Scanner] Startup scan failed:', err)
      })
      GameScannerManager.startPeriodicScan()
    })

    createWindow()

    try {
      AuthManager.init()
    } catch (error) {
      log.error('[Account] Failed to initialize AuthManager:', error)
    }

    try {
      AuthManager.updateUserInfo()
    } catch (_error) {
      ipcManager.send('account:update-user-info-error')
    }

    await initI18n()

    // Setup context menu
    await setupContextMenu()

    // Setup tray
    trayManager = await setupTray(mainWindow)

    // Setup temporary directory
    await setupTempDirectory()

    // Sync all databases with remote
    syncInitializing = true
    void startSync().finally(() => {
      syncInitializing = false
    })

    // Setup auto updater
    setupAutoUpdater()

    // Note: Scanner will be started after games are loaded (see db:games-loaded handler above)

    await pluginService.initialize()

    // Setup screenshot service
    await setupScreenshotService()

    // Setup native module
    let monitorError: string | undefined
    try {
      await setupNativeModule()
    } catch (error) {
      monitorError = `Game monitoring could not be initialized: ${error instanceof Error ? error.message : String(error)}`
      log.error('[Native]', monitorError)
    }

    app.on('activate', function () {
      // On macOS it's common to re-create a window in the app when the
      // dock icon is clicked and there are no other windows open.
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })

    void primeGoogleImageSearchSession()
    await windowReady
    await markStartupReady(monitorError)
    if (monitorError && !process.argv.some((arg) => arg.startsWith('--vnite-admin-request='))) {
      dialog.showErrorBox('Vnite monitoring', monitorError)
    }
  })
  .catch((error) => {
    log.error('[App] Startup failed:', error)
    dialog.showErrorBox('Vnite startup', error instanceof Error ? error.message : String(error))
    app.quit()
  })

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // trayManager.destroy()
    app.quit()
  }
})

// Add cleanup logic before application exit
app.on('before-quit', (event) => {
  if (cleanupFinished) return
  event.preventDefault()
  void cleanupApplication()
    .then(() => app.quit())
    .catch((error) => {
      log.error('[App] Could not safely close the application:', error)
      cleanupPromise = undefined
      dialog.showErrorBox('Vnite', error instanceof Error ? error.message : String(error))
    })
})

// Add cleanup on process exit
process.on('exit', () => {
  cleanupPowerShell()
})

// Handle unexpected exits
process.on('SIGINT', () => {
  app.quit()
})

process.on('SIGTERM', () => {
  app.quit()
})

// In this file you can include the rest of your app"s specific main process
// code. You can also put them in separate files and require them here.
