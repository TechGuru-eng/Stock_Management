import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertsView } from './AlertsView'
import { useExpiry } from '../expiry/useExpiry'
import { formatXaf } from '../../domain/money'
import { useAlerts } from './useAlerts'

/** Home: the products that need attention, at a glance. Hidden for people who do not look after stock, and when all is well. */
export function AttentionCard({ goOrder, goExpiry }: { goOrder: () => void; goExpiry?: () => void }) {
  const { t } = useTranslation()
  const state = useAlerts()
  const expiry = useExpiry()
  const [open, setOpen] = useState(false)
  const hasExpiry = Boolean(expiry && expiry.rows.length > 0)
  if (!state || (state.active.length === 0 && !hasExpiry)) return null
  const c = state.counts
  return (
    <section className="panel panel--flag body-md">
      <div className="flex items-center justify-between gap-2">
        <h3 className="h6">{t('alerts.title')}</h3>
        <button onClick={() => setOpen((x) => !x)} aria-expanded={open} className="btn btn--secondary btn--sm">{open ? t('alerts.hide') : t('alerts.seeAll')}</button>
      </div>
      <p style={{ marginTop: 4 }}>
        {c.out > 0 && <strong style={{ marginRight: 8 }}>! {t('alerts.nOut', { count: c.out })}</strong>}
        {c.low > 0 && <span style={{ marginRight: 8 }}>{t('alerts.nLow', { count: c.low })}</span>}
        {c.running_out > 0 && <span>{t('alerts.nRunning', { count: c.running_out })}</span>}
      </p>
      {hasExpiry && (
        <p style={{ marginTop: 4 }}>
          {expiry!.summary.expiredUnits > 0 && <strong style={{ marginRight: 8 }}>! {t('expiry.expiredTotal', { units: expiry!.summary.expiredUnits, value: formatXaf(expiry!.summary.expiredValue) })}</strong>}
          {expiry!.summary.soonUnits > 0 && <span style={{ marginRight: 8 }}>{t('expiry.soonTotal', { units: expiry!.summary.soonUnits, value: formatXaf(expiry!.summary.soonValue) })}</span>}
          {goExpiry && <button onClick={goExpiry} className="btn btn--secondary btn--sm">{t('expiry.open')}</button>}
        </p>
      )}
      {!open && state.active.length > 0 && <p style={{ marginTop: 4 }}>{state.active.slice(0, 4).map((a) => a.name).join(', ')}{state.active.length > 4 ? '…' : ''}</p>}
      {open && <div style={{ marginTop: 15 }}><AlertsView onOrder={goOrder} /></div>}
    </section>
  )
}
