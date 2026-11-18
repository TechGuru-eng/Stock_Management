/**
 * Mobile-money provider adapters (MTN MoMo "Collection" and Orange Money "WebPay"), used to collect subscription payments.
 *
 * Pure: no Deno or browser APIs, the network is injected (`Http`). Copied into supabase/functions/payments/providers.ts
 * (a test keeps the two identical), so what the tests exercise is what runs on the server.
 *
 * The one rule that matters: a provider's callback is only a NUDGE. Anyone can POST to a public URL, and MTN's callbacks
 * carry no signature at all. So nothing in a callback is believed; the server asks the provider, with its own credentials,
 * what happened to this payment, and believes only that answer.
 *
 * Written from the providers' public documentation and tested against fakes. It has NOT been run against the real MTN or
 * Orange servers (that needs the business's own provider credentials).
 */

export type PayState = 'pending' | 'successful' | 'failed'

export interface HttpRequest {
  method: 'GET' | 'POST'
  headers: Record<string, string>
  body?: string
}
export interface HttpResponse {
  status: number
  text: string
}
export type Http = (url: string, init: HttpRequest) => Promise<HttpResponse>

/** `retryable`: the same request may work later (provider down, rate limited). Otherwise something needs a person (bad credentials, wrong currency). */
export class ProviderError extends Error {
  readonly retryable: boolean
  constructor(message: string, retryable: boolean) {
    super(message)
    this.retryable = retryable
  }
}

export interface StatusResult {
  state: PayState
  /** What the provider says was paid (whole XAF). Absent when the provider does not say. */
  amount?: number
  providerReference?: string
  reason?: string
}

export interface TokenCache {
  get(key: string): string | undefined
  set(key: string, token: string, ttlSeconds: number): void
}

export function memoryTokenCache(now: () => number = Date.now): TokenCache {
  const m = new Map<string, { token: string; until: number }>()
  return {
    get(key) {
      const e = m.get(key)
      return e && e.until > now() ? e.token : undefined
    },
    set(key, token, ttl) {
      m.set(key, { token, until: now() + Math.max(0, ttl - 60) * 1000 })
    },
  }
}

const enc = new TextEncoder()
export const basicAuth = (user: string, secret: string): string => {
  const bytes = enc.encode(`${user}:${secret}`)
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return `Basic ${btoa(s)}`
}

/** Strict parse of a JSON body; anything else is a provider fault, not something to guess at. */
function json(res: HttpResponse, what: string): Record<string, unknown> {
  try {
    const v = JSON.parse(res.text) as unknown
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  } catch {
    /* fall through */
  }
  throw new ProviderError(`${what}: unreadable answer from the provider`, res.status >= 500)
}

function failFor(res: HttpResponse, what: string): never {
  if (res.status === 429 || res.status >= 500) throw new ProviderError(`${what}: provider unavailable (${res.status})`, true)
  if (res.status === 401 || res.status === 403) throw new ProviderError(`${what}: credentials refused (${res.status})`, false)
  throw new ProviderError(`${what}: refused (${res.status})`, false)
}

const isHttps = (u: unknown): u is string => typeof u === 'string' && /^https:\/\/[^\s/]+/.test(u) && !u.endsWith('/')
const str = (v: unknown, max = 300): string | null => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null)

/** A whole-franc amount from a provider's string or number ("15000", "15000.0", 15000). Anything fractional or odd is refused. */
export function wholeAmount(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+(\.0+)?$/.test(v.trim()) ? Number(v) : NaN
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

/** +2376XXXXXXXX -> 2376XXXXXXXX (what MTN wants as the MSISDN). */
export function msisdn(phone: string): string {
  if (!/^\+2376\d{8}$/.test(phone)) throw new ProviderError('not a Cameroon mobile number', false)
  return phone.slice(1)
}

/* ----------------------------------- MTN ----------------------------------- */

export interface MtnConfig {
  /** e.g. https://sandbox.momodeveloper.mtn.com (no trailing slash) */
  baseUrl: string
  subscriptionKey: string
  apiUser: string
  apiKey: string
  /** "sandbox" for tests, the country code the provider gave you for real money (e.g. "mtncameroon"). */
  targetEnvironment: string
  /** The sandbox only accepts "EUR"; real Cameroon payments are "XAF". */
  currency: string
}

export function parseMtnConfig(raw: unknown): MtnConfig | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const c = { baseUrl: r.baseUrl, subscriptionKey: str(r.subscriptionKey), apiUser: str(r.apiUser), apiKey: str(r.apiKey), targetEnvironment: str(r.targetEnvironment, 40), currency: str(r.currency, 3) }
  if (!isHttps(c.baseUrl) || !c.subscriptionKey || !c.apiUser || !c.apiKey || !c.targetEnvironment || !c.currency) return null
  return c as MtnConfig
}

