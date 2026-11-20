import { useState, type FormEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../../data/db'
import type { Ctx } from '../../data/repo'
import { addSupplier, createPurchase, paySupplier, receiveGoods, returnToSupplier, supplierPayable } from '../../data/purchasingRepo'
import { useCtx } from '../../data/useCtx'
import { QuoteHint } from './QuoteHint'
import { ReorderView } from './ReorderView'
import { SupplierPriceList } from './SupplierPriceList'
import { formatXaf } from '../../domain/money'
import { can } from '../../domain/permissions'
import { purchaseStatus, receivedByLine, supplierBalance, supplierStatement } from '../../domain/purchasing'

type Method = 'cash' | 'mtn_momo' | 'orange_money'
const input = 'input'
const btn = 'btn btn--primary'
const num = (s: string) => (s.trim() === '' ? 0 : Number(s))

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  )
}

function MethodSelect({ value, onChange }: { value: Method; onChange: (m: Method) => void }) {
  const { t } = useTranslation()
  return (
    <select className={input} value={value} onChange={(e) => onChange(e.target.value as Method)}>
      {(['cash', 'mtn_momo', 'orange_money'] as const).map((m) => <option key={m} value={m}>{t(`pos.${m}`)}</option>)}
    </select>
  )
}

/* ---------------------------------- new order ---------------------------------- */

interface DraftLine {
  productId: string
  unitId: string
  quantity: string
  totalCost: string
}

