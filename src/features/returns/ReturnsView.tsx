import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../../data/db'
import type { Ctx } from '../../data/repo'
import { approveRequest, cancelSale, pendingApprovals, processReturn, rejectRequest, requestReturn, saleFacts } from '../../data/returnsRepo'
import { useCtx } from '../../data/useCtx'
import { formatXaf } from '../../domain/money'
import { can } from '../../domain/permissions'
import { returnableQuantities, saleReturnStatus, type ReturnRequest } from '../../domain/returns'

type Method = 'cash' | 'mtn_momo' | 'orange_money'
const input = 'input'
const btn = 'btn btn--primary'
const num = (s: string) => (s.trim() === '' ? 0 : Number(s))

function SaleDetail({ ctx, saleId, onBack }: { ctx: Ctx; saleId: string; onBack: () => void }) {
  const { t } = useTranslation()
  const facts = useLiveQuery(() => saleFacts(saleId), [saleId])
  const customer = useLiveQuery(async () => {
    const s = await db.sales.get(saleId)
    return s?.customerId ? db.customers.get(s.customerId) : undefined
  }, [saleId])
  const [qty, setQty] = useState<Record<string, string>>({})
  const [keep, setKeep] = useState<Record<string, boolean>>({})
  const [reason, setReason] = useState('')
  const [method, setMethod] = useState<Method>('cash')
  const [msg, setMsg] = useState<string | null>(null)
  if (!facts) return null

  const left = returnableQuantities(facts.saleLines, facts.priorLines)
  const anyLeft = [...left.values()].some((v) => v > 0)
  const approver = can(ctx.role, 'sales.refund_approve')

  function buildRequest(kind: 'return' | 'cancellation'): ReturnRequest {
    const lines = kind === 'cancellation'
      ? facts!.saleLines.filter((l) => (left.get(l.id) ?? 0) > 0).map((l) => ({ saleLineId: l.id, quantity: left.get(l.id)!, restock: keep[l.id] !== false }))
      : facts!.saleLines.filter((l) => num(qty[l.id] ?? '') > 0).map((l) => ({ saleLineId: l.id, quantity: num(qty[l.id]), restock: keep[l.id] !== false }))
    return { kind, reason, refundMethod: method, lines }
  }

  async function run(kind: 'return' | 'cancellation', mode: 'do' | 'ask') {
    setMsg(null)
    try {
      const request = buildRequest(kind)
      if (mode === 'ask') {
        await requestReturn(ctx, saleId, request)
        setMsg(t('rets.requested'))
      } else if (kind === 'cancellation') {
        await cancelSale(ctx, saleId, reason, method)
        setMsg(t('rets.done'))
      } else {
        await processReturn(ctx, saleId, request)
        setMsg(t('rets.done'))
      }
      setQty({})
    } catch (err) {
      setMsg(t('rets.error', { msg: (err as Error).message }))
    }
  }

  return (
    <div className="stack">
      <button onClick={onBack} className="btn btn--tertiary" style={{ alignSelf: 'flex-start' }}>{t('rets.back')}</button>
      <h3 className="h4">{facts.sale.saleNumber} · {formatXaf(facts.sale.total)}</h3>
      <p className="body-md muted">
        {facts.sale.occurredAt.slice(0, 16).replace('T', ' ')}{customer ? ` · ${customer.name}` : ''} · <strong>{t(`rets.status.${saleReturnStatus(facts.sale, facts.returns)}`)}</strong>
      </p>
      <ul className="body-md muted stack" style={{ gap: 4 }}>
        {facts.returns.map((r) => (
          <li key={r.id}>{r.occurredAt.slice(0, 10)} · {formatXaf(r.totalValue)} ({r.refundedAmount > 0 ? `${t('rets.refunded')} ${formatXaf(r.refundedAmount)}` : ''}{r.refundedAmount > 0 && r.debtReduced > 0 ? ', ' : ''}{r.debtReduced > 0 ? `${t('rets.debtCut')} ${formatXaf(r.debtReduced)}` : ''})</li>
        ))}
      </ul>

      {!anyLeft ? <p className="body-md muted">{t('rets.nothingLeft')}</p> : (
        <form onSubmit={(e: FormEvent) => { e.preventDefault(); void run('return', approver ? 'do' : 'ask') }} className="panel stack">
          {facts.saleLines.filter((l) => (left.get(l.id) ?? 0) > 0).map((l) => (
            <div key={l.id} className="stack" style={{ gap: 4 }}>
              <span className="body-md">{l.productName} <span className="body-md muted">({left.get(l.id)} {l.unitName} {t('rets.returnable')})</span></span>
              <input className={input} inputMode="decimal" placeholder={t('rets.qty')} value={qty[l.id] ?? ''} onChange={(e) => setQty((q) => ({ ...q, [l.id]: e.target.value }))} />
              <label className="check-row body-sm">
                <input type="checkbox" checked={keep[l.id] !== false} onChange={(e) => setKeep((k) => ({ ...k, [l.id]: e.target.checked }))} />
                {t('rets.restock')} <span className="muted">· {t('rets.damagedHint')}</span>
              </label>
            </div>
          ))}
          <input className={input} required placeholder={t('rets.reason')} value={reason} onChange={(e) => setReason(e.target.value)} />
          <select className={input} value={method} onChange={(e) => setMethod(e.target.value as Method)} aria-label={t('rets.refundMethod')}>
            {(['cash', 'mtn_momo', 'orange_money'] as const).map((m) => <option key={m} value={m}>{t('rets.refundMethod')}: {t(`pos.${m}`)}</option>)}
          </select>
          <p className="body-sm muted">{t('rets.rule')}</p>
          <p className="body-sm muted">{t('rets.exchange')}</p>
          <button className={btn}>{approver ? t('rets.returnAction') : t('rets.requestAction')}</button>
          <button type="button" onClick={() => void run('cancellation', approver ? 'do' : 'ask')} className="btn btn--danger">
            {approver ? t('rets.cancelAction') : `${t('rets.requestAction')}: ${t('rets.cancelAction')}`}
          </button>
        </form>
      )}
      {msg && <p role="status" className="label-lg">{msg}</p>}
    </div>
  )
}

