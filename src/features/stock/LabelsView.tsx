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

const input = 'input'
const btn = 'btn btn--primary'
const btn2 = 'btn btn--secondary'

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
    <div className="stack">
      <button onClick={onBack} className="btn btn--tertiary" style={{ alignSelf: 'flex-start' }}>{t('stock.back')}</button>
      <h3 className="h4">{t('labels.title')}</h3>
      <p className="body-md muted">{t('labels.hint')}</p>

      <fieldset className="panel" style={{ display: 'grid', gap: 10 }}>
        <label className="field" style={{ gridColumn: '1 / -1' }}>{t('labels.sheet')}
          <select className={input} value={sheetId} onChange={(e) => { setSheetId(e.target.value); setStart('1') }}>
            {SHEETS.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        {labelsPerPage(sheet) > 1 && (
          <label className="field">{t('labels.startAt', { max: labelsPerPage(sheet) })}
            <input className={input} inputMode="numeric" value={start} onChange={(e) => setStart(e.target.value.replace(/\D/g, ''))} />
          </label>
        )}
        <div className="stack" style={{ justifyContent: 'flex-end' }}>
          <label className="check-row body-md"><input type="checkbox" checked={withPrice} onChange={(e) => setWithPrice(e.target.checked)} /> {t('labels.price')}</label>
          <label className="check-row body-md"><input type="checkbox" checked={guides} onChange={(e) => setGuides(e.target.checked)} /> {t('labels.guides')}</label>
        </div>
      </fieldset>

      <div className="flex gap-2">
        <input className={`${input} flex-1`} placeholder={t('stock.search')} aria-label={t('stock.search')} value={q} onChange={(e) => setQ(e.target.value)} />
        <button className={btn2} onClick={() => setCopies(Object.fromEntries(data.products.filter((p) => p.barcode).map((p) => [p.id, '1'])))}>{t('labels.allWithCode')}</button>
        <button className={btn2} onClick={() => setCopies({})}>{t('labels.clear')}</button>
      </div>

      <ul className="stack" style={{ gap: 8 }}>
        {shown.map((p) => (
          <li key={p.id} className="panel flex items-center justify-between gap-2">
            <div>
              <div className="body-md">{p.name}</div>
              <div className="body-sm muted">{p.barcode ?? t('labels.noCode')}{data.price.has(p.id) ? ` · ${data.price.get(p.id)} FCFA` : ''}</div>
            </div>
            <input
              aria-label={`${p.name} — ${t('labels.copies')}`} inputMode="numeric" className={`${input} text-right`} style={{ maxWidth: 80 }} placeholder="0" value={copies[p.id] ?? ''}
              onChange={(e) => setCopies({ ...copies, [p.id]: e.target.value.replace(/\D/g, '') })}
            />
          </li>
        ))}
      </ul>

      <section className="panel stack" style={{ position: 'sticky', bottom: 0, background: 'var(--neutral-white)' }}>
        <p className="body-md">{t('labels.summary', { n: plan.items.length, pages: pageCount })}{plan.truncated && ` ${t('labels.truncated')}`}</p>
        {missing.length > 0 && (
          <div className="notice notice--amber body-sm">
            {t('labels.missing', { names: plan.skipped.join(', ') })}
            {canWrite && <button className="btn btn--tertiary" style={{ marginLeft: 8 }} onClick={() => void makeCodes()}>{t('labels.makeCodes', { n: missing.length })}</button>}
          </div>
        )}
        {msg && <p role="status" className="label-lg">{msg}</p>}
        <div className="flex gap-2">
          <button className={`${btn} flex-1`} disabled={busy || plan.items.length === 0} onClick={() => void make('download')}>{t('labels.download')}</button>
          <button className={btn2} disabled={busy || plan.items.length === 0} onClick={() => void make('share')}>{t('invoices.share')}</button>
        </div>
      </section>
    </div>
  )
}
