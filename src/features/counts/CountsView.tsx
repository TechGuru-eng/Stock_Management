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

const input = 'input'
const btn = 'btn btn--primary'
const btn2 = 'btn btn--secondary'

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
    <div className="stack">
      <p className="body-md muted">{t('counts.hint')}</p>
      {can(ctx.role, 'stock.count') && (
        <form onSubmit={start} className="panel stack">
          <h4 className="h6">{t('counts.start')}</h4>
          <input className={input} placeholder={t('counts.name')} aria-label={t('counts.name')} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required />
          <label className="check-row body-md"><input type="checkbox" checked={blind} onChange={(e) => setBlind(e.target.checked)} /> {t('counts.blind')}</label>
          <button className={btn}>{t('counts.startAction')}</button>
          {msg && <p role="alert" className="field__error">{msg}</p>}
        </form>
      )}
      {list.length === 0 && <p className="body-md muted">{t('counts.none')}</p>}
      <ul className="list-wrap">
        {list.map(({ c, status, counted }) => (
          <li key={c.id} style={{ padding: 0 }}>
            <button onClick={() => setSel(c.id)} className="flex w-full items-center justify-between text-left" style={{ padding: '15px 20px' }}>
              <span>{c.name}<span className="block label-lg muted">{new Date(c.startedAt).toLocaleDateString(i18n.language)} · {t('counts.nCounted', { n: counted })}</span></span>
              <span className="tag">{t(`counts.status.${status}`)}</span>
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
    <div className="stack">
      <button onClick={onBack} className="btn btn--tertiary" style={{ alignSelf: 'flex-start' }}>{t('stock.back')}</button>
      <h3 className="h4">{count.name}</h3>
      <p className="body-md muted">
        {t(`counts.status.${countStatus(decision)}`)} · {t('counts.nCounted', { n: latest.size })} / {products.length}
        {count.blind && ` · ${t('counts.blindShort')}`}{decision?.note && ` · ${decision.note}`}
      </p>
      {msg && <p role="alert" className="field__error">{msg}</p>}

      {mayCount && (
        <>
          <div className="flex gap-2">
            <input className={input} placeholder={t('counts.search')} aria-label={t('counts.search')} value={q} onChange={(e) => setQ(e.target.value)} />
            <ScanButton continuous onCode={onScanned} />
          </div>
          <ul className="stack" style={{ gap: 8 }}>
            {shown.map((p) => {
              const l = latest.get(p.id)
              return (
                <li key={p.id} className="panel flex items-center justify-between gap-2">
                  <div>
                    <div className="body-md">{p.name}</div>
                    <div className="body-sm muted">{l ? t('counts.lastCounted', { n: l.counted, unit: p.baseUnit }) : t('counts.notCounted')}{showExpected && l ? ` · ${t('counts.expectedWas', { n: l.expected })}` : ''}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      aria-label={`${p.name} — ${t('counts.counted')}`} inputMode="numeric" className={`${input} text-right`} style={{ maxWidth: 90 }} value={vals[p.id] ?? ''}
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
        <section className="panel stack">
          <h4 className="h6">{t('counts.review')}</h4>
          <p className="body-md">
            {t('counts.summary', { diff: sum.withDifference, total: sum.counted })} · {t('counts.missing')}: <strong>{formatXaf(sum.shortageValue)}</strong> · {t('counts.extra')}: <strong>{formatXaf(sum.surplusValue)}</strong>
            {sum.accuracyBp !== null && ` · ${t('counts.accuracy', { pct: (sum.accuracyBp / 100).toFixed(0) })}`}
          </p>
          <div className="table-wrap">
            <table className="table" style={{ minWidth: '22rem' }}>
              <thead><tr><th>{t('counts.product')}</th><th className="num">{t('counts.expected')}</th><th className="num">{t('counts.counted')}</th><th className="num">{t('counts.diff')}</th><th className="num">{t('counts.value')}</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.productId}>
                    <td>{r.name}{r.flagged && <span className="tag tag--flag" style={{ marginLeft: 4 }}>{t('counts.recountAdvised')}</span>}</td>
                    <td className="num">{r.expected}</td><td className="num">{r.counted}</td>
                    <td className="num">{r.diff > 0 ? '+' : ''}{r.diff}</td>
                    <td className="num">{formatXaf(r.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {open && products.length > latest.size && <p className="label-lg">! {t('counts.uncounted', { n: products.length - latest.size })}</p>}
          <div className="flex flex-wrap gap-2">
            <button className={btn2} onClick={exportCsv}>{t('reports.exportCsv')}</button>
            {mayDecide && !rejecting && (
              <>
                <button className={btn} onClick={() => void decide('approve')}>{t('counts.approve')}</button>
                <button className={btn2} onClick={() => setRejecting(true)}>{t('counts.reject')}</button>
              </>
            )}
          </div>
          {mayDecide && <p className="body-sm muted">{t('counts.approveHint')}</p>}
          {rejecting && (
            <div className="stack">
              <input className={input} placeholder={t('counts.rejectWhy')} aria-label={t('counts.rejectWhy')} value={note} onChange={(e) => setNote(e.target.value)} />
              <div className="flex gap-2"><button className={btn} disabled={!note.trim()} onClick={() => void decide('reject')}>{t('counts.reject')}</button><button className={btn2} onClick={() => setRejecting(false)}>{t('shops.cancel')}</button></div>
            </div>
          )}
        </section>
      )}
    </div>
  )
}
