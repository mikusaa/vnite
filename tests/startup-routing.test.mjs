import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import ts from 'typescript'
const require = createRequire(import.meta.url)
const {
  StartupStore,
  REQUEST_ID,
  validateOptions,
  validateStartupUrl
} = require('../src/main/features/system/services/startupState.ts')

async function coordinator(t, elevated = false) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vnite-routing-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const identity = {
    sid: 'S-1-5-21-test',
    exePath: 'C:\\Vnite\\Vnite.exe',
    stateDirectory: directory,
    elevated,
    installationId: 'test',
    sessionId: 1
  }
  const store = new StartupStore(directory, identity.sid, identity.exePath)
  const calls = []
  const timers = []
  const legacyReads = []
  let legacyOpenAtLogin = false
  let loginItem = false
  let tasks = { launch: 'absent', logon: 'absent', runAsAdminFlag: false }
  const native = {
    getStartupIdentity: async () => identity,
    isElevatedPrivilege: () => elevated,
    probeStartupTasks: async () => tasks,
    prepareStartupStorage: async () => {},
    configureStartupTasks: async (login, admin) => {
      calls.push(['configure', login, admin])
      tasks = {
        launch: admin ? 'ok' : 'absent',
        logon: admin ? 'ok' : 'absent',
        runAsAdminFlag: false
      }
      return {}
    },
    restoreStartupTasks: async () => {
      calls.push(['rollback'])
    },
    runStartupTask: async (id) => {
      calls.push(['run', id])
      const request = await store.readRequest(id)
      if (request.action === 'configure') {
        await store.saveSettings({
          version: 1,
          sid: identity.sid,
          exePath: identity.exePath,
          ...request.options,
          restartPending: true
        })
      }
      await store.reply(id, { ok: true })
    },
    launchStartupHelper: async () => {
      calls.push(['uac'])
      throw new Error('Unexpected UAC')
    }
  }
  const electron = {
    app: {
      isPackaged: true,
      getPath: () => identity.exePath,
      getLoginItemSettings: () => ({ openAtLogin: loginItem }),
      setLoginItemSettings: ({ openAtLogin }) => {
        loginItem = openAtLogin
      }
    },
    dialog: { showErrorBox: (...args) => calls.push(['dialog', ...args]) }
  }
  const source = await readFile(
    new URL('../src/main/features/system/services/autostart.ts', import.meta.url),
    'utf8'
  )
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    }
  }).outputText
  const exports = {}
  const sandbox = {
    exports,
    console,
    Error,
    setTimeout(callback, delay) {
      if (delay === 1_000) {
        timers.push(callback)
        return { unref() {} }
      }
      return setTimeout(callback, delay)
    },
    process: { platform: 'win32', argv: [] },
    require(name) {
      if (name === 'electron') return electron
      if (name === 'electron-log/main') return { info() {}, warn() {}, error() {} }
      if (name === 'vnite-native') return native
      if (name === '~/core/database') {
        return {
          ConfigDBManager: {
            getConfigValue: async (key) => {
              assert.equal(key, 'general.openAtLogin')
              legacyReads.push(key)
              return legacyOpenAtLogin
            }
          }
        }
      }
      if (name === './startupState')
        return { StartupStore, REQUEST_ID, validateOptions, validateStartupUrl }
      throw new Error(`Unexpected import: ${name}`)
    }
  }
  vm.runInNewContext(compiled, sandbox)
  return {
    api: exports,
    native,
    store,
    identity,
    calls,
    timers,
    legacyReads,
    setLegacyOpenAtLogin: (value) => {
      legacyOpenAtLogin = value
    },
    setTasks: (value) => {
      tasks = value
    }
  }
}

test('legacy login preference migrates once without granting administrator mode', async (t) => {
  const f = await coordinator(t)
  f.setLegacyOpenAtLogin(true)
  await f.api.setupAutoStart()
  const settings = await f.store.readSettings()
  assert.equal(settings.openAtLogin, true)
  assert.equal(settings.runAsAdmin, false)
  assert.equal(f.calls.length, 0)
  f.setLegacyOpenAtLogin(false)
  await f.api.setupAutoStart()
  assert.equal((await f.store.readSettings()).openAtLogin, true)
  assert.equal(f.legacyReads.length, 1)
})

test('existing local administrator settings are preserved during startup migration', async (t) => {
  const f = await coordinator(t)
  await f.store.saveSettings({
    version: 1,
    sid: f.identity.sid,
    exePath: f.identity.exePath,
    openAtLogin: false,
    runAsAdmin: true,
    restartPending: false
  })
  f.setLegacyOpenAtLogin(true)
  await f.api.setupAutoStart()
  assert.equal((await f.store.readSettings()).openAtLogin, false)
  assert.equal((await f.store.readSettings()).runAsAdmin, true)
  assert.equal(f.legacyReads.length, 0)
  assert.equal(f.calls.length, 0)
})

test('UAC cancellation leaves the existing startup preference intact', async (t) => {
  const f = await coordinator(t)
  await f.store.saveSettings({
    version: 1,
    sid: f.identity.sid,
    exePath: f.identity.exePath,
    openAtLogin: false,
    runAsAdmin: false,
    restartPending: false
  })
  f.native.launchStartupHelper = async () => {
    throw new Error(JSON.stringify({ code: 0x800704c7, message: 'Cancelled' }))
  }
  const result = await f.api.setAutoStart({ openAtLogin: true, runAsAdmin: true })
  assert.equal(result.ok, false)
  assert.equal(result.cancelled, true)
  assert.equal((await f.store.readSettings()).runAsAdmin, false)
})