export async function mtnToken(cfg: MtnConfig, http: Http, cache?: TokenCache): Promise<string> {
  const key = `mtn:${cfg.apiUser}`
  const hit = cache?.get(key)
  if (hit) return hit
  const res = await http(`${cfg.baseUrl}/collection/token/`, {
    method: 'POST',
    headers: { Authorization: basicAuth(cfg.apiUser, cfg.apiKey), 'Ocp-Apim-Subscription-Key': cfg.subscriptionKey },
  })
  if (res.status !== 200) failFor(res, 'MTN token')
  const b = json(res, 'MTN token')
  const token = str(b.access_token, 4000)
  if (!token) throw new ProviderError('MTN token: no token in the answer', false)
  cache?.set(key, token, typeof b.expires_in === 'number' ? b.expires_in : 300)
  return token
}

export interface MtnRequest {
  /** Our attempt id (a UUID): MTN uses it as the payment's reference, so asking twice with it cannot charge twice. */
  attemptId: string
  amount: number
  phone: string
  /** Our own reference (STK-XXXXXXXX), shown in MTN's records. */
  externalId: string
  message: string
  callbackUrl?: string
}

/** Sends the "approve this payment" prompt to the customer's phone. Resolves when MTN has ACCEPTED the request (not when it is paid). */
export async function mtnRequestToPay(cfg: MtnConfig, http: Http, r: MtnRequest, cache?: TokenCache): Promise<void> {
  if (!Number.isSafeInteger(r.amount) || r.amount <= 0) throw new ProviderError('bad amount', false)
  const token = await mtnToken(cfg, http, cache)
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'X-Reference-Id': r.attemptId,
    'X-Target-Environment': cfg.targetEnvironment,
    'Ocp-Apim-Subscription-Key': cfg.subscriptionKey,
    'Content-Type': 'application/json',
  }
  if (r.callbackUrl) headers['X-Callback-Url'] = r.callbackUrl
  const res = await http(`${cfg.baseUrl}/collection/v1_0/requesttopay`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      amount: String(r.amount),
      currency: cfg.currency,
      externalId: r.externalId,
      payer: { partyIdType: 'MSISDN', partyId: msisdn(r.phone) },
      payerMessage: r.message.slice(0, 100),
      payeeNote: r.externalId,
    }),
  })
  // 202 = accepted. 409 = this reference was already sent (a retry of the same attempt): nothing new was charged.
  if (res.status === 202 || res.status === 409) return
  if (res.status === 401) cache?.set(`mtn:${cfg.apiUser}`, '', 0) // the cached token went stale: fetch a new one next time
  failFor(res, 'MTN request to pay')
}

export async function mtnStatus(cfg: MtnConfig, http: Http, attemptId: string, cache?: TokenCache): Promise<StatusResult> {
  const token = await mtnToken(cfg, http, cache)
  const res = await http(`${cfg.baseUrl}/collection/v1_0/requesttopay/${encodeURIComponent(attemptId)}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}`, 'X-Target-Environment': cfg.targetEnvironment, 'Ocp-Apim-Subscription-Key': cfg.subscriptionKey },
  })
  if (res.status === 404) return { state: 'pending' } // just sent: the provider may not have it yet
  if (res.status !== 200) failFor(res, 'MTN status')
  const b = json(res, 'MTN status')
  const status = String(b.status ?? '').toUpperCase()
  if (status === 'PENDING') return { state: 'pending' }
  if (status === 'FAILED') {
    const reason = typeof b.reason === 'string' ? b.reason : b.reason && typeof b.reason === 'object' ? str((b.reason as Record<string, unknown>).code ?? (b.reason as Record<string, unknown>).message, 100) : null
    return { state: 'failed', reason: reason ?? undefined }
  }
  if (status !== 'SUCCESSFUL') throw new ProviderError(`MTN status: unknown status "${status.slice(0, 30)}"`, false)
  if (String(b.currency ?? '') !== cfg.currency) throw new ProviderError('MTN status: paid in a different currency than asked', false)
  const amount = wholeAmount(b.amount)
  if (amount === null) throw new ProviderError('MTN status: unreadable amount', false)
  return { state: 'successful', amount, providerReference: str(b.financialTransactionId, 100) ?? `mtn:${attemptId}` }
}

/* ---------------------------------- Orange --------------------------------- */

