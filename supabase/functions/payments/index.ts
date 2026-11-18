// StockCM Edge Function: payments
// Collects a subscription payment through MTN MoMo (a prompt on the customer's phone) or Orange Money (a payment page).
//
// POST { action: 'start', payment_id }       signed in as the owner: sends the prompt / creates the payment page
// POST { action: 'check', attempt_id }       signed in as the owner: asks the provider what happened, settles if it is over
// POST ?cb=<attempt id>                       the provider's callback. NOT believed: it only makes us ask the provider.
// POST ?reconcile=1  (signed like the billing webhook)   a scheduled sweep that asks about every open attempt
//
// verify_jwt is OFF for this function because the callback has no login; 'start' and 'check' check the user themselves.
// Truth only ever comes from asking the provider with our own credentials; settling goes through the database's
// idempotent confirm path (amount must match, a provider reference can be used once).
import { createClient } from 'jsr:@supabase/supabase-js@2'
import {
  ProviderError, memoryTokenCache, mtnRequestToPay, mtnStatus, orangeInitiate, orangeStatus, parseMtnConfig, parseOrangeConfig,
  type Http, type StatusResult,
} from './providers.ts'
import { verifySignature } from './signature.ts'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-stockcm-signature',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const url = Deno.env.get('SUPABASE_URL')!
const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } })
const cache = memoryTokenCache()
const http: Http = async (u, init) => {
  const res = await fetch(u, { method: init.method, headers: init.headers, body: init.body, signal: AbortSignal.timeout(15_000) })
  return { status: res.status, text: await res.text() }
}

async function config(provider: string) {
  const { data } = await admin.from('platform_secrets').select('value').eq('key', `provider_${provider}`).maybeSingle()
  if (!data?.value) return null
  try {
    const raw = JSON.parse(data.value)
    return provider === 'mtn_momo' ? { kind: 'mtn' as const, cfg: parseMtnConfig(raw) } : { kind: 'orange' as const, cfg: parseOrangeConfig(raw) }
  } catch {
    return null
  }
}

/** Ask the provider about one attempt and record the answer. Safe to call as often as you like: it is rate-limited and idempotent. */
async function refresh(attemptId: string): Promise<{ status: string; reason?: string }> {
  const touch = (await admin.rpc('payment_attempt_touch', { p_attempt: attemptId })).data as { ok: boolean; done?: boolean; throttled?: boolean; status?: string } | null
  if (!touch?.ok) return { status: 'unknown' }
  if (touch.done || touch.throttled) return { status: touch.status ?? 'pending' }
  const a = (await admin.rpc('payment_attempt_get', { p_attempt: attemptId })).data as { id: string; provider: string; amount: number; pay_token: string | null } | null
  if (!a) return { status: 'unknown' }
  const c = await config(a.provider)
  if (!c?.cfg) {
    await admin.rpc('payment_attempt_error', { p_attempt: attemptId, p_reason: 'provider_not_configured' })
    return { status: 'error', reason: 'provider_not_configured' }
  }
  let st: StatusResult
  try {
    if (c.kind === 'mtn') st = await mtnStatus(c.cfg as never, http, a.id, cache)
    else if (!a.pay_token) return { status: 'pending' }
    else st = await orangeStatus(c.cfg as never, http, { attemptId: a.id, amount: Number(a.amount), payToken: a.pay_token }, cache)
  } catch (e) {
    if (e instanceof ProviderError && e.retryable) return { status: 'pending' } // provider is having a bad moment: ask again later
    const reason = e instanceof ProviderError ? e.message : 'provider_error'
    await admin.rpc('payment_attempt_error', { p_attempt: attemptId, p_reason: reason })
    return { status: 'error', reason }
  }
  if (st.state === 'pending') return { status: 'pending' }
  const { data } = await admin.rpc('settle_payment_attempt', {
    p_attempt: attemptId, p_state: st.state, p_amount: st.amount ?? null, p_provider_ref: st.providerReference ?? null, p_reason: st.reason ?? null,
  })
  const r = data as { status?: string; reason?: string } | null
  return { status: r?.status ?? 'pending', reason: r?.reason }
}

