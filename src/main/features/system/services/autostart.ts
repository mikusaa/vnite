import { app, dialog } from 'electron'
import log from 'electron-log/main'
import * as native from 'vnite-native'
import type {
  AutoStartOptions,
  AutoStartResult,
  AutoStartStatus,
  AutoStartTaskState,
  StartupReply,
  StartupRequest,
  StartupSettings
} from '@appTypes/autostart'
import { REQUEST_ID, StartupStore, validateOptions, validateStartupUrl } from './startupState'

const LOGIN_ARGS = ['--hidden']
const LAUNCH_TIMEOUT = 60_000
const CONFIG_TIMEOUT = 300_000

let contextPromise: Promise<StartupContext> | undefined
let operation: Promise<unknown> = Promise.resolve()
let restartTimer: ReturnType<typeof setTimeout> | undefined
let applicationReady = false
let monitoringError: string | undefined
let routedLaunchHidden = false
const incomingRequests = new Set<string>()
const completedRequests = new Set<string>()
let runtime:
  | {
      isBusy: () => boolean
      restart: () => Promise<void>
      deliver: (request: StartupRequest) => Promise<void>
    }
  | undefined

interface StartupContext {
  identity: native.StartupIdentity
  store: StartupStore
}

export function startupError(error: unknown): { error: string; code?: number; cancelled: boolean } {
  const message = error instanceof Error ? error.message : String(error)
  try {
    const encoded = JSON.parse(message) as { message: string; code: number }
    if (typeof encoded.message === 'string' && typeof encoded.code === 'number') {
      return {
        error: encoded.message,
        code: encoded.code,
        cancelled: (encoded.code & 0xffff) === 1223
      }
    }
  } catch {
    // JS and filesystem errors are already readable.
  }
  return { error: message, cancelled: false }
}

async function context(): Promise<StartupContext> {
  contextPromise ??= native.getStartupIdentity().then((identity) => ({
    identity,
    store: new StartupStore(identity.stateDirectory, identity.sid, identity.exePath)
  }))
  return contextPromise
}

function defaults(identity: native.StartupIdentity): StartupSettings {
  return {
    version: 1,
    sid: identity.sid,
    exePath: identity.exePath,
    openAtLogin: false,
    runAsAdmin: false,
    restartPending: false
  }
}

async function previousSettings(): Promise<StartupSettings> {
  const { identity, store } = await context()
  try {
    return (await store.readSettings()) ?? defaults(identity)
  } catch (error) {
    // Explicit settings changes can repair corrupt metadata. Startup routing
    // still reads strictly and requires an explicit recovery launch.
    return { ...defaults(identity), lastError: startupError(error).error }
  }
}

function loginItemEnabled(): boolean {
  return app.getLoginItemSettings({ path: app.getPath('exe'), args: LOGIN_ARGS }).openAtLogin
}

function setLoginItem(enabled: boolean): void {
  app.setLoginItemSettings({
    openAtLogin: enabled,
    path: app.getPath('exe'),
    args: LOGIN_ARGS,
    ...(process.platform === 'win32' ? { name: 'vnite' } : {})
  })
  if (loginItemEnabled() !== enabled) throw new Error('Windows login item verification failed')
}

export async function getAutoStartStatus(): Promise<AutoStartStatus> {
  if (process.platform !== 'win32') {
    return {
      openAtLogin: app.getLoginItemSettings().openAtLogin,
      runAsAdmin: false,
      processElevated: false,
      restartPending: false,
      launchTask: 'absent',
      logonTask: 'absent',
      loginItem: app.getLoginItemSettings().openAtLogin,
      runAsAdminFlag: false
    }
  }
  const { identity } = await context()
  const settings = await previousSettings()
  let launchTask: AutoStartTaskState = 'unknown'
  let logonTask: AutoStartTaskState = 'unknown'
  let runAsAdminFlag = false
  let lastError = settings.lastError ?? monitoringError
  try {
    const probe = await native.probeStartupTasks(settings.openAtLogin)
    launchTask = probe.launch as AutoStartTaskState
    logonTask = probe.logon as AutoStartTaskState
    runAsAdminFlag = probe.runAsAdminFlag
  } catch (error) {
    lastError = startupError(error).error
  }
  return {
    openAtLogin: settings.openAtLogin,
    runAsAdmin: settings.runAsAdmin,
    processElevated: identity.elevated,
    restartPending: settings.restartPending && !identity.elevated,
    launchTask,
    logonTask,
    loginItem: loginItemEnabled(),
    runAsAdminFlag,
    lastError
  }
}

