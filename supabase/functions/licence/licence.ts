/**
 * Signed licence (a compact ES256 token, like a JWT). The SERVER signs it; a device only needs the PUBLIC key to
 * check it, so it works offline and cannot be forged on the device.
 *
 * What it carries: the business, its plan and limits, when the paid period and grace period end, and `validUntil`
 * = the earlier of (grace end) and (issued + 30 days). So a device must sync at least every 30 days, and a lapsed
 * subscription stops new records on its own once grace ends, even with no connection.
 *
 * This file is also copied into supabase/functions/licence/licence.ts for the Edge Function that signs tokens.
 * A test keeps the two identical. Uses only standard WebCrypto, so it runs in browsers, Node and Deno.
 */

export interface LicenceLimits {
  shops: number | null
  staff: number | null
  products: number | null
}

export interface LicencePayload {
  v: 1
  /** Tenant (business) id. */
  sub: string
  plan: string
  limits: LicenceLimits
  /** 'trial' | 'active' | 'suspended' as stored; the live state is derived from the dates below. */
  base: 'trial' | 'active' | 'suspended'
  periodEnd: number
  graceEnd: number
  issuedAt: number
  offlineDays: number
  validUntil: number
}

const DAY = 86_400_000

export function buildPayload(a: {
  tenantId: string
  plan: string
  limits: LicenceLimits
  base: 'trial' | 'active' | 'suspended'
  periodEndMs: number
  graceDays: number
  offlineDays: number
  nowMs: number
}): LicencePayload {
  const graceEnd = a.periodEndMs + a.graceDays * DAY
  return {
    v: 1, sub: a.tenantId, plan: a.plan, limits: a.limits, base: a.base, periodEnd: a.periodEndMs, graceEnd,
    issuedAt: a.nowMs, offlineDays: a.offlineDays, validUntil: Math.min(graceEnd, a.nowMs + a.offlineDays * DAY),
  }
}

/* ------------------------------ encoding helpers ------------------------------ */

const enc = new TextEncoder()
const dec = new TextDecoder()

export function toB64u(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromB64u(text: string): Uint8Array {
  const pad = text.length % 4 === 0 ? '' : '='.repeat(4 - (text.length % 4))
  const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/') + pad)
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

const ALG = { name: 'ECDSA', namedCurve: 'P-256' } as const
const SIGN = { name: 'ECDSA', hash: 'SHA-256' } as const

export async function generateLicenceKeys(): Promise<{ publicJwk: JsonWebKey; privateJwk: JsonWebKey }> {
  const pair = await crypto.subtle.generateKey(ALG, true, ['sign', 'verify'])
  return {
    publicJwk: await crypto.subtle.exportKey('jwk', pair.publicKey),
    privateJwk: await crypto.subtle.exportKey('jwk', pair.privateKey),
  }
}

/* ---------------------------------- sign / verify ---------------------------------- */

export async function signLicence(payload: LicencePayload, privateJwk: JsonWebKey): Promise<string> {
  const header = toB64u(enc.encode(JSON.stringify({ alg: 'ES256', typ: 'LIC' })))
  const body = toB64u(enc.encode(JSON.stringify(payload)))
  const key = await crypto.subtle.importKey('jwk', privateJwk, ALG, false, ['sign'])
  const sig = new Uint8Array(await crypto.subtle.sign(SIGN, key, enc.encode(`${header}.${body}`)))
  return `${header}.${body}.${toB64u(sig)}`
}

/** Returns the payload only if the signature is valid. Anything malformed, forged or of another algorithm gives null. */
export async function verifyLicence(token: string, publicJwk: JsonWebKey): Promise<LicencePayload | null> {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const header = JSON.parse(dec.decode(fromB64u(parts[0])))
    if (header.alg !== 'ES256') return null // never trust the token to choose its own algorithm
    const key = await crypto.subtle.importKey('jwk', publicJwk, ALG, false, ['verify'])
    const ok = await crypto.subtle.verify(SIGN, key, fromB64u(parts[2]) as BufferSource, enc.encode(`${parts[0]}.${parts[1]}`))
    if (!ok) return null
    const p = JSON.parse(dec.decode(fromB64u(parts[1]))) as LicencePayload
    return p.v === 1 && typeof p.sub === 'string' ? p : null
  } catch {
    return null
  }
}

/* ------------------------------- what the device does ------------------------------- */

/**
 *  valid          full use
 *  grace          the paid period ended; full use with a warning
 *  sync_required  not synced for `offlineDays`: read-only until the device connects (it does NOT mean unpaid)
 *  expired        grace ended: read-only until renewed
 *  suspended      read-only, set by StockCM staff
 *  clock_changed  the device clock went backwards: read-only until it syncs
 */
export type LicenceStatus = 'valid' | 'grace' | 'sync_required' | 'expired' | 'suspended' | 'clock_changed'

const CLOCK_SLACK_MS = 5 * 60_000

export function licenceStatus(p: LicencePayload, nowMs: number, latestTimeSeenMs = 0): LicenceStatus {
  if (p.base === 'suspended') return 'suspended'
  if (nowMs + CLOCK_SLACK_MS < latestTimeSeenMs) return 'clock_changed'
  if (nowMs >= p.graceEnd) return 'expired'
  if (nowMs >= p.issuedAt + p.offlineDays * DAY) return 'sync_required'
  return nowMs >= p.periodEnd ? 'grace' : 'valid'
}

export const licenceAllowsWrites = (s: LicenceStatus): boolean => s === 'valid' || s === 'grace'
