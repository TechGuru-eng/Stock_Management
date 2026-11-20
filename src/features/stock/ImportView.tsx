import { useState, type ChangeEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { applyImport, exportCatalogueCsv, loadKnownProducts, type ApplyResult } from '../../data/importRepo'
import type { Ctx } from '../../data/repo'
import { decodeFile, parseCsv } from '../../domain/csvParse'
import { downloadText, reportFileName } from '../../domain/csv'
import { formatXaf } from '../../domain/money'
import { ImportStockPanel } from './ImportStockView'
import { planImport, type FieldChange, type ImportPlan } from '../../domain/priceImport'

const btn = 'btn btn--primary'
const btn2 = 'btn btn--secondary'
const SHOW = 300

/** Stock > Import prices: edit prices in a spreadsheet, load the file, read the plan, confirm. Nothing changes before the confirmation. */
function PricePanel({ ctx }: { ctx: Ctx }) {
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
    <div className="stack">
      <ol className="body-sm muted stack" style={{ gap: 4, paddingLeft: 20, listStyle: 'decimal' }}>
        <li>{t('import.step1')}</li><li>{t('import.step2')}</li><li>{t('import.step3')}</li>
      </ol>

      {!result && (
        <div className="panel stack">
          <button className={btn2} onClick={() => void exportCatalogueCsv(sep).then((csv) => downloadText(reportFileName('catalogue', new Date().toISOString().slice(0, 10)), csv))}>{t('import.download')}</button>
          <label className="btn btn--primary" style={{ cursor: 'pointer' }}>
            {fileName ? t('import.otherFile') : t('import.choose')}
            <input type="file" accept=".csv,.txt,text/csv" className="sr-only" onChange={(e) => void onFile(e)} />
          </label>
          <label className="check-row body-md">
            <input type="checkbox" checked={createMissing} onChange={(e) => { setCreateMissing(e.target.checked); void replan(csvRows, e.target.checked) }} /> {t('import.createMissing')}
          </label>
          <p className="body-sm muted">{t('import.hintExcel')}</p>
        </div>
      )}
      {msg && <p role="alert" className="field__error">{msg}</p>}

      {plan?.fatal && <p role="alert" className="field__error">{t(`import.fatal.${plan.fatal}`)}</p>}

      {plan && !plan.fatal && (
        <section className="stack">
          <p className="body-md">
            <strong>{fileName}</strong> — {t('import.summary', { update: plan.counts.update, create: plan.counts.create, unchanged: plan.counts.unchanged, error: plan.counts.error })}
          </p>
          {plan.counts.flagged > 0 && (
            <label className="check-row body-md panel panel--flag" style={{ alignItems: 'flex-start' }}>
              <input type="checkbox" checked={includeFlagged} onChange={(e) => setIncludeFlagged(e.target.checked)} /> {t('import.flagged', { n: plan.counts.flagged })}
            </label>
          )}
          <ul className="stack" style={{ gap: 4 }}>
            {[...plan.rows].filter((r) => r.kind !== 'unchanged').sort((a, b) => (a.kind === 'error' ? -1 : 0) - (b.kind === 'error' ? -1 : 0)).slice(0, SHOW).map((r) => (
              <li key={r.line} className={`body-sm panel${r.kind === 'error' || (r.kind === 'update' && r.flagged) ? ' panel--flag' : ''}`} style={{ padding: 10 }}>
                <span className="muted">{t('import.line', { n: r.line })} · </span>
                {r.kind === 'error' && <><strong>{r.name || '—'}</strong>: <span>! {t(`import.problem.${r.problem}`)}</span></>}
                {r.kind === 'update' && <><strong>{r.name}</strong> ({r.unitName}) — {r.changes.map(change).join(' · ')}</>}
                {r.kind === 'create' && <><strong>{r.name}</strong> — {t('import.willCreate')} · {r.unitName} · {formatXaf(r.price)}{r.barcode ? ` · ${r.barcode}` : ''}</>}
              </li>
            ))}
          </ul>
          {plan.rows.filter((r) => r.kind !== 'unchanged').length > SHOW && <p className="body-sm muted">{t('import.more', { n: SHOW })}</p>}
          <div className="flex gap-2">
            <button className={`${btn} flex-1`} disabled={busy || applicable === 0} onClick={() => void apply()}>{t('import.apply', { n: applicable })}</button>
            <button className={btn2} onClick={() => { setPlan(null); setCsvRows(null); setFileName('') }}>{t('shops.cancel')}</button>
          </div>
        </section>
      )}

      {result && (
        <section className="panel stack">
          <p role="status" className="label-lg">{t('import.done', { updated: result.updated, created: result.created })}</p>
          {result.skipped > 0 && <p className="body-sm muted">{t('import.skipped', { n: result.skipped })}</p>}
          {result.failed.length > 0 && (
            <div className="body-sm">
              <p>{t('import.failed', { n: result.failed.length })}</p>
              <ul style={{ paddingLeft: 20, listStyle: 'disc' }}>{result.failed.map((f) => <li key={f.line}>{t('import.line', { n: f.line })} · {f.name}: {f.message}</li>)}</ul>
            </div>
          )}
          <button className={btn2} onClick={() => { setResult(null); setFileName('') }}>{t('import.again')}</button>
        </section>
      )}
    </div>
  )
}

/** Stock > Import: prices, or opening stock. */
export function ImportView({ ctx, onBack }: { ctx: Ctx; onBack: () => void }) {
  const { t } = useTranslation()
  const [mode, setMode] = useState<'prices' | 'stock'>('prices')
  return (
    <div className="stack">
      <button onClick={onBack} className="btn btn--tertiary" style={{ alignSelf: 'flex-start' }}>{t('stock.back')}</button>
      <h3 className="h4">{t('import.title')}</h3>
      <div role="tablist" className="auth-tabs" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
        {(['prices', 'stock'] as const).map((k) => (
          <button key={k} role="tab" aria-selected={mode === k} onClick={() => setMode(k)}>
            {t(`import.mode.${k}`)}
          </button>
        ))}
      </div>
      {mode === 'prices' ? <PricePanel ctx={ctx} /> : <ImportStockPanel ctx={ctx} />}
    </div>
  )
}
