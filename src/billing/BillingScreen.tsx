import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { buildSubscriptionInvoice } from '../domain/invoice'
import { downloadPdf, invoiceFileName, renderInvoicePdf } from '../pdf/invoicePdf'
import { useBuyer } from '../features/invoices/useSeller'
import { useAuth } from '../auth/AuthProvider'
import { formatXaf } from '../domain/money'
import { normalizeCameroonPhone } from '../domain/onboarding'
import { DEFAULT_TERMS, quote, upgradeCharge, type BillingTerm, type PlanDef } from '../domain/subscription'
import { supabase } from '../lib/supabase'
import { refreshLicence } from './licenceStore'
import { useSubscription } from './useSubscription'

const input = 'min-h-12 w-full rounded border border-slate-300 bg-transparent px-3'
const btn = 'min-h-12 rounded bg-teal-700 px-4 font-semibold text-white disabled:opacity-60'

interface PlanRow { code: string; name: string; price_xaf: number | null; max_shops: number | null; max_staff: number | null; max_products: number | null }
interface Info { terms: BillingTerm[]; merchant_numbers: Record<string, string>; grace_days: number }
interface Payment { id: string; kind: 'renewal' | 'upgrade'; reference: string; status: string; expected_amount: number; plan_code: string; method: string; invoice_id: string | null; created_at: string }
interface Invoice { id: string; number: string; amount: number; plan_code: string; period_start: string | null; period_end: string; issued_at: string }
interface Sub { plan_code: string; next_plan_code: string | null; status: string; period_end: string }

const toPlan = (p: PlanRow): PlanDef => ({ code: p.code, name: p.name, priceXaf: p.price_xaf, maxShops: p.max_shops, maxStaff: p.max_staff, maxProducts: p.max_products })

