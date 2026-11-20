import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../auth/AuthProvider'
import { db } from '../../data/db'
import type { Ctx } from '../../data/repo'
import { isStale, pollDelayMs } from '../../domain/paymentAttempts'
import { normalizeCameroonPhone } from '../../domain/onboarding'
import { formatXaf } from '../../domain/money'
import { checkRequest, fitsSale, unusedCollections, type CollectionProvider, type CollectionRecord } from '../../domain/tillCollections'
import { supabase } from '../../lib/supabase'

const base = `${(import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? ''}/functions/v1`
const input = 'input'
const btn = 'btn btn--primary'
const COLUMNS = 'id, tenant_id, shop_id, provider, phone, amount, status, payment_url, provider_reference, reason, sale_id, created_at'

type Phase =
  | { k: 'idle' }
  | { k: 'sending' }
  | { k: 'waiting'; id: string; since: string; provider: CollectionProvider; url?: string; checks: number }
  | { k: 'stopped'; reason: string }

interface Row { id: string; tenant_id: string; shop_id: string; provider: CollectionProvider; phone: string; amount: number | string; status: CollectionRecord['status']; provider_reference: string | null; sale_id: string | null; created_at: string; reason: string | null }

const toRecord = (r: Row): CollectionRecord => ({
  id: r.id, tenantId: r.tenant_id, shopId: r.shop_id, provider: r.provider, phone: r.phone, amount: Number(r.amount), status: r.status,
  providerReference: r.provider_reference ?? undefined, saleId: r.sale_id ?? undefined, createdAt: r.created_at,
})

/**
 * Collect mobile money from the customer's own phone. The customer approves; the operator tells the server; only then does a sale get a
 * "verified" payment. Online only (a prompt needs the network). The till still works offline with manual, unverified mobile-money entries.
 */
