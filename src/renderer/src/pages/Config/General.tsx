import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Card, CardContent, CardHeader, CardTitle } from '@ui/card'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue
} from '@ui/select'
import { Switch } from '@ui/switch'
import { Button } from '@ui/button'

import { eventBus } from '~/app/events'
import { ipcManager } from '~/app/ipc'
import { ConfigItem } from '~/components/form/ConfigItem'
import { ConfigItemPure } from '~/components/form/ConfigItemPure'
import { useTheme } from '~/components/ThemeProvider'
import { useConfigState } from '~/hooks'
import { useRunningGames } from '~/pages/Library/store'
import { cn } from '~/utils'
import type { AutoStartStatus } from '@appTypes/autostart'

export function General(): React.JSX.Element {
  const { themeSetting, setThemeSetting } = useTheme()
  const { t } = useTranslation('config')
  const { i18n } = useTranslation()
  const [enableForegroundTimer] = useConfigState('general.enableForegroundTimer')
  const { runningGames } = useRunningGames.getState()

  const [autoStartStatus, setAutoStartStatus] = useState<AutoStartStatus | null>(null)
  const [autoStartPending, setAutoStartPending] = useState(false)

  const isWindows = window.electron.process.platform === 'win32'
  const openAtLogin = autoStartStatus?.openAtLogin ?? false
  const runAsAdmin = autoStartStatus?.runAsAdmin ?? false

  useEffect(() => {
    const refresh = (): void => {
      ipcManager
        .invoke('system:get-autostart-status')
        .then((status) => setAutoStartStatus(status))
        .catch((error) => console.error('Failed to read auto start status:', error))
    }
    refresh()
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [isWindows])

  // Never persist the preference unless the operating system actually applied it.
  const applyAutoStart = async (nextOpenAtLogin: boolean, nextElevated: boolean): Promise<void> => {
    setAutoStartPending(true)
    try {
      const result = await ipcManager.invoke('system:set-autostart', {
        openAtLogin: nextOpenAtLogin,
        runAsAdmin: nextElevated
      })

      setAutoStartStatus(result.status)

      if (result.ok) {
        eventBus.emit('tray:config-updated', undefined, { source: 'openAtLogin' })
        toast.success(
          t(
            result.status.restartPending
              ? 'general.autoStartRestartPending'
              : 'general.autoStartUpdated'
          )
        )
      } else {
        toast.error(
          result.cancelled
            ? t('general.autoStartCancelled')
            : t('general.autoStartFailed', { reason: result.error ?? '' })
        )
      }
    } catch (error) {
      toast.error(t('general.autoStartFailed', { reason: String(error) }))
    } finally {
      setAutoStartPending(false)
    }
  }

  const autoStartHint = ((): string => {
    if (!isWindows) return t('general.autoStartUnsupported')
    if (autoStartStatus?.lastError) return autoStartStatus.lastError
    if (autoStartStatus?.restartPending) return t('general.autoStartRestartPending')
    if (!runAsAdmin) {
      if (autoStartStatus?.processElevated) return t('general.autoStartCurrentAdmin')
      if (!openAtLogin) return ''
      // A RUNASADMIN compatibility flag makes the login item channel unusable:
      // Windows refuses to elevate startup items, so the app never starts.
      return autoStartStatus?.runAsAdminFlag
        ? t('general.autoStartCompatFlagConflict')
        : t('general.autoStartModeLoginItem')
    }

    switch (autoStartStatus?.launchTask) {
      case 'ok':
        return autoStartStatus?.logonTask === 'ok'
          ? t('general.autoStartModeTask')
          : t('general.autoStartTaskMissing')
      case 'stale-path':
        return t('general.autoStartTaskStale')
      case 'disabled':
      case 'wrong-runlevel':
      case 'wrong-principal':
      case 'wrong-logon-type':
      case 'invalid-settings':
      case 'absent':
        return t('general.autoStartTaskMissing')
      default:
        return t('general.autoStartTaskUnknown')
    }
  })()

  const languageOptions = [
    { value: 'zh-CN', label: '简体中文' },
    { value: 'zh-TW', label: '正體中文' },
    { value: 'en', label: 'English' },
    { value: 'ja', label: '日本語' },
    { value: 'ru', label: 'Русский' },
    { value: 'ko', label: '한국어' }
  ]

  return (
    <Card className={cn('group')}>
      <CardHeader>
        <CardTitle className={cn('relative')}>
          <div className={cn('flex flex-row justify-between items-center')}>
            <div className={cn('flex items-center')}>{t('general.title')}</div>
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className={cn('space-y-4')}>
          {/* Open at login */}
          <div className={cn('space-y-4')}>
            <div className={cn('border-b pb-2')}>{t('general.autoStartTitle')}</div>

            <ConfigItemPure
              title={t('general.openAtLogin')}
              description={t('general.openAtLoginDescription')}
              disabled={autoStartPending || !autoStartStatus}
            >
              <Switch
                checked={openAtLogin}
                disabled={autoStartPending || !autoStartStatus}
                onCheckedChange={(checked: boolean) => {
                  void applyAutoStart(checked, runAsAdmin)
                }}
              />
            </ConfigItemPure>

            <ConfigItemPure
              title={t('general.openAtLoginElevated')}
              description={t('general.openAtLoginElevatedDescription')}
              disabled={autoStartPending || !isWindows || !autoStartStatus}
            >
              <Switch
                checked={runAsAdmin}
                disabled={autoStartPending || !isWindows || !autoStartStatus}
                onCheckedChange={(checked: boolean) => {
                  void applyAutoStart(openAtLogin, checked)
                }}
              />
            </ConfigItemPure>

            {autoStartHint !== '' && (
              <div className={cn('text-sm text-muted-foreground')}>{autoStartHint}</div>
            )}
            {runAsAdmin &&
              (autoStartStatus?.launchTask !== 'ok' || autoStartStatus.logonTask !== 'ok') && (
                <Button
                  variant="outline"
                  disabled={autoStartPending}
                  onClick={() => void applyAutoStart(openAtLogin, runAsAdmin)}
                >
                  {t('general.autoStartRepair')}
                </Button>
              )}
          </div>

          {/* Language */}
          <ConfigItem
            hookType="config"
            path="general.language"
            title={t('general.language')}
            description={t('general.languageDescription')}
            controlType="select"
            options={languageOptions}
            onChange={async (value: string) => {
              await i18n.changeLanguage(value)
              await ipcManager.invoke('app:update-language', value)
            }}
          />

          {/* Theme */}
          <ConfigItemPure title={t('general.theme')} description={t('general.themeDescription')}>
            <Select
              value={themeSetting}
              onValueChange={(value: 'dark' | 'light' | 'follow-system') => setThemeSetting(value)}
            >
              <SelectTrigger className={cn('')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel>{t('general.theme')}</SelectLabel>
                  <SelectItem value="dark">{t('general.darkTheme')}</SelectItem>
                  <SelectItem value="light">{t('general.lightTheme')}</SelectItem>
                  <SelectItem value="follow-system">{t('general.followSystem')}</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </ConfigItemPure>

          {/* Close behavior */}
          <ConfigItem
            hookType="config"
            path="general.quitToTray"
            title={t('general.closeMainPanel')}
            description={t('general.closeMainPanelDescription')}
            controlType="select"
            options={[
              { value: 'false', label: t('general.quitApp') },
              { value: 'true', label: t('general.minimizeToTray') }
            ]}
            onChange={async (value: string) => {
              eventBus.emit('tray:config-updated', undefined, {
                source: 'quitToTray'
              })
              console.log('Close behavior changed:', value === 'true' ? 'minimize' : 'quit')
            }}
          />

          {/* Hide window after game start */}
          <ConfigItem
            hookType="config"
            path="general.hideWindowAfterGameStart"
            title={t('general.hideWindowAfterGameStart')}
            description={t('general.hideWindowAfterGameStartDescription')}
            controlType="switch"
          />

          {/* 默认延续现有的退出后唤起行为，同时允许用户按需关闭。 */}
          <ConfigItem
            hookType="config"
            path="general.showWindowAfterGameExit"
            title={t('general.showWindowAfterGameExit')}
            description={t('general.showWindowAfterGameExitDescription')}
            controlType="switch"
          />

          {/* Foreground Window Settings */}
          <div className={cn('space-y-4')}>
            <div className={cn('border-b pb-2')}>{t('general.timerTitle')}</div>
            <div className={cn(' space-y-4')}>
              <ConfigItem
                hookType="config"
                path="general.enableForegroundTimer"
                title={t('general.foregroundTimer.title')}
                description={t('general.foregroundTimer.description')}
                controlType="switch"
                disabled={runningGames.length > 0}
                onChange={(value: boolean) => {
                  ipcManager.send('system:change-foreground-timer', value)
                }}
              />

              <ConfigItem
                hookType="config"
                path="general.foregroundWaitTime"
                title={t('general.foregroundWaitTime.title')}
                description={t('general.foregroundWaitTime.description')}
                controlType="input"
                inputType="number"
                min={0}
                steps={{ default: 1, shift: 5 }}
                disabled={runningGames.length > 0 || !enableForegroundTimer}
                onChange={(value: string) => {
                  ipcManager.send('system:change-foreground-timer-wait-time', Number(value))
                }}
              />

              <ConfigItem
                hookType="config"
                path="general.ignoreShortInterruptions"
                title={t('general.ignoreShortInterruptions.title')}
                description={t('general.ignoreShortInterruptions.description')}
                controlType="input"
                inputType="number"
                min={0}
                steps={{ default: 60, ctrl: 30, alt: 5, shift: 300 }}
              />

              <ConfigItem
                hookType="config"
                path="general.ignoreShortSessions"
                title={t('general.ignoreShortSessions.title')}
                description={t('general.ignoreShortSessions.description')}
                controlType="input"
                inputType="number"
                min={0}
                steps={{ default: 1, shift: 5 }}
              />
            </div>
          </div>

          {/* Record Statistics Settings */}
          <div className={cn('space-y-4')}>
            <div className={cn('border-b pb-2')}>{t('general.statisticsTitle')}</div>
            <ConfigItem
              hookType="config"
              path="record.dayBoundaryHour"
              title={t('general.dayBoundaryHour.title')}
              description={t('general.dayBoundaryHour.description')}
              controlType="slider"
              min={0}
              max={23}
              step={1}
              formatValue={(value) => `${value}:00`}
            />
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
