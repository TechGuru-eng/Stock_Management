import { useState, type FormEvent } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useTranslation } from 'react-i18next'
import { db } from '../../data/db'
import { adjustPoints, loadRules } from '../../data/loyaltyRepo'
import type { Ctx } from '../../data/repo'
import { can } from '../../domain/permissions'
import { balanceOf, redeemValue, statement } from '../../domain/loyalty'
import { formatXaf } from '../../domain/money'

/** A customer's points: balance, history and (managers) a manual correction. Hidden while the program was never switched on and nothing was earned. */
export function CustomerPoints({ ctx, customerId }: { ctx: Ctx; customerId: string }) {
  const { t } = useTranslation()
  const rules = useLiveQuery(() => loadRules(), [])
  const entries = useLiveQuery(() => db.loyaltyEntries.where('customerId').equals(customerId).toArray(), [customerId]) ?? []
  const [pts, setPts] = useState('')
  const [note, setNote] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  if (!rules || (!rules.enabled && entries.length === 0)) return null
  const balance = balanceOf(entries)
  const rows = statement(entries).reverse()

  async function submit(e: FormEvent) {
    e.preventDefault()
    setMsg(null)
    try {
      await adjustPoints(ctx, customerId, Math.trunc(Number(pts)), note)
      setPts('')
      setNote('')
    } catch (err) {
      setMsg((err as Error).message)
    }
  }

  return (
    <section className="flex flex-col gap-2 rounded border border-slate-200 p-3 dark:border-slate-700">
      <h4 className="font-semibold">{t('loyalty.points')}</h4>
      <p>{t('loyalty.balance', { n: balance, value: formatXaf(redeemValue(Math.max(balance, 0), rules)) })}</p>
      {balance < 0 && <p role="alert" className="text-sm text-amber-700">{t('loyalty.negative')}</p>}
      {rows.length > 0 && (
        <ul className="max-h-48 overflow-y-auto text-sm text-slate-600 dark:text-slate-300">
          {rows.map((r) => (
            <li key={r.entry.id} className="flex justify-between gap-2 py-0.5">
              <span>{r.entry.occurredAt.slice(0, 10)} · {t(`loyalty.kind.${r.entry.kind}`)}{r.entry.note ? ` (${r.entry.note})` : ''}</span>
              <span>{r.entry.points > 0 ? '+' : ''}{r.entry.points} → {r.balance}</span>
            </li>
          ))}
        </ul>
      )}
      {can(ctx.role, 'sales.refund_approve') && (
        <form onSubmit={submit} className="flex flex-col gap-2">
          <p className="text-sm font-medium">{t('loyalty.adjust')}</p>
          <input className="min-h-12 rounded border border-slate-300 bg-transparent px-3" inputMode="numeric" placeholder={t('loyalty.adjustPoints')} aria-label={t('loyalty.adjustPoints')} value={pts} onChange={(e) => setPts(e.target.value.replace(/[^0-9-]/g, ''))} />
          <input className="min-h-12 rounded border border-slate-300 bg-transparent px-3" placeholder={t('loyalty.reason')} aria-label={t('loyalty.reason')} value={note} onChange={(e) => setNote(e.target.value)} />
          <button className="min-h-12 rounded border border-slate-300 px-3" disabled={!pts || !note.trim()}>{t('loyalty.apply')}</button>
        </form>
      )}
      {msg && <p role="alert" className="text-sm text-red-700">{msg}</p>}
    </section>
  )
}
