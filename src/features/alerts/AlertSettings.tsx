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
    <section className="panel stack" style={{ marginTop: 24 }}>
      <h3 className="h5">{t('alerts.settings')}</h3>
      <label className="field" style={{ maxWidth: 220 }}>{t('alerts.lead')}
        <select className="input" value={settings.leadDays} onChange={(e) => void saveAlertSettings({ leadDays: Number(e.target.value) })}>
          {[3, 5, 7, 10, 14, 21].map((d) => <option key={d} value={d}>{t('reorder.days', { n: d })}</option>)}
        </select>
      </label>
      <label className="check-row body-md">
        <input type="checkbox" checked={settings.notify && !denied} disabled={!supported || denied} onChange={(e) => void toggle(e.target.checked)} /> {t('alerts.notify')}
      </label>
      <p className="body-sm muted">{!supported ? t('alerts.noSupport') : denied ? t('alerts.denied') : t('alerts.notifyHint')}</p>
    </section>
  )
}
