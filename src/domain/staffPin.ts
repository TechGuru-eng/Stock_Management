/**
 * Staff PIN rules. The SAME rules are enforced on the server (supabase/migrations/0010_staff_pin.sql)
 * and here, so a weak PIN is refused before it is ever sent and cannot be saved by a modified client.
 */

export type PinProblem = 'format' | 'repeated' | 'sequence' | 'common'

/** Very common PINs people guess first. Refused even though they pass the format checks. */
const COMMON = new Set([
  '1212', '2580', '0852', '2000', '1004', '1122', '6969', '1313', '4200', '1010',
  '123123', '121212', '112233', '696969', '159753', '789456', '123321', '654321', '111222', '102030',
])

export function validatePin(pin: string): { ok: true } | { ok: false; problem: PinProblem } {
  if (!/^[0-9]{4,6}$/.test(pin)) return { ok: false, problem: 'format' }
  if (/^(\d)\1+$/.test(pin)) return { ok: false, problem: 'repeated' }
  const d = [...pin].map(Number)
  const step = d[1] - d[0]
  if ((step === 1 || step === -1) && d.every((x, i) => i === 0 || x - d[i - 1] === step)) return { ok: false, problem: 'sequence' }
  if (COMMON.has(pin)) return { ok: false, problem: 'common' }
  return { ok: true }
}

/** After this many wrong PINs in a row the account locks. */
export const MAX_FREE_ATTEMPTS = 5
const BASE_LOCK_SECONDS = 300
const MAX_LOCK_SECONDS = 3600

/**
 * Lock length after `failed` wrong PINs in a row: nothing for the first 4, then 5 minutes at the 5th,
 * doubling with every further wrong PIN, up to one hour. A correct PIN resets the count.
 */
export function lockSeconds(failed: number): number {
  if (failed < MAX_FREE_ATTEMPTS) return 0
  return Math.min(BASE_LOCK_SECONDS * 2 ** (failed - MAX_FREE_ATTEMPTS), MAX_LOCK_SECONDS)
}

/** Wrong PINs still allowed before the next lock. */
export function attemptsLeft(failed: number): number {
  return Math.max(MAX_FREE_ATTEMPTS - failed, 0)
}

/* ------------------------------ session policy ------------------------------ */

/** A signed-in staff device locks itself after this long without activity. */
export const IDLE_LOCK_MINUTES = 5
/** A staff member must sign in again with the server after this long (when online). */
export const MAX_SESSION_HOURS = 12

export function idleExpired(lastActivityMs: number, nowMs: number, minutes = IDLE_LOCK_MINUTES): boolean {
  return nowMs - lastActivityMs >= minutes * 60_000
}

export function sessionExpired(loggedInMs: number, nowMs: number, hours = MAX_SESSION_HOURS): boolean {
  return nowMs - loggedInMs >= hours * 3_600_000
}
