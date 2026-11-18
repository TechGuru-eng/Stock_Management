import { useState, type ChangeEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { applyImport, exportCatalogueCsv, loadKnownProducts, type ApplyResult } from '../../data/importRepo'
import type { Ctx } from '../../data/repo'
import { decodeFile, parseCsv } from '../../domain/csvParse'
import { downloadText, reportFileName } from '../../domain/csv'
import { formatXaf } from '../../domain/money'
import { planImport, type FieldChange, type ImportPlan } from '../../domain/priceImport'

const btn = 'min-h-12 rounded bg-teal-700 px-4 font-semibold text-white disabled:opacity-60'
const btn2 = 'min-h-12 rounded border border-slate-300 px-4'
const SHOW = 300

/** Stock > Import prices: edit prices in a spreadsheet, load the file, read the plan, confirm. Nothing changes before the confirmation. */
export function ImportView({ ctx, onBack }: { ctx: Ctx; onBack: () => void }) {
  const { t, i18n } = useTranslation()
  const [createMissing, setCreateMissing] = useState(false)
  const [csvRows, setCsvRows] = useState<string[][] | null>(null)
  const [fileName, setFileName] = useState('')
  const [plan, setPlan] = useState<ImportPlan | null>(null)
  const [includeFlagged, setIncludeFlagged] = useState(false)
  const [result, setResult] = useState<ApplyResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const sep = i18n.language.startsWith('fr') ? ';' : ','

  async function replan(rows: string[][] | null, create: boolean) {
    if (!rows) return setPlan(null)
    setPlan(planImport(rows, await loadKnownProducts(), { createMissing: create }))
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
      setResult(await applyImport(ctx, plan, { includeFlagged }))
      setPlan(null); setCsvRows(null)
    } catch (err) {
      setMsg((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const change = (c: FieldChange) => {
    const label = t(`import.field.${c.field}`)
    const f = (v: number | string | null) => (c.field === 'price' ? formatXaf(Number(v)) : c.field === 'taxRateBp' ? `${Number(v) / 100} %` : v === null ? '—' : String(v))
    return `${label}: ${f(c.from)} → ${f(c.to)}`
  }

  const applicable = plan ? plan.counts.update - (includeFlagged ? 0 : plan.counts.flagged) + plan.counts.create : 0

  return (
    <div className="flex flex-col gap-3">
      <button onClick={onBack} className="min-h-12 self-start text-teal-700 underline">{t('stock.back')}</button>
      <h3 className="text-xl font-semibold">{t('import.title')}</h3>
      <ol className="list-decimal pl-5 text-sm text-slate-600 dark:text-slate-300">
        <li>{t('import.step1')}</li><li>{t('import.step2')}</li><li>{t('import.step3')}</li>
      </ol>

      {!result && (
        <div className="flex flex-col gap-2 rounded border border-slate-200 p-3 dark:border-slate-700">
          <button className={btn2} onClick={() => void exportCatalogueCsv(sep).then((csv) => downloadText(reportFileName('catalogue', new Date().toISOString().slice(0, 10)), csv))}>{t('import.download')}</button>
          <label className="flex min-h-12 cursor-pointer items-center justify-center rounded bg-teal-700 px-4 font-semibold text-white">
            {fileName ? t('import.otherFile') : t('import.choose')}
            <input type="file" accept=".csv,.txt,text/csv" className="sr-only" onChange={(e) => void onFile(e)} />
          </label>
          <label className="flex min-h-10 items-center gap-2 text-sm">
            <input type="checkbox" checked={createMissing} onChange={(e) => { setCreateMissing(e.target.checked); void replan(csvRows, e.target.checked) }} /> {t('import.createMissing')}
          </label>
          <p className="text-xs text-slate-500">{t('import.hintExcel')}</p>
        </div>
      )}
      {msg && <p role="alert" className="rounded bg-red-50 p-2 text-sm text-red-800">{msg}</p>}

      {plan?.fatal && <p role="alert" className="rounded bg-red-50 p-2 text-sm text-red-800">{t(`import.fatal.${plan.fatal}`)}</p>}

      {plan && !plan.fatal && (
        <section className="flex flex-col gap-3">
          <p className="text-sm">
            <strong>{fileName}</strong> — {t('import.summary', { update: plan.counts.update, create: plan.counts.create, unchanged: plan.counts.unchanged, error: plan.counts.error })}
          </p>
          {plan.counts.flagged > 0 && (
            <label className="flex items-start gap-2 rounded bg-amber-50 p-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">
              <input type="checkbox" className="mt-1" checked={includeFlagged} onChange={(e) => setIncludeFlagged(e.target.checked)} /> {t('import.flagged', { n: plan.counts.flagged })}
            </label>
          )}
          <ul className="flex flex-col gap-1 text-sm">
            {[...plan.rows].filter((r) => r.kind !== 'unchanged').sort((a, b) => (a.kind === 'error' ? -1 : 0) - (b.kind === 'error' ? -1 : 0)).slice(0, SHOW).map((r) => (
              <li key={r.line} className={`rounded border p-2 ${r.kind === 'error' ? 'border-red-300 bg-red-50 dark:bg-red-950' : r.kind === 'update' && r.flagged ? 'border-amber-300 bg-amber-50 dark:bg-amber-950' : 'border-slate-200 dark:border-slate-700'}`}>
                <span className="text-xs text-slate-500">{t('import.line', { n: r.line })} · </span>
                {r.kind === 'error' && <><strong>{r.name || '—'}</strong>: <span className="text-red-800 dark:text-red-200">{t(`import.problem.${r.problem}`)}</span></>}
                {r.kind === 'update' && <><strong>{r.name}</strong> ({r.unitName}) — {r.changes.map(change).join(' · ')}</>}
                {r.kind === 'create' && <><strong>{r.name}</strong> — {t('import.willCreate')} · {r.unitName} · {formatXaf(r.price)}{r.barcode ? ` · ${r.barcode}` : ''}</>}
              </li>
            ))}
          </ul>
          {plan.rows.filter((r) => r.kind !== 'unchanged').length > SHOW && <p className="text-xs text-slate-500">{t('import.more', { n: SHOW })}</p>}
          <div className="flex gap-2">
            <button className={`${btn} flex-1`} disabled={busy || applicable === 0} onClick={() => void apply()}>{t('import.apply', { n: applicable })}</button>
            <button className={btn2} onClick={() => { setPlan(null); setCsvRows(null); setFileName('') }}>{t('shops.cancel')}</button>
          </div>
        </section>
      )}

      {result && (
        <section className="flex flex-col gap-2 rounded border border-slate-200 p-3 dark:border-slate-700">
          <p role="status" className="font-semibold text-teal-700">{t('import.done', { updated: result.updated, created: result.created })}</p>
          {result.skipped > 0 && <p className="text-sm text-amber-800">{t('import.skipped', { n: result.skipped })}</p>}
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
