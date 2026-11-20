import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { db, type ProductRec } from '../../data/db'
import { addUnit, EditError, updateProduct, updateUnit } from '../../data/productsRepo'
import type { Ctx } from '../../data/repo'
import { describeBarcode, findByBarcode, nextInternalEan } from '../../domain/barcode'
import { bpToPercent, percentToBp } from '../../domain/productEdit'
import { supabase } from '../../lib/supabase'
import { ScanButton } from '../../scanner/ScanButton'

const input = 'input'
const btn = 'btn btn--primary'
const btn2 = 'btn btn--secondary'

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <span className="field__hint">{hint}</span>}
    </label>
  )
}

/** Edit a product's details and prices. What is fixed (base unit, unit sizes, service or not) is shown but cannot be changed. */
export function EditProduct({ ctx, product, onDone }: { ctx: Ctx; product: ProductRec; onDone: () => void }) {
  const { t } = useTranslation()
  const units = useLiveQuery(() => db.units.where('productId').equals(product.id).toArray(), [product.id]) ?? []
  const all = useLiveQuery(() => db.products.toArray(), []) ?? []
  const [f, setF] = useState({
    name: product.name, barcode: product.barcode ?? '', sku: product.sku ?? '', minStock: String(product.minStock),
    tax: bpToPercent(product.taxRateBp), active: product.active, trackExpiry: Boolean(product.trackExpiry),
  })
  const [prices, setPrices] = useState<Record<string, { name: string; price: string }>>({})
  const [newUnit, setNewUnit] = useState({ name: '', factor: '', price: '' })
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    setPrices(Object.fromEntries(units.map((u) => [u.id, { name: u.name, price: String(u.sellPrice) }])))
  }, [units])

  const clash = f.barcode.trim() ? findByBarcode(all.filter((p) => p.id !== product.id), f.barcode) : undefined
  const info = f.barcode.trim() ? describeBarcode(f.barcode) : null

  async function save(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setMsg(null)
    try {
      const bp = percentToBp(f.tax)
      if (bp === null) throw new EditError(t('edit.badTax'))
      let changed = await updateProduct(ctx, product.id, {
        name: f.name, barcode: f.barcode.trim() === '' ? null : f.barcode, sku: f.sku.trim() === '' ? null : f.sku,
        minStock: Number(f.minStock), taxRateBp: bp, active: f.active, trackExpiry: product.isService ? false : f.trackExpiry,
      })
      for (const u of units) {
        const p = prices[u.id]
        if (p && (await updateUnit(ctx, u.id, { name: p.name, sellPrice: Number(p.price) }))) changed = true
      }
      if (newUnit.name.trim() || newUnit.factor || newUnit.price) {
        await addUnit(ctx, product.id, { name: newUnit.name, factor: Number(newUnit.factor), sellPrice: Number(newUnit.price) })
        setNewUnit({ name: '', factor: '', price: '' })
        changed = true
      }
      setMsg({ ok: true, text: changed ? t('edit.saved') : t('edit.nothing') })
    } catch (err) {
      setMsg({ ok: false, text: t('edit.error', { msg: (err as Error).message }) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={save} className="panel stack">
      <h4 className="h6">{t('edit.title')}</h4>
      <Field label={t('stock.name')}><input className={input} required maxLength={120} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>

      <Field label={t('stock.barcode')}>
        <div className="flex gap-2">
          <input className={input} value={f.barcode} onChange={(e) => setF({ ...f, barcode: e.target.value })} />
          <ScanButton onCode={(c) => { setF((x) => ({ ...x, barcode: c })) }} />
        </div>
        {clash && <span role="status" className="field__error">{t('scan.alreadyUsed', { name: clash.name })}</span>}
        {!clash && info?.checksumOk === false && <span role="status" className="field__error">{t('scan.badChecksum')}</span>}
        {!f.barcode.trim() && <button type="button" className="btn btn--tertiary" onClick={() => setF({ ...f, barcode: nextInternalEan(all.map((p) => p.barcode)) })}>{t('scan.makeCode')}</button>}
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label={t('edit.sku')}><input className={input} maxLength={40} value={f.sku} onChange={(e) => setF({ ...f, sku: e.target.value })} /></Field>
        <Field label={t('stock.minStock')}><input className={input} inputMode="numeric" value={f.minStock} onChange={(e) => setF({ ...f, minStock: e.target.value.replace(/\D/g, '') })} /></Field>
      </div>
      <Field label={t('edit.tax')} hint={t('edit.taxHint')}><input className={input} inputMode="decimal" value={f.tax} onChange={(e) => setF({ ...f, tax: e.target.value })} /></Field>

      <fieldset className="panel stack" style={{ gap: 10 }}>
        <legend className="label-lg muted">{t('edit.units')}</legend>
        <p className="body-sm muted">{t('edit.unitsHint')}</p>
        {[...units].sort((a, b) => a.factor - b.factor).map((u) => (
          <div key={u.id} className="grid grid-cols-[1fr_6rem_auto] items-end gap-2">
            <Field label={u.isBase ? t('edit.baseUnit') : t('edit.unitName')}>
              <input className={input} value={prices[u.id]?.name ?? ''} maxLength={40} onChange={(e) => setPrices({ ...prices, [u.id]: { ...(prices[u.id] ?? { price: '' }), name: e.target.value } })} />
            </Field>
            <Field label={t('edit.price')}>
              <input className={`${input} text-right`} inputMode="numeric" value={prices[u.id]?.price ?? ''} onChange={(e) => setPrices({ ...prices, [u.id]: { ...(prices[u.id] ?? { name: '' }), price: e.target.value.replace(/\D/g, '') } })} />
            </Field>
            <span className="label-lg muted" style={{ paddingBottom: 12 }}>{u.factor > 1 ? `= ${u.factor}` : ''}</span>
          </div>
        ))}
        <div className="grid grid-cols-3 gap-2" style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 10 }}>
          <Field label={t('edit.newUnit')}><input className={input} placeholder="carton" value={newUnit.name} onChange={(e) => setNewUnit({ ...newUnit, name: e.target.value })} /></Field>
          <Field label={t('edit.factor', { unit: product.baseUnit })}><input className={input} inputMode="numeric" value={newUnit.factor} onChange={(e) => setNewUnit({ ...newUnit, factor: e.target.value.replace(/\D/g, '') })} /></Field>
          <Field label={t('edit.price')}><input className={`${input} text-right`} inputMode="numeric" value={newUnit.price} onChange={(e) => setNewUnit({ ...newUnit, price: e.target.value.replace(/\D/g, '') })} /></Field>
        </div>
      </fieldset>

      {!product.isService && <label className="check-row body-md"><input type="checkbox" checked={f.trackExpiry} onChange={(e) => setF({ ...f, trackExpiry: e.target.checked })} /> {t('expiry.track')}</label>}
      <label className="check-row body-md"><input type="checkbox" checked={!f.active} onChange={(e) => setF({ ...f, active: !e.target.checked })} /> {t('edit.hide')}</label>
      <p className="body-sm muted">{t('edit.fixed', { unit: product.baseUnit, kind: product.isService ? t('edit.service') : t('edit.goods') })}</p>

      {msg && <p role="status" className={msg.ok ? 'label-lg' : 'field__error'}>{msg.text}</p>}
      <div className="flex gap-3">
        <button type="button" onClick={onDone} className={`${btn2} flex-1`}>{t('edit.close')}</button>
        <button className={`${btn} flex-1`} disabled={busy}>{t('stock.save')}</button>
      </div>
      <History productId={product.id} />
    </form>
  )
}

interface Change { id: string; at: string; changes: Record<string, unknown>; before: Record<string, unknown> | null }

/** Who changed what and when. The log lives on the server, so it needs a connection. */
function History({ productId }: { productId: string }) {
  const { t, i18n } = useTranslation()
  const [rows, setRows] = useState<Change[] | null>(null)
  useEffect(() => {
    if (!supabase || !navigator.onLine) return
    void supabase.from('product_changes').select('id, at, changes, before').eq('product_id', productId).order('at', { ascending: false }).limit(10)
      .then(({ data }) => setRows((data as Change[] | null) ?? []))
  }, [productId])
  if (!rows || rows.length === 0) return null
  return (
    <section style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 10 }}>
      <h5 className="h6">{t('edit.history')}</h5>
      <ul className="body-sm muted stack" style={{ gap: 4, marginTop: 4 }}>
        {rows.map((r) => (
          <li key={r.id}>{new Date(r.at).toLocaleString(i18n.language)} — {Object.entries(r.changes).map(([k, v]) => `${k}: ${r.before && k in r.before ? `${String(r.before[k] ?? '∅')} → ` : ''}${String(v ?? '∅')}`).join(', ')}</li>
        ))}
      </ul>
    </section>
  )
}
