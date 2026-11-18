import i18n from '../../i18n'
import type { StockAlert } from '../../domain/alerts'

/**
 * A notification on this device. It works while the app is open or running in the background of the phone; it is NOT sent by a server,
 * so nothing arrives while the app is fully closed.
 */
export async function showStockNotification(fresh: readonly StockAlert[]): Promise<void> {
  const t = i18n.t.bind(i18n)
  const out = fresh.filter((a) => a.level === 'out').length
  const title = out > 0 ? t('alerts.notifyOut', { count: out }) : t('alerts.notifyLow', { count: fresh.length })
  const body = fresh.slice(0, 5).map((a) => a.name).join(', ') + (fresh.length > 5 ? '…' : '')
  const options: NotificationOptions = { body, tag: 'stockcm-stock-alert', icon: '/favicon.svg' }
  try {
    const reg = await navigator.serviceWorker?.getRegistration()
    if (reg) return await reg.showNotification(title, options)
  } catch { /* fall back below */ }
  try { new Notification(title, options) } catch { /* not supported here */ }
}

export async function askNotificationPermission(): Promise<NotificationPermission> {
  if (typeof Notification === 'undefined') return 'denied'
  if (Notification.permission !== 'default') return Notification.permission
  return Notification.requestPermission()
}
