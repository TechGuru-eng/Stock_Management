import { ProductSuppliers } from '../purchasing/ProductSuppliers'
import { EditProduct } from './EditProduct'
import { ExpiryView } from '../expiry/ExpiryView'
import { useExpiry } from '../expiry/useExpiry'
import { ImportView } from './ImportView'
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

/* ------------------------------ product form ------------------------------ */

function ProductForm({ ctx, onDone }: { ctx: Ctx; onDone: () => void }) {
  const { t } = useTranslation()
  const [f, setF] = useState({
    name: '', barcode: '', isService: false, baseUnit: 'piece', basePrice: '', bigName: '', bigFactor: '', bigPrice: '',
    minStock: '', tax: '', openingQty: '', openingCost: '', trackExpiry: false, openingExpiry: '',
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
        trackExpiry: f.trackExpiry && !f.isService, openingExpiry: f.openingExpiry || undefined,
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
    <form onSubmit={submit} className="stack">
      <Field label={t('stock.name')}><input className={input} required value={f.name} onChange={(e) => set('name', e.target.value)} /></Field>
      <Field label={t('stock.barcode')}>
        <div className="flex gap-2">
          <input className={input} inputMode="numeric" value={f.barcode} onChange={(e) => set('barcode', e.target.value)} />
          <ScanButton onCode={(c) => { set('barcode', c) }} />
        </div>
        {barcodeNote && <span role="status" className={barcodeNote.bad ? 'field__error' : 'label-lg muted'}>{barcodeNote.text}</span>}
        {!f.barcode.trim() && !f.isService && <button type="button" className="btn btn--tertiary" onClick={() => set('barcode', nextInternalEan(existing.map((p) => p.barcode)))}>{t('scan.makeCode')}</button>}
      </Field>
      <label className="check-row body-md"><input type="checkbox" checked={f.isService} onChange={(e) => set('isService', e.target.checked)} /> {t('stock.isService')}</label>
      <Field label={t('stock.baseUnit')}><input className={input} value={f.baseUnit} onChange={(e) => set('baseUnit', e.target.value)} /></Field>
      <Field label={t('stock.basePrice')}><input className={input} inputMode="numeric" required value={f.basePrice} onChange={(e) => set('basePrice', e.target.value)} /></Field>
      {!f.isService && (
        <>
          <fieldset className="panel stack">
            <legend className="label-lg muted">{t('stock.bigUnit')}</legend>
            <Field label={t('stock.bigUnitName')}><input className={input} value={f.bigName} onChange={(e) => set('bigName', e.target.value)} /></Field>
            <Field label={t('stock.bigUnitFactor')}><input className={input} inputMode="numeric" value={f.bigFactor} onChange={(e) => set('bigFactor', e.target.value)} /></Field>
            <Field label={t('stock.bigUnitPrice')}><input className={input} inputMode="numeric" value={f.bigPrice} onChange={(e) => set('bigPrice', e.target.value)} /></Field>
          </fieldset>
          <Field label={t('stock.minStock')}><input className={input} inputMode="numeric" value={f.minStock} onChange={(e) => set('minStock', e.target.value)} /></Field>
          <Field label={t('stock.openingQty')}><input className={input} inputMode="numeric" value={f.openingQty} onChange={(e) => set('openingQty', e.target.value)} /></Field>
          <Field label={t('stock.openingCost')}><input className={input} inputMode="numeric" value={f.openingCost} onChange={(e) => set('openingCost', e.target.value)} /></Field>
          <label className="check-row body-md"><input type="checkbox" checked={f.trackExpiry} onChange={(e) => set('trackExpiry', e.target.checked)} /> {t('expiry.track')}</label>
          {f.trackExpiry && num(f.openingQty) > 0 && <Field label={t('expiry.openingDate')}><input type="date" className={input} value={f.openingExpiry} onChange={(e) => set('openingExpiry', e.target.value)} /></Field>}
        </>
      )}
      <Field label={t('stock.taxPercent')}><input className={input} inputMode="decimal" value={f.tax} onChange={(e) => set('tax', e.target.value)} /></Field>
      {error && <p role="alert" className="field__error">{error}</p>}
      <div className="flex gap-3">
        <button type="button" onClick={onDone} className="btn btn--secondary flex-1">{t('stock.cancel')}</button>
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
  const [editing, setEditing] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [unitId, setUnitId] = useState('')
  const [qty, setQty] = useState('')
  const [totalCost, setTotalCost] = useState('')
  const [reason, setReason] = useState('')
  const [expiry, setExpiry] = useState('')
  const [type, setType] = useState<RemovalType>('damaged')

  const onHand = cost?.quantity ?? 0
  const unit: UnitRec | undefined = units.find((u) => u.id === unitId) ?? units.find((u) => u.isBase)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setMsg(null)
    try {
      if (mode === 'receive') {
        if (!unit) return
        await receiveStock(ctx, product.id, unit, num(qty), Math.round(num(totalCost)), product.trackExpiry && expiry ? expiry : undefined)
      } else if (mode === 'remove') {
        await removeStock(ctx, product.id, Math.round(num(qty)), type, reason)
      }
      setMsg(t('stock.done'))
      setMode(null)
      setQty(''); setTotalCost(''); setReason(''); setExpiry('')
    } catch (err) {
      setMsg(t('stock.error', { msg: (err as Error).message }))
    }
  }

  const parts = breakdown(Math.max(onHand, 0), units.map((u) => ({ id: u.id, name: u.name, factor: u.factor, price: u.sellPrice })))
  const canReceive = can(ctx.role, 'stock.receive')
  const canRemove = can(ctx.role, 'stock.adjust_approve')

  return (
    <div className="stack">
      <button onClick={onBack} className="btn btn--tertiary" style={{ alignSelf: 'flex-start' }}>{t('stock.back')}</button>
      <h3 className="h4">{product.name}{!product.active && <span className="tag" style={{ marginLeft: 8 }}>{t('edit.hidden')}</span>}</h3>
      <p className="body-md">
        {t('stock.onHand')}: <strong>{onHand <= product.minStock ? '! ' : ''}{onHand} {product.baseUnit}</strong>
        {parts.length > 1 && <span className="muted"> ({parts.map((p) => `${p.count} ${p.unit.name}`).join(' + ')})</span>}
      </p>
      <ul className="body-sm muted stack" style={{ gap: 4 }}>
        {units.map((u) => <li key={u.id}>{u.name}{u.factor > 1 ? ` (${u.factor})` : ''}: {formatXaf(u.sellPrice)}</li>)}
      </ul>
      {can(ctx.role, 'products.write') && !mode && (
        <button onClick={() => setEditing((x) => !x)} aria-expanded={editing} className="btn btn--secondary" style={{ alignSelf: 'flex-start' }}>{editing ? t('edit.close') : t('edit.open')}</button>
      )}
      {editing && <EditProduct ctx={ctx} product={product} onDone={() => setEditing(false)} />}
      {!product.isService && !editing && !mode && <ProductSuppliers productId={product.id} />}
      {!product.isService && !mode && !editing && (
        <div className="flex gap-3">
          <button disabled={!canReceive} onClick={() => setMode('receive')} className={`${btn} flex-1`}>{t('stock.receive')}</button>
          <button disabled={!canRemove} onClick={() => setMode('remove')} className="btn btn--secondary flex-1">{t('stock.remove')}</button>
        </div>
      )}
      {!canReceive && !canRemove && <p className="body-sm muted">{t('stock.noPermission')}</p>}
      {mode && (
        <form onSubmit={submit} className="panel stack">
          {mode === 'receive' ? (
            <>
              <Field label={t('stock.unit')}>
                <select className={input} value={unit?.id ?? ''} onChange={(e) => setUnitId(e.target.value)}>
                  {units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
              </Field>
              <Field label={t('stock.quantity')}><input className={input} inputMode="decimal" required value={qty} onChange={(e) => setQty(e.target.value)} /></Field>
              <Field label={t('stock.totalCost')}><input className={input} inputMode="numeric" required value={totalCost} onChange={(e) => setTotalCost(e.target.value)} /></Field>
              {product.trackExpiry && <Field label={t('expiry.dateOfGoods')}><input type="date" className={input} value={expiry} onChange={(e) => setExpiry(e.target.value)} /></Field>}
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
            <button type="button" onClick={() => setMode(null)} className="btn btn--secondary flex-1">{t('stock.cancel')}</button>
            <button className={`${btn} flex-1`}>{t('stock.save')}</button>
          </div>
        </form>
      )}
      {msg && <p role="status" className="label-lg">{msg}</p>}
    </div>
  )
}

/* -------------------------------- screen --------------------------------- */

export function StockScreen() {
  const { t } = useTranslation()
  const ctx = useCtx()
  const [search, setSearch] = useState('')
  const [view, setView] = useState<'list' | 'new' | string>('list')
  const [showHidden, setShowHidden] = useState(false)
  const expiry = useExpiry()

  const rows = useLiveQuery(async () => {
    if (!ctx) return []
    const ps = await db.products.orderBy('name').toArray()
    const cs = new Map((await db.costs.where('shopId').equals(ctx.shopId).toArray()).map((c) => [c.productId, c.quantity]))
    return ps.map((p) => ({ p, onHand: cs.get(p.id) ?? 0 }))
  }, [ctx?.shopId])

  if (!ctx) return null
  const detail = view !== 'list' && view !== 'new' ? rows?.find((r) => r.p.id === view)?.p : undefined

  if (view === 'expiry') return <ExpiryView ctx={ctx} onBack={() => setView('list')} />
  if (view === 'import') return <ImportView ctx={ctx} onBack={() => setView('list')} />
  if (view === 'labels') return <LabelsView ctx={ctx} onBack={() => setView('list')} />
  if (view === 'new') return <ProductForm ctx={ctx} onDone={() => setView('list')} />
  if (detail) return <ProductDetail ctx={ctx} product={detail} onBack={() => setView('list')} />

  const q = search.trim().toLowerCase()
  const hiddenCount = (rows ?? []).filter(({ p }) => !p.active).length
  const shown = (rows ?? []).filter(({ p }) => (showHidden || p.active) && (!q || p.name.toLowerCase().includes(q) || p.barcode?.toLowerCase().includes(q) || (p.barcode ? sameBarcode(p.barcode, search) : false)))
  const canWrite = can(ctx.role, 'products.write')

  return (
    <div className="stack">
      <div className="flex gap-3" style={{ flexWrap: 'wrap' }}>
        <input className={input} style={{ flex: 1, minWidth: 160 }} placeholder={t('stock.search')} value={search} onChange={(e) => setSearch(e.target.value)} />
        <ScanButton onCode={(c) => { setSearch(c) }} />
        {canWrite && <button onClick={() => setView('import')} className="btn btn--secondary">{t('import.open')}</button>}
        {expiry && (expiry.rows.length > 0 || expiry.warnDays > 0) && <button onClick={() => setView('expiry')} className="btn btn--secondary" style={{ position: 'relative' }}>{t('expiry.open')}{expiry.rows.length > 0 && <span className="pos-tabbar__badge" style={{ top: -6, right: -6 }}>{expiry.rows.length}</span>}</button>}
        <button onClick={() => setView('labels')} className="btn btn--secondary">{t('labels.open')}</button>
        {canWrite && <button onClick={() => setView('new')} className={btn}>+ {t('stock.newProduct')}</button>}
      </div>
      {hiddenCount > 0 && <label className="check-row body-md"><input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} /> {t('edit.showHidden', { n: hiddenCount })}</label>}
      {shown.length === 0 && <p className="body-md muted">{t('stock.none')}</p>}
      <ul className="list-wrap">
        {shown.map(({ p, onHand }) => (
          <li key={p.id} style={{ padding: 0 }}>
            <button onClick={() => setView(p.id)} className="flex w-full items-center justify-between text-left" style={{ padding: '15px 20px' }}>
              <span>{p.name}</span>
              {p.isService ? <span className="label-lg muted">service</span> : (
                <span className={onHand <= p.minStock ? 'label-lg' : 'body-md'}>
                  {onHand <= p.minStock ? '! ' : ''}{onHand} {p.baseUnit}{onHand <= p.minStock ? ` · ${t('stock.low')}` : ''}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
