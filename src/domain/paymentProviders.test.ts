import { describe, expect, it } from 'vitest'
import appCopy from './paymentProviders.ts?raw'
import edgeCopy from '../../supabase/functions/payments/providers.ts?raw'
import {
  ProviderError, basicAuth, memoryTokenCache, mtnRequestToPay, mtnStatus, mtnToken, msisdn, orangeInitiate, orangeStatus, orangeToken, parseMtnConfig, parseOrangeConfig, wholeAmount,
  type Http, type HttpRequest, type MtnConfig, type OrangeConfig,
} from './paymentProviders'
import { MAX_ATTEMPTS, attemptGate, isStale, pollDelayMs } from './paymentAttempts'

const mtn: MtnConfig = { baseUrl: 'https://mtn.test', subscriptionKey: 'sub', apiUser: 'user', apiKey: 'key', targetEnvironment: 'sandbox', currency: 'XAF' }
const orange: OrangeConfig = { baseUrl: 'https://orange.test', authorization: 'Basic abc', merchantKey: 'mk', currency: 'XAF', returnUrl: 'https://app.test/back', cancelUrl: 'https://app.test/cancel' }
const ID = '11111111-2222-4333-8444-555555555555'

/** A scripted fake provider: answers by "METHOD path", records every call. */
function fake(routes: Record<string, { status: number; body?: unknown } | ((req: HttpRequest) => { status: number; body?: unknown })>) {
  const calls: { url: string; init: HttpRequest }[] = []
  const http: Http = async (url, init) => {
    calls.push({ url, init })
    const path = new URL(url).pathname
    const r = routes[`${init.method} ${path}`]
    if (!r) return { status: 500, text: 'no route' }
    const out = typeof r === 'function' ? r(init) : r
    return { status: out.status, text: out.body === undefined ? '' : JSON.stringify(out.body) }
  }
  return { http, calls }
}
const tokenRoute = { 'POST /collection/token/': { status: 200, body: { access_token: 'T1', expires_in: 3600 } } }

describe('the server copy', () => {
  it('is identical to the one the tests run', () => {
    expect(edgeCopy).toBe(appCopy)
  })
})

describe('small helpers', () => {
  it('whole amounts only', () => {
    expect(wholeAmount('15000')).toBe(15000)
    expect(wholeAmount('15000.0')).toBe(15000)
    expect(wholeAmount(15000)).toBe(15000)
    expect(wholeAmount('150.5')).toBeNull()
    expect(wholeAmount('-5')).toBeNull()
    expect(wholeAmount('abc')).toBeNull()
    expect(wholeAmount(0)).toBeNull()
  })
  it('turns a Cameroon number into an MSISDN and refuses anything else', () => {
    expect(msisdn('+237677123456')).toBe('237677123456')
    expect(() => msisdn('677123456')).toThrow(ProviderError)
  })
  it('builds a Basic header', () => {
    expect(basicAuth('user', 'key')).toBe('Basic dXNlcjprZXk=')
  })
  it('config must be complete and https', () => {
    expect(parseMtnConfig(mtn)).toEqual(mtn)
    expect(parseMtnConfig({ ...mtn, baseUrl: 'http://mtn.test' })).toBeNull()
    expect(parseMtnConfig({ ...mtn, apiKey: '' })).toBeNull()
    expect(parseMtnConfig(null)).toBeNull()
    expect(parseOrangeConfig(orange)).toEqual(orange)
    expect(parseOrangeConfig({ ...orange, returnUrl: 'http://x.test' })).toBeNull()
    expect(parseOrangeConfig({ ...orange, merchantKey: undefined })).toBeNull()
  })
})

describe('the token cache', () => {
  it('reuses a token until shortly before it expires, then asks again', async () => {
    let t = 0
    const cache = memoryTokenCache(() => t)
    const { http, calls } = fake(tokenRoute)
    expect(await mtnToken(mtn, http, cache)).toBe('T1')
    expect(await mtnToken(mtn, http, cache)).toBe('T1')
    expect(calls).toHaveLength(1)
    t = 3_600_000 // an hour later: expired
    await mtnToken(mtn, http, cache)
    expect(calls).toHaveLength(2)
  })
  it('sends the credentials the way MTN asks', async () => {
    const { http, calls } = fake(tokenRoute)
    await mtnToken(mtn, http)
    expect(calls[0].init.headers).toMatchObject({ Authorization: basicAuth('user', 'key'), 'Ocp-Apim-Subscription-Key': 'sub' })
  })
  it('refused credentials are a human problem, not a retry', async () => {
    const { http } = fake({ 'POST /collection/token/': { status: 401 } })
    await expect(mtnToken(mtn, http)).rejects.toMatchObject({ retryable: false })
  })
})

