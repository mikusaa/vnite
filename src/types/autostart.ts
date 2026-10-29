export interface AutoStartOptions {
  openAtLogin: boolean
  runAsAdmin: boolean
}

export type AutoStartTaskState =
  | 'absent'
  | 'ok'
  | 'disabled'
  | 'stale-path'
  | 'wrong-principal'
  | 'wrong-logon-type'
  | 'wrong-runlevel'
  | 'invalid-settings'
  | 'unknown'

export interface AutoStartStatus extends AutoStartOptions {
  processElevated: boolean
  restartPending: boolean
  launchTask: AutoStartTaskState
  logonTask: AutoStartTaskState
  loginItem: boolean
  runAsAdminFlag: boolean
  lastError?: string
}

export interface AutoStartResult {
  ok: boolean
  cancelled?: boolean
  error?: string
  code?: number
  status: AutoStartStatus
}

export interface StartupSettings extends AutoStartOptions {
  version: 1
  sid: string
  exePath: string
  restartPending: boolean
  lastError?: string
}

export interface StartupRequest {
  id: string
  sid: string
  createdAt: number
  expiresAt: number
  action: 'launch' | 'configure'
  options?: AutoStartOptions
  showWindow?: boolean
  urls?: string[]
}

export interface StartupReply {
  ok: boolean
  error?: string
  code?: number
  monitorError?: string
}
