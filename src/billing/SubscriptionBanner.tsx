import { useTranslation } from 'react-i18next'
import { reminderLevel } from '../domain/subscription'
import { useSubscription } from './useSubscription'

/** Tells the owner and staff where the subscription stands, in plain words, before it becomes a problem. */
export function SubscriptionBanner({ onRenew }: { onRenew: () => void }) {
  const { t } = useTranslation()
  const { state, status, view } = useSubscription()
  if (!state || !status || !view) return null

  let key: string | null = null
  let n = 0
  let tone: 'info' | 'warn' | 'bad' = 'warn'

  if (status === 'suspended' || status === 'expired' || status === 'sync_required' || status === 'clock_changed') {
    key = status
    tone = status === 'sync_required' || status === 'clock_changed' ? 'warn' : 'bad'
  } else if (status === 'grace') {
    key = 'grace'; n = state.graceDaysLeft; tone = 'bad'
  } else if (view.payload.base === 'trial' && state.daysLeft <= 7) {
    key = 'trial'; n = Math.max(state.daysLeft, 0); tone = 'info'
  } else {
    const level = reminderLevel(state)
    if (level === 'soon' || level === 'urgent') { key = level; n = Math.max(state.daysLeft, 0); tone = level === 'urgent' ? 'bad' : 'warn' }
  }
  if (!key) return null

  const style = tone === 'bad' ? 'bg-red-100 text-red-900' : tone === 'warn' ? 'bg-amber-100 text-amber-900' : 'bg-sky-100 text-sky-900'
  const canRenew = key !== 'sync_required' && key !== 'clock_changed' && key !== 'suspended'
  return (
    <div role="status" className={`flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm ${style}`}>
      <span>{t(`billing.banner.${key}`, { n })}</span>
      {canRenew && <button onClick={onRenew} className="min-h-12 rounded border border-current px-3 font-semibold">{t('billing.banner.renewAction')}</button>}
    </div>
  )
}
