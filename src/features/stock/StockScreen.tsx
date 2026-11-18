import { LabelsView } from './LabelsView'
import { ScanButton } from '../../scanner/ScanButton'
import { describeBarcode, findByBarcode, nextInternalEan, sameBarcode } from '../../domain/barcode'
import { useState, type FormEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, type ProductRec, type UnitRec } from '../../data/db'
import { addProduct, receiveStock, removeStock, type Ctx, type RemovalType } from '../../data/repo'
import { useCtx } from '../../data/useCtx'
import { can } from '../../domain/permissions'
import { formatXaf } from '../../domain/money'
import { breakdown } from '../../domain/units'

const input = 'min-h-12 w-full rounded border border-slate-300 bg-transparent px-3'
const btn = 'min-h-12 rounded bg-teal-700 px-4 font-semibold text-white disabled:opacity-60'
const num = (s: string) => (s.trim() === '' ? 0 : Number(s))

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm font-medium">{label}</span>
      {children}
    </label>
  )
}

/* ------------------------------ product form ------------------------------ */

function ProductForm({ ctx, onDone }: { ctx: Ctx; onDone: () => void }) {
  const { t } = useTranslation()
  const [f, setF] = useState({
    name: '', barcode: '', isService: false, baseUnit: 'piece', basePrice: '', bigName: '', bigFactor: '', bigPrice: '',
    minStock: '', tax: '', openingQty: '', openingCost: '',
  })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const set = (k: keyof typeof f, v: string | boolean) => setF((p) => ({ ...p, [k]: v }))

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const units = [{ name: f.baseUnit.trim() || 'piece', factor: 1, sellPrice: num(f.basePrice), isBase: true }]
      if (f.bigName.trim() && num(f.bigFactor) >= 2) {
        units.push({ name: f.bigName.trim(), factor: num(f.bigFactor), sellPrice: num(f.bigPrice), isBase: false })
      }
      for (const u of units) if (!Number.isInteger(u.sellPrice) || u.sellPrice < 0) throw new Error('price must be a whole number of FCFA')
      await addProduct(ctx, {
        name: f.name, barcode: f.barcode, baseUnit: units[0].name, minStock: Math.round(num(f.minStock)),
        taxRateBp: Math.round(num(f.tax) * 100), isService: f.isService, units,
        openingQty: f.isService ? 0 : Math.round(num(f.openingQty)),
        openingTotalCost: f.isService ? 0 : Math.round(num(f.openingCost)),
      })
      onDone()
    } catch (err) {
      setError(t('stock.error', { msg: (err as Error).message }))
    } finally {
      setBusy(false)
    }
  }

  const existing = useLiveQuery(() => db.products.toArray(), []) ?? []
  const clash = f.barcode.trim() ? findByBarcode(existing, f.barcode) : undefined
  const info = f.barcode.trim() ? describeBarcode(f.barcode) : null
  const barcodeNote = clash
    ? { bad: true, text: t('scan.alreadyUsed', { name: clash.name }) }
    : info && info.checksumOk === false ? { bad: true, text: t('scan.badChecksum') }
    : info && info.kind !== 'other' ? { bad: false, text: t('scan.valid', { kind: info.kind.toUpperCase() }) } : null

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <Field label={t('stock.name')}><input className={input} required value={f.name} onChange={(e) => set('name', e.target.value)} /></Field>
      <Field label={t('stock.barcode')}>
        <div className="flex gap-2">
          <input className={input} inputMode="numeric" value={f.barcode} onChange={(e) => set('barcode', e.target.value)} />
          <ScanButton onCode={(c) => { set('barcode', c) }} />
        </div>
        {barcodeNote && <span role="status" className={`text-sm ${barcodeNote.bad ? 'text-red-700' : 'text-slate-600'}`}>{barcodeNote.text}</span>}
        {!f.barcode.trim() && !f.isService && <button type="button" className="self-start text-sm text-teal-700 underline" onClick={() => set('barcode', nextInternalEan(existing.map((p) => p.barcode)))}>{t('scan.makeCode')}</button>}
      </Field>
      <label className="flex items-center gap-2"><input type="checkbox" checked={f.isService} onChange={(e) => set('isService', e.target.checked)} /> {t('stock.isService')}</label>
      <Field label={t('stock.baseUnit')}><input className={input} value={f.baseUnit} onChange={(e) => set('baseUnit', e.target.value)} /></Field>
      <Field label={t('stock.basePrice')}><input className={input} inputMode="numeric" required value={f.basePrice} onChange={(e) => set('basePrice', e.target.value)} /></Field>
      {!f.isService && (
        <>
          <fieldset className="flex flex-col gap-3 rounded border border-slate-200 p-3">
            <legend className="px-1 text-sm">{t('stock.bigUnit')}</legend>
            <Field label={t('stock.bigUnitName')}><input className={input} value={f.bigName} onChange={(e) => set('bigName', e.target.value)} /></Field>
            <Field label={t('stock.bigUnitFactor')}><input className={input} inputMode="numeric" value={f.bigFactor} onChange={(e) => set('bigFactor', e.target.value)} /></Field>
            <Field label={t('stock.bigUnitPrice')}><input className={input} inputMode="numeric" value={f.bigPrice} onChange={(e) => set('bigPrice', e.target.value)} /></Field>
          </fieldset>
          <Field label={t('stock.minStock')}><input className={input} inputMode="numeric" value={f.minStock} onChange={(e) => set('minStock', e.target.value)} /></Field>
          <Field label={t('stock.openingQty')}><input className={input} inputMode="numeric" value={f.openingQty} onChange={(e) => set('openingQty', e.target.value)} /></Field>
          <Field label={t('stock.openingCost')}><input className={input} inputMode="numeric" value={f.openingCost} onChange={(e) => set('openingCost', e.target.value)} /></Field>
        </>
      )}
      <Field label={t('stock.taxPercent')}><input className={input} inputMode="decimal" value={f.tax} onChange={(e) => set('tax', e.target.value)} /></Field>
      {error && <p role="alert" className="text-red-700">{error}</p>}
      <div className="flex gap-3">
        <button type="button" onClick={onDone} className="min-h-12 flex-1 rounded border border-slate-300">{t('stock.cancel')}</button>
        <button disabled={busy} className={`${btn} flex-1`}>{t('stock.save')}</button>
      </div>
    </form>
  )
}

