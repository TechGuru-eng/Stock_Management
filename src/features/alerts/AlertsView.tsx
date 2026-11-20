import { useLiveQuery } from 'dexie-react-hooks'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../auth/AuthProvider'
import { loadSnoozed, snoozeProduct, unsnoozeProduct } from '../../data/alertsRepo'
import { digestText, isSnoozed, type StockAlert } from '../../domain/alerts'
import { waLink } from '../../domain/reminders'
import { useBusinessInfo } from '../invoices/useSeller'
import { useAlerts } from './useAlerts'

const URG = { out: 'tag--flag', low: 'tag--flag', running_out: 'tag--outline' } as const
const btn2 = 'btn btn--secondary btn--sm'

/** Everything that needs attention in this shop, with snooze and a shortcut to the ordering screen. */
export function AlertsView({ onOrder }: { onOrder: () => void }) {
  const { t, i18n } = useTranslation()
  const { membership } = useAuth()
  const state = useAlerts()
  const info = useBusinessInfo()
  const snoozed = useLiveQuery(() => loadSnoozed(), []) ?? {}
  const [showHidden, setShowHidden] = useState(false)
  if (!state) return null
  const now = new Date()
  const rows = state.all.filter((a) => showHidden || (!a.covered && !isSnoozed(snoozed, a.productId, now)))
  const hiddenCount = state.all.length - state.active.length
  const lang = i18n.language.startsWith('fr') ? 'fr' : 'en'
  const digest = digestText(lang, membership?.tenantName ?? '', state.active)
  const link = waLink(info.phone, digest)

  const line = (a: StockAlert) => [
    t('alerts.onHand', { n: Math.max(a.onHand, 0), unit: a.baseUnit }),
    a.minStock > 0 ? t('alerts.min', { n: a.minStock }) : null,
    a.daysLeft !== null ? t('alerts.daysLeft', { n: Math.floor(a.daysLeft) }) : null,
    a.onOrder > 0 ? t('alerts.onOrder', { n: a.onOrder }) : null,
  ].filter(Boolean).join(' · ')

  return (
    <div className="stack">
      <p className="body-md muted">{t('alerts.hint')}</p>
      <div className="flex flex-wrap gap-2">
        <button className="btn btn--primary" onClick={onOrder}>{t('alerts.order')}</button>
        {link && state.active.length > 0 && <a href={link} target="_blank" rel="noopener noreferrer" className="btn btn--secondary">{t('alerts.digest')}</a>}
      </div>
      {rows.length === 0 && <p className="notice body-md">{t('alerts.none')}</p>}
      <ul className="stack" style={{ gap: 8 }}>
        {rows.map((a) => {
          const hidden = a.covered || isSnoozed(snoozed, a.productId, now)
          return (
            <li key={a.productId} className="panel body-sm" style={{ padding: 10, opacity: hidden ? 0.6 : 1 }}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <span className="body-md">{a.name}</span>
                  <span className={`tag ${URG[a.level]}`} style={{ marginLeft: 8 }}>{t(`alerts.level.${a.level}`)}</span>
                  {a.covered && <span className="label-lg muted" style={{ marginLeft: 8 }}>{t('alerts.covered')}</span>}
                  {isSnoozed(snoozed, a.productId, now) && <span className="label-lg muted" style={{ marginLeft: 8 }}>{t('alerts.snoozedUntil', { date: new Date(snoozed[a.productId]).toLocaleDateString(i18n.language) })}</span>}
                  <div className="body-sm muted">{line(a)}</div>
                </div>
              </div>
              {!a.covered && (
                <div className="flex flex-wrap gap-2" style={{ marginTop: 8 }}>
                  {isSnoozed(snoozed, a.productId, now)
                    ? <button className={btn2} onClick={() => void unsnoozeProduct(a.productId)}>{t('alerts.unsnooze')}</button>
                    : [1, 7, 30].map((d) => <button key={d} className={btn2} onClick={() => void snoozeProduct(a.productId, d)}>{t('alerts.snooze', { n: d })}</button>)}
                </div>
              )}
            </li>
          )
        })}
      </ul>
      {hiddenCount > 0 && <label className="check-row body-md"><input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} /> {t('alerts.showHidden', { n: hiddenCount })}</label>}
    </div>
  )
}
