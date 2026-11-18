import { useLiveQuery } from 'dexie-react-hooks'
import { useMemo, useState, type ChangeEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { db } from '../../data/db'
import { importCatalogueForSuppliers } from './quotes'
import { applySupplierImport, setSupplierPrice, type SupplierImportResult } from '../../data/supplierPricesRepo'
import type { Ctx } from '../../data/repo'
import { decodeFile, parseCsv } from '../../domain/csvParse'
import { downloadText } from '../../domain/csv'
import { formatXaf } from '../../domain/money'
import { can } from '../../domain/permissions'
import { planSupplierImport, type SupplierPlan } from '../../domain/supplierPriceImport'
import { changeBp, currentQuotes, isStale, lastPaid, perBaseUnit, quoteHistory } from '../../domain/supplierPrices'

const input = 'min-h-12 w-full rounded border border-slate-300 bg-transparent px-3'
const btn = 'min-h-12 rounded bg-teal-700 px-4 font-semibold text-white disabled:opacity-60'
const btn2 = 'min-h-12 rounded border border-slate-300 px-4'

/** A supplier's price list: what they quote, what we really paid last time, how it moved. Quotes can be typed or imported from a file. */
export function SupplierPriceList({ ctx, supplierId }: { ctx: Ctx; supplierId: string }) {
  const { t, i18n } = useTranslation()
  const allowed = can(ctx.role, 'purchases.manage')
  const data = useLiveQuery(async () => {
    const [prices, products, units, purchases, receipts, receiptLines] = await Promise.all([
      db.supplierPrices.where('supplierId').equals(supplierId).toArray(), db.products.toArray(), db.units.toArray(), db.purchases.toArray(), db.receipts.toArray(), db.receiptLines.toArray(),
    ])
    return { prices, products, units, paid: lastPaid(purchases, receipts, receiptLines) }
  }, [supplierId])
  const [productId, setProductId] = useState('')
  const [unitId, setUnitId] = useState('')
  const [price, setPrice] = useState('')
  const [edit, setEdit] = useState<Record<string, string>>({})
  const [open, setOpen] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  // import
  const [plan, setPlan] = useState<SupplierPlan | null>(null)
  const [fileName, setFileName] = useState('')
  const [includeFlagged, setIncludeFlagged] = useState(false)
  const [result, setResult] = useState<SupplierImportResult | null>(null)

  const quotes = useMemo(() => currentQuotes(data?.prices ?? []), [data])
  if (!data) return null
  const { products, units, paid } = data
  const productName = new Map(products.map((p) => [p.id, p.name]))
  const unitOf = new Map(units.map((u) => [u.id, u]))
  const rows = [...quotes.values()].sort((a, b) => (productName.get(a.productId) ?? '').localeCompare(productName.get(b.productId) ?? '') || (unitOf.get(a.unitId)?.factor ?? 0) - (unitOf.get(b.unitId)?.factor ?? 0))
  const chosenUnits = units.filter((u) => u.productId === productId)

  const run = async (fn: () => Promise<unknown>) => {
    setMsg(null)
    try { await fn(); setMsg(t('sprice.saved')) } catch (e) { setMsg(t('purch.error', { msg: (e as Error).message })) }
  }

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    setResult(null); setIncludeFlagged(false); setMsg(null)
    try {
      if (f.size > 5_000_000) throw new Error(t('import.tooBig'))
      const known = await importCatalogueForSuppliers()
      setPlan(planSupplierImport(parseCsv(decodeFile(await f.arrayBuffer())), known, (p, u) => quotes.get(`${supplierId}|${p}|${u}`)?.price ?? null))
      setFileName(f.name)
    } catch (err) {
      setMsg((err as Error).message)
    }
  }

  return (
    <section className="flex flex-col gap-3 rounded border border-slate-200 p-3 dark:border-slate-700">
      <h4 className="font-semibold">{t('sprice.title')}</h4>
      <p className="text-xs text-slate-500">{t('sprice.hint')}</p>

      {rows.length === 0 && <p className="text-sm text-slate-500">{t('sprice.none')}</p>}
      <ul className="flex flex-col gap-2">
        {rows.map((q) => {
          const u = unitOf.get(q.unitId)
          const hist = quoteHistory(data.prices, q)
          const prev = hist[1]?.price ?? null
          const move = changeBp(prev, q.price)
          const p = paid.get(`${supplierId}|${q.productId}`)
          const k = `${q.productId}|${q.unitId}`
          return (
            <li key={k} className="rounded border border-slate-200 p-2 text-sm dark:border-slate-700">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="font-medium">{productName.get(q.productId) ?? '—'} <span className="text-slate-500">({u?.name})</span></div>
                  <div className="text-xs text-slate-500">
                    {u && u.factor > 1 && `${formatXaf(perBaseUnit(q.price, u.factor))} / ${t('sprice.base')} · `}
                    {p && `${t('sprice.lastPaid', { cost: formatXaf(p.baseCost), date: new Date(p.at).toLocaleDateString(i18n.language) })} · `}
                    {isStale(q.recordedAt, new Date()) ? <span className="text-amber-700">{t('sprice.stale')}</span> : new Date(q.recordedAt).toLocaleDateString(i18n.language)}
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-semibold tabular-nums">{formatXaf(q.price)}</div>
                  {move !== null && move !== 0 && <div className={`text-xs ${move > 0 ? 'text-red-700' : 'text-teal-700'}`}>{move > 0 ? '▲' : '▼'} {Math.abs(move / 100).toFixed(1)} %</div>}
                </div>
              </div>
              {allowed && (
                <div className="mt-2 flex gap-2">
                  <input aria-label={t('sprice.newPrice')} inputMode="numeric" className={`${input} !min-h-10 w-28 text-right`} placeholder={t('sprice.newPrice')} value={edit[k] ?? ''} onChange={(e) => setEdit({ ...edit, [k]: e.target.value.replace(/\D/g, '') })} />
                  <button className={`${btn2} !min-h-10`} disabled={!edit[k]} onClick={() => void run(async () => { await setSupplierPrice(ctx, { supplierId, productId: q.productId, unitId: q.unitId, price: Number(edit[k]) }); setEdit({ ...edit, [k]: '' }) })}>{t('sprice.update')}</button>
                  {hist.length > 1 && <button className="text-xs text-teal-700 underline" onClick={() => setOpen(open === k ? null : k)}>{t('sprice.history')}</button>}
                </div>
              )}
              {open === k && <ul className="mt-1 text-xs text-slate-600 dark:text-slate-300">{hist.map((h) => <li key={h.id}>{new Date(h.recordedAt).toLocaleDateString(i18n.language)} · {formatXaf(h.price)}{h.source === 'import' ? ` · ${t('sprice.imported')}` : ''}</li>)}</ul>}
            </li>
          )
        })}
      </ul>

      {allowed && (
        <>
          <form
            onSubmit={(e) => { e.preventDefault(); void run(async () => { await setSupplierPrice(ctx, { supplierId, productId, unitId: unitId || chosenUnits.find((u) => u.isBase)!.id, price: Number(price) }); setPrice('') }) }}
            className="flex flex-col gap-2 border-t border-slate-200 pt-3 dark:border-slate-700"
          >
            <h5 className="text-sm font-medium">{t('sprice.add')}</h5>
            <select className={input} value={productId} onChange={(e) => { setProductId(e.target.value); setUnitId('') }} aria-label={t('purch.product')} required>
              <option value="">{t('purch.product')}</option>
              {products.filter((p) => p.active && !p.isService).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            {productId && (
              <select className={input} value={unitId || chosenUnits.find((u) => u.isBase)?.id} onChange={(e) => setUnitId(e.target.value)} aria-label={t('purch.unit')}>
                {chosenUnits.map((u) => <option key={u.id} value={u.id}>{u.name}{u.factor > 1 ? ` (${u.factor})` : ''}</option>)}
              </select>
            )}
            <div className="flex gap-2">
              <input className={input} inputMode="numeric" placeholder={t('sprice.priceHere')} aria-label={t('sprice.priceHere')} value={price} onChange={(e) => setPrice(e.target.value.replace(/\D/g, ''))} required />
              <button className={btn} disabled={!productId || !price}>{t('purch.save')}</button>
            </div>
          </form>

          <div className="flex flex-col gap-2 border-t border-slate-200 pt-3 dark:border-slate-700">
            <h5 className="text-sm font-medium">{t('sprice.import')}</h5>
            <p className="text-xs text-slate-500">{t('sprice.importHint')}</p>
            <div className="flex gap-2">
              <button className={btn2} onClick={() => downloadText('stockcm-supplier-prices-template.csv', '﻿name;barcode;unit;price\r\nEau 1.5L;5449000000996;carton;7000\r\n')}>{t('importStock.template')}</button>
              <label className={`${btn} flex cursor-pointer items-center`}>{t('import.choose')}<input type="file" accept=".csv,.txt,text/csv" className="sr-only" onChange={(e) => void onFile(e)} /></label>
            </div>
            {plan?.fatal && <p role="alert" className="rounded bg-red-50 p-2 text-sm text-red-800">{t(`import.fatal.${plan.fatal}`)}</p>}
            {plan && !plan.fatal && !result && (
              <div className="flex flex-col gap-2">
                <p className="text-sm"><strong>{fileName}</strong> — {t('sprice.summary', { newQuotes: plan.counts.newQuotes, changed: plan.counts.changed, unchanged: plan.counts.unchanged, error: plan.counts.error })}</p>
                {plan.counts.flagged > 0 && <label className="flex items-start gap-2 rounded bg-amber-50 p-2 text-sm text-amber-900"><input type="checkbox" className="mt-1" checked={includeFlagged} onChange={(e) => setIncludeFlagged(e.target.checked)} /> {t('sprice.flagged', { n: plan.counts.flagged })}</label>}
                <ul className="flex flex-col gap-1 text-sm">
                  {plan.rows.filter((r) => r.kind !== 'unchanged').slice(0, 200).map((r) => (
                    <li key={r.line} className={`rounded border p-2 ${r.kind === 'error' ? 'border-red-300 bg-red-50' : r.kind === 'set' && r.flagged ? 'border-amber-300 bg-amber-50' : 'border-slate-200'}`}>
                      <span className="text-xs text-slate-500">{t('import.line', { n: r.line })} · </span>
                      {r.kind === 'error' && <><strong>{r.name || '—'}</strong>: <span className="text-red-800">{t(`sprice.problem.${r.problem}`)}</span></>}
                      {r.kind === 'set' && <><strong>{r.name}</strong> ({r.unitName}) — {r.oldPrice === null ? t('sprice.new') : formatXaf(r.oldPrice)} → {formatXaf(r.newPrice)}{r.changeBp !== null && ` (${r.changeBp > 0 ? '+' : ''}${(r.changeBp / 100).toFixed(1)} %)`}</>}
                    </li>
                  ))}
                </ul>
                <div className="flex gap-2">
                  <button className={`${btn} flex-1`} disabled={plan.counts.set - (includeFlagged ? 0 : plan.counts.flagged) === 0}
                    onClick={() => void run(async () => { setResult(await applySupplierImport(ctx, supplierId, plan, { includeFlagged })); setPlan(null) })}>
                    {t('sprice.apply', { n: plan.counts.set - (includeFlagged ? 0 : plan.counts.flagged) })}
                  </button>
                  <button className={btn2} onClick={() => setPlan(null)}>{t('shops.cancel')}</button>
                </div>
              </div>
            )}
            {result && (
              <div className="text-sm"><p role="status" className="font-semibold text-teal-700">{t('sprice.done', { n: result.saved })}</p>
                {result.skipped > 0 && <p className="text-amber-800">{t('sprice.skipped', { n: result.skipped })}</p>}
                {result.failed.map((f) => <p key={f.line} className="text-red-800">{t('import.line', { n: f.line })} · {f.name}: {f.message}</p>)}
              </div>
            )}
          </div>
        </>
      )}
      {msg && <p role="status" className="text-sm">{msg}</p>}
    </section>
  )
}
