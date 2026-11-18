import { useState, type ChangeEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { applyStockImport, loadKnownProducts, type StockApplyResult } from '../../data/importRepo'
import type { Ctx } from '../../data/repo'
import { useAuth } from '../../auth/AuthProvider'
import { decodeFile, parseCsv } from '../../domain/csvParse'
import { downloadText } from '../../domain/csv'
import { formatXaf } from '../../domain/money'
import { planStockImport, type StockPlan } from '../../domain/stockImport'

const btn = 'min-h-12 rounded bg-teal-700 px-4 font-semibold text-white disabled:opacity-60'
const btn2 = 'min-h-12 rounded border border-slate-300 px-4'
const SHOW = 300

/** The opening stock half of the import screen: how many of each product are on the shelf, and what they cost. */
export function ImportStockPanel({ ctx }: { ctx: Ctx }) {
  const { t } = useTranslation()
  const { membership } = useAuth()
  const shopName = membership?.shops.find((s) => s.id === ctx.shopId)?.name ?? ''
  const [createMissing, setCreateMissing] = useState(false)
  const [csvRows, setCsvRows] = useState<string[][] | null>(null)
  const [fileName, setFileName] = useState('')
  const [plan, setPlan] = useState<StockPlan | null>(null)
  const [includeFlagged, setIncludeFlagged] = useState(false)
  const [result, setResult] = useState<StockApplyResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  async function replan(rows: string[][] | null, create: boolean) {
    if (!rows) return setPlan(null)
    setPlan(planStockImport(rows, await loadKnownProducts(ctx.shopId), { createMissing: create }))
  }

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    setMsg(null); setResult(null); setIncludeFlagged(false)
    try {
      if (f.size > 5_000_000) throw new Error(t('import.tooBig'))
      const rows = parseCsv(decodeFile(await f.arrayBuffer()))
      setCsvRows(rows); setFileName(f.name)
      await replan(rows, createMissing)
    } catch (err) {
      setMsg((err as Error).message)
    }
  }

  async function apply() {
    if (!plan) return
    setBusy(true); setMsg(null)
    try {
      setResult(await applyStockImport(ctx, plan, { includeFlagged }))
      setPlan(null); setCsvRows(null)
    } catch (err) {
      setMsg((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const applicable = plan ? plan.counts.opening + plan.counts.create - (includeFlagged ? 0 : plan.counts.flagged) : 0
  const template = '﻿name;barcode;unit;qty;unit_cost;price\r\nEau 1.5L;5449000000996;bouteille;48;300;500\r\n'

  return (
    <div className="flex flex-col gap-3">
      <p className="rounded bg-sky-50 p-2 text-sm text-sky-900 dark:bg-sky-950 dark:text-sky-100">{t('importStock.where', { shop: shopName })}</p>
      <ol className="list-decimal pl-5 text-sm text-slate-600 dark:text-slate-300"><li>{t('importStock.step1')}</li><li>{t('importStock.step2')}</li><li>{t('importStock.step3')}</li></ol>

      {!result && (
        <div className="flex flex-col gap-2 rounded border border-slate-200 p-3 dark:border-slate-700">
          <button className={btn2} onClick={() => downloadText('stockcm-opening-stock-template.csv', template)}>{t('importStock.template')}</button>
          <label className="flex min-h-12 cursor-pointer items-center justify-center rounded bg-teal-700 px-4 font-semibold text-white">
            {fileName ? t('import.otherFile') : t('import.choose')}
            <input type="file" accept=".csv,.txt,text/csv" className="sr-only" onChange={(e) => void onFile(e)} />
          </label>
          <label className="flex min-h-10 items-center gap-2 text-sm">
            <input type="checkbox" checked={createMissing} onChange={(e) => { setCreateMissing(e.target.checked); void replan(csvRows, e.target.checked) }} /> {t('importStock.createMissing')}
          </label>
          <p className="text-xs text-slate-500">{t('importStock.hint')}</p>
        </div>
      )}
      {msg && <p role="alert" className="rounded bg-red-50 p-2 text-sm text-red-800">{msg}</p>}
      {plan?.fatal && <p role="alert" className="rounded bg-red-50 p-2 text-sm text-red-800">{t(`importStock.fatal.${plan.fatal}`, { defaultValue: t(`import.fatal.${plan.fatal}`) })}</p>}

      {plan && !plan.fatal && (
        <section className="flex flex-col gap-3">
          <p className="text-sm"><strong>{fileName}</strong> — {t('importStock.summary', { opening: plan.counts.opening, create: plan.counts.create, error: plan.counts.error, value: formatXaf(plan.totalValue) })}</p>
          {plan.counts.flagged > 0 && (
            <label className="flex items-start gap-2 rounded bg-amber-50 p-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">
              <input type="checkbox" className="mt-1" checked={includeFlagged} onChange={(e) => setIncludeFlagged(e.target.checked)} /> {t('importStock.flagged', { n: plan.counts.flagged })}
            </label>
          )}
          <ul className="flex flex-col gap-1 text-sm">
            {[...plan.rows].filter((r) => r.kind !== 'skip').sort((a, b) => (a.kind === 'error' ? -1 : 0) - (b.kind === 'error' ? -1 : 0)).slice(0, SHOW).map((r) => (
              <li key={r.line} className={`rounded border p-2 ${r.kind === 'error' ? 'border-red-300 bg-red-50 dark:bg-red-950' : (r.kind === 'opening' || r.kind === 'create') && r.flagged ? 'border-amber-300 bg-amber-50 dark:bg-amber-950' : 'border-slate-200 dark:border-slate-700'}`}>
                <span className="text-xs text-slate-500">{t('import.line', { n: r.line })} · </span>
                {r.kind === 'error' && <><strong>{r.name || '—'}</strong>: <span className="text-red-800 dark:text-red-200">{t(`importStock.problem.${r.problem}`)}</span></>}
                {r.kind === 'opening' && <><strong>{r.name}</strong> — {r.baseQty} {t('importStock.units')} · {formatXaf(r.totalCost)}{r.flagged && ` · ${t('importStock.costAbove')}`}</>}
                {r.kind === 'create' && <><strong>{r.name}</strong> — {t('import.willCreate')} · {r.baseQty} {r.unitName} · {formatXaf(r.totalCost)}{r.flagged && ` · ${t('importStock.costAbove')}`}</>}
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <button className={`${btn} flex-1`} disabled={busy || applicable === 0} onClick={() => void apply()}>{t('importStock.apply', { n: applicable })}</button>
            <button className={btn2} onClick={() => { setPlan(null); setCsvRows(null); setFileName('') }}>{t('shops.cancel')}</button>
          </div>
        </section>
      )}

      {result && (
        <section className="flex flex-col gap-2 rounded border border-slate-200 p-3 dark:border-slate-700">
          <p role="status" className="font-semibold text-teal-700">{t('importStock.done', { recorded: result.recorded, created: result.created, value: formatXaf(result.value) })}</p>
          {result.skipped > 0 && <p className="text-sm text-amber-800">{t('importStock.skipped', { n: result.skipped })}</p>}
          {result.failed.length > 0 && (
            <div className="text-sm text-red-800">
              <p>{t('import.failed', { n: result.failed.length })}</p>
              <ul className="list-disc pl-5">{result.failed.map((f) => <li key={f.line}>{t('import.line', { n: f.line })} · {f.name}: {f.message}</li>)}</ul>
            </div>
          )}
          <button className={btn2} onClick={() => { setResult(null); setFileName('') }}>{t('import.again')}</button>
        </section>
      )}
    </div>
  )
}