async function applyConfiguration(
  options: AutoStartOptions,
  restartPending: boolean
): Promise<void> {
  const { identity, store } = await context()
  await native.prepareStartupStorage()
  const old = await previousSettings()
  const wasLoginItemEnabled = loginItemEnabled()
  let snapshot: native.StartupTaskSnapshot | undefined
  try {
    if (identity.elevated) {
      snapshot = await native.configureStartupTasks(options.openAtLogin, options.runAsAdmin)
    } else if (options.runAsAdmin) {
      throw new Error('Administrator startup configuration requires authorization')
    } else {
      const probe = await native.probeStartupTasks(options.openAtLogin)
      if (probe.launch !== 'absent' || probe.logon !== 'absent') {
        throw new Error(
          'Existing administrator tasks must be removed before enabling normal startup'
        )
      }
      if (options.openAtLogin && probe.runAsAdminFlag) {
        throw new Error(
          'The executable compatibility settings still require administrator privileges'
        )
      }
    }
    setLoginItem(options.openAtLogin && !options.runAsAdmin)
    await store.saveSettings({
      ...defaults(identity),
      ...options,
      restartPending: options.runAsAdmin && restartPending
    })
  } catch (error) {
    const failures: string[] = []
    if (snapshot) {
      try {
        await native.restoreStartupTasks(snapshot)
      } catch (rollback) {
        failures.push(startupError(rollback).error)
      }
    }
    try {
      setLoginItem(wasLoginItemEnabled)
    } catch (rollback) {
      failures.push(startupError(rollback).error)
    }
    try {
      await store.saveSettings(old)
    } catch (rollback) {
      failures.push(startupError(rollback).error)
    }
    if (failures.length) {
      throw new Error(`${startupError(error).error}; rollback failed: ${failures.join('; ')}`)
    }
    throw error
  }
}

