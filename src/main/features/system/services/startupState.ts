import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  AutoStartOptions,
  StartupReply,
  StartupRequest,
  StartupSettings
} from '../../../../types/autostart'

export const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function validateOptions(value: unknown): AutoStartOptions {
  if (
    !value ||
    typeof value !== 'object' ||
    typeof (value as AutoStartOptions).openAtLogin !== 'boolean' ||
    typeof (value as AutoStartOptions).runAsAdmin !== 'boolean'
  ) {
    throw new Error('Invalid startup options')
  }
  return {
    openAtLogin: (value as AutoStartOptions).openAtLogin,
    runAsAdmin: (value as AutoStartOptions).runAsAdmin
  }
}

export function validateStartupUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 16_384) return false
  try {
    const url = new URL(value)
    return (
      url.protocol === 'vnite:' &&
      ((url.hostname === 'rungameid' && /^\/[^/\s]+\/?$/.test(url.pathname)) ||
        (url.hostname === 'auth' && url.pathname === '/callback'))
    )
  } catch {
    return false
  }
}

export class StartupStore {
  constructor(
    readonly directory: string,
    readonly sid: string,
    readonly exePath: string
  ) {}

  async atomicWrite(file: string, value: unknown): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true })
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify(value), {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx'
      })
      await rename(temporary, file)
    } finally {
      await rm(temporary, { force: true })
    }
  }

  async readSettings(): Promise<StartupSettings | null> {
    let raw: string
    try {
      raw = await readFile(path.join(this.directory, 'state.json'), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    const value = JSON.parse(raw) as StartupSettings
    if (
      value.version !== 1 ||
      value.sid !== this.sid ||
      value.exePath.toLowerCase() !== this.exePath.toLowerCase() ||
      typeof value.restartPending !== 'boolean'
    ) {
      throw new Error('Startup configuration belongs to a different account or installation')
    }
    return { ...value, ...validateOptions(value) }
  }

  async saveSettings(value: StartupSettings): Promise<void> {
    validateOptions(value)
    if (value.sid !== this.sid || value.exePath !== this.exePath) {
      throw new Error('Cannot save startup settings for another installation')
    }
    await this.atomicWrite(path.join(this.directory, 'state.json'), value)
  }

  async createRequest(
    value: Pick<StartupRequest, 'action' | 'options' | 'urls' | 'showWindow'>,
    timeout: number
  ): Promise<StartupRequest> {
    const request: StartupRequest = {
      ...value,
      id: randomUUID(),
      sid: this.sid,
      createdAt: Date.now(),
      expiresAt: Date.now() + timeout
    }
    await this.atomicWrite(this.requestPath(request.id), request)
    return request
  }

  private requestPath(id: string): string {
    if (!REQUEST_ID.test(id)) throw new Error('Invalid startup request ID')
    return path.join(this.directory, 'requests', `${id}.json`)
  }

  async readRequest(id: string): Promise<StartupRequest> {
    const raw = await readFile(this.requestPath(id), 'utf8')
    if (Buffer.byteLength(raw) > 64 * 1024) throw new Error('Startup request is too large')
    const value = JSON.parse(raw) as StartupRequest
    if (
      value.id !== id ||
      value.sid !== this.sid ||
      !Number.isFinite(value.createdAt) ||
      !Number.isFinite(value.expiresAt) ||
      value.createdAt > Date.now() + 5_000 ||
      value.expiresAt <= Date.now() ||
      value.expiresAt - value.createdAt > 5 * 60_000 ||
      (value.action !== 'launch' && value.action !== 'configure')
    ) {
      throw new Error('Startup request is expired or invalid')
    }
    if (value.action === 'configure') value.options = validateOptions(value.options)
    if (
      value.action === 'launch' &&
      (typeof value.showWindow !== 'boolean' ||
        !Array.isArray(value.urls) ||
        value.urls.length > 16 ||
        !value.urls.every(validateStartupUrl))
    ) {
      throw new Error('Invalid startup launch request')
    }
    return value
  }

  async reply(id: string, value: StartupReply): Promise<void> {
    await this.atomicWrite(`${this.requestPath(id)}.result`, value)
  }

  async readReply(id: string): Promise<StartupReply | null> {
    try {
      const value = JSON.parse(
        await readFile(`${this.requestPath(id)}.result`, 'utf8')
      ) as StartupReply
      if (typeof value.ok !== 'boolean') throw new Error('Invalid startup reply')
      return value
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async removeRequest(id: string): Promise<void> {
    await Promise.all([
      rm(this.requestPath(id), { force: true }),
      rm(`${this.requestPath(id)}.result`, { force: true })
    ])
  }
}