export function CollectPanel({ ctx, remaining, customerPhone, usedIds, onUse }: { ctx: Ctx; remaining: number; customerPhone?: string; usedIds: string[]; onUse: (c: CollectionRecord) => void }) {
  const { t, i18n } = useTranslation()
  const { session } = useAuth()
  const [providers, setProviders] = useState<Record<string, boolean>>({})
  const [provider, setProvider] = useState<CollectionProvider>('mtn_momo')
  const [phone, setPhone] = useState(customerPhone ?? '')
  const [amount, setAmount] = useState('')
  const [phase, setPhase] = useState<Phase>({ k: 'idle' })
  const [waiting, setWaiting] = useState<CollectionRecord[]>([])
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false; if (timer.current) clearTimeout(timer.current) }, [])
  useEffect(() => { if (customerPhone) setPhone(customerPhone) }, [customerPhone])
  useEffect(() => { if (remaining > 0 && amount === '') setAmount(String(remaining)) }, [remaining, amount])

  const call = useCallback(async (body: Record<string, unknown>) => {
    const res = await fetch(`${base}/payments?lang=${i18n.language.startsWith('fr') ? 'fr' : 'en'}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token ?? ''}` }, body: JSON.stringify(body),
    })
    return (await res.json().catch(() => ({}))) as Record<string, unknown>
  }, [session, i18n.language])

  // Which providers this business has set up, and what is already collected but not used (also catches a till closed mid-payment).
  const loadWaiting = useCallback(async () => {
    if (!supabase || !navigator.onLine) return
    const p = await supabase.rpc('tenant_providers', { p_tenant: ctx.tenantId })
    if (alive.current) setProviders((p.data as Record<string, boolean> | null) ?? {})
    const { data } = await supabase.from('till_collections').select(COLUMNS).eq('shop_id', ctx.shopId).eq('status', 'successful').is('sale_id', null).order('created_at', { ascending: true }).limit(20)
    const recs = ((data as unknown as Row[]) ?? []).map(toRecord)
    for (const r of recs) await db.tillCollections.put(r) // this device's copy: what a sale can use
    if (alive.current) setWaiting(unusedCollections(recs, { shopId: ctx.shopId, now: new Date() }))
  }, [ctx.tenantId, ctx.shopId])
  useEffect(() => { void loadWaiting() }, [loadWaiting])
  useEffect(() => {
    if (!providers[provider] && providers.mtn_momo !== undefined) setProvider(providers.mtn_momo ? 'mtn_momo' : 'orange_money')
  }, [providers, provider])

  useEffect(() => {
    if (phase.k !== 'waiting') return
    const w = phase
    timer.current = setTimeout(async () => {
      const r = await call({ action: 'till_check', id: w.id })
      if (!alive.current) return
      const status = String(r.status ?? 'pending')
      if (status === 'successful') {
        await loadWaiting()
        const rec = await db.tillCollections.get(w.id)
        setPhase({ k: 'idle' })
        if (rec) onUse(rec)
        return
      }
      if (status === 'failed' || status === 'error') { setPhase({ k: 'stopped', reason: status === 'failed' ? 'declined' : 'error' }); return }
      if (isStale(w.since, new Date())) { setPhase({ k: 'stopped', reason: 'expired' }); return }
      setPhase({ ...w, checks: w.checks + 1 })
    }, pollDelayMs(w.checks))
    return () => { if (timer.current) clearTimeout(timer.current) }
  }, [phase, call, onUse, loadWaiting])

  if (!navigator.onLine || (!providers.mtn_momo && !providers.orange_money)) return null

  async function send() {
    const normalized = normalizeCameroonPhone(phone)
    const amt = Math.round(Number(amount))
    const problem = normalized ? checkRequest(amt, normalized) : 'phone'
    if (problem || !normalized) return setPhase({ k: 'stopped', reason: problem ?? 'phone' })
    setPhase({ k: 'sending' })
    const r = await call({ action: 'till_start', shop_id: ctx.shopId, provider, phone: normalized, amount: amt })
    if (!alive.current) return
    if (r.ok === true) setPhase({ k: 'waiting', id: String(r.id), since: new Date().toISOString(), provider, url: typeof r.payment_url === 'string' ? r.payment_url : undefined, checks: 0 })
    else setPhase({ k: 'stopped', reason: typeof r.reason === 'string' ? r.reason : 'error' })
  }

  const reasons = ['declined', 'expired', 'error', 'phone', 'amount', 'not_configured', 'too_many_open', 'provider_error']
  return (
    <section className="panel stack">
      <h4 className="h6">{t('collect.title')}</h4>
      <p className="body-sm muted">{t('collect.hint')}</p>
      {(phase.k === 'idle' || phase.k === 'stopped') && (
        <div className="stack">
          <select className={input} value={provider} onChange={(e) => setProvider(e.target.value as CollectionProvider)} aria-label={t('money.method')}>
            {providers.mtn_momo && <option value="mtn_momo">{t('pos.mtn_momo')}</option>}
            {providers.orange_money && <option value="orange_money">{t('pos.orange_money')}</option>}
          </select>
          <input className={input} type="tel" inputMode="tel" placeholder={t('collect.phone')} aria-label={t('collect.phone')} value={phone} onChange={(e) => setPhone(e.target.value)} />
          <input className={input} inputMode="numeric" placeholder={t('pos.amount')} aria-label={t('pos.amount')} value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))} />
          <button type="button" className={btn} onClick={() => void send()}>{t(provider === 'mtn_momo' ? 'collect.sendPrompt' : 'collect.orangePage')}</button>
          {phase.k === 'stopped' && <p role="alert" className="field__error">{t(`collect.stopped.${reasons.includes(phase.reason) ? phase.reason : 'error'}`)}</p>}
        </div>
      )}
      {phase.k === 'sending' && <p role="status" className="body-md">{t('payNow.sending')}</p>}
      {phase.k === 'waiting' && (
        <div className="stack">
          <p role="status" className="body-md">{t(phase.provider === 'mtn_momo' ? 'collect.waitingMtn' : 'collect.waitingOrange')}</p>
          {phase.url && <a className={`${btn} inline-flex items-center justify-center`} href={phase.url} target="_blank" rel="noopener noreferrer">{t('payNow.openPageLink')}</a>}
          <button type="button" className="btn btn--secondary" onClick={() => setPhase({ k: 'idle' })}>{t('collect.stopWaiting')}</button>
          <p className="body-sm muted">{t('collect.waitHint')}</p>
        </div>
      )}
      {waiting.filter((c) => !usedIds.includes(c.id)).length > 0 && (
        <div className="stack" style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 15 }}>
          <p className="label-lg">{t('collect.unused')}</p>
          {waiting.filter((c) => !usedIds.includes(c.id)).map((c) => (
            <div key={c.id} className="flex items-center justify-between gap-2 body-sm">
              <span>{formatXaf(c.amount)} · {t(`pos.${c.provider}`)} · {c.phone} · {new Date(c.createdAt).toLocaleString()}</span>
              <button type="button" className="btn btn--secondary btn--sm" disabled={fitsSale(c, remaining) !== null} onClick={() => onUse(c)}>{t('collect.use')}</button>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
