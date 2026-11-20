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
    <section className="panel stack">
      <h4 className="h6">{t('loyalty.points')}</h4>
      <p className="body-md">{t('loyalty.balance', { n: balance, value: formatXaf(redeemValue(Math.max(balance, 0), rules)) })}</p>
      {balance < 0 && <p role="alert" className="field__error">{t('loyalty.negative')}</p>}
      {rows.length > 0 && (
        <ul className="body-sm muted stack" style={{ gap: 2, maxHeight: 192, overflowY: 'auto' }}>
          {rows.map((r) => (
            <li key={r.entry.id} className="flex justify-between gap-2">
              <span>{r.entry.occurredAt.slice(0, 10)} · {t(`loyalty.kind.${r.entry.kind}`)}{r.entry.note ? ` (${r.entry.note})` : ''}</span>
              <span>{r.entry.points > 0 ? '+' : ''}{r.entry.points} → {r.balance}</span>
            </li>
          ))}
        </ul>
      )}
      {can(ctx.role, 'sales.refund_approve') && (
        <form onSubmit={submit} className="stack">
          <p className="label-lg muted">{t('loyalty.adjust')}</p>
          <input className="input" inputMode="numeric" placeholder={t('loyalty.adjustPoints')} aria-label={t('loyalty.adjustPoints')} value={pts} onChange={(e) => setPts(e.target.value.replace(/[^0-9-]/g, ''))} />
          <input className="input" placeholder={t('loyalty.reason')} aria-label={t('loyalty.reason')} value={note} onChange={(e) => setNote(e.target.value)} />
          <button className="btn btn--secondary" disabled={!pts || !note.trim()}>{t('loyalty.apply')}</button>
        </form>
      )}
      {msg && <p role="alert" className="field__error">{msg}</p>}
    </section>
  )
}
