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

  const flagged = tone !== 'info'
  const canRenew = key !== 'sync_required' && key !== 'clock_changed' && key !== 'suspended'
  return (
    <div role="status" className={flagged ? 'banner banner--flag' : 'banner'}>
      <span>{flagged ? '! ' : ''}{t(`billing.banner.${key}`, { n })}</span>
      {canRenew && <button onClick={onRenew} className="btn btn--secondary">{t('billing.banner.renewAction')}</button>}
    </div>
  )
}