async function waitForReply(request: StartupRequest): Promise<StartupReply> {
  const { store } = await context()
  while (Date.now() < request.expiresAt) {
    const reply = await store.readReply(request.id)
    if (reply) return reply
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Administrator startup timed out before the application confirmed readiness')
}

async function requestConfiguration(options: AutoStartOptions): Promise<void> {
  const { identity, store } = await context()
  if (identity.elevated) {
    await applyConfiguration(options, false)
    return
  }
  const probe = await native.probeStartupTasks(options.openAtLogin)
  if (!options.runAsAdmin && probe.launch === 'absent' && probe.logon === 'absent') {
    await applyConfiguration(options, false)
    return
  }
  const request = await store.createRequest({ action: 'configure', options }, CONFIG_TIMEOUT)
  try {
    if (probe.launch === 'ok') {
      await native.runStartupTask(request.id)
    } else {
      const result = await native.launchStartupHelper(request.id)
      if (result.exitCode !== 0 && !(await store.readReply(request.id))) {
        throw new Error('Administrator setup failed. Authorize using the same Windows account.')
      }
    }
    const reply = await waitForReply(request)
    if (!reply.ok) {
      throw new Error(JSON.stringify({ message: reply.error, code: reply.code ?? 0 }))
    }
  } finally {
    await store.removeRequest(request.id)
  }
}

export async function setAutoStart(raw: AutoStartOptions): Promise<AutoStartResult> {
  const execute = async (): Promise<AutoStartResult> => {
    try {
      const options = validateOptions(raw)
      if (process.platform !== 'win32') {
        if (options.runAsAdmin)
          throw new Error('Administrator startup is only available on Windows')
        app.setLoginItemSettings({ openAtLogin: options.openAtLogin })
      } else {
        if (!app.isPackaged)
          throw new Error('Administrator startup must be configured in a packaged application')
        await requestConfiguration(options)
      }
      const status = await getAutoStartStatus()
      schedulePendingRestart()
      return { ok: true, status }
    } catch (error) {
      const failure = startupError(error)
      log.error('[AutoStart] Configuration failed:', failure.error)
      await rememberError(failure.error)
      return { ok: false, ...failure, status: await getAutoStartStatus() }
    }
  }
  const result = operation.then(execute, execute)
  operation = result.catch(() => undefined)
  return result
}

async function rememberError(error: string): Promise<void> {
  if (process.platform !== 'win32') return
  try {
    const { identity, store } = await context()
    const settings = (await store.readSettings()) ?? defaults(identity)
    await store.saveSettings({ ...settings, lastError: error })
  } catch (writeError) {
    log.error('[AutoStart] Failed to persist startup error:', writeError)
  }
}

function flag(argv: string[], name: string): string | undefined {
  const value = argv.find((arg) => arg.startsWith(`${name}=`))
  if (!value) return undefined
  const id = value.slice(name.length + 1)
  if (!REQUEST_ID.test(id)) throw new Error('Invalid startup request ID')
  return id
}

/**
 * Returns true for short-lived helper/router processes. This is deliberately
 * called before any database is opened or the application lock is acquired.
 */
export async function bootstrapStartup(argv: string[]): Promise<boolean> {
  if (process.platform !== 'win32' || !app.isPackaged) return false
  try {
    const { identity, store } = await context()
    if (argv.includes('--vnite-startup-uninstall')) {
      await native.removeInstallationStartupTasks()
      setLoginItem(false)
      return true
    }
    const configuration = flag(argv, '--vnite-startup-config')
    const incoming = flag(argv, '--vnite-admin-request')
    if (configuration || incoming) {
      if (!identity.elevated)
        throw new Error('The startup task did not launch an administrator process')
      const id = (configuration ?? incoming)!
      try {
        const request = await store.readRequest(id)
        if (request.action === 'configure') {
          await applyConfiguration(request.options!, true)
          await store.reply(id, { ok: true })
          return true
        }
        if (configuration) throw new Error('A configuration helper cannot handle a launch request')
        routedLaunchHidden = !request.showWindow
        incomingRequests.add(id)
        return false
      } catch (error) {
        const failure = startupError(error)
        await store.reply(id, { ok: false, error: failure.error, code: failure.code })
        throw error
      }
    }
    const settings = await store.readSettings()
    if (argv.includes('--vnite-startup-recovery')) return false
    if (argv.includes('--vnite-admin-logon')) {
      if (!settings?.runAsAdmin || !settings.openAtLogin) return true
      if (!identity.elevated)
        throw new Error('The login task did not launch an administrator process')
    }
    if (settings?.runAsAdmin && !identity.elevated) {
      const request = await store.createRequest(
        {
          action: 'launch',
          showWindow: !argv.includes('--hidden'),
          urls: argv.filter(validateStartupUrl)
        },
        LAUNCH_TIMEOUT
      )
      try {
        await native.runStartupTask(request.id)
        const result = await waitForReply(request)
        if (!result.ok) throw new Error(result.error ?? 'Administrator startup failed')
        if (result.monitorError) {
          dialog.showErrorBox('Vnite', result.monitorError)
        }
      } finally {
        // Expired requests cannot be replayed by a late task process.
        await store.removeRequest(request.id)
      }
      return true
    }
    return false
  } catch (error) {
    const failure = startupError(error)
    process.exitCode = 1
    log.error('[AutoStart] Startup routing failed:', failure.error)
    await rememberError(failure.error)
    if (
      !argv.some((arg) => arg.startsWith('--vnite-startup-config=')) &&
      !argv.includes('--vnite-startup-uninstall')
    ) {
      dialog.showErrorBox(
        'Vnite startup',
        `${failure.error}\n\nOpen Vnite with --vnite-startup-recovery to repair the startup settings.`
      )
    }
    // A recovery launch is explicit and does not silently downgrade normal launches.
    if (argv.includes('--vnite-startup-recovery')) return false
    return true
  }
}

export async function acceptStartupArguments(argv: string[]): Promise<void> {
  const id = flag(argv, '--vnite-admin-request')
  if (id && !completedRequests.has(id)) incomingRequests.add(id)
  await drainStartupRequests()
}

async function drainStartupRequests(): Promise<void> {
  if (!applicationReady || !runtime) return
  const { store } = await context()
  for (const id of incomingRequests) {
    incomingRequests.delete(id)
    if (completedRequests.has(id)) continue
    // Claim before awaiting delivery so concurrent second-instance events
    // cannot dispatch the same game/auth callback twice.
    completedRequests.add(id)
    try {
      const request = await store.readRequest(id)
      if (request.action !== 'launch') throw new Error('Unexpected startup request type')
      await runtime.deliver(request)
      await store.reply(id, { ok: true, monitorError: monitoringError })
    } catch (error) {
      const failure = startupError(error)
      await store.reply(id, { ok: false, error: failure.error, code: failure.code })
    }
  }
}

export function setStartupRuntime(callbacks: NonNullable<typeof runtime>): void {
  runtime = callbacks
}

export async function markStartupReady(error?: string): Promise<void> {
  applicationReady = true
  monitoringError = error
  if (process.platform === 'win32') {
    const { identity, store } = await context()
    const settings = await store.readSettings()
    if (settings && identity.elevated && settings.restartPending) {
      await store.saveSettings({ ...settings, restartPending: false })
    }
    await drainStartupRequests()
    schedulePendingRestart()
  }
}

function schedulePendingRestart(): void {
  if (!runtime || !applicationReady || process.platform !== 'win32' || restartTimer) return
  restartTimer = setTimeout(async () => {
    restartTimer = undefined
    try {
      const { identity, store } = await context()
      const settings = await store.readSettings()
      if (!settings?.runAsAdmin || !settings.restartPending || identity.elevated) return
      if (runtime!.isBusy()) {
        schedulePendingRestart()
        return
      }
      await runtime!.restart()
    } catch (error) {
      await rememberError(startupError(error).error)
    }
  }, 1_000)
  restartTimer.unref()
}

export async function setupAutoStart(): Promise<void> {
  if (process.platform !== 'win32' || !app.isPackaged) return
  const { identity, store } = await context()
  if (await store.readSettings()) return
  // The legacy synced values are read once, after the normal DB initialization.
  const { ConfigDBManager } = await import('~/core/database')
  const openAtLogin = await ConfigDBManager.getConfigValue('general.openAtLogin')
  const elevated = await ConfigDBManager.getConfigValue('general.openAtLoginElevated')
  if (elevated && identity.elevated) {
    await applyConfiguration({ openAtLogin, runAsAdmin: true }, false)
  } else {
    await store.saveSettings({
      ...defaults(identity),
      openAtLogin,
      // A legacy preference is not proof that the new tasks were authorized.
      lastError: elevated
        ? 'Administrator startup needs to be configured for this installation.'
        : undefined
    })
  }
}

export function isProcessElevated(): boolean {
  return process.platform === 'win32' && native.isElevatedPrivilege()
}

export function shouldHideStartupWindow(): boolean {
  return process.argv.includes('--hidden') || routedLaunchHidden
}