function NewOrder({ ctx, onDone }: { ctx: Ctx; onDone: () => void }) {
  const { t } = useTranslation()
  const suppliers = useLiveQuery(() => db.suppliers.orderBy('name').toArray(), []) ?? []
  const products = useLiveQuery(() => db.products.filter((p) => p.active && !p.isService).toArray(), []) ?? []
  const units = useLiveQuery(() => db.units.toArray(), []) ?? []
  const [supplierId, setSupplierId] = useState('')
  const [invoice, setInvoice] = useState('')
  const [lines, setLines] = useState<DraftLine[]>([{ productId: '', unitId: '', quantity: '', totalCost: '' }])
  const [newName, setNewName] = useState('')
  const [newPhone, setNewPhone] = useState('')
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const patch = (i: number, p: Partial<DraftLine>) => setLines((ls) => ls.map((l, k) => (k === i ? { ...l, ...p } : l)))
  const unitsOf = (pid: string) => units.filter((u) => u.productId === pid)

  async function createSupplier() {
    try {
      const s = await addSupplier(ctx, newName, newPhone)
      setSupplierId(s.id); setAdding(false); setNewName(''); setNewPhone('')
    } catch (e) {
      setError(t('purch.error', { msg: (e as Error).message }))
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    try {
      if (!supplierId) throw new Error(t('purch.supplier'))
      await createPurchase(ctx, {
        supplierId, invoiceNumber: invoice,
        lines: lines.filter((l) => l.productId).map((l) => ({
          productId: l.productId, unitId: l.unitId || unitsOf(l.productId).find((u) => u.isBase)!.id,
          quantity: num(l.quantity), totalCost: Math.round(num(l.totalCost)),
        })),
      })
      onDone()
    } catch (err) {
      setError(t('purch.error', { msg: (err as Error).message }))
    }
  }

  return (
    <form onSubmit={submit} className="stack">
      <Field label={t('purch.supplier')}>
        <select className={input} value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
          <option value="" />
          {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </Field>
      {adding ? (
        <div className="panel stack">
          <input className={input} placeholder={t('purch.supplierName')} value={newName} onChange={(e) => setNewName(e.target.value)} />
          <input className={input} placeholder={t('purch.phone')} inputMode="tel" value={newPhone} onChange={(e) => setNewPhone(e.target.value)} />
          <button type="button" onClick={() => void createSupplier()} className={btn}>{t('purch.save')}</button>
        </div>
      ) : (
        <button type="button" onClick={() => setAdding(true)} className="btn btn--tertiary" style={{ alignSelf: 'flex-start' }}>+ {t('purch.newSupplier')}</button>
      )}
      <Field label={t('purch.invoice')}><input className={input} value={invoice} onChange={(e) => setInvoice(e.target.value)} /></Field>

      {lines.map((l, i) => (
        <div key={i} className="panel stack">
          <select className={input} value={l.productId} onChange={(e) => patch(i, { productId: e.target.value, unitId: '' })} aria-label={t('purch.product')}>
            <option value="">{t('purch.product')}</option>
            {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          {l.productId && (
            <select className={input} value={l.unitId || unitsOf(l.productId).find((u) => u.isBase)?.id} onChange={(e) => patch(i, { unitId: e.target.value })} aria-label={t('purch.unit')}>
              {unitsOf(l.productId).map((u) => <option key={u.id} value={u.id}>{u.name}{u.factor > 1 ? ` (${u.factor})` : ''}</option>)}
            </select>
          )}
          <div className="flex gap-2">
            <input className={input} inputMode="decimal" placeholder={t('purch.quantity')} value={l.quantity} onChange={(e) => patch(i, { quantity: e.target.value })} />
            <input className={input} inputMode="numeric" placeholder={t('purch.totalCost')} value={l.totalCost} onChange={(e) => patch(i, { totalCost: e.target.value })} />
          </div>
          {l.productId && (
            <QuoteHint
              supplierId={supplierId} productId={l.productId} unitId={l.unitId || unitsOf(l.productId).find((u) => u.isBase)?.id || ''}
              quantity={num(l.quantity)} totalCost={num(l.totalCost)} onUse={(total) => patch(i, { totalCost: String(total) })}
            />
          )}
        </div>
      ))}
      <button type="button" onClick={() => setLines((ls) => [...ls, { productId: '', unitId: '', quantity: '', totalCost: '' }])} className="btn btn--tertiary" style={{ alignSelf: 'flex-start' }}>
        + {t('purch.addLine')}
      </button>
      {error && <p role="alert" className="field__error">{error}</p>}
      <div className="flex gap-3">
        <button type="button" onClick={onDone} className="btn btn--secondary flex-1">{t('purch.back')}</button>
        <button className={`${btn} flex-1`}>{t('purch.createOrder')}</button>
      </div>
    </form>
  )
}

/* ------------------------------- order detail ------------------------------- */

function OrderDetail({ ctx, purchaseId, onBack }: { ctx: Ctx; purchaseId: string; onBack: () => void }) {
  const { t } = useTranslation()
  const data = useLiveQuery(async () => {
    const purchase = await db.purchases.get(purchaseId)
    if (!purchase) return null
    const lines = await db.purchaseLines.where('purchaseId').equals(purchaseId).toArray()
    const receipts = await db.receipts.where('purchaseId').equals(purchaseId).toArray()
    const rl = receipts.length ? await db.receiptLines.where('receiptId').anyOf(receipts.map((r) => r.id)).toArray() : []
    const supplier = await db.suppliers.get(purchase.supplierId)
    const all = await db.products.toArray()
    const products = new Map(all.map((p) => [p.id, p.name]))
    const tracked = new Set(all.filter((p) => p.trackExpiry).map((p) => p.id))
    return { purchase, lines, rl, supplier, products, tracked }
  }, [purchaseId])
  const [qty, setQty] = useState<Record<string, string>>({})
  const [dates, setDates] = useState<Record<string, string>>({})
  const [paid, setPaid] = useState('')
  const [method, setMethod] = useState<Method>('cash')
  const [msg, setMsg] = useState<string | null>(null)
  if (!data) return null

  const got = receivedByLine(data.rl)
  const status = purchaseStatus(data.lines, data.rl)
  const canReceive = can(ctx.role, 'stock.receive')
  const canPay = can(ctx.role, 'purchases.manage')

  async function submit(e: FormEvent) {
    e.preventDefault()
    setMsg(null)
    try {
      const deliveries = data!.lines
        .map((l) => ({ purchaseLineId: l.id, baseQuantity: Math.round(num(qty[l.id] ?? '')), expiry: data!.tracked.has(l.productId) && dates[l.id] ? dates[l.id] : undefined }))
        .filter((d) => d.baseQuantity > 0)
      await receiveGoods(ctx, purchaseId, deliveries, canPay && num(paid) > 0 ? { amount: Math.round(num(paid)), method } : undefined)
      setQty({}); setPaid('')
      setMsg(t('purch.done'))
    } catch (err) {
      setMsg(t('purch.error', { msg: (err as Error).message }))
    }
  }

  return (
    <div className="stack">
      <button onClick={onBack} className="btn btn--tertiary" style={{ alignSelf: 'flex-start' }}>{t('purch.back')}</button>
      <h3 className="h4">{data.supplier?.name}</h3>
      <p className="body-md muted">
        {data.purchase.invoiceNumber ? `${data.purchase.invoiceNumber} · ` : ''}{data.purchase.orderedAt.slice(0, 10)} · <strong>{t(`purch.status.${status}`)}</strong>
      </p>
      <ul className="list-wrap">
        {data.lines.map((l) => (
          <li key={l.id}>
            <p className="body-md">{data.products.get(l.productId)}</p>
            <p className="body-sm muted">
              {t('purch.ordered')} {l.baseQuantity} · {t('purch.received')} {got.get(l.id) ?? 0} · {t('purch.remaining')} {l.baseQuantity - (got.get(l.id) ?? 0)} · {formatXaf(l.totalCost)}
            </p>
          </li>
        ))}
      </ul>
      {status !== 'received' && canReceive && (
        <form onSubmit={submit} className="panel stack">
          <h4 className="h6">{t('purch.receiveGoods')}</h4>
          <p className="body-sm muted">{t('purch.receiveHint')}</p>
          {data.lines.filter((l) => (got.get(l.id) ?? 0) < l.baseQuantity).map((l) => (
            <Field key={l.id} label={`${data.products.get(l.productId)} (${t('purch.remaining')} ${l.baseQuantity - (got.get(l.id) ?? 0)})`}>
              <input className={input} inputMode="numeric" value={qty[l.id] ?? ''} onChange={(e) => setQty((q) => ({ ...q, [l.id]: e.target.value }))} />
              {data.tracked.has(l.productId) && <input type="date" aria-label={t('expiry.dateOfGoods')} className={input} style={{ marginTop: 8 }} value={dates[l.id] ?? ''} onChange={(e) => setDates((d) => ({ ...d, [l.id]: e.target.value }))} />}
            </Field>
          ))}
          {canPay && (
            <>
              <Field label={t('purch.paidNow')}><input className={input} inputMode="numeric" value={paid} onChange={(e) => setPaid(e.target.value)} /></Field>
              <Field label={t('purch.method')}><MethodSelect value={method} onChange={setMethod} /></Field>
            </>
          )}
          <button className={btn}>{t('purch.receiveGoods')}</button>
        </form>
      )}
      {msg && <p role="status" className="label-lg">{msg}</p>}
    </div>
  )
}

/* -------------------------------- purchases list -------------------------------- */

export function PurchasesView() {
  const { t } = useTranslation()
  const ctx = useCtx()
  const [view, setView] = useState<'list' | 'new' | string>('list')
  const rows = useLiveQuery(async () => {
    const ps = (await db.purchases.toArray()).sort((a, b) => (a.orderedAt < b.orderedAt ? 1 : -1))
    const out = []
    for (const p of ps) {
      const lines = await db.purchaseLines.where('purchaseId').equals(p.id).toArray()
      const receipts = await db.receipts.where('purchaseId').equals(p.id).toArray()
      const rl = receipts.length ? await db.receiptLines.where('receiptId').anyOf(receipts.map((r) => r.id)).toArray() : []
      out.push({ p, supplier: await db.suppliers.get(p.supplierId), status: purchaseStatus(lines, rl), total: lines.reduce((s, l) => s + l.totalCost, 0) })
    }
    return out
  }, []) ?? []
  if (!ctx) return null
  if (view === 'new') return <NewOrder ctx={ctx} onDone={() => setView('list')} />
  if (view === 'reorder') return <ReorderView ctx={ctx} onBack={() => setView('list')} />
  if (view !== 'list') return <OrderDetail ctx={ctx} purchaseId={view} onBack={() => setView('list')} />
  return (
    <div className="stack">
      {can(ctx.role, 'purchases.manage') && (
        <div className="flex gap-2">
          <button onClick={() => setView('new')} className={`${btn} flex-1`}>+ {t('purch.newOrder')}</button>
          <button onClick={() => setView('reorder')} className="btn btn--secondary flex-1">{t('reorder.open')}</button>
        </div>
      )}
      {rows.length === 0 && <p className="body-md muted">{t('purch.noOrders')}</p>}
      <ul className="list-wrap">
        {rows.map(({ p, supplier, status, total }) => (
          <li key={p.id} style={{ padding: 0 }}>
            <button onClick={() => setView(p.id)} className="flex w-full items-center justify-between text-left" style={{ padding: '15px 20px' }}>
              <span>{supplier?.name}<span className="block body-sm muted">{p.orderedAt.slice(0, 10)} · {t(`purch.status.${status}`)}</span></span>
              <span className="num">{formatXaf(total)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

/* ------------------------------------ suppliers ------------------------------------ */

function SupplierDetail({ ctx, supplierId, onBack }: { ctx: Ctx; supplierId: string; onBack: () => void }) {
  const { t } = useTranslation()
  const supplier = useLiveQuery(() => db.suppliers.get(supplierId), [supplierId])
  const entries = useLiveQuery(() => db.supplierEntries.where('supplierId').equals(supplierId).toArray(), [supplierId]) ?? []
  const products = useLiveQuery(() => db.products.filter((p) => !p.isService).toArray(), []) ?? []
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState<Method>('cash')
  const [retProduct, setRetProduct] = useState('')
  const [retQty, setRetQty] = useState('')
  const [retCredit, setRetCredit] = useState('')
  const [retReason, setRetReason] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const owed = supplierBalance(entries)
  const allowed = can(ctx.role, 'purchases.manage')
  const guard = async (fn: () => Promise<void>) => {
    setMsg(null)
    try { await fn(); setMsg(t('purch.done')) } catch (err) { setMsg(t('purch.error', { msg: (err as Error).message })) }
  }

  return (
    <div className="stack">
      <button onClick={onBack} className="btn btn--tertiary" style={{ alignSelf: 'flex-start' }}>{t('purch.back')}</button>
      <h3 className="h4">{supplier?.name}</h3>
      <p className="body-md">{owed > 0 ? <>{t('purch.owedTo')}: <strong>{formatXaf(owed)}</strong></> : owed < 0 ? <>{t('purch.credit')}: <strong>{formatXaf(-owed)}</strong></> : t('purch.nothingOwed')}</p>

      {allowed && owed > 0 && (
        <form onSubmit={(e) => { e.preventDefault(); void guard(async () => { await paySupplier(ctx, { supplierId, amount: Math.round(num(amount)), method }); setAmount('') }) }} className="panel stack">
          <h4 className="h6">{t('purch.pay')}</h4>
          <Field label={t('purch.amount')}><input className={input} inputMode="numeric" required value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
          <Field label={t('purch.method')}><MethodSelect value={method} onChange={setMethod} /></Field>
          <button className={btn}>{t('purch.save')}</button>
        </form>
      )}

      {allowed && (
        <form onSubmit={(e) => { e.preventDefault(); void guard(async () => { await returnToSupplier(ctx, { supplierId, productId: retProduct, baseQuantity: Math.round(num(retQty)), creditValue: Math.round(num(retCredit)), reason: retReason }); setRetQty(''); setRetCredit(''); setRetReason('') }) }} className="panel stack">
          <h4 className="h6">{t('purch.returnGoods')}</h4>
          <select className={input} required value={retProduct} onChange={(e) => setRetProduct(e.target.value)} aria-label={t('purch.product')}>
            <option value="">{t('purch.product')}</option>
            {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <input className={input} inputMode="numeric" required placeholder={t('purch.baseQty')} value={retQty} onChange={(e) => setRetQty(e.target.value)} />
          <input className={input} inputMode="numeric" required placeholder={t('purch.creditValue')} value={retCredit} onChange={(e) => setRetCredit(e.target.value)} />
          <input className={input} required placeholder={t('purch.reason')} value={retReason} onChange={(e) => setRetReason(e.target.value)} />
          <button className={btn}>{t('purch.save')}</button>
        </form>
      )}
      {msg && <p role="status" className="label-lg">{msg}</p>}

      <SupplierPriceList ctx={ctx} supplierId={supplierId} />

      <section>
        <h4 className="h6" style={{ marginBottom: 10 }}>{t('purch.statement')}</h4>
        <ul className="list-wrap">
          {supplierStatement(entries).map(({ entry, balance }) => (
            <li key={entry.id} className="flex justify-between body-sm">
              <span>{entry.occurredAt.slice(0, 10)} · {t(`purch.kind.${entry.kind}`)}</span>
              <span>{entry.amount > 0 ? '+' : ''}{formatXaf(entry.amount)} <span className="muted">→ {formatXaf(balance)}</span></span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}

export function SuppliersView() {
  const { t } = useTranslation()
  const ctx = useCtx()
  const [sel, setSel] = useState<string | null>(null)
  const rows = useLiveQuery(async () => {
    const suppliers = await db.suppliers.orderBy('name').toArray()
    const out = []
    for (const s of suppliers) out.push({ s, owed: await supplierPayable(s.id) })
    return out
  }, []) ?? []
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [err, setErr] = useState<string | null>(null)
  if (!ctx) return null
  if (sel) return <SupplierDetail ctx={ctx} supplierId={sel} onBack={() => setSel(null)} />
  return (
    <div className="stack">
      {can(ctx.role, 'purchases.manage') && (
        <form onSubmit={(e) => { e.preventDefault(); setErr(null); addSupplier(ctx, name, phone).then(() => { setName(''); setPhone('') }).catch((x: Error) => setErr(x.message)) }} className="panel stack">
          <input className={input} placeholder={t('purch.supplierName')} value={name} onChange={(e) => setName(e.target.value)} />
          <input className={input} placeholder={t('purch.phone')} inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
          {err && <p role="alert" className="field__error">{err}</p>}
          <button className={btn}>+ {t('purch.newSupplier')}</button>
        </form>
      )}
      {rows.length === 0 && <p className="body-md muted">{t('purch.noSuppliers')}</p>}
      <ul className="list-wrap">
        {rows.map(({ s, owed }) => (
          <li key={s.id} style={{ padding: 0 }}>
            <button onClick={() => setSel(s.id)} className="flex w-full items-center justify-between text-left" style={{ padding: '15px 20px' }}>
              <span>{s.name}</span>
              <span className={owed > 0 ? 'label-lg' : 'body-md muted'}>{owed > 0 ? `! ${formatXaf(owed)}` : owed < 0 ? `+${formatXaf(-owed)}` : '—'}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
