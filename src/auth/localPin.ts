import { db } from '../data/db'
import { attemptsLeft, lockSeconds } from '../domain/staffPin'

/**
 * Offline re-unlock for a staff member who already signed in on this device.
 *
 * The PIN is never stored. Only a salted PBKDF2 verifier is, so the PIN can be CHECKED offline but not
 * read back. Wrong-PIN counting and lockout run here too. Limits (documented, not hidden): someone who can
 * wipe this browser's storage can reset the local counter, and this check only RESUMES a session that was
 * already issued by the server; it cannot create one, and it cannot switch to a different staff member.
 */
const ITERATIONS = 150_000

interface LocalPin {
  salt: string
  hash: string
  iterations: number
  failed: number
  lockedUntil: number
  name: string
}

const key = (userId: string) => `pin:${userId}`
const b64 = (u8: Uint8Array) => btoa(String.fromCharCode(...u8))
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

export async function pbkdf2(pin: string, salt: string, iterations: number): Promise<string> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64(salt) as BufferSource, iterations }, material, 256)
  return b64(new Uint8Array(bits))
}

/** Compare without stopping at the first difference. */
function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export async function enrollLocalPin(userId: string, pin: string, name: string, iterations = ITERATIONS): Promise<void> {
  const salt = b64(crypto.getRandomValues(new Uint8Array(16)))
  const rec: LocalPin = { salt, hash: await pbkdf2(pin, salt, iterations), iterations, failed: 0, lockedUntil: 0, name }
  await db.meta.put({ key: key(userId), value: rec })
}

export async function removeLocalPin(userId: string): Promise<void> {
  await db.meta.delete(key(userId))
}

export async function hasLocalPin(userId: string): Promise<boolean> {
  return Boolean(await db.meta.get(key(userId)))
}

export type LocalCheck =
  | { ok: true }
  | { ok: false; reason: 'none' }
  | { ok: false; reason: 'locked'; retryAfterSec: number }
  | { ok: false; reason: 'wrong'; attemptsLeft: number; retryAfterSec: number }

export async function verifyLocalPin(userId: string, pin: string, now = Date.now()): Promise<LocalCheck> {
  const row = await db.meta.get(key(userId))
  if (!row) return { ok: false, reason: 'none' }
  const rec = row.value as LocalPin
  if (rec.lockedUntil > now) return { ok: false, reason: 'locked', retryAfterSec: Math.ceil((rec.lockedUntil - now) / 1000) }

  const candidate = await pbkdf2(pin, rec.salt, rec.iterations)
  if (sameSecret(candidate, rec.hash)) {
    await db.meta.put({ key: key(userId), value: { ...rec, failed: 0, lockedUntil: 0 } })
    return { ok: true }
  }
  const failed = rec.failed + 1
  const wait = lockSeconds(failed)
  await db.meta.put({ key: key(userId), value: { ...rec, failed, lockedUntil: wait > 0 ? now + wait * 1000 : 0 } })
  return { ok: false, reason: 'wrong', attemptsLeft: attemptsLeft(failed), retryAfterSec: wait }
}
