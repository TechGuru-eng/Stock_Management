import { useEffect, useState, type FormEvent } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useTranslation } from 'react-i18next'
import { planHasFeature } from '../../billing/licenceStore'
import { loadRules, saveRules } from '../../data/loyaltyRepo'
import { useCtx } from '../../data/useCtx'
import { can } from '../../domain/permissions'
import { DEFAULT_LOYALTY, rewardRateBp, validateRules, type LoyaltyRules } from '../../domain/loyalty'

const box = 'min-h-12 rounded border border-slate-300 bg-transparent px-3'

/** More tab (owner): switch the points program on and set its rules. */
export function LoyaltySettings() {
  const { t } = useTranslation()
  const ctx = useCtx()
  const saved = useLiveQuery(() => loadRules(), [])
  const [f, setF] = useState({ enabled: false, earnPer: '1000', pointValue: '10', minRedeem: '50', share: '50' })
  const [msg, setMsg] = useState<string | null>(null)
  const [allowed, setAllowed] = useState(true)
  useEffect(() => {
    const r = saved ?? DEFAULT_LOYALTY
    setF({ enabled: r.enabled, earnPer: String(r.earnPer), pointValue: String(r.pointValue), minRedeem: String(r.minRedeem), share: String(r.maxShareBp / 100) })
  }, [saved])
  useEffect(() => { void planHasFeature('loyalty').then(setAllowed) }, [])
  if (!ctx || !can(ctx.role, 'settings.write')) return null
  const rules: LoyaltyRules = { enabled: f.enabled && allowed, earnPer: Number(f.earnPer), pointValue: Number(f.pointValue), minRedeem: Number(f.minRedeem), maxShareBp: Math.round(Number(f.share) * 100) }
  const problems = validateRules(rules)
  const rate = problems.length ? null : rewardRateBp(rules) / 100

  async function submit(e: FormEvent) {
    e.preventDefault()
    setMsg(null)
    try { await saveRules(ctx!, rules); setMsg(t('loyalty.saved')) } catch (err) { setMsg((err as Error).message) }
  }

  return (
    <form onSubmit={submit} className="mt-6 flex flex-col gap-3 rounded border border-slate-200 p-3 dark:border-slate-700">
      <h3 className="text-lg font-semibold">{t('loyalty.title')}</h3>
      <p className="text-sm text-slate-600 dark:text-slate-300">{t('loyalty.hint')}</p>
      {!allowed && <p className="text-sm text-amber-700">{t('loyalty.planLocked')}</p>}
      <label className="flex min-h-12 items-center gap-2"><input type="checkbox" disabled={!allowed} checked={f.enabled && allowed} onChange={(e) => setF({ ...f, enabled: e.target.checked })} />{t('loyalty.enable')}</label>
      <label className="flex flex-col gap-1 text-sm">{t('loyalty.earnPer')}<input className={box} inputMode="numeric" value={f.earnPer} onChange={(e) => setF({ ...f, earnPer: e.target.value })} /></label>
      <label className="flex flex-col gap-1 text-sm">{t('loyalty.pointValue')}<input className={box} inputMode="numeric" value={f.pointValue} onChange={(e) => setF({ ...f, pointValue: e.target.value })} /></label>
      <label className="flex flex-col gap-1 text-sm">{t('loyalty.minRedeem')}<input className={box} inputMode="numeric" value={f.minRedeem} onChange={(e) => setF({ ...f, minRedeem: e.target.value })} /></label>
      <label className="flex flex-col gap-1 text-sm">{t('loyalty.share')}<input className={box} inputMode="numeric" value={f.share} onChange={(e) => setF({ ...f, share: e.target.value })} /></label>
      {rate !== null && <p className="text-sm">{t('loyalty.cost', { rate })}</p>}
      {problems.length > 0 && <p role="alert" className="text-sm text-red-700">{t('loyalty.invalid')}</p>}
      <button className="min-h-12 rounded bg-teal-700 px-4 text-white disabled:opacity-50" disabled={problems.length > 0}>{t('loyalty.save')}</button>
      {msg && <p role="status" className="text-sm">{msg}</p>}
    </form>
  )
}