function Pending({ ctx }: { ctx: Ctx }) {
  const { t } = useTranslation()
  const list = useLiveQuery(pendingApprovals, []) ?? []
  const sales = useLiveQuery(() => db.sales.toArray(), []) ?? []
  const [note, setNote] = useState<Record<string, string>>({})
  const [msg, setMsg] = useState<string | null>(null)
  if (!can(ctx.role, 'sales.refund_approve')) return null
  const guard = async (fn: () => Promise<unknown>) => {
    setMsg(null)
    try { await fn(); setMsg(t('rets.done')) } catch (err) { setMsg(t('rets.error', { msg: (err as Error).message })) }
  }
  return (
    <section className="stack">
      <h4 className="h6">{t('rets.pending')}</h4>
      {list.length === 0 && <p className="body-md muted">{t('rets.noPending')}</p>}
      {list.map((r) => (
        <div key={r.id} className="panel panel--flag">
          <p className="body-md">{sales.find((s) => s.id === r.payload.saleId)?.saleNumber} · {r.payload.request.kind === 'cancellation' ? t('rets.cancelAction') : t('rets.returns')}</p>
          <p className="body-sm">{r.payload.request.reason}</p>
          <div className="btn-row" style={{ marginTop: 10 }}>
            <button onClick={() => void guard(() => approveRequest(ctx, r.id))} className={btn}>{t('rets.approve')}</button>
            <input className={input} style={{ maxWidth: 160 }} placeholder={t('rets.rejectNote')} value={note[r.id] ?? ''} onChange={(e) => setNote((n) => ({ ...n, [r.id]: e.target.value }))} />
            <button onClick={() => void guard(() => rejectRequest(ctx, r.id, note[r.id] ?? ''))} className="btn btn--secondary">{t('rets.reject')}</button>
          </div>
        </div>
      ))}
      {msg && <p role="status" className="label-lg">{msg}</p>}
    </section>
  )
}

export function ReturnsView() {
  const { t } = useTranslation()
  const ctx = useCtx()
  const [sel, setSel] = useState<string | null>(null)
  const rows = useLiveQuery(async () => {
    const sales = (await db.sales.toArray()).sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1)).slice(0, 30)
    const returns = await db.saleReturns.toArray()
    return sales.map((s) => ({ s, status: saleReturnStatus(s, returns) }))
  }, []) ?? []
  if (!ctx) return null
  if (sel) return <SaleDetail ctx={ctx} saleId={sel} onBack={() => setSel(null)} />
  return (
    <div className="stack">
      <Pending ctx={ctx} />
      <section>
        <h4 className="h6" style={{ marginBottom: 10 }}>{t('rets.recent')}</h4>
        {rows.length === 0 && <p className="body-md muted">{t('rets.none')}</p>}
        <ul className="list-wrap">
          {rows.map(({ s, status }) => (
            <li key={s.id} style={{ padding: 0 }}>
              <button onClick={() => setSel(s.id)} className="flex w-full items-center justify-between text-left" style={{ padding: '15px 20px' }}>
                <span>{s.saleNumber}<span className="block body-sm muted">{s.occurredAt.slice(0, 16).replace('T', ' ')} · {t(`rets.status.${status}`)}</span></span>
                <span className="num">{formatXaf(s.total)}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
