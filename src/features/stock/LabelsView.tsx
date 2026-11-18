import { useLiveQuery } from 'dexie-react-hooks'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { db } from '../../data/db'
import { assignBarcode, type Ctx } from '../../data/repo'
import { nextInternalEan } from '../../domain/barcode'
import { SHEETS, clampCopies, expandLabels, labelsPerPage, layoutPages, sheetById } from '../../domain/labels'
import { can } from '../../domain/permissions'
import { renderLabelsPdf } from '../../pdf/labelsPdf'
import { downloadPdf, sharePdf } from '../../pdf/invoicePdf'

const input = 'min-h-12 rounded border border-slate-300 bg-transparent px-3'
const btn = 'min-h-12 rounded bg-teal-700 px-4 font-semibold text-white disabled:opacity-60'
const btn2 = 'min-h-12 rounded border border-slate-300 px-4 disabled:opacity-60'

/** Stock > Labels: choose products and copies, pick the sticker sheet, get a PDF of barcode labels (with the price if wanted). */
export function LabelsView({ ctx, onBack }: { ctx: Ctx; onBack: () => void }) {
  const { t } = useTranslation()
  const [copies, setCopies] = useState<Record<string, string>>({})
  const [sheetId, setSheetId] = useState('a4-21')
  const [start, setStart] = useState('1')
  const [withPrice, setWithPrice] = useState(true)
  const [guides, setGuides] = useState(false)
  const [q, setQ] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const data = useLiveQuery(async () => {
    const products = (await db.products.toArray()).filter((p) => p.active && !p.isService).sort((a, b) => a.name.localeCompare(b.name))
    const units = await db.units.toArray()
    const price = new Map(units.filter((u) => u.isBase).map((u) => [u.productId, u.sellPrice]))
    return { products, price }
  }, []) ?? { products: [], price: new Map<string, number>() }

  const sheet = sheetById(sheetId)
  const requests = Object.entries(copies).map(([productId, n]) => ({ productId, copies: clampCopies(Number(n)) })).filter((r) => r.copies > 0)
  const info = useMemo(() => new Map(data.products.map((p) => [p.id, { name: p.name, barcode: p.barcode, price: data.price.get(p.id) ?? null }])), [data])
  const plan = expandLabels(requests, info, withPrice)
  const startCell = Math.min(Math.max(Math.floor(Number(start) || 1), 1), labelsPerPage(sheet)) - 1
  const pageCount = layoutPages(sheet, plan.items.length, startCell).length
  const canWrite = can(ctx.role, 'products.write')
  const needle = q.trim().toLowerCase()
  const shown = data.products.filter((p) => !needle || p.name.toLowerCase().includes(needle) || (p.barcode ?? '').includes(needle))
  const missing = requests.filter((r) => !info.get(r.productId)?.barcode)

  async function makeCodes() {
    setMsg(null)
    try {
      const used = data.products.map((p) => p.barcode)
      for (const r of missing) {
        const code = nextInternalEan(used)
        used.push(code)
        await assignBarcode(ctx, r.productId, code)
      }
      setMsg(t('labels.codesMade', { n: missing.length }))
    } catch (e) {
      setMsg((e as Error).message)
    }
  }

  async function make(mode: 'download' | 'share') {
    setBusy(true)
    setMsg(null)
    try {
      const bytes = await renderLabelsPdf(plan.items, sheet, { startCell, guides })
      const name = `stockcm-labels-${new Date().toISOString().slice(0, 10)}.pdf`
      if (mode === 'share' && (await sharePdf(name, bytes, t('labels.title')))) return
      downloadPdf(name, bytes)
    } catch (e) {
      setMsg((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <button onClick={onBack} className="min-h-12 self-start text-teal-700 underline">{t('stock.back')}</button>
      <h3 className="text-xl font-semibold">{t('labels.title')}</h3>
      <p className="text-sm text-slate-600 dark:text-slate-300">{t('labels.hint')}</p>

      <fieldset className="grid gap-2 rounded border border-slate-200 p-3 dark:border-slate-700 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm font-medium sm:col-span-2">{t('labels.sheet')}
          <select className={input} value={sheetId} onChange={(e) => { setSheetId(e.target.value); setStart('1') }}>
            {SHEETS.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        {labelsPerPage(sheet) > 1 && (
          <label className="flex flex-col gap-1 text-sm font-medium">{t('labels.startAt', { max: labelsPerPage(sheet) })}
            <input className={input} inputMode="numeric" value={start} onChange={(e) => setStart(e.target.value.replace(/\D/g, ''))} />
          </label>
        )}
        <div className="flex flex-col justify-end gap-1 text-sm">
          <label className="flex min-h-10 items-center gap-2"><input type="checkbox" checked={withPrice} onChange={(e) => setWithPrice(e.target.checked)} /> {t('labels.price')}</label>
          <label className="flex min-h-10 items-center gap-2"><input type="checkbox" checked={guides} onChange={(e) => setGuides(e.target.checked)} /> {t('labels.guides')}</label>
        </div>
      </fieldset>

      <div className="flex gap-2">
        <input className={`${input} flex-1`} placeholder={t('stock.search')} aria-label={t('stock.search')} value={q} onChange={(e) => setQ(e.target.value)} />
        <button className={btn2} onClick={() => setCopies(Object.fromEntries(data.products.filter((p) => p.barcode).map((p) => [p.id, '1'])))}>{t('labels.allWithCode')}</button>
        <button className={btn2} onClick={() => setCopies({})}>{t('labels.clear')}</button>
      </div>

      <ul className="flex flex-col gap-2">
        {shown.map((p) => (
          <li key={p.id} className="flex items-center justify-between gap-2 rounded border border-slate-200 p-2 dark:border-slate-700">
            <div>
              <div className="font-medium">{p.name}</div>
              <div className="text-xs text-slate-500">{p.barcode ?? t('labels.noCode')}{data.price.has(p.id) ? ` · ${data.price.get(p.id)} FCFA` : ''}</div>
            </div>
            <input
              aria-label={`${p.name} — ${t('labels.copies')}`} inputMode="numeric" className={`${input} w-20 text-right`} placeholder="0" value={copies[p.id] ?? ''}
              onChange={(e) => setCopies({ ...copies, [p.id]: e.target.value.replace(/\D/g, '') })}
            />
          </li>
        ))}
      </ul>

      <section className="sticky bottom-0 flex flex-col gap-2 rounded border border-slate-300 bg-white p-3 dark:bg-slate-950">
        <p className="text-sm">{t('labels.summary', { n: plan.items.length, pages: pageCount })}{plan.truncated && ` ${t('labels.truncated')}`}</p>
        {missing.length > 0 && (
          <div className="rounded bg-amber-50 p-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">
            {t('labels.missing', { names: plan.skipped.join(', ') })}
            {canWrite && <button className="ml-2 underline" onClick={() => void makeCodes()}>{t('labels.makeCodes', { n: missing.length })}</button>}
          </div>
        )}
        {msg && <p role="status" className="text-sm">{msg}</p>}
        <div className="flex gap-2">
          <button className={`${btn} flex-1`} disabled={busy || plan.items.length === 0} onClick={() => void make('download')}>{t('labels.download')}</button>
          <button className={btn2} disabled={busy || plan.items.length === 0} onClick={() => void make('share')}>{t('invoices.share')}</button>
        </div>
      </section>
    </div>
  )
}