describe('MTN: asking the customer to pay', () => {
  const route = { ...tokenRoute, 'POST /collection/v1_0/requesttopay': { status: 202 } }
  const req = { attemptId: ID, amount: 15_000, phone: '+237677123456', externalId: 'STK-ABCD2345', message: 'StockCM', callbackUrl: 'https://f.test/payments?cb=' + ID }
  it('sends the right request: our attempt id as the reference, whole-franc amount, the customer MSISDN', async () => {
    const { http, calls } = fake(route)
    await mtnRequestToPay(mtn, http, req)
    const c = calls[1]
    expect(c.init.headers).toMatchObject({ 'X-Reference-Id': ID, 'X-Target-Environment': 'sandbox', Authorization: 'Bearer T1', 'X-Callback-Url': req.callbackUrl })
    expect(JSON.parse(c.init.body!)).toMatchObject({ amount: '15000', currency: 'XAF', externalId: 'STK-ABCD2345', payer: { partyIdType: 'MSISDN', partyId: '237677123456' } })
  })
  it('a repeat of the same reference (409) is not an error and charges nothing new', async () => {
    const { http } = fake({ ...tokenRoute, 'POST /collection/v1_0/requesttopay': { status: 409 } })
    await expect(mtnRequestToPay(mtn, http, req)).resolves.toBeUndefined()
  })
  it('a provider outage can be retried; bad credentials or a bad request cannot', async () => {
    await expect(mtnRequestToPay(mtn, fake({ ...tokenRoute, 'POST /collection/v1_0/requesttopay': { status: 503 } }).http, req)).rejects.toMatchObject({ retryable: true })
    await expect(mtnRequestToPay(mtn, fake({ ...tokenRoute, 'POST /collection/v1_0/requesttopay': { status: 400 } }).http, req)).rejects.toMatchObject({ retryable: false })
  })
  it('refuses a silly amount or number before any network call', async () => {
    const { http, calls } = fake(route)
    await expect(mtnRequestToPay(mtn, http, { ...req, amount: 0 })).rejects.toThrow()
    await expect(mtnRequestToPay(mtn, http, { ...req, phone: '12345' })).rejects.toThrow()
    expect(calls.filter((c) => c.url.includes('requesttopay'))).toHaveLength(0)
  })
})

describe('MTN: what happened to the payment', () => {
  const statusOf = (body: unknown, status = 200) => fake({ ...tokenRoute, [`GET /collection/v1_0/requesttopay/${ID}`]: { status, body } }).http
  it('pending stays pending; unknown to the provider yet is also pending', async () => {
    expect(await mtnStatus(mtn, statusOf({ status: 'PENDING' }), ID)).toEqual({ state: 'pending' })
    expect(await mtnStatus(mtn, statusOf({}, 404), ID)).toEqual({ state: 'pending' })
  })
  it('successful carries the amount and the provider reference that the server will check and record', async () => {
    expect(await mtnStatus(mtn, statusOf({ status: 'SUCCESSFUL', amount: '15000', currency: 'XAF', financialTransactionId: 'FT123' }), ID)).toEqual({ state: 'successful', amount: 15000, providerReference: 'FT123' })
  })
  it('failed carries the reason', async () => {
    expect(await mtnStatus(mtn, statusOf({ status: 'FAILED', reason: 'PAYER_NOT_FOUND' }), ID)).toEqual({ state: 'failed', reason: 'PAYER_NOT_FOUND' })
    expect(await mtnStatus(mtn, statusOf({ status: 'FAILED', reason: { code: 'NOT_ENOUGH_FUNDS' } }), ID)).toMatchObject({ reason: 'NOT_ENOUGH_FUNDS' })
  })
  it('never believes a success in the wrong currency, with a strange amount, or with an unknown status', async () => {
    await expect(mtnStatus(mtn, statusOf({ status: 'SUCCESSFUL', amount: '15000', currency: 'EUR' }), ID)).rejects.toThrow(/currency/)
    await expect(mtnStatus(mtn, statusOf({ status: 'SUCCESSFUL', amount: '1.5', currency: 'XAF' }), ID)).rejects.toThrow(/amount/)
    await expect(mtnStatus(mtn, statusOf({ status: 'WEIRD' }), ID)).rejects.toThrow(/unknown status/)
  })
  it('garbage from the provider is an error, not a guess', async () => {
    const http: Http = async (url) => (url.includes('token') ? { status: 200, text: JSON.stringify({ access_token: 'T' }) } : { status: 200, text: '<html>' })
    await expect(mtnStatus(mtn, http, ID)).rejects.toThrow(/unreadable/)
  })
})

