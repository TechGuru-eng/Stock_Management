import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../auth/AuthProvider'
import { isStale, pollDelayMs } from '../domain/paymentAttempts'
import { supabase } from '../lib/supabase'

const base = `${(import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? ''}/functions/v1`
const btn = 'btn btn--primary'

type Phase =
  | { k: 'idle' }
  | { k: 'sending' }
  | { k: 'waiting'; attempt: string; since: string; url?: string; checks: number }
  | { k: 'paid' }
  | { k: 'stopped'; reason: string }

/**
 * "Pay now" for a pending subscription payment: MTN sends a prompt to the owner's phone, Orange gives a payment page.
 * The screen only asks the server what happened; it never decides that money arrived. Hidden when the provider is not set up,
 * so the manual "send money with this reference" route stays the way to pay.
 */
export function PayNow({ paymentId, method, onPaid }: { paymentId: string; method: 'mtn_momo' | 'orange_money'; onPaid: () => void }) {
  const { t, i18n } = useTranslation()
  const { session } = useAuth()
  const [available, setAvailable] = useState(false)
  const [phase, setPhase] = useState<Phase>({ k: 'idle' })
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false; if (timer.current) clearTimeout(timer.current) }, [])

  const call = useCallback(async (body: Record<string, unknown>, lang?: string) => {
    const res = await fetch(`${base}/payments${lang ? `?lang=${lang}` : ''}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token ?? ''}` }, body: JSON.stringify(body),
    })
    return (await res.json().catch(() => ({}))) as Record<string, unknown>
  }, [session])

  // Is this provider switched on? And is there already a prompt waiting (page reloaded)?
  useEffect(() => {
    if (!supabase || !navigator.onLine) return
    let live = true
    void (async () => {
      const m = await supabase!.rpc('payment_methods_available')
      if (!live) return
      setAvailable(Boolean((m.data as Record<string, boolean> | null)?.[method]))
      const a = await supabase!.from('payment_attempts').select('id, status, created_at, payment_url').eq('payment_id', paymentId).in('status', ['initiated', 'pending']).order('created_at', { ascending: false }).limit(1).maybeSingle()
      if (live && a.data && !isStale(a.data.created_at as string, new Date())) setPhase({ k: 'waiting', attempt: a.data.id as string, since: a.data.created_at as string, url: (a.data.payment_url as string | null) ?? undefined, checks: 0 })
    })()
    return () => { live = false }
  }, [paymentId, method])

  // While waiting: ask the server, slowly more rarely, until it is over (or ten minutes have passed: then offer a retry).
  useEffect(() => {
    if (phase.k !== 'waiting') return
    const w = phase
    timer.current = setTimeout(async () => {
      const r = await call({ action: 'check', attempt_id: w.attempt })
      if (!alive.current) return
      const status = String(r.status ?? 'pending')
      if (status === 'successful') { setPhase({ k: 'paid' }); onPaid(); return }
      if (status === 'failed' || status === 'error') { setPhase({ k: 'stopped', reason: status === 'failed' ? 'declined' : 'error' }); return }
      if (isStale(w.since, new Date())) { setPhase({ k: 'stopped', reason: 'expired' }); return }
      setPhase({ ...w, checks: w.checks + 1 })
    }, pollDelayMs(w.checks))
    return () => { if (timer.current) clearTimeout(timer.current) }
  }, [phase, call, onPaid])

  async function start() {
    setPhase({ k: 'sending' })
    const r = await call({ action: 'start', payment_id: paymentId }, i18n.language.startsWith('fr') ? 'fr' : 'en')
    if (!alive.current) return
    if (r.ok === true) setPhase({ k: 'waiting', attempt: String(r.attempt), since: new Date().toISOString(), url: typeof r.payment_url === 'string' ? r.payment_url : undefined, checks: 0 })
    else setPhase({ k: 'stopped', reason: typeof r.reason === 'string' ? r.reason : typeof r.error === 'string' ? r.error : 'error' })
  }

  if (!available) return null
  if (phase.k === 'paid') return <p role="status" className="notice body-md" style={{ marginTop: 8 }}>{t('payNow.paid')}</p>
  return (
    <div className="stack" style={{ marginTop: 15, borderTop: '1px solid var(--border-subtle)', paddingTop: 15 }}>
      {(phase.k === 'idle' || phase.k === 'stopped') && (
        <>
          <button type="button" className={btn} onClick={() => void start()}>{t(method === 'mtn_momo' ? 'payNow.sendPrompt' : 'payNow.openPage')}</button>
          {phase.k === 'stopped' && <p role="alert" className="field__error">{t(`payNow.stopped.${['declined', 'expired', 'error', 'in_progress', 'too_many', 'already_paid', 'not_payable', 'not_configured', 'provider_error'].includes(phase.reason) ? phase.reason : 'error'}`)}</p>}
        </>
      )}
      {phase.k === 'sending' && <p role="status" className="body-md">{t('payNow.sending')}</p>}
      {phase.k === 'waiting' && (
        <>
          <p role="status" className="body-md">{t(method === 'mtn_momo' ? 'payNow.waitingMtn' : 'payNow.waitingOrange')}</p>
          {phase.url && <a className={`${btn} inline-flex items-center justify-center`} href={phase.url} target="_blank" rel="noopener noreferrer">{t('payNow.openPageLink')}</a>}
          <p className="body-sm muted">{t('payNow.waitHint')}</p>
        </>
      )}
    </div>
  )
}
