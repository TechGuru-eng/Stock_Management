import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect } from 'react'
import { loadActiveAlerts, takeNewAlerts } from '../../data/alertsRepo'
import { useCtx } from '../../data/useCtx'
import { can } from '../../domain/permissions'
import { countByLevel, type AlertSettings, type StockAlert } from '../../domain/alerts'

export interface AlertsState {
  all: StockAlert[]
  active: StockAlert[]
  settings: AlertSettings
  counts: ReturnType<typeof countByLevel>
}

/** The stock alerts of the current shop, kept up to date as sales and deliveries are recorded. Only for people who look after stock. */
export function useAlerts(): AlertsState | null {
  const ctx = useCtx()
  const data = useLiveQuery(
    async () => (ctx && can(ctx.role, 'stock.receive') ? loadActiveAlerts(ctx) : null),
    [ctx?.shopId, ctx?.role],
  )
  if (!data) return null
  return { ...data, counts: countByLevel(data.active) }
}

/** A device notification the first time something gets worse (never the same alert twice). Needs permission and the setting switched on. */
export function useAlertNotifications(): void {
  const ctx = useCtx()
  const state = useAlerts()
  const key = state ? state.active.map((a) => `${a.productId}:${a.level}`).join(',') : ''
  useEffect(() => {
    if (!ctx || !state || !state.settings.notify || typeof Notification === 'undefined' || Notification.permission !== 'granted') return
    void takeNewAlerts(ctx, state.active).then(async (fresh) => {
      if (fresh.length === 0) return
      const { showStockNotification } = await import('./notify')
      await showStockNotification(fresh)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, state?.settings.notify])
}