/* ----------------------------- product detail ----------------------------- */

function ProductDetail({ ctx, product, onBack }: { ctx: Ctx; product: ProductRec; onBack: () => void }) {
  const { t } = useTranslation()
  const units = useLiveQuery(() => db.units.where('productId').equals(product.id).toArray(), [product.id]) ?? []
  const cost = useLiveQuery(() => db.costs.get(`${ctx.shopId}:${product.id}`), [product.id, ctx.shopId])
  const [mode, setMode] = useState<'receive' | 'remove' | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [unitId, setUnitId] = useState('')
  const [qty, setQty] = useState('')
  const [totalCost, setTotalCost] = useState('')
  const [reason, setReason] = useState('')
  const [type, setType] = useState<RemovalType>('damaged')

  const onHand = cost?.quantity ?? 0
  const unit: UnitRec | undefined = units.find((u) => u.id === unitId) ?? units.find((u) => u.isBase)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setMsg(null)
    try {
      if (mode === 'receive') {
        if (!unit) return
        await receiveStock(ctx, product.id, unit, num(qty), Math.round(num(totalCost)))
      } else if (mode === 'remove') {
        await removeStock(ctx, product.id, Math.round(num(qty)), type, reason)
      }
      setMsg(t('stock.done'))
      setMode(null)
      setQty(''); setTotalCost(''); setReason('')
    } catch (err) {
      setMsg(t('stock.error', { msg: (err as Error).message }))
    }
  }

  const parts = breakdown(Math.max(onHand, 0), units.map((u) => ({ id: u.id, name: u.name, factor: u.factor, price: u.sellPrice })))
  const canReceive = can(ctx.role, 'stock.receive')
  const canRemove = can(ctx.role, 'stock.adjust_approve')

  return (
    <div className="flex flex-col gap-3">
      <button onClick={onBack} className="min-h-12 self-start text-teal-700 underline">{t('stock.back')}</button>
      <h3 className="text-xl font-semibold">{product.name}</h3>
      <p>
        {t('stock.onHand')}: <strong className={onHand <= product.minStock ? 'text-red-700' : ''}>{onHand} {product.baseUnit}</strong>
        {parts.length > 1 && <span className="text-slate-500"> ({parts.map((p) => `${p.count} ${p.unit.name}`).join(' + ')})</span>}
      </p>
      <ul className="text-sm text-slate-600 dark:text-slate-300">
        {units.map((u) => <li key={u.id}>{u.name}{u.factor > 1 ? ` (${u.factor})` : ''}: {formatXaf(u.sellPrice)}</li>)}
      </ul>
      {!product.isService && !mode && (
        <div className="flex gap-3">
          <button disabled={!canReceive} onClick={() => setMode('receive')} className={`${btn} flex-1`}>{t('stock.receive')}</button>
          <button disabled={!canRemove} onClick={() => setMode('remove')} className="min-h-12 flex-1 rounded border border-slate-300 disabled:opacity-50">{t('stock.remove')}</button>
        </div>
      )}
      {!canReceive && !canRemove && <p className="text-sm text-slate-500">{t('stock.noPermission')}</p>}
      {mode && (
        <form onSubmit={submit} className="flex flex-col gap-3 rounded border border-slate-200 p-3">
          {mode === 'receive' ? (
            <>
              <Field label={t('stock.unit')}>
                <select className={input} value={unit?.id ?? ''} onChange={(e) => setUnitId(e.target.value)}>
                  {units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
              </Field>
              <Field label={t('stock.quantity')}><input className={input} inputMode="decimal" required value={qty} onChange={(e) => setQty(e.target.value)} /></Field>
              <Field label={t('stock.totalCost')}><input className={input} inputMode="numeric" required value={totalCost} onChange={(e) => setTotalCost(e.target.value)} /></Field>
            </>
          ) : (
            <>
              <Field label={t('stock.reasonType')}>
                <select className={input} value={type} onChange={(e) => setType(e.target.value as RemovalType)}>
                  {(['damaged', 'expired', 'missing', 'giveaway', 'personal_use'] as const).map((k) => <option key={k} value={k}>{t(`stock.${k}`)}</option>)}
                </select>
              </Field>
              <Field label={`${t('stock.quantity')} (${product.baseUnit})`}><input className={input} inputMode="numeric" required value={qty} onChange={(e) => setQty(e.target.value)} /></Field>
              <Field label={t('stock.reason')}><input className={input} required value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
            </>
          )}
          <div className="flex gap-3">
            <button type="button" onClick={() => setMode(null)} className="min-h-12 flex-1 rounded border border-slate-300">{t('stock.cancel')}</button>
            <button className={`${btn} flex-1`}>{t('stock.save')}</button>
          </div>
        </form>
      )}
      {msg && <p role="status" className="text-sm">{msg}</p>}
    </div>
  )
}

