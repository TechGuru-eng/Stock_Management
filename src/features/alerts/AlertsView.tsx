import { useLiveQuery } from 'dexie-react-hooks'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../auth/AuthProvider'
import { loadSnoozed, snoozeProduct, unsnoozeProduct } from '../../data/alertsRepo'
import { digestText, isSnoozed, type StockAlert } from '../../domain/alerts'
import { waLink } from '../../domain/reminders'
import { useBusinessInfo } from '../invoices/useSeller'
import { useAlerts } from './useAlerts'

const URG = { out: 'bg-red-100 text-red-800', low: 'bg-orange-100 text-orange-800', running_out: 'bg-amber-100 text-amber-800' } as const
const btn2 = 'min-h-10 rounded border border-slate-300 px-3 text-sm'

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
    <div className="flex flex-col gap-3">
      <p className="text-sm text-slate-600 dark:text-slate-300">{t('alerts.hint')}</p>
      <div className="flex flex-wrap gap-2">
        <button className="min-h-12 rounded bg-teal-700 px-4 font-semibold text-white" onClick={onOrder}>{t('alerts.order')}</button>
        {link && state.active.length > 0 && <a href={link} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-12 items-center rounded border border-emerald-600 px-4 font-medium text-emerald-700">{t('alerts.digest')}</a>}
      </div>
      {rows.length === 0 && <p className="rounded bg-teal-50 p-3 text-teal-900">{t('alerts.none')}</p>}
      <ul className="flex flex-col gap-2">
        {rows.map((a) => {
          const hidden = a.covered || isSnoozed(snoozed, a.productId, now)
          return (
            <li key={a.productId} className={`rounded border border-slate-200 p-2 text-sm dark:border-slate-700 ${hidden ? 'opacity-60' : ''}`}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <span className="font-medium">{a.name}</span>
                  <span className={`ml-2 rounded px-1.5 py-0.5 text-xs font-medium ${URG[a.level]}`}>{t(`alerts.level.${a.level}`)}</span>
                  {a.covered && <span className="ml-2 text-xs text-teal-700">{t('alerts.covered')}</span>}
                  {isSnoozed(snoozed, a.productId, now) && <span className="ml-2 text-xs text-slate-500">{t('alerts.snoozedUntil', { date: new Date(snoozed[a.productId]).toLocaleDateString(i18n.language) })}</span>}
                  <div className="text-xs text-slate-500">{line(a)}</div>
                </div>
              </div>
              {!a.covered && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {isSnoozed(snoozed, a.productId, now)
                    ? <button className={btn2} onClick={() => void unsnoozeProduct(a.productId)}>{t('alerts.unsnooze')}</button>
                    : [1, 7, 30].map((d) => <button key={d} className={btn2} onClick={() => void snoozeProduct(a.productId, d)}>{t('alerts.snooze', { n: d })}</button>)}
                </div>
              )}
            </li>
          )
        })}
      </ul>
      {hiddenCount > 0 && <label className="flex min-h-10 items-center gap-2 text-sm"><input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} /> {t('alerts.showHidden', { n: hiddenCount })}</label>}
    </div>
  )
}
