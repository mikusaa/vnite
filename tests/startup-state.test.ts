import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  StartupStore,
  validateOptions,
  validateStartupUrl
} from '../src/main/features/system/services/startupState.ts'

async function fixture(t: { after: (fn: () => Promise<void>) => void }): Promise<StartupStore> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vnite-startup-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return new StartupStore(directory, 'S-1-5-21-test', 'C:\\Games\\Vnite.exe')
}

test('startup settings stay separate from the DB and reject a different identity', async (t) => {
  const store = await fixture(t)
  assert.equal(await store.readSettings(), null)
  await store.saveSettings({
    version: 1,
    sid: store.sid,
    exePath: store.exePath,
    openAtLogin: false,
    runAsAdmin: true,
    restartPending: true
  })
  assert.equal((await store.readSettings())?.runAsAdmin, true)
  assert.equal((await store.readSettings())?.openAtLogin, false)
  const other = new StartupStore(store.directory, 'S-1-5-21-other', store.exePath)
  await assert.rejects(other.readSettings(), /different account/)
})

test('requests support game and auth URLs and reject arbitrary commands and expired requests', async (t) => {
  const store = await fixture(t)
  const urls = ['vnite://rungameid/game-1', 'vnite://auth/callback?code=a&state=b']
  const request = await store.createRequest({ action: 'launch', showWindow: true, urls }, 60_000)
  assert.deepEqual((await store.readRequest(request.id)).urls, urls)
  await assert.rejects(store.readRequest('../state'), /Invalid startup request/)
  const file = path.join(store.directory, 'requests', `${request.id}.json`)
  await writeFile(file, JSON.stringify({ ...request, urls: ['file:///C:/Windows/cmd.exe'] }))
  await assert.rejects(store.readRequest(request.id), /Invalid startup launch/)
  await writeFile(file, JSON.stringify({ ...request, expiresAt: Date.now() - 1 }))
  await assert.rejects(store.readRequest(request.id), /expired/)
})

test('configuration requests accept only explicit independent boolean options', async (t) => {
  const store = await fixture(t)
  assert.deepEqual(validateOptions({ openAtLogin: false, runAsAdmin: true }), {
    openAtLogin: false,
    runAsAdmin: true
  })
  assert.throws(() => validateOptions({ openAtLogin: true, runAsAdmin: 'true' }), /Invalid/)
  const request = await store.createRequest(
    {
      action: 'configure',
      options: { openAtLogin: true, runAsAdmin: false }
    },
    300_000
  )
  assert.deepEqual((await store.readRequest(request.id)).options, {
    openAtLogin: true,
    runAsAdmin: false
  })
  await store.reply(request.id, { ok: false, error: 'access denied', code: 5 })
  assert.deepEqual(await store.readReply(request.id), {
    ok: false,
    error: 'access denied',
    code: 5
  })
  await store.removeRequest(request.id)
  assert.equal(await store.readReply(request.id), null)
})

test('atomic settings updates leave complete JSON and corrupt settings fail visibly', async (t) => {
  const store = await fixture(t)
  for (let i = 0; i < 4; i++) {
    await store.saveSettings({
      version: 1,
      sid: store.sid,
      exePath: store.exePath,
      openAtLogin: i % 2 === 0,
      runAsAdmin: true,
      restartPending: false
    })
    assert.equal(
      JSON.parse(await readFile(path.join(store.directory, 'state.json'), 'utf8')).runAsAdmin,
      true
    )
  }
  await writeFile(path.join(store.directory, 'state.json'), '{bad')
  await assert.rejects(store.readSettings())
  assert.equal(validateStartupUrl('https://example.com'), false)
  assert.equal(validateStartupUrl('vnite://run-command/powershell'), false)
  assert.equal(validateStartupUrl('vnite://rungameid/game-1'), true)
})