/* -------------------------------- screen --------------------------------- */

export function StockScreen() {
  const { t } = useTranslation()
  const ctx = useCtx()
  const [search, setSearch] = useState('')
  const [view, setView] = useState<'list' | 'new' | string>('list')

  const rows = useLiveQuery(async () => {
    if (!ctx) return []
    const ps = await db.products.orderBy('name').toArray()
    const cs = new Map((await db.costs.where('shopId').equals(ctx.shopId).toArray()).map((c) => [c.productId, c.quantity]))
    return ps.map((p) => ({ p, onHand: cs.get(p.id) ?? 0 }))
  }, [ctx?.shopId])

  if (!ctx) return null
  const detail = view !== 'list' && view !== 'new' ? rows?.find((r) => r.p.id === view)?.p : undefined

  if (view === 'labels') return <LabelsView ctx={ctx} onBack={() => setView('list')} />
  if (view === 'new') return <ProductForm ctx={ctx} onDone={() => setView('list')} />
  if (detail) return <ProductDetail ctx={ctx} product={detail} onBack={() => setView('list')} />

  const q = search.trim().toLowerCase()
  const shown = (rows ?? []).filter(({ p }) => !q || p.name.toLowerCase().includes(q) || p.barcode?.toLowerCase().includes(q) || (p.barcode ? sameBarcode(p.barcode, search) : false))
  const canWrite = can(ctx.role, 'products.write')

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-3">
        <input className={input} placeholder={t('stock.search')} value={search} onChange={(e) => setSearch(e.target.value)} />
        <ScanButton onCode={(c) => { setSearch(c) }} />
        <button onClick={() => setView('labels')} className="min-h-12 shrink-0 rounded border border-slate-300 px-3">{t('labels.open')}</button>
        {canWrite && <button onClick={() => setView('new')} className={`${btn} shrink-0`}>+ {t('stock.newProduct')}</button>}
      </div>
      {shown.length === 0 && <p className="text-slate-500">{t('stock.none')}</p>}
      <ul className="flex flex-col divide-y divide-slate-200 dark:divide-slate-800">
        {shown.map(({ p, onHand }) => (
          <li key={p.id}>
            <button onClick={() => setView(p.id)} className="flex min-h-14 w-full items-center justify-between py-2 text-left">
              <span>{p.name}</span>
              {p.isService ? <span className="text-sm text-slate-500">service</span> : (
                <span className={onHand <= p.minStock ? 'font-semibold text-red-700' : ''}>
                  {onHand} {p.baseUnit}{onHand <= p.minStock ? ` · ${t('stock.low')}` : ''}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