async function start(req: Request, paymentId: string) {
  const authorization = req.headers.get('Authorization')
  if (!authorization) return json({ error: 'unauthorized' }, 401)
  // The database decides whether this person may do this, as them (billing.manage on this payment's business).
  const user = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authorization } }, auth: { persistSession: false, autoRefreshToken: false } })
  const { data, error } = await user.rpc('begin_payment_attempt', { p_payment: paymentId })
  if (error) return json({ error: 'not_allowed' }, error.code === '42501' ? 403 : 400)
  const b = data as { ok: boolean; reason?: string; attempt: string; provider: string; amount: number; phone: string; reference: string }
  if (!b.ok) return json({ ok: false, reason: b.reason }, 200)

  const c = await config(b.provider)
  if (!c?.cfg) {
    await admin.rpc('payment_attempt_error', { p_attempt: b.attempt, p_reason: 'provider_not_configured' })
    return json({ ok: false, reason: 'not_configured' })
  }
  const callbackUrl = `${url}/functions/v1/payments?cb=${b.attempt}`
  try {
    if (c.kind === 'mtn') {
      await mtnRequestToPay(c.cfg as never, http, { attemptId: b.attempt, amount: Number(b.amount), phone: b.phone, externalId: b.reference, message: 'StockCM', callbackUrl }, cache)
      await admin.rpc('payment_attempt_sent', { p_attempt: b.attempt, p_pay_token: null, p_payment_url: null })
      return json({ ok: true, attempt: b.attempt, provider: b.provider })
    }
    const lang = (new URL(req.url).searchParams.get('lang') ?? 'fr') === 'en' ? 'en' : 'fr'
    const o = await orangeInitiate(c.cfg as never, http, { attemptId: b.attempt, amount: Number(b.amount), externalId: b.reference, notifUrl: callbackUrl, lang }, cache)
    await admin.rpc('payment_attempt_sent', { p_attempt: b.attempt, p_pay_token: o.payToken, p_payment_url: o.paymentUrl })
    return json({ ok: true, attempt: b.attempt, provider: b.provider, payment_url: o.paymentUrl })
  } catch (e) {
    const reason = e instanceof ProviderError ? e.message : 'provider_error'
    await admin.rpc('payment_attempt_error', { p_attempt: b.attempt, p_reason: reason })
    return json({ ok: false, reason: 'provider_error', retryable: e instanceof ProviderError ? e.retryable : true })
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST' && req.method !== 'GET') return json({ error: 'method_not_allowed' }, 405)
  const q = new URL(req.url).searchParams

  // The provider's callback: ignore what it says, just look into this attempt. Always the same harmless answer.
  const cb = q.get('cb')
  if (cb !== null) {
    if (UUID.test(cb)) await refresh(cb)
    return json({ ok: true })
  }

  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)
  const raw = await req.text()
  if (raw.length > 5_000) return json({ error: 'too_large' }, 413)

  if (q.get('reconcile') === '1') {
    const { data: sec } = await admin.from('platform_secrets').select('value').eq('key', 'billing_webhook_secret').maybeSingle()
    if (!(await verifySignature(raw, req.headers.get('x-stockcm-signature'), sec?.value ?? null))) return json({ error: 'bad_signature' }, 401)
    const { data: ids } = await admin.rpc('payment_attempts_open', { p_limit: 20 })
    let n = 0
    for (const id of (ids as string[] | null) ?? []) { await refresh(id); n++ }
    return json({ ok: true, checked: n })
  }

  let body: Record<string, unknown>
  try { body = JSON.parse(raw) } catch { return json({ error: 'bad_request' }, 400) }

  if (body.action === 'start' && typeof body.payment_id === 'string' && UUID.test(body.payment_id)) return await start(req, body.payment_id)

  if (body.action === 'check' && typeof body.attempt_id === 'string' && UUID.test(body.attempt_id)) {
    const authorization = req.headers.get('Authorization')
    if (!authorization) return json({ error: 'unauthorized' }, 401)
    const user = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authorization } }, auth: { persistSession: false, autoRefreshToken: false } })
    const { data } = await user.from('payment_attempts').select('id').eq('id', body.attempt_id).maybeSingle() // row-level security: only the owner of that business sees it
    if (!data) return json({ error: 'not_found' }, 404)
    return json({ ok: true, ...(await refresh(body.attempt_id)) })
  }
  return json({ error: 'bad_request' }, 400)
})
