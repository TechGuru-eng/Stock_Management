import { useLiveQuery } from 'dexie-react-hooks'
import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { ScanButton } from '../../scanner/ScanButton'
import { findByBarcode } from '../../domain/barcode'
import { approveCount, recordCount, rejectCount, startCount } from '../../data/countsRepo'
import { db } from '../../data/db'
import { useCtx } from '../../data/useCtx'
import type { Ctx } from '../../data/repo'
import { countStatus, latestLines, summarizeCount, varianceRows } from '../../domain/counts'
import { downloadText, reportFileName, toCsv } from '../../domain/csv'
import { formatXaf } from '../../domain/money'
import { can } from '../../domain/permissions'

const input = 'min-h-12 w-full rounded border border-slate-300 bg-transparent px-3'
const btn = 'min-h-12 rounded bg-teal-700 px-4 font-semibold text-white disabled:opacity-60'
const btn2 = 'min-h-12 rounded border border-slate-300 px-4 disabled:opacity-60'

export function CountsView() {
  const { t, i18n } = useTranslation()
  const ctx = useCtx()
  const [sel, setSel] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [blind, setBlind] = useState(true)
  const [msg, setMsg] = useState<string | null>(null)
  const list = useLiveQuery(async () => {
    if (!ctx) return []
    const cs = (await db.stockCounts.where('shopId').equals(ctx.shopId).toArray()).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
    const ds = await db.countDecisions.toArray()
    const ls = await db.countLines.toArray()
    return cs.map((c) => ({ c, status: countStatus(ds.find((d) => d.countId === c.id)), counted: latestLines(ls.filter((l) => l.countId === c.id)).length }))
  }, [ctx?.shopId]) ?? []
  if (!ctx) return null
  if (sel) return <CountDetail ctx={ctx} countId={sel} onBack={() => setSel(null)} />

  async function start(e: FormEvent) {
    e.preventDefault()
    setMsg(null)
    try {
      const c = await startCount(ctx!, { name, blind })
      setName('')
      setSel(c.id)
    } catch (err) {
      setMsg((err as Error).message)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-slate-600 dark:text-slate-300">{t('counts.hint')}</p>
      {can(ctx.role, 'stock.count') && (
        <form onSubmit={start} className="flex flex-col gap-2 rounded border border-slate-200 p-3 dark:border-slate-700">
          <h4 className="font-semibold">{t('counts.start')}</h4>
          <input className={input} placeholder={t('counts.name')} aria-label={t('counts.name')} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required />
          <label className="flex min-h-10 items-center gap-2 text-sm"><input type="checkbox" checked={blind} onChange={(e) => setBlind(e.target.checked)} /> {t('counts.blind')}</label>
          <button className={btn}>{t('counts.startAction')}</button>
          {msg && <p role="alert" className="text-sm text-red-700">{msg}</p>}
        </form>
      )}
      {list.length === 0 && <p className="text-slate-500">{t('counts.none')}</p>}
      <ul className="divide-y divide-slate-200 dark:divide-slate-800">
        {list.map(({ c, status, counted }) => (
          <li key={c.id}>
            <button onClick={() => setSel(c.id)} className="flex min-h-14 w-full items-center justify-between py-2 text-left">
              <span>{c.name}<span className="block text-xs text-slate-500">{new Date(c.startedAt).toLocaleDateString(i18n.language)} · {t('counts.nCounted', { n: counted })}</span></span>
              <span className={status === 'approved' ? 'text-teal-700' : status === 'rejected' ? 'text-red-700' : 'text-amber-700'}>{t(`counts.status.${status}`)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

function CountDetail({ ctx, countId, onBack }: { ctx: Ctx; countId: string; onBack: () => void }) {
  const { t, i18n } = useTranslation()
  const [q, setQ] = useState('')
  const [vals, setVals] = useState<Record<string, string>>({})
  const [msg, setMsg] = useState<string | null>(null)
  const [rejecting, setRejecting] = useState(false)
  const [note, setNote] = useState('')
  const data = useLiveQuery(async () => {
    const count = await db.stockCounts.get(countId)
    const lines = await db.countLines.where('countId').equals(countId).toArray()
    const decision = await db.countDecisions.where('countId').equals(countId).first()
    const products = (await db.products.toArray()).filter((p) => p.active && !p.isService).sort((a, b) => a.name.localeCompare(b.name))
    return { count, lines, decision, products }
  }, [countId])
  if (!data?.count) return null
  const { count, lines, decision, products } = data
  const open = !decision
  const mayCount = open && can(ctx.role, 'stock.count')
  const mayDecide = open && can(ctx.role, 'stock.adjust_approve')
  const showExpected = !count.blind || can(ctx.role, 'stock.adjust_approve')
  const names = new Map(products.map((p) => [p.id, p.name]))
  const latest = new Map(latestLines(lines).map((l) => [l.productId, l]))
  const rows = varianceRows(lines, names)
  const sum = summarizeCount(rows)
  const needle = q.trim().toLowerCase()
  const shown = products.filter((p) => !needle || p.name.toLowerCase().includes(needle) || (p.barcode ?? '').includes(needle))

  /** Each scan adds one to the tally for that product; the counter checks it and presses Save. */
  function onScanned(code: string): string {
    const hit = findByBarcode(products, code)
    if (!hit) return t('scan.unknown', { code })
    setVals((v) => ({ ...v, [hit.id]: String((Number(v[hit.id] || 0)) + 1) }))
    setQ('')
    return t('scan.tally', { name: hit.name })
  }

  async function save(productId: string) {
    setMsg(null)
    try {
      await recordCount(ctx, countId, productId, Number(vals[productId]))
      setVals((v) => ({ ...v, [productId]: '' }))
    } catch (e) {
      setMsg((e as Error).message)
    }
  }
  async function decide(kind: 'approve' | 'reject') {
    setMsg(null)
    try {
      if (kind === 'approve') await approveCount(ctx, countId)
      else await rejectCount(ctx, countId, note)
      setRejecting(false)
    } catch (e) {
      setMsg((e as Error).message)
    }
  }
  const sep = i18n.language.startsWith('fr') ? ';' : ','
  const exportCsv = () => downloadText(reportFileName(`count-${count.name}`, new Date().toISOString().slice(0, 10)), toCsv([
    { label: t('counts.product'), value: (r: (typeof rows)[number]) => r.name }, { label: t('counts.expected'), value: (r) => r.expected }, { label: t('counts.counted'), value: (r) => r.counted },
    { label: t('counts.diff'), value: (r) => r.diff }, { label: t('counts.unitCost'), value: (r) => r.unitCost }, { label: t('counts.value'), value: (r) => r.value },
  ], rows, sep))

  return (
    <div className="flex flex-col gap-3">
      <button onClick={onBack} className="min-h-12 self-start text-teal-700 underline">{t('stock.back')}</button>
      <h3 className="text-xl font-semibold">{count.name}</h3>
      <p className="text-sm text-slate-600 dark:text-slate-300">
        {t(`counts.status.${countStatus(decision)}`)} · {t('counts.nCounted', { n: latest.size })} / {products.length}
        {count.blind && ` · ${t('counts.blindShort')}`}{decision?.note && ` · ${decision.note}`}
      </p>
      {msg && <p role="alert" className="rounded bg-red-50 p-2 text-sm text-red-800">{msg}</p>}

      {mayCount && (
        <>
          <div className="flex gap-2">
            <input className={input} placeholder={t('counts.search')} aria-label={t('counts.search')} value={q} onChange={(e) => setQ(e.target.value)} />
            <ScanButton continuous onCode={onScanned} />
          </div>
          <ul className="flex flex-col gap-2">
            {shown.map((p) => {
              const l = latest.get(p.id)
              return (
                <li key={p.id} className="flex items-center justify-between gap-2 rounded border border-slate-200 p-2 dark:border-slate-700">
                  <div>
                    <div className="font-medium">{p.name}</div>
                    <div className="text-xs text-slate-500">{l ? t('counts.lastCounted', { n: l.counted, unit: p.baseUnit }) : t('counts.notCounted')}{showExpected && l ? ` · ${t('counts.expectedWas', { n: l.expected })}` : ''}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      aria-label={`${p.name} — ${t('counts.counted')}`} inputMode="numeric" className={`${input} w-24 text-right`} value={vals[p.id] ?? ''}
                      onChange={(e) => setVals({ ...vals, [p.id]: e.target.value.replace(/\D/g, '') })}
                      onKeyDown={(e) => { if (e.key === 'Enter' && (vals[p.id] ?? '') !== '') void save(p.id) }}
                    />
                    <button className={btn2} disabled={(vals[p.id] ?? '') === ''} onClick={() => void save(p.id)}>{l ? t('counts.recount') : t('counts.save')}</button>
                  </div>
                </li>
              )
            })}
          </ul>
        </>
      )}

      {(mayDecide || !open) && rows.length > 0 && (
        <section className="flex flex-col gap-2 rounded border border-slate-200 p-3 dark:border-slate-700">
          <h4 className="font-semibold">{t('counts.review')}</h4>
          <p className="text-sm">
            {t('counts.summary', { diff: sum.withDifference, total: sum.counted })} · {t('counts.missing')}: <strong className="text-red-700">{formatXaf(sum.shortageValue)}</strong> · {t('counts.extra')}: <strong className="text-teal-700">{formatXaf(sum.surplusValue)}</strong>
            {sum.accuracyBp !== null && ` · ${t('counts.accuracy', { pct: (sum.accuracyBp / 100).toFixed(0) })}`}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[22rem] text-sm">
              <thead><tr className="text-left text-xs text-slate-500"><th>{t('counts.product')}</th><th className="text-right">{t('counts.expected')}</th><th className="text-right">{t('counts.counted')}</th><th className="text-right">{t('counts.diff')}</th><th className="text-right">{t('counts.value')}</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.productId} className={`border-t border-slate-100 dark:border-slate-800 ${r.flagged ? 'bg-amber-50 dark:bg-amber-950' : ''}`}>
                    <td className="py-1.5">{r.name}{r.flagged && <span className="ml-1 text-xs font-semibold text-amber-800">{t('counts.recountAdvised')}</span>}</td>
                    <td className="text-right tabular-nums">{r.expected}</td><td className="text-right tabular-nums">{r.counted}</td>
                    <td className={`text-right tabular-nums ${r.diff < 0 ? 'text-red-700' : r.diff > 0 ? 'text-teal-700' : ''}`}>{r.diff > 0 ? '+' : ''}{r.diff}</td>
                    <td className="text-right tabular-nums">{formatXaf(r.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {open && products.length > latest.size && <p className="text-xs text-amber-800">{t('counts.uncounted', { n: products.length - latest.size })}</p>}
          <div className="flex flex-wrap gap-2">
            <button className={btn2} onClick={exportCsv}>{t('reports.exportCsv')}</button>
            {mayDecide && !rejecting && (
              <>
                <button className={btn} onClick={() => void decide('approve')}>{t('counts.approve')}</button>
                <button className={btn2} onClick={() => setRejecting(true)}>{t('counts.reject')}</button>
              </>
            )}
          </div>
          {mayDecide && <p className="text-xs text-slate-500">{t('counts.approveHint')}</p>}
          {rejecting && (
            <div className="flex flex-col gap-2">
              <input className={input} placeholder={t('counts.rejectWhy')} aria-label={t('counts.rejectWhy')} value={note} onChange={(e) => setNote(e.target.value)} />
              <div className="flex gap-2"><button className={btn} disabled={!note.trim()} onClick={() => void decide('reject')}>{t('counts.reject')}</button><button className={btn2} onClick={() => setRejecting(false)}>{t('shops.cancel')}</button></div>
            </div>
          )}
        </section>
      )}
    </div>
  )
}
