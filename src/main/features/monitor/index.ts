export { startMonitor } from './services'
export {
  setupNativeMonitor,
  stopNativeMonitor,
  startPhantomMonitor,
  enableForegroundHook,
  disableForegroundHook,
  changeForegroundWaitTime,
  hasActiveGameMonitors
} from './services/nativeMonitor'
export { setupNativeMonitorIPC } from './ipc'