test('unknown task state cannot be reported as a successful disable', async (t) => {
  const f = await coordinator(t)
  f.native.probeStartupTasks = async () => {
    throw new Error('Task service unavailable')
  }
  const result = await f.api.setAutoStart({ openAtLogin: false, runAsAdmin: false })
  assert.equal(result.ok, false)
  assert.equal(result.status.launchTask, 'unknown')
})

test('later configuration reuses the authorized task and never requests UAC', async (t) => {
  const f = await coordinator(t)
  f.setTasks({ launch: 'ok', logon: 'ok', runAsAdminFlag: false })
  const result = await f.api.setAutoStart({ openAtLogin: false, runAsAdmin: true })
  assert.equal(result.ok, true)
  assert.equal(result.status.runAsAdmin, true)
  assert.equal(result.status.openAtLogin, false)
  assert.deepEqual(
    f.calls.map(([call]) => call),
    ['run']
  )
})

test('ordinary double-click and protocol launches route through the task before app startup', async (t) => {
  const f = await coordinator(t)
  await f.store.saveSettings({
    version: 1,
    sid: f.identity.sid,
    exePath: f.identity.exePath,
    openAtLogin: true,
    runAsAdmin: true,
    restartPending: false
  })
  const routed = await f.api.bootstrapStartup(['Vnite.exe', 'vnite://rungameid/game-1'])
  assert.equal(routed, true)
  assert.equal(f.calls[0][0], 'run')
  assert.equal(
    f.calls.some(([call]) => call === 'uac'),
    false
  )
})

test('a task request waits for readiness and duplicate arguments deliver once', async (t) => {
  const f = await coordinator(t, true)
  const request = await f.store.createRequest(
    { action: 'launch', showWindow: true, urls: ['vnite://rungameid/game-1'] },
    60_000
  )
  const args = ['Vnite.exe', `--vnite-admin-request=${request.id}`]
  assert.equal(await f.api.bootstrapStartup(args), false)
  assert.equal(await f.store.readReply(request.id), null)
  let deliveries = 0
  f.api.setStartupRuntime({
    isBusy: () => true,
    restart: async () => {},
    deliver: async () => {
      deliveries++
    }
  })
  await f.api.markStartupReady('ETW failed')
  await f.api.acceptStartupArguments(args)
  assert.equal(deliveries, 1)
  assert.deepEqual(await f.store.readReply(request.id), { ok: true, monitorError: 'ETW failed' })
})

test('a hidden cold launch keeps its requested window visibility', async (t) => {
  const f = await coordinator(t, true)
  const request = await f.store.createRequest(
    { action: 'launch', showWindow: false, urls: [] },
    60_000
  )
  assert.equal(
    await f.api.bootstrapStartup(['Vnite.exe', `--vnite-admin-request=${request.id}`]),
    false
  )
  assert.equal(f.api.shouldHideStartupWindow(), true)
})

test('task changes are rolled back when the final state cannot be committed', async (t) => {
  const f = await coordinator(t, true)
  f.native.configureStartupTasks = async () => {
    f.calls.push(['configure'])
    return {}
  }
  // Saving state is the final transaction step; simulate a failure there.
  const original = StartupStore.prototype.saveSettings
  StartupStore.prototype.saveSettings = async function () {
    throw new Error('Disk full')
  }
  t.after(() => {
    StartupStore.prototype.saveSettings = original
  })
  const result = await f.api.setAutoStart({ openAtLogin: true, runAsAdmin: true })
  assert.equal(result.ok, false)
  assert.equal(
    f.calls.some(([call]) => call === 'rollback'),
    true
  )
})

test('the first authorization is reused for subsequent changes', async (t) => {
  const f = await coordinator(t)
  let authorizations = 0
  f.native.launchStartupHelper = async (id) => {
    authorizations++
    const request = await f.store.readRequest(id)
    await f.store.saveSettings({
      version: 1,
      sid: f.identity.sid,
      exePath: f.identity.exePath,
      ...request.options,
      restartPending: true
    })
    f.setTasks({ launch: 'ok', logon: 'ok', runAsAdminFlag: false })
    await f.store.reply(id, { ok: true })
    return { exitCode: 0 }
  }
  assert.equal((await f.api.setAutoStart({ openAtLogin: true, runAsAdmin: true })).ok, true)
  assert.equal((await f.api.setAutoStart({ openAtLogin: false, runAsAdmin: true })).ok, true)
  assert.equal(authorizations, 1)
})

test('pending restart waits for active work and proceeds automatically when idle', async (t) => {
  const f = await coordinator(t)
  await f.store.saveSettings({
    version: 1,
    sid: f.identity.sid,
    exePath: f.identity.exePath,
    openAtLogin: true,
    runAsAdmin: true,
    restartPending: true
  })
  let busy = true
  let restarts = 0
  f.api.setStartupRuntime({
    isBusy: () => busy,
    deliver: async () => {},
    restart: async () => {
      restarts++
    }
  })
  await f.api.markStartupReady()
  await f.timers.shift()()
  assert.equal(restarts, 0)
  busy = false
  await f.timers.shift()()
  assert.equal(restarts, 1)
})
