import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { saveWarnDays, writeOffAllExpired, writeOffExpired } from '../../data/batchesRepo'
import type { Ctx } from '../../data/repo'
import { formatXaf } from '../../domain/money'
import { can } from '../../domain/permissions'
import { useExpiry } from './useExpiry'

const btn = 'min-h-12 rounded bg-teal-700 px-4 font-semibold text-white disabled:opacity-60'
const btn2 = 'min-h-10 rounded border border-slate-300 px-3 text-sm'

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
    <div className="flex flex-col gap-3">
      {onBack && <button onClick={onBack} className="min-h-12 self-start text-teal-700 underline">{t('stock.back')}</button>}
      <h3 className="text-xl font-semibold">{t('expiry.title')}</h3>
      <p className="text-sm text-slate-600 dark:text-slate-300">{t('expiry.hint')}</p>
      <label className="flex flex-col gap-1 text-sm">{t('expiry.warn')}
        <select className="min-h-12 rounded border border-slate-300 bg-transparent px-3" value={warnDays} onChange={(e) => void saveWarnDays(Number(e.target.value))}>
          {[7, 14, 30, 60, 90].map((d) => <option key={d} value={d}>{t('reorder.days', { n: d })}</option>)}
        </select>
      </label>

      {rows.length === 0 ? <p className="rounded bg-teal-50 p-3 text-teal-900">{t('expiry.none')}</p> : (
        <>
          <p className="text-sm">
            {summary.expiredUnits > 0 && <strong className="mr-3 text-red-700">{t('expiry.expiredTotal', { units: summary.expiredUnits, value: formatXaf(summary.expiredValue) })}</strong>}
            {summary.soonUnits > 0 && <span>{t('expiry.soonTotal', { units: summary.soonUnits, value: formatXaf(summary.soonValue) })}</span>}
          </p>
          {mayWriteOff && summary.expiredUnits > 0 && (
            confirm ? (
              <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-900">
                <p>{t('expiry.confirmAll', { units: summary.expiredUnits, value: formatXaf(summary.expiredValue) })}</p>
                <div className="mt-2 flex gap-2">
                  <button className={btn} onClick={() => void run(async () => { const r = await writeOffAllExpired(ctx); return t('expiry.writtenOff', { units: r.units, products: r.products }) })}>{t('expiry.writeOffAll')}</button>
                  <button className={btn2} onClick={() => setConfirm(false)}>{t('shops.cancel')}</button>
                </div>
              </div>
            ) : <button className={`${btn} self-start`} onClick={() => setConfirm(true)}>{t('expiry.writeOffAll')}</button>
          )}
          <ul className="flex flex-col gap-2">
            {rows.map((r) => (
              <li key={`${r.productId}-${r.batchId}`} className={`rounded border p-2 text-sm ${r.status === 'expired' ? 'border-red-300 bg-red-50 dark:bg-red-950' : 'border-amber-300 bg-amber-50 dark:bg-amber-950'}`}>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <span className="font-medium">{r.name}</span>
                    <div className="text-xs text-slate-600 dark:text-slate-300">
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
      {msg && <p role="status" className="rounded bg-slate-100 p-2 text-sm dark:bg-slate-800">{msg}</p>}
    </div>
  )
}