/** Owner only: where the subscription stands, how to renew, plan changes, payments and invoices. */
export function BillingScreen() {
  const { t, i18n } = useTranslation()
  const { session, membership } = useAuth()
  const tenantId = membership?.tenantId
  const { state, status } = useSubscription()
  const [plans, setPlans] = useState<PlanRow[]>([])
  const [info, setInfo] = useState<Info | null>(null)
  const [usage, setUsage] = useState<{ shops: number; staff: number; products: number } | null>(null)
  const [sub, setSub] = useState<Sub | null>(null)
  const [payments, setPayments] = useState<Payment[]>([])
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [months, setMonths] = useState(1)
  const [method, setMethod] = useState<'mtn_momo' | 'orange_money'>('mtn_momo')
  const [phone, setPhone] = useState('')
  const [created, setCreated] = useState<{ reference: string; expected_amount: number; method: string } | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!supabase || !tenantId || !navigator.onLine) return
    const [p, i, u, s, pay, inv] = await Promise.all([
      supabase.from('plans').select('code, name, price_xaf, max_shops, max_staff, max_products').eq('active', true).order('price_xaf', { ascending: true, nullsFirst: false }),
      supabase.rpc('billing_info', { p_tenant: tenantId }),
      supabase.rpc('tenant_usage', { p_tenant: tenantId }),
      supabase.from('subscriptions').select('plan_code, next_plan_code, status, period_end').eq('tenant_id', tenantId).maybeSingle(),
      supabase.from('billing_payments').select('id, kind, reference, status, expected_amount, plan_code, method, invoice_id, created_at').eq('tenant_id', tenantId).order('created_at', { ascending: false }).limit(20),
      supabase.from('invoices').select('id, number, amount, plan_code, period_start, period_end, issued_at').eq('tenant_id', tenantId).order('issued_at', { ascending: false }).limit(20),
    ])
    setPlans((p.data as PlanRow[]) ?? [])
    setInfo((i.data as Info) ?? null)
    setUsage((u.data as typeof usage) ?? null)
    setSub((s.data as Sub) ?? null)
    setPayments((pay.data as Payment[]) ?? [])
    setInvoices((inv.data as Invoice[]) ?? [])
  }, [tenantId])

  useEffect(() => { void load() }, [load])

  // While a payment is waiting, look again every 10 seconds; once it is confirmed, fetch the new licence.
  const waiting = payments.some((p) => p.status === 'pending')
  useEffect(() => {
    if (!waiting) return
    const timer = setInterval(() => void load(), 10_000)
    return () => clearInterval(timer)
  }, [waiting, load])
  const confirmedCount = payments.filter((p) => p.invoice_id).length
  const buyer = useBuyer()
  async function invoicePdf(i: Invoice) {
    const pay = payments.find((p) => p.invoice_id === i.id)
    const inv = buildSubscriptionInvoice({
      number: i.number, issuedAt: i.issued_at, planName: i.plan_code.charAt(0).toUpperCase() + i.plan_code.slice(1), periodStart: i.period_start, periodEnd: i.period_end,
      amount: i.amount, method: pay?.method, seller: { name: 'StockCM', lines: ['stockcm.app'] }, buyer, lang: i18n.language.startsWith('fr') ? 'fr' : 'en',
    })
    downloadPdf(invoiceFileName(inv.number), await renderInvoicePdf(inv))
  }
  useEffect(() => {
    if (confirmedCount > 0 && session) void refreshLicence(session.access_token)
  }, [confirmedCount, session])

  const current = plans.find((p) => p.code === sub?.plan_code)
  const effective = plans.find((p) => p.code === (sub?.next_plan_code ?? sub?.plan_code))
  const terms = info?.terms ?? [...DEFAULT_TERMS]
  const term = terms.find((x) => x.months === months) ?? terms[0]
  const q = useMemo(() => (effective?.price_xaf != null ? quote(toPlan(effective), term) : null), [effective, term])
  const money = (m: number) => formatXaf(m)

  const guard = async (fn: () => Promise<void>) => {
    setMsg(null)
    try { await fn(); await load() } catch (e) { setMsg(t('billing.error', { msg: (e as Error).message })) }
  }

  async function createPayment(e: FormEvent) {
    e.preventDefault()
    const normalized = normalizeCameroonPhone(phone)
    if (!normalized) return setMsg(t('auth.invalidPhone'))
    await guard(async () => {
      const { data, error } = await supabase!.rpc('create_billing_payment', {
        p_tenant: tenantId, p_kind: 'renewal', p_plan: effective!.code, p_months: months, p_method: method, p_phone: normalized,
      })
      if (error) throw new Error(error.message)
      setCreated({ ...(data as { reference: string; expected_amount: number }), method })
    })
  }

  async function switchPlan(p: PlanRow) {
    await guard(async () => {
      const { data, error } = await supabase!.rpc('change_plan', { p_tenant: tenantId, p_plan: p.code })
      if (error) throw new Error(error.message)
      const r = data as { applied?: string; requires_payment?: boolean }
      if (r.requires_payment) {
        const normalized = normalizeCameroonPhone(phone)
        if (!normalized) throw new Error(t('auth.invalidPhone'))
        const pay = await supabase!.rpc('create_billing_payment', { p_tenant: tenantId, p_kind: 'upgrade', p_plan: p.code, p_months: null, p_method: method, p_phone: normalized })
        if (pay.error) throw new Error(pay.error.message)
        setCreated({ ...(pay.data as { reference: string; expected_amount: number }), method })
      } else {
        setMsg(r.applied === 'at_renewal' ? t('billing.appliedLater') : t('billing.appliedNow'))
      }
    })
  }

  if (!navigator.onLine) return <p className="text-slate-500">{t('billing.offlineNeeded')}</p>
  if (!current) return null

  const days = state?.daysLeft ?? 0
  const lim = (v: number | null) => (v === null ? t('billing.unlimited') : String(v))

  return (
    <div className="flex flex-col gap-4">
      <h3 className="text-lg font-semibold">{t('billing.title')}</h3>

      <section className="rounded border border-slate-200 p-3">
        <p className="text-xl font-bold">{current.name}</p>
        <p>{status ? t(`billing.status.${status === 'valid' ? (sub?.status === 'trial' ? 'trial' : 'active') : status === 'sync_required' || status === 'clock_changed' ? 'active' : status}`) : ''}</p>
        {sub && <p className="text-sm text-slate-600 dark:text-slate-300">{t('billing.endsOn', { date: new Date(sub.period_end).toLocaleDateString() })} · {t('billing.daysLeft', { n: Math.max(days, 0) })}</p>}
        {sub?.next_plan_code && (
          <p className="mt-2 text-sm">{t('billing.scheduled', { plan: plans.find((p) => p.code === sub.next_plan_code)?.name })}{' '}
            <button className="text-teal-700 underline" onClick={() => void guard(async () => { await supabase!.rpc('change_plan', { p_tenant: tenantId, p_plan: current.code }) })}>{t('billing.cancelScheduled')}</button>
          </p>
        )}
        <p className="mt-2 text-sm font-medium">{t('billing.limits')}</p>
        <ul className="text-sm text-slate-600 dark:text-slate-300">
          <li>{t('billing.shops')}: {usage?.shops ?? '–'} / {lim(current.max_shops)}</li>
          <li>{t('billing.staff')}: {usage?.staff ?? '–'} / {lim(current.max_staff)}</li>
          <li>{t('billing.products')}: {usage?.products ?? '–'} / {lim(current.max_products)}</li>
        </ul>
      </section>

      <form onSubmit={createPayment} className="flex flex-col gap-3 rounded border border-slate-200 p-3">
        <h4 className="font-semibold">{t('billing.renew')}{effective && effective.code !== current.code ? ` (${effective.name})` : ''}</h4>
        <select className={input} value={months} onChange={(e) => setMonths(Number(e.target.value))} aria-label={t('billing.renew')}>
          {terms.map((x) => <option key={x.months} value={x.months}>{t('billing.term', { months: x.months })}{x.bonus ? ` · ${t('billing.bonus', { bonus: x.bonus })}` : ''}</option>)}
        </select>
        {q && <p className="text-lg font-bold">{t('billing.total')}: {money(q.amount)}</p>}
        <select className={input} value={method} onChange={(e) => setMethod(e.target.value as typeof method)} aria-label={t('billing.method')}>
          <option value="mtn_momo">{t('pos.mtn_momo')}</option>
          <option value="orange_money">{t('pos.orange_money')}</option>
        </select>
        <input className={input} type="tel" inputMode="tel" placeholder={t('billing.phone')} value={phone} onChange={(e) => setPhone(e.target.value)} />
        <button className={btn} disabled={!q}>{t('billing.createPayment')}</button>
      </form>

      {created && (
        <section role="status" className="rounded border-2 border-teal-700 p-3">
          <p>{t('billing.reference')}: <strong className="text-xl tracking-widest">{created.reference}</strong></p>
          <p>{t('billing.amountToPay')}: <strong>{money(created.expected_amount)}</strong></p>
          {info?.merchant_numbers?.[created.method]
            ? <p>{t('billing.sendTo', { method: t(`pos.${created.method}`) })}: <strong>{info.merchant_numbers[created.method]}</strong></p>
            : <p className="text-amber-800">{t('billing.merchantMissing')}</p>}
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">{t('billing.howToPay')}</p>
        </section>
      )}

      <section>
        <h4 className="mb-2 font-semibold">{t('billing.changePlan')}</h4>
        <ul className="flex flex-col gap-2">
          {plans.filter((p) => p.code !== current.code).map((p) => {
            const up = p.price_xaf !== null && current.price_xaf !== null && p.price_xaf > current.price_xaf
            const charge = up && sub?.status !== 'trial' ? upgradeCharge(current.price_xaf!, p.price_xaf!, days) : 0
            return (
              <li key={p.code} className="flex items-center justify-between gap-2 rounded border border-slate-200 p-3">
                <span>
                  <strong>{p.name}</strong> · {p.price_xaf === null ? t('billing.custom') : `${money(p.price_xaf)}/m`}
                  {charge > 0 && <span className="block text-xs text-slate-500">{t('billing.upgradeCharge', { amount: money(charge), days })}</span>}
                </span>
                {p.price_xaf !== null && <button className="min-h-12 rounded border border-teal-700 px-3 text-teal-700" onClick={() => void switchPlan(p)}>{t('billing.switchTo', { plan: p.name })}</button>}
              </li>
            )
          })}
        </ul>
      </section>

      <section>
        <h4 className="mb-2 font-semibold">{t('billing.history')}</h4>
        {payments.length === 0 && <p className="text-slate-500">{t('billing.noHistory')}</p>}
        <ul className="divide-y divide-slate-200 text-sm dark:divide-slate-800">
          {payments.map((p) => (
            <li key={p.id} className="flex justify-between gap-2 py-2">
              <span>{t(`billing.kind.${p.kind}`)} · {p.reference}<span className="block text-xs text-slate-500">{new Date(p.created_at).toLocaleDateString()}</span></span>
              <span className="text-right">{money(p.expected_amount)}<span className="block text-xs">{p.status === 'provider_verified' ? t('billing.confirmed') : p.status === 'recorded' ? t('billing.recorded') : p.status === 'failed' ? t('billing.failed') : t('billing.pending')}</span></span>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h4 className="mb-2 font-semibold">{t('billing.invoices')}</h4>
        <ul className="divide-y divide-slate-200 text-sm dark:divide-slate-800">
          {invoices.map((i) => <li key={i.id} className="flex items-center justify-between gap-2 py-2"><span>{i.number}<span className="block text-xs text-slate-500">{new Date(i.issued_at).toLocaleDateString()}</span></span><span className="flex items-center gap-3">{money(i.amount)}<button className="min-h-10 rounded border border-slate-300 px-3" onClick={() => void invoicePdf(i)}>{t('invoices.pdf')}</button></span></li>)}
        </ul>
      </section>
      {msg && <p role="status" className="text-sm text-red-700">{msg}</p>}
    </div>
  )
}
