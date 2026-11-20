import { useLiveQuery } from 'dexie-react-hooks'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ScanButton } from '../../scanner/ScanButton'
import { findByBarcode } from '../../domain/barcode'
import { useAuth } from '../../auth/AuthProvider'
import { db } from '../../data/db'
import { transferStock } from '../../data/shopsRepo'
import { useCtx } from '../../data/useCtx'
import { checkTransfer } from '../../domain/shops'

const input = 'input'
const btn = 'btn btn--primary'

/** Move goods to another shop of the same business. Stock leaves here at its average cost and arrives there at the same value. */
export function TransferView() {
  const { t } = useTranslation()
  const ctx = useCtx()
  const { membership } = useAuth()
  const others = membership?.shops.filter((s) => s.id !== ctx?.shopId) ?? []
  const [to, setTo] = useState('')
  const [qty, setQty] = useState<Record<string, string>>({})
  const [note, setNote] = useState('')
  const [msg, setMsg] = useState<string | null>(null)

  const rows = useLiveQuery(async () => {
    if (!ctx) return []
    const products = (await db.products.toArray()).filter((p) => p.active && !p.isService).sort((a, b) => a.name.localeCompare(b.name))
    const costs = new Map((await db.costs.where('shopId').equals(ctx.shopId).toArray()).map((c) => [c.productId, c.quantity]))
    return products.map((p) => ({ p, have: Math.max(costs.get(p.id) ?? 0, 0) })).filter((r) => r.have > 0)
  }, [ctx?.shopId]) ?? []

  const recent = useLiveQuery(async () => {
    if (!ctx) return []
    const ms = (await db.movements.where('shopId').equals(ctx.shopId).toArray()).filter((m) => m.type === 'transfer_in' || m.type === 'transfer_out')
    const names = new Map((await db.products.toArray()).map((p) => [p.id, p.name]))
    return ms.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, 15).map((m) => ({ ...m, name: names.get(m.productId) ?? '—' }))
  }, [ctx?.shopId]) ?? []

  if (!ctx || !membership) return null
  if (others.length === 0) return <p className="body-md muted">{t('shops.transfer.needTwo')}</p>

  const lines = Object.entries(qty).map(([productId, v]) => ({ productId, qty: Number(v) })).filter((l) => l.qty > 0)
  const have = new Map(rows.map((r) => [r.p.id, r.have]))
  const check: ReturnType<typeof checkTransfer> = to ? checkTransfer(ctx.shopId, to, lines, have) : { ok: false, problem: 'no_lines' }
  const shopName = (id: string) => membership.shops.find((s) => s.id === id)?.name ?? '—'

  function onScanned(code: string): string {
    const hit = findByBarcode(rows.map((r) => r.p), code)
    if (!hit) return t('scan.notInStock', { code })
    setQty((q) => ({ ...q, [hit.id]: String(Math.min(Number(q[hit.id] || 0) + 1, have.get(hit.id) ?? 0)) }))
    return t('scan.tally', { name: hit.name })
  }

  async function go() {
    setMsg(null)
    try {
      await transferStock(ctx!, to, lines, note)
      setQty({})
      setNote('')
      setMsg(t('shops.transfer.done', { to: shopName(to) }))
    } catch (e) {
      setMsg((e as Error).message)
    }
  }

  return (
    <div className="stack">
      <p className="body-md muted">{t('shops.transfer.hint', { from: shopName(ctx.shopId) })}</p>
      <label className="field">{t('shops.transfer.to')}
        <select className={input} value={to} onChange={(e) => setTo(e.target.value)}>
          <option value="">—</option>
          {others.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </label>
      {rows.length > 0 && <div><ScanButton continuous onCode={onScanned} className="btn btn--secondary" /></div>}
      {rows.length === 0 ? <p className="body-md muted">{t('shops.transfer.noStock')}</p> : (
        <ul className="stack" style={{ gap: 8 }}>
          {rows.map(({ p, have: h }) => {
            const bad = check.ok === false && check.productId === p.id
            return (
              <li key={p.id} className={`panel flex items-center justify-between gap-2${bad ? ' panel--flag' : ''}`}>
                <div><div className="body-md">{p.name}</div><div className="body-sm muted">{t('shops.transfer.have', { n: h, unit: p.baseUnit })}</div></div>
                <input
                  aria-label={`${p.name} — ${t('shops.transfer.qty')}`} inputMode="numeric" value={qty[p.id] ?? ''}
                  className={`${input} text-right`} style={{ maxWidth: 90 }}
                  onChange={(e) => setQty({ ...qty, [p.id]: e.target.value.replace(/\D/g, '') })}
                />
              </li>
            )
          })}
        </ul>
      )}
      <input className={input} placeholder={t('shops.transfer.note')} aria-label={t('shops.transfer.note')} value={note} onChange={(e) => setNote(e.target.value)} />
      {check.ok === false && check.problem === 'not_enough_stock' && <p role="alert" className="field__error">{t('shops.transfer.notEnough')}</p>}
      {msg && <p role="status" className="notice body-sm">{msg}</p>}
      <button className={btn} disabled={!check.ok} onClick={() => void go()}>{t('shops.transfer.send')}</button>

      {recent.length > 0 && (
        <div>
          <h4 className="h6" style={{ marginTop: 10 }}>{t('shops.transfer.recent')}</h4>
          <ul className="body-sm muted stack" style={{ gap: 4, marginTop: 4 }}>
            {recent.map((m) => (
              <li key={m.id}>{new Date(m.createdAt).toLocaleDateString()} · {m.name} · {m.quantity > 0 ? '+' : ''}{m.quantity} · {m.type === 'transfer_in' ? t('shops.transfer.in') : t('shops.transfer.out')}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
