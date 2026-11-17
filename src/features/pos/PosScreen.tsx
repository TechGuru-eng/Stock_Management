import { useMemo, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useLiveQuery } from 'dexie-react-hooks'
import { useAuth } from '../../auth/AuthProvider'
import { db, type ProductRec, type UnitRec } from '../../data/db'
import { addCustomer, checkout, customerBalance, type Ctx } from '../../data/repo'
import { useCtx } from '../../data/useCtx'
import { formatXaf } from '../../domain/money'
import { cartTotals, type CartLine, type CheckoutResult } from '../../domain/pos'
import type { PaymentMethod } from '../../domain/payments'
import { InvoiceActions } from '../invoices/InvoiceActions'
import { buildReceiptText, whatsappLink } from '../../domain/receipt'

const input = 'min-h-12 w-full rounded border border-slate-300 bg-transparent px-3'
const btn = 'min-h-12 rounded bg-teal-700 px-4 font-semibold text-white disabled:opacity-60'
const num = (s: string) => (s.trim() === '' ? 0 : Number(s))
const METHODS: PaymentMethod[] = ['cash', 'mtn_momo', 'orange_money', 'credit']

interface PayRow {
  method: PaymentMethod
  amount: string
}

function Receipt({ result, payments, shopName, phone, onNew }: { result: CheckoutResult; payments: PayRow[]; shopName: string; phone?: string; onNew: () => void }) {
  const { t, i18n } = useTranslation()
  const lang = i18n.language === 'en' ? 'en' : 'fr'
  const text = buildReceiptText(
    shopName, result.sale, result.lines,
    payments.filter((p) => p.method !== 'credit').map((p) => ({ method: p.method as 'cash' | 'mtn_momo' | 'orange_money', amount: num(p.amount) })),
    lang,
  )
  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-xl font-semibold">{t('pos.saleDone')}</h3>
      {result.oversoldProductIds.length > 0 && <p role="alert" className="rounded bg-amber-100 p-3 text-amber-900">{t('pos.oversold')}</p>}
      <pre className="overflow-x-auto rounded border border-slate-200 p-3 text-sm whitespace-pre-wrap">{text}</pre>
      <div className="flex gap-3">
        <a href={whatsappLink(text, phone)} target="_blank" rel="noopener noreferrer" className={`${btn} flex flex-1 items-center justify-center`}>{t('pos.whatsapp')}</a>
        <button onClick={() => window.print()} className="min-h-12 flex-1 rounded border border-slate-300">{t('pos.print')}</button>
      </div>
      <InvoiceActions saleId={result.sale.id} />
      <button onClick={onNew} className={btn}>{t('pos.newSale')}</button>
    </div>
  )
}

function NewCustomer({ ctx, onCreated }: { ctx: Ctx; onCreated: (id: string) => void }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [limit, setLimit] = useState('')
  const [err, setErr] = useState<string | null>(null)

  async function save(e: FormEvent) {
    e.preventDefault()
    try {
      const c = await addCustomer(ctx, name, phone, Math.round(num(limit)))
      onCreated(c.id)
      setOpen(false); setName(''); setPhone(''); setLimit('')
    } catch (error) {
      setErr((error as Error).message)
    }
  }
  if (!open) return <button type="button" onClick={() => setOpen(true)} className="min-h-12 text-teal-700 underline">+ {t('pos.newCustomer')}</button>
  return (
    <form onSubmit={save} className="flex flex-col gap-2 rounded border border-slate-200 p-3">
      <input className={input} placeholder={t('pos.customerName')} required value={name} onChange={(e) => setName(e.target.value)} />
      <input className={input} placeholder={t('pos.customerPhone')} inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
      <input className={input} placeholder={t('pos.creditLimit')} inputMode="numeric" value={limit} onChange={(e) => setLimit(e.target.value)} />
      {err && <p role="alert" className="text-red-700">{err}</p>}
      <button className={btn}>{t('pos.save')}</button>
    </form>
  )
}