describe('Orange: sending the customer to the payment page', () => {
  const otoken = { 'POST /oauth/v3/token': { status: 200, body: { access_token: 'OT', expires_in: '3600' } } }
  const init = { attemptId: ID, amount: 5000, externalId: 'STK-ABCD2345', notifUrl: 'https://f.test/payments?cb=' + ID, lang: 'fr' as const }
  it('asks for a token with the given authorization, then creates the web payment', async () => {
    const { http, calls } = fake({ ...otoken, 'POST /orange-money-webpay/cm/v1/webpayment': { status: 201, body: { status: 201, pay_token: 'PT1', payment_url: 'https://pay.orange.test/x', notif_token: 'n' } } })
    expect(await orangeInitiate(orange, http, init)).toEqual({ paymentUrl: 'https://pay.orange.test/x', payToken: 'PT1' })
    expect(calls[0].init.headers.Authorization).toBe('Basic abc')
    expect(calls[0].init.body).toBe('grant_type=client_credentials')
    expect(JSON.parse(calls[1].init.body!)).toMatchObject({ merchant_key: 'mk', currency: 'XAF', order_id: ID, amount: 5000, notif_url: init.notifUrl, reference: 'STK-ABCD2345' })
  })
  it('never sends the customer to a non-https address (no script links)', async () => {
    for (const url of ['javascript:alert(1)', 'http://x.test', 'data:text/html,x']) {
      const { http } = fake({ ...otoken, 'POST /orange-money-webpay/cm/v1/webpayment': { status: 201, body: { pay_token: 'P', payment_url: url } } })
      await expect(orangeInitiate(orange, http, init)).rejects.toThrow(/no payment page/)
    }
  })
  it('token parsing tolerates a numeric string for the expiry', async () => {
    expect(await orangeToken(orange, fake(otoken).http)).toBe('OT')
  })
})

describe('Orange: what happened to the payment', () => {
  const q = { attemptId: ID, amount: 5000, payToken: 'PT1' }
  const s = (body: unknown, status = 200) => fake({ 'POST /oauth/v3/token': { status: 200, body: { access_token: 'OT', expires_in: 3600 } }, 'POST /orange-money-webpay/cm/v1/transactionstatus': { status, body } }).http
  it('maps the provider statuses', async () => {
    expect(await orangeStatus(orange, s({ status: 'PENDING' }), q)).toEqual({ state: 'pending' })
    expect(await orangeStatus(orange, s({ status: 'INITIATED' }), q)).toEqual({ state: 'pending' })
    expect(await orangeStatus(orange, s({ status: 'SUCCESS', txnid: 'MP1' }), q)).toEqual({ state: 'successful', amount: 5000, providerReference: 'MP1' })
    expect(await orangeStatus(orange, s({ status: 'EXPIRED' }), q)).toEqual({ state: 'failed', reason: 'expired' })
    expect(await orangeStatus(orange, s({ status: 'FAILED' }), q)).toMatchObject({ state: 'failed' })
    await expect(orangeStatus(orange, s({ status: 'MAYBE' }), q)).rejects.toThrow(/unknown status/)
  })
})

describe('the attempt rules', () => {
  const now = new Date('2026-11-18T10:00:00Z')
  const at = (minAgo: number) => new Date(now.getTime() - minAgo * 60_000).toISOString()
  it('one live prompt at a time; a finished or old one does not block', () => {
    expect(attemptGate([], now)).toBe('ok')
    expect(attemptGate([{ status: 'pending', createdAt: at(1) }], now)).toBe('in_progress')
    expect(attemptGate([{ status: 'pending', createdAt: at(5) }], now)).toBe('ok') // the prompt has lapsed
    expect(attemptGate([{ status: 'failed', createdAt: at(1) }], now)).toBe('ok') // wrong PIN: try again
  })
  it('a paid payment is never charged again, and retries are limited', () => {
    expect(attemptGate([{ status: 'successful', createdAt: at(60) }], now)).toBe('already_paid')
    expect(attemptGate(Array.from({ length: MAX_ATTEMPTS }, () => ({ status: 'failed' as const, createdAt: at(60) })), now)).toBe('too_many')
  })
  it('polling slows down and a stale prompt is recognised', () => {
    expect(pollDelayMs(0)).toBeLessThan(pollDelayMs(10))
    expect(pollDelayMs(10)).toBeLessThan(pollDelayMs(40))
    expect(isStale(at(11), now)).toBe(true)
    expect(isStale(at(2), now)).toBe(false)
  })
})

import sigApp from './webhookSignature.ts?raw'
import sigPayments from '../../supabase/functions/payments/signature.ts?raw'
describe('the signature helper copied into the payments function', () => {
  it('is identical', () => {
    expect(sigPayments).toBe(sigApp)
  })
})
