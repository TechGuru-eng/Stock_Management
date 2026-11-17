import { describe, expect, it } from 'vitest'
import appCopy from './webhookSignature.ts?raw'
import edgeCopy from '../../supabase/functions/billing-webhook/signature.ts?raw'
import { hmacHex, parseWebhook, sameHex, verifySignature } from './webhookSignature'

const secret = 'test-secret-do-not-use-in-production'
const body = JSON.stringify({ reference: 'STK-ABCD2345', provider: 'mtn_momo', provider_reference: 'MP260101.1234', status: 'SUCCESSFUL', amount: 15000, currency: 'XAF' })

describe('webhook signature', () => {
  it('accepts the exact message that was signed', async () => {
    expect(await verifySignature(body, await hmacHex(secret, body), secret)).toBe(true)
  })
  it('refuses a message changed by even one character (e.g. raising the amount)', async () => {
    const sig = await hmacHex(secret, body)
    expect(await verifySignature(body.replace('15000', '15001'), sig, secret)).toBe(false)
  })
  it('refuses a signature made with another secret, a missing signature, or a missing secret', async () => {
    expect(await verifySignature(body, await hmacHex('someone-elses-secret', body), secret)).toBe(false)
    expect(await verifySignature(body, null, secret)).toBe(false)
    expect(await verifySignature(body, 'abc', secret)).toBe(false)
    expect(await verifySignature(body, await hmacHex(secret, body), null)).toBe(false)
  })
  it('compares in a way that ignores case but not content', () => {
    expect(sameHex('ABCDEF', 'abcdef')).toBe(true)
    expect(sameHex('abcdef', 'abcdee')).toBe(false)
    expect(sameHex('abc', 'abcd')).toBe(false)
  })
  it('is a standard HMAC-SHA256 (a known test vector)', async () => {
    expect(await hmacHex('key', 'The quick brown fox jumps over the lazy dog')).toBe('f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8')
  })
})

describe('webhook message parsing', () => {
  it('reads a good message', () => {
    expect(parseWebhook(body)).toEqual({ reference: 'STK-ABCD2345', provider: 'mtn_momo', providerReference: 'MP260101.1234', outcome: 'successful', amount: 15000 })
  })
  it.each([
    ['not json'], ['{}'],
    [JSON.stringify({ reference: 'bad', provider: 'mtn', provider_reference: 'x', status: 'successful', amount: 1, currency: 'XAF' })],
    [JSON.stringify({ reference: 'STK-ABCD2345', provider: 'mtn', provider_reference: 'x', status: 'pending', amount: 1, currency: 'XAF' })],
    [JSON.stringify({ reference: 'STK-ABCD2345', provider: 'mtn', provider_reference: 'x', status: 'successful', amount: 10.5, currency: 'XAF' })],
    [JSON.stringify({ reference: 'STK-ABCD2345', provider: 'mtn', provider_reference: 'x', status: 'successful', amount: -5, currency: 'XAF' })],
    [JSON.stringify({ reference: 'STK-ABCD2345', provider: 'mtn', provider_reference: 'x', status: 'successful', amount: 100, currency: 'USD' })],
    [JSON.stringify({ reference: 'STK-ABCD2345', provider: 'MTN; drop', provider_reference: 'x', status: 'successful', amount: 100, currency: 'XAF' })],
  ])('refuses %s', (raw) => {
    expect(parseWebhook(raw)).toBeNull()
  })
})

describe('the Edge Function copy', () => {
  it('is identical to the app copy', () => {
    expect(edgeCopy.replace(/\r\n/g, '\n')).toBe(appCopy.replace(/\r\n/g, '\n'))
  })
})