export function PosScreen() {
  const { t } = useTranslation()
  const ctx = useCtx()
  const { membership } = useAuth()
  const [search, setSearch] = useState('')
  const [cart, setCart] = useState<CartLine[]>([])
  const [customerId, setCustomerId] = useState('')
  const [pays, setPays] = useState<PayRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<{ result: CheckoutResult; pays: PayRow[]; phone?: string } | null>(null)

  const products = useLiveQuery(() => db.products.filter((p) => p.active).toArray(), []) ?? []
  const units = useLiveQuery(() => db.units.toArray(), []) ?? []
  const customers = useLiveQuery(() => db.customers.orderBy('name').toArray(), []) ?? []
  const balance = useLiveQuery(() => (customerId ? customerBalance(customerId) : Promise.resolve(0)), [customerId]) ?? 0
  const unitsByProduct = useMemo(() => {
    const m = new Map<string, UnitRec[]>()
    for (const u of units) m.set(u.productId, [...(m.get(u.productId) ?? []), u])
    return m
  }, [units])

  const totals = cartTotals(cart)
  const paid = pays.reduce((s, p) => s + num(p.amount), 0)
  const remaining = totals.total - paid

  if (!ctx) return null
  if (done) {
    return <Receipt result={done.result} payments={done.pays} shopName={membership?.tenantName ?? ''} phone={done.phone}
      onNew={() => { setDone(null); setCart([]); setPays([]); setCustomerId(''); setSearch('') }} />
  }

  const q = search.trim().toLowerCase()
  const matches: ProductRec[] = q ? products.filter((p) => p.name.toLowerCase().includes(q) || p.barcode === search.trim()).slice(0, 8) : []

  function add(p: ProductRec, u: UnitRec) {
    setError(null)
    setCart((c) => {
      const i = c.findIndex((l) => l.productId === p.id && l.unitId === u.id)
      if (i >= 0) return c.map((l, k) => (k === i ? { ...l, quantity: l.quantity + 1 } : l))
      return [...c, {
        productId: p.id, productName: p.name, unitId: u.id, unitName: u.name, factor: u.factor, unitPrice: u.sellPrice,
        quantity: 1, lineDiscount: 0, taxRateBp: p.taxRateBp, isService: p.isService,
      }]
    })
    setSearch('')
  }

  function onSearchKey(e: FormEvent) {
    e.preventDefault()
    // A barcode scanner types the code and presses Enter.
    const hit = products.find((p) => p.barcode === search.trim()) ?? (matches.length === 1 ? matches[0] : undefined)
    if (!hit) return
    const us = unitsByProduct.get(hit.id) ?? []
    const u = us.find((x) => x.isBase) ?? us[0]
    if (u) add(hit, u)
  }

  const patch = (i: number, p: Partial<CartLine>) => setCart((c) => c.map((l, k) => (k === i ? { ...l, ...p } : l)))
  const setPay = (i: number, p: Partial<PayRow>) => setPays((r) => r.map((x, k) => (k === i ? { ...x, ...p } : x)))

  async function complete() {
    if (!ctx) return
    setError(null)
    setBusy(true)
    try {
      const payments = pays.filter((p) => num(p.amount) > 0).map((p) => ({ method: p.method, amount: Math.round(num(p.amount)) }))
      const result = await checkout(ctx, { lines: cart, payments, customerId: customerId || undefined })
      setDone({ result, pays, phone: customers.find((c) => c.id === customerId)?.phone })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={onSearchKey}>
        <input className={input} placeholder={t('pos.search')} value={search} onChange={(e) => setSearch(e.target.value)} autoFocus />
      </form>

      {q && (
        <ul className="flex flex-col divide-y divide-slate-200 rounded border border-slate-200 dark:divide-slate-800">
          {matches.length === 0 && <li className="p-3 text-slate-500">{t('pos.noResults')}</li>}
          {matches.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 p-2">
              <span>{p.name}</span>
              <span className="flex gap-2">
                {(unitsByProduct.get(p.id) ?? []).map((u) => (
                  <button key={u.id} onClick={() => add(p, u)} className="min-h-12 rounded border border-teal-700 px-3 text-sm">
                    {u.name} · {formatXaf(u.sellPrice)}
                  </button>
                ))}
              </span>
            </li>
          ))}
        </ul>
      )}

      <section>
        <h3 className="mb-2 font-semibold">{t('pos.cart')}</h3>
        {cart.length === 0 && <p className="text-slate-500">{t('pos.empty')}</p>}
        <ul className="flex flex-col gap-3">
          {cart.map((l, i) => (
            <li key={`${l.productId}-${l.unitId}`} className="rounded border border-slate-200 p-3">
              <div className="flex justify-between">
                <strong>{l.productName} <span className="font-normal text-slate-500">({l.unitName})</span></strong>
                <button onClick={() => setCart((c) => c.filter((_, k) => k !== i))} className="min-h-12 px-2 text-red-700" aria-label={t('pos.remove')}>✕</button>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => patch(i, { quantity: Math.max(l.quantity - 1, 1) })} className="min-h-12 w-12 rounded border" aria-label="-">−</button>
                <input className={`${input} text-center`} inputMode="decimal" value={l.quantity} onChange={(e) => patch(i, { quantity: num(e.target.value) })} />
                <button onClick={() => patch(i, { quantity: l.quantity + 1 })} className="min-h-12 w-12 rounded border" aria-label="+">+</button>
                <span className="w-28 text-right">{formatXaf(Math.round(l.unitPrice * l.quantity))}</span>
              </div>
              <label className="mt-2 flex items-center gap-2 text-sm">
                {t('pos.discount')}
                <input className={`${input} w-32`} inputMode="numeric" value={l.lineDiscount || ''} onChange={(e) => patch(i, { lineDiscount: Math.round(num(e.target.value)) })} />
              </label>
            </li>
          ))}
        </ul>
      </section>

      {cart.length > 0 && (
        <>
          <section className="rounded bg-slate-100 p-3 dark:bg-slate-800">
            {totals.discount > 0 && <p className="flex justify-between"><span>{t('pos.subtotal')}</span><span>{formatXaf(totals.subtotal)}</span></p>}
            {totals.discount > 0 && <p className="flex justify-between"><span>{t('pos.discount')}</span><span>-{formatXaf(totals.discount)}</span></p>}
            {totals.tax > 0 && <p className="flex justify-between"><span>{t('pos.tax')}</span><span>{formatXaf(totals.tax)}</span></p>}
            <p className="flex justify-between text-xl font-bold"><span>{t('pos.total')}</span><span>{formatXaf(totals.total)}</span></p>
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="font-semibold">{t('pos.customer')}</h3>
            <select className={input} value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
              <option value="">{t('pos.walkIn')}</option>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            {customerId && <p className="text-sm text-slate-600 dark:text-slate-300">{formatXaf(balance)}</p>}
            <NewCustomer ctx={ctx} onCreated={setCustomerId} />
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="font-semibold">{t('pos.payments')}</h3>
            {pays.map((p, i) => (
              <div key={i} className="flex gap-2">
                <select className={input} value={p.method} onChange={(e) => setPay(i, { method: e.target.value as PaymentMethod })}>
                  {METHODS.map((m) => <option key={m} value={m}>{t(`pos.${m}`)}</option>)}
                </select>
                <input className={input} inputMode="numeric" placeholder={t('pos.amount')} value={p.amount} onChange={(e) => setPay(i, { amount: e.target.value })} />
                <button onClick={() => setPays((r) => r.filter((_, k) => k !== i))} className="min-h-12 px-2 text-red-700" aria-label={t('pos.remove')}>✕</button>
              </div>
            ))}
            <div className="flex gap-3">
              <button onClick={() => setPays([{ method: 'cash', amount: String(totals.total) }])} className="min-h-12 flex-1 rounded border border-slate-300">{t('pos.payFull')}</button>
              <button onClick={() => setPays((r) => [...r, { method: 'cash', amount: remaining > 0 ? String(remaining) : '' }])} className="min-h-12 flex-1 rounded border border-slate-300">+ {t('pos.add')}</button>
            </div>
            <p className={`text-sm ${remaining === 0 ? 'text-teal-700' : 'text-amber-800'}`}>{t('pos.remaining')}: {formatXaf(remaining)}</p>
            {pays.some((p) => p.method === 'mtn_momo' || p.method === 'orange_money') && <p className="text-xs text-slate-500">{t('pos.notRecorded')}</p>}
          </section>

          {error && <p role="alert" className="text-red-700">{error}</p>}
          <button onClick={() => void complete()} disabled={busy || remaining !== 0 || paid === 0 && totals.total > 0} className={btn}>{t('pos.complete')}</button>
        </>
      )}
    </div>
  )
}