export interface OrangeConfig {
  /** https://api.orange.com (no trailing slash) */
  baseUrl: string
  /** The full Authorization header value Orange gave you for the token call, e.g. "Basic abc123...". */
  authorization: string
  merchantKey: string
  currency: string
  /** Where the customer lands after paying or cancelling, and where Orange tells us (a nudge only). */
  returnUrl: string
  cancelUrl: string
}

export function parseOrangeConfig(raw: unknown): OrangeConfig | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const c = { baseUrl: r.baseUrl, authorization: str(r.authorization, 1000), merchantKey: str(r.merchantKey), currency: str(r.currency, 3), returnUrl: r.returnUrl, cancelUrl: r.cancelUrl }
  const page = (u: unknown) => typeof u === 'string' && /^https:\/\/\S+$/.test(u)
  if (!isHttps(c.baseUrl) || !c.authorization || !c.merchantKey || !c.currency || !page(c.returnUrl) || !page(c.cancelUrl)) return null
  return c as OrangeConfig
}

export async function orangeToken(cfg: OrangeConfig, http: Http, cache?: TokenCache): Promise<string> {
  const key = 'orange'
  const hit = cache?.get(key)
  if (hit) return hit
  const res = await http(`${cfg.baseUrl}/oauth/v3/token`, {
    method: 'POST',
    headers: { Authorization: cfg.authorization, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: 'grant_type=client_credentials',
  })
  if (res.status !== 200) failFor(res, 'Orange token')
  const b = json(res, 'Orange token')
  const token = str(b.access_token, 4000)
  if (!token) throw new ProviderError('Orange token: no token in the answer', false)
  cache?.set(key, token, typeof b.expires_in === 'number' ? b.expires_in : Number(b.expires_in) || 300)
  return token
}

export interface OrangeInit {
  paymentUrl: string
  payToken: string
}

/** Orange has no prompt on the phone: it returns a page where the customer pays. We send the customer there. */
export async function orangeInitiate(cfg: OrangeConfig, http: Http, r: { attemptId: string; amount: number; externalId: string; notifUrl: string; lang: 'fr' | 'en' }, cache?: TokenCache): Promise<OrangeInit> {
  if (!Number.isSafeInteger(r.amount) || r.amount <= 0) throw new ProviderError('bad amount', false)
  const token = await orangeToken(cfg, http, cache)
  const res = await http(`${cfg.baseUrl}/orange-money-webpay/cm/v1/webpayment`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      merchant_key: cfg.merchantKey, currency: cfg.currency, order_id: r.attemptId, amount: r.amount,
      return_url: cfg.returnUrl, cancel_url: cfg.cancelUrl, notif_url: r.notifUrl, lang: r.lang, reference: r.externalId,
    }),
  })
  if (res.status === 401) cache?.set('orange', '', 0)
  if (res.status !== 200 && res.status !== 201) failFor(res, 'Orange web payment')
  const b = json(res, 'Orange web payment')
  const payToken = str(b.pay_token, 300)
  const paymentUrl = str(b.payment_url, 2000)
  // The customer is sent to this address: it must be an https page, never something a bad answer could turn into a script link.
  if (!payToken || !paymentUrl || !/^https:\/\/[^\s]+$/.test(paymentUrl)) throw new ProviderError('Orange web payment: no payment page in the answer', false)
  return { paymentUrl, payToken }
}

export async function orangeStatus(cfg: OrangeConfig, http: Http, r: { attemptId: string; amount: number; payToken: string }, cache?: TokenCache): Promise<StatusResult> {
  const token = await orangeToken(cfg, http, cache)
  const res = await http(`${cfg.baseUrl}/orange-money-webpay/cm/v1/transactionstatus`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ order_id: r.attemptId, amount: r.amount, pay_token: r.payToken }),
  })
  if (res.status === 404) return { state: 'pending' }
  if (res.status !== 200) failFor(res, 'Orange status')
  const b = json(res, 'Orange status')
  const status = String(b.status ?? '').toUpperCase()
  if (status === 'INITIATED' || status === 'PENDING') return { state: 'pending' }
  if (status === 'FAILED' || status === 'EXPIRED') return { state: 'failed', reason: status.toLowerCase() }
  if (status !== 'SUCCESS' && status !== 'SUCCESSFUL') throw new ProviderError(`Orange status: unknown status "${status.slice(0, 30)}"`, false)
  // Orange checks the amount we send against the order; it does not return one, so the amount asked for is the amount paid.
  return { state: 'successful', amount: r.amount, providerReference: str(b.txnid, 100) ?? `orange:${r.attemptId}` }
}
