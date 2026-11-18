import { useLiveQuery } from 'dexie-react-hooks'
import { useTranslation } from 'react-i18next'
import { loadActiveAlerts, loadAlertSettings, saveAlertSettings, takeNewAlerts } from '../../data/alertsRepo'
import { useCtx } from '../../data/useCtx'
import { can } from '../../domain/permissions'
import { askNotificationPermission } from './notify'

/** More tab: how early to warn, and whether this device should show notifications. */
export function AlertSettings() {
  const { t } = useTranslation()
  const ctx = useCtx()
  const settings = useLiveQuery(() => loadAlertSettings(), [])
  if (!ctx || !settings || !can(ctx.role, 'stock.receive')) return null
  const supported = typeof Notification !== 'undefined'
  const denied = supported && Notification.permission === 'denied'

  async function toggle(on: boolean) {
    if (!on) return saveAlertSettings({ notify: false })
    if ((await askNotificationPermission()) !== 'granted') return
    // what is already low is the starting point: only NEW problems notify from now on
    const { active } = await loadActiveAlerts(ctx!)
    await takeNewAlerts(ctx!, active)
    await saveAlertSettings({ notify: true })
  }

  return (
    <section className="mt-6 flex flex-col gap-3 rounded border border-slate-200 p-3 dark:border-slate-700">
      <h3 className="text-lg font-semibold">{t('alerts.settings')}</h3>
      <label className="flex flex-col gap-1 text-sm">{t('alerts.lead')}
        <select className="min-h-12 rounded border border-slate-300 bg-transparent px-3" value={settings.leadDays} onChange={(e) => void saveAlertSettings({ leadDays: Number(e.target.value) })}>
          {[3, 5, 7, 10, 14, 21].map((d) => <option key={d} value={d}>{t('reorder.days', { n: d })}</option>)}
        </select>
      </label>
      <label className="flex min-h-12 items-center gap-2">
        <input type="checkbox" checked={settings.notify && !denied} disabled={!supported || denied} onChange={(e) => void toggle(e.target.checked)} /> {t('alerts.notify')}
      </label>
      <p className="text-xs text-slate-500">{!supported ? t('alerts.noSupport') : denied ? t('alerts.denied') : t('alerts.notifyHint')}</p>
    </section>
  )
}
