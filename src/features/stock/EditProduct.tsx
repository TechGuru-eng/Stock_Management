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

const input = 'min-h-12 w-full rounded border border-slate-300 bg-transparent px-3'
const btn = 'min-h-12 rounded bg-teal-700 px-4 font-semibold text-white disabled:opacity-60'
const btn2 = 'min-h-12 rounded border border-slate-300 px-4'

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="text-xs text-slate-500">{hint}</span>}
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
    tax: bpToPercent(product.taxRateBp), active: product.active,
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
        minStock: Number(f.minStock), taxRateBp: bp, active: f.active,
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
    <form onSubmit={save} className="flex flex-col gap-3 rounded border border-slate-200 p-3 dark:border-slate-700">
      <h4 className="font-semibold">{t('edit.title')}</h4>
      <Field label={t('stock.name')}><input className={input} required maxLength={120} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>

      <Field label={t('stock.barcode')}>
        <div className="flex gap-2">
          <input className={input} value={f.barcode} onChange={(e) => setF({ ...f, barcode: e.target.value })} />
          <ScanButton onCode={(c) => { setF((x) => ({ ...x, barcode: c })) }} />
        </div>
        {clash && <span role="status" className="text-sm text-red-700">{t('scan.alreadyUsed', { name: clash.name })}</span>}
        {!clash && info?.checksumOk === false && <span role="status" className="text-sm text-red-700">{t('scan.badChecksum')}</span>}
        {!f.barcode.trim() && <button type="button" className="self-start text-sm text-teal-700 underline" onClick={() => setF({ ...f, barcode: nextInternalEan(all.map((p) => p.barcode)) })}>{t('scan.makeCode')}</button>}
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label={t('edit.sku')}><input className={input} maxLength={40} value={f.sku} onChange={(e) => setF({ ...f, sku: e.target.value })} /></Field>
        <Field label={t('stock.minStock')}><input className={input} inputMode="numeric" value={f.minStock} onChange={(e) => setF({ ...f, minStock: e.target.value.replace(/\D/g, '') })} /></Field>
      </div>
      <Field label={t('edit.tax')} hint={t('edit.taxHint')}><input className={input} inputMode="decimal" value={f.tax} onChange={(e) => setF({ ...f, tax: e.target.value })} /></Field>

      <fieldset className="flex flex-col gap-2 rounded border border-slate-200 p-3 dark:border-slate-700">
        <legend className="px-1 text-sm font-medium">{t('edit.units')}</legend>
        <p className="text-xs text-slate-500">{t('edit.unitsHint')}</p>
        {[...units].sort((a, b) => a.factor - b.factor).map((u) => (
          <div key={u.id} className="grid grid-cols-[1fr_6rem_auto] items-end gap-2">
            <Field label={u.isBase ? t('edit.baseUnit') : t('edit.unitName')}>
              <input className={input} value={prices[u.id]?.name ?? ''} maxLength={40} onChange={(e) => setPrices({ ...prices, [u.id]: { ...(prices[u.id] ?? { price: '' }), name: e.target.value } })} />
            </Field>
            <Field label={t('edit.price')}>
              <input className={`${input} text-right`} inputMode="numeric" value={prices[u.id]?.price ?? ''} onChange={(e) => setPrices({ ...prices, [u.id]: { ...(prices[u.id] ?? { name: '' }), price: e.target.value.replace(/\D/g, '') } })} />
            </Field>
            <span className="pb-3 text-xs text-slate-500">{u.factor > 1 ? `= ${u.factor}` : ''}</span>
          </div>
        ))}
        <div className="grid grid-cols-3 gap-2 border-t border-slate-200 pt-2 dark:border-slate-700">
          <Field label={t('edit.newUnit')}><input className={input} placeholder="carton" value={newUnit.name} onChange={(e) => setNewUnit({ ...newUnit, name: e.target.value })} /></Field>
          <Field label={t('edit.factor', { unit: product.baseUnit })}><input className={input} inputMode="numeric" value={newUnit.factor} onChange={(e) => setNewUnit({ ...newUnit, factor: e.target.value.replace(/\D/g, '') })} /></Field>
          <Field label={t('edit.price')}><input className={`${input} text-right`} inputMode="numeric" value={newUnit.price} onChange={(e) => setNewUnit({ ...newUnit, price: e.target.value.replace(/\D/g, '') })} /></Field>
        </div>
      </fieldset>

      <label className="flex min-h-10 items-center gap-2"><input type="checkbox" checked={!f.active} onChange={(e) => setF({ ...f, active: !e.target.checked })} /> {t('edit.hide')}</label>
      <p className="text-xs text-slate-500">{t('edit.fixed', { unit: product.baseUnit, kind: product.isService ? t('edit.service') : t('edit.goods') })}</p>

      {msg && <p role="status" className={`text-sm ${msg.ok ? 'text-teal-700' : 'text-red-700'}`}>{msg.text}</p>}
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
    <section className="border-t border-slate-200 pt-2 text-sm dark:border-slate-700">
      <h5 className="font-medium">{t('edit.history')}</h5>
      <ul className="mt-1 space-y-1 text-xs text-slate-600 dark:text-slate-300">
        {rows.map((r) => (
          <li key={r.id}>{new Date(r.at).toLocaleString(i18n.language)} — {Object.entries(r.changes).map(([k, v]) => `${k}: ${r.before && k in r.before ? `${String(r.before[k] ?? '∅')} → ` : ''}${String(v ?? '∅')}`).join(', ')}</li>
        ))}
      </ul>
    </section>
  )
}
