import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../auth/AuthProvider'
import { createOrdersFromSuggestions, loadReorder, type ReorderView as View } from '../../data/reorderRepo'
import type { Ctx } from '../../data/repo'
import { formatXaf } from '../../domain/money'
import { can } from '../../domain/permissions'
import { DEFAULT_REORDER, orderMessage, type ReorderSettings, type Sourced } from '../../domain/reorder'
import { waLink } from '../../domain/reminders'

const input = 'min-h-12 rounded border border-slate-300 bg-transparent px-3'
const btn = 'min-h-12 rounded bg-teal-700 px-4 font-semibold text-white disabled:opacity-60'
const btn2 = 'min-h-12 rounded border border-slate-300 px-4'
const URG = { out: 'bg-red-100 text-red-800', urgent: 'bg-orange-100 text-orange-800', soon: 'bg-amber-100 text-amber-800', low: 'bg-slate-100 text-slate-700' } as const

/** Purchases > What to order: what is running out, how much to order and from whom. It suggests; a person creates the orders. */
export function ReorderView({ ctx, onBack }: { ctx: Ctx; onBack: () => void }) {
  const { t, i18n } = useTranslation()
  const { membership } = useAuth()
  const [settings, setSettings] = useState<ReorderSettings>(DEFAULT_REORDER)
  const [view, setView] = useState<View | null>(null)
  const [qty, setQty] = useState<Record<string, string>>({})
  const [off, setOff] = useState<Set<string>>(new Set())
  const [supplierFor, setSupplierFor] = useState<Record<string, string>>({})
  const [msg, setMsg] = useState<string | null>(null)
  const [suppliers, setSuppliers] = useState<{ id: string; name: string }[]>([])
  const allowed = can(ctx.role, 'purchases.manage')
  const lang = i18n.language.startsWith('fr') ? 'fr' : 'en'

  useEffect(() => {
    let live = true
    void loadReorder(ctx, settings).then((v) => {
      if (!live) return
      setView(v)
      setSuppliers([...v.suppliers].map(([id, s]) => ({ id, name: s.name })))
      setQty({}); setOff(new Set())
    })
    return () => { live = false }
  }, [ctx, settings])

  const effQty = (r: Sourced) => {
    const raw = qty[r.productId]
    return raw === undefined || raw === '' ? r.qty : Number(raw)
  }
  const costOf = (r: Sourced) => (r.unitCost === null ? 0 : Math.round(r.unitCost * effQty(r)))
  const groups = useMemo(() => view?.groups ?? [], [view])

  async function create(supplierId: string, rows: Sourced[]) {
    setMsg(null)
    const lines = rows.filter((r) => !off.has(r.productId) && effQty(r) > 0).map((r) => ({ productId: r.productId, qty: effQty(r), totalCost: costOf(r) }))
    if (lines.length === 0) return setMsg(t('reorder.nothingChosen'))
    const res = await createOrdersFromSuggestions(ctx, [{ supplierId, lines }])
    if (res.failed.length) return setMsg(t('purch.error', { msg: res.failed[0].message }))
    setMsg(t('reorder.created', { n: lines.length }))
    setView(await loadReorder(ctx, settings)) // those products now count as "on order"
  }

  const num = (k: keyof ReorderSettings, label: string, options: number[]) => (
    <label className="flex flex-col gap-1 text-sm">{label}
      <select className={input} value={settings[k] as number} onChange={(e) => setSettings({ ...settings, [k]: Number(e.target.value) })}>
        {options.map((o) => <option key={o} value={o}>{t('reorder.days', { n: o })}</option>)}
      </select>
    </label>
  )

  return (
    <div className="flex flex-col gap-3">
      <button onClick={onBack} className="min-h-12 self-start text-teal-700 underline">{t('purch.back')}</button>
      <h3 className="text-xl font-semibold">{t('reorder.title')}</h3>
      <p className="text-sm text-slate-600 dark:text-slate-300">{t('reorder.hint')}</p>

      <div className="grid grid-cols-3 gap-2">
        {num('coverDays', t('reorder.cover'), [7, 14, 21, 30])}
        {num('windowDays', t('reorder.window'), [14, 30, 60, 90])}
        {num('leadDays', t('reorder.lead'), [2, 4, 7, 10, 14])}
      </div>
      <label className="flex min-h-10 items-center gap-2 text-sm"><input type="checkbox" checked={settings.roundToPack} onChange={(e) => setSettings({ ...settings, roundToPack: e.target.checked })} /> {t('reorder.packs')}</label>

      {!view ? <p className="text-slate-500">…</p> : groups.length === 0 ? <p className="rounded bg-teal-50 p-3 text-teal-900">{t('reorder.nothing')}</p> : groups.map((g) => {
        const name = g.supplierId ? (view.suppliers.get(g.supplierId)?.name ?? '—') : t('reorder.noSupplier')
        const chosen = (g.supplierId ?? supplierFor['none']) || ''
        const target = g.supplierId ?? chosen
        const kept = g.rows.filter((r) => !off.has(r.productId) && effQty(r) > 0)
        const total = kept.reduce((s, r) => s + costOf(r), 0)
        const phone = target ? view.suppliers.get(target)?.phone : undefined
        const text = orderMessage(lang, membership?.tenantName ?? '', kept.map((r) => ({ name: r.name, qty: effQty(r), baseUnit: r.baseUnit, packs: r.packName && r.packs && Number.isInteger(effQty(r) / (r.qty / r.packs)) ? effQty(r) / (r.qty / r.packs) : null, packName: r.packName })))
        const link = phone ? waLink(phone, text) : null
        return (
          <section key={g.supplierId ?? 'none'} className="flex flex-col gap-2 rounded border border-slate-200 p-3 dark:border-slate-700">
            <h4 className="font-semibold">{name}</h4>
            <ul className="flex flex-col gap-2">
              {g.rows.map((r) => (
                <li key={r.productId} className={`rounded border border-slate-200 p-2 text-sm dark:border-slate-700 ${off.has(r.productId) ? 'opacity-50' : ''}`}>
                  <div className="flex items-start justify-between gap-2">
                    <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={!off.has(r.productId)} onChange={(e) => { const n = new Set(off); if (e.target.checked) n.delete(r.productId); else n.add(r.productId); setOff(n) }} />
                      <span><span className="font-medium">{r.name}</span>
                        <span className={`ml-2 rounded px-1.5 py-0.5 text-xs font-medium ${URG[r.urgency]}`}>{t(`reorder.urgency.${r.urgency}`)}</span>
                        <span className="block text-xs text-slate-500">
                          {t('reorder.onHand', { n: r.onHand, unit: r.baseUnit })}{r.onOrder > 0 && ` · ${t('reorder.onOrder', { n: r.onOrder })}`}
                          {r.daysLeft !== null ? ` · ${t('reorder.daysLeft', { n: Math.floor(r.daysLeft) })}` : ` · ${t('reorder.notSelling')}`}
                          {r.speed > 0 && ` · ${t('reorder.speed', { n: Number(r.speed.toFixed(1)) })}`}
                        </span>
                      </span>
                    </label>
                    <div className="text-right">
                      <input aria-label={`${r.name} — ${t('reorder.qty')}`} inputMode="numeric" className={`${input} !min-h-10 w-20 text-right`} value={qty[r.productId] ?? String(r.qty)} onChange={(e) => setQty({ ...qty, [r.productId]: e.target.value.replace(/\D/g, '') })} />
                      <div className="text-xs text-slate-500">{r.packs && r.packName ? t('reorder.packsOf', { n: r.packs, pack: r.packName }) : r.baseUnit}</div>
                    </div>
                  </div>
                  <div className="mt-1 text-xs text-slate-500">
                    {r.unitCost === null ? t('reorder.noPrice') : `${formatXaf(costOf(r))} · ${t(`reorder.source.${r.costSource}`)}`}
                  </div>
                </li>
              ))}
            </ul>
            {!g.supplierId && (
              <label className="flex flex-col gap-1 text-sm">{t('reorder.pickSupplier')}
                <select className={input} value={supplierFor['none'] ?? ''} onChange={(e) => setSupplierFor({ none: e.target.value })}>
                  <option value="" />
                  {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </label>
            )}
            <p className="text-sm">{t('reorder.total', { total: formatXaf(total) })}</p>
            <div className="flex flex-wrap gap-2">
              {allowed && <button className={btn} disabled={!target || kept.length === 0} onClick={() => void create(target, g.rows)}>{t('reorder.create')}</button>}
              {link && <a href={link} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-12 items-center rounded border border-emerald-600 px-4 font-medium text-emerald-700">{t('reorder.whatsapp')}</a>}
            </div>
          </section>
        )
      })}
      {msg && <p role="status" className="rounded bg-slate-100 p-2 text-sm dark:bg-slate-800">{msg}</p>}
      <button onClick={onBack} className={btn2}>{t('purch.back')}</button>
    </div>
  )
}
