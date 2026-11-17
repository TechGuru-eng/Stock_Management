import appCopy from './licence.ts?raw'
import edgeCopy from '../../supabase/functions/licence/licence.ts?raw'
import { describe, expect, it } from 'vitest'
import {
  buildPayload, fromB64u, generateLicenceKeys, licenceAllowsWrites, licenceStatus, signLicence, toB64u, verifyLicence,
  type LicencePayload,
} from './licence'

const DAY = 86_400_000
const now = Date.parse('2026-11-17T12:00:00Z')
const limits = { shops: 1, staff: 5, products: 5000 }

const make = (over: Partial<Parameters<typeof buildPayload>[0]> = {}): LicencePayload =>
  buildPayload({ tenantId: 'tenant-1', plan: 'business', limits, base: 'active', periodEndMs: now + 20 * DAY, graceDays: 7, offlineDays: 30, nowMs: now, ...over })

describe('licence signature', () => {
  it('a token signed by the server verifies with the public key', async () => {
    const keys = await generateLicenceKeys()
    const token = await signLicence(make(), keys.privateJwk)
    const p = await verifyLicence(token, keys.publicJwk)
    expect(p).toMatchObject({ sub: 'tenant-1', plan: 'business', limits })
  })

  it('the public key cannot sign, and a different key does not verify', async () => {
    const a = await generateLicenceKeys()
    const b = await generateLicenceKeys()
    const token = await signLicence(make(), a.privateJwk)
    expect(await verifyLicence(token, b.publicJwk)).toBeNull()
    expect('d' in a.publicJwk).toBe(false) // the private part is not in the public key
  })

  it('changing even one character of the payload breaks the signature (e.g. extending your own plan)', async () => {
    const keys = await generateLicenceKeys()
    const token = await signLicence(make({ plan: 'starter' }), keys.privateJwk)
    const [h, , s] = token.split('.')
    const forged = toB64u(new TextEncoder().encode(JSON.stringify({ ...make({ plan: 'pro' }) })))
    expect(await verifyLicence(`${h}.${forged}.${s}`, keys.publicJwk)).toBeNull()
  })

  it('rejects malformed tokens and tokens that pick their own algorithm', async () => {
    const keys = await generateLicenceKeys()
    expect(await verifyLicence('', keys.publicJwk)).toBeNull()
    expect(await verifyLicence('a.b', keys.publicJwk)).toBeNull()
    expect(await verifyLicence('not.a.token', keys.publicJwk)).toBeNull()
    const none = `${toB64u(new TextEncoder().encode('{"alg":"none"}'))}.${toB64u(new TextEncoder().encode(JSON.stringify(make())))}.`
    expect(await verifyLicence(none, keys.publicJwk)).toBeNull()
  })

  it('base64url round-trips awkward bytes', () => {
    const bytes = Uint8Array.from([0, 250, 251, 252, 253, 254, 255, 62, 63])
    expect(Array.from(fromB64u(toB64u(bytes)))).toEqual(Array.from(bytes))
  })
})

describe('what a device does with a licence (tests 15, 20)', () => {
  const p = make() // period ends in 20 days, grace 7 more, must sync within 30

  it('valid in the middle of a paid period', () => {
    expect(licenceStatus(p, now)).toBe('valid')
    expect(licenceStatus(p, now + 10 * DAY)).toBe('valid')
  })
  it('grace after the period ends: still full use', () => {
    const s = licenceStatus(p, now + 22 * DAY)
    expect(s).toBe('grace')
    expect(licenceAllowsWrites(s)).toBe(true)
  })
  it('expired once grace ends: read-only, even with no connection', () => {
    const s = licenceStatus(p, now + 27 * DAY)
    expect(s).toBe('expired')
    expect(licenceAllowsWrites(s)).toBe(false)
  })
  it('the 30-day offline rule and the paid period agree: whichever ends first applies', () => {
    const long = make({ periodEndMs: now + 365 * DAY }) // paid for a year
    expect(licenceStatus(long, now + 29 * DAY)).toBe('valid')
    expect(licenceStatus(long, now + 31 * DAY)).toBe('sync_required') // paid up, but must connect: NOT "unpaid"
    expect(licenceAllowsWrites(licenceStatus(long, now + 31 * DAY))).toBe(false)
    expect(make({ periodEndMs: now + 10 * DAY }).validUntil).toBe(now + 17 * DAY) // grace ends before 30 days
    expect(long.validUntil).toBe(now + 30 * DAY)
  })
  it('a suspended business is read-only', () => {
    expect(licenceStatus(make({ base: 'suspended' }), now)).toBe('suspended')
  })
  it('moving the device clock backwards is noticed', () => {
    expect(licenceStatus(p, now - 3 * DAY, now + 5 * DAY)).toBe('clock_changed')
    expect(licenceStatus(p, now + 5 * DAY - 60_000, now + 5 * DAY)).toBe('valid') // a minute of drift is fine
  })
})

describe('the signing code is the same in the app and in the Edge Function', () => {
  it('the two copies are identical', () => {
    expect(edgeCopy.replace(/\r\n/g, '\n')).toBe(appCopy.replace(/\r\n/g, '\n'))
  })
})
