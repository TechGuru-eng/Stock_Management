import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { saveWarnDays, writeOffAllExpired, writeOffExpired } from '../../data/batchesRepo'
import type { Ctx } from '../../data/repo'
import { formatXaf } from '../../domain/money'
import { can } from '../../domain/permissions'
import { useExpiry } from './useExpiry'

const btn = 'btn btn--primary'
const btn2 = 'btn btn--secondary btn--sm'

/** Stock > Expiry: what has expired and what will soon, with a write-off that removes the expired units from stock. */
export function ExpiryView({ ctx, onBack }: { ctx: Ctx; onBack?: () => void }) {
  const { t, i18n } = useTranslation()
  const state = useExpiry()
  const [msg, setMsg] = useState<string | null>(null)
  const [confirm, setConfirm] = useState(false)
  if (!state) return null
  const { rows, summary, warnDays } = state
  const mayWriteOff = can(ctx.role, 'stock.adjust_approve')
  const date = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(i18n.language)

  async function run(fn: () => Promise<string>) {
    setMsg(null)
    try { setMsg(await fn()) } catch (e) { setMsg((e as Error).message) } finally { setConfirm(false) }
  }

  return (
    <div className="stack">
      {onBack && <button onClick={onBack} className="btn btn--tertiary" style={{ alignSelf: 'flex-start' }}>{t('stock.back')}</button>}
      <h3 className="h4">{t('expiry.title')}</h3>
      <p className="body-md muted">{t('expiry.hint')}</p>
      <label className="field" style={{ maxWidth: 220 }}>{t('expiry.warn')}
        <select className="input" value={warnDays} onChange={(e) => void saveWarnDays(Number(e.target.value))}>
          {[7, 14, 30, 60, 90].map((d) => <option key={d} value={d}>{t('reorder.days', { n: d })}</option>)}
        </select>
      </label>

      {rows.length === 0 ? <p className="notice body-md">{t('expiry.none')}</p> : (
        <>
          <p className="body-md">
            {summary.expiredUnits > 0 && <strong style={{ marginRight: 15 }}>! {t('expiry.expiredTotal', { units: summary.expiredUnits, value: formatXaf(summary.expiredValue) })}</strong>}
            {summary.soonUnits > 0 && <span>{t('expiry.soonTotal', { units: summary.soonUnits, value: formatXaf(summary.soonValue) })}</span>}
          </p>
          {mayWriteOff && summary.expiredUnits > 0 && (
            confirm ? (
              <div className="panel panel--flag body-md">
                <p>{t('expiry.confirmAll', { units: summary.expiredUnits, value: formatXaf(summary.expiredValue) })}</p>
                <div className="flex gap-2" style={{ marginTop: 10 }}>
                  <button className={btn} onClick={() => void run(async () => { const r = await writeOffAllExpired(ctx); return t('expiry.writtenOff', { units: r.units, products: r.products }) })}>{t('expiry.writeOffAll')}</button>
                  <button className={btn2} onClick={() => setConfirm(false)}>{t('shops.cancel')}</button>
                </div>
              </div>
            ) : <button className={btn} style={{ alignSelf: 'flex-start' }} onClick={() => setConfirm(true)}>{t('expiry.writeOffAll')}</button>
          )}
          <ul className="stack" style={{ gap: 8 }}>
            {rows.map((r) => (
              <li key={`${r.productId}-${r.batchId}`} className={`panel body-sm${r.status === 'expired' ? ' panel--flag' : ''}`} style={{ padding: 10 }}>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <span className="body-md">{r.name}</span>
                    <div className="body-sm muted">
                      {r.quantity} {r.baseUnit} · {formatXaf(r.value)} · {date(r.expiry)} · {r.status === 'expired' ? t('expiry.expiredAgo', { n: -r.daysLeft }) : r.daysLeft === 0 ? t('expiry.today') : t('expiry.inDays', { n: r.daysLeft })}
                    </div>
                  </div>
                  {mayWriteOff && r.status === 'expired' && <button className={btn2} onClick={() => void run(async () => t('expiry.writtenOff', { units: await writeOffExpired(ctx, r.productId), products: 1 }))}>{t('expiry.writeOff')}</button>}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      {msg && <p role="status" className="notice body-sm">{msg}</p>}
    </div>
  )
}
