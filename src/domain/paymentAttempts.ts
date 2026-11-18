/**
 * Rules for trying to collect one subscription payment through a mobile-money provider. The database enforces the same
 * rules (migration 0025, begin_payment_attempt); this copy lets the screen explain them and is tested against the same cases.
 */

export type AttemptStatus = 'initiated' | 'pending' | 'successful' | 'failed' | 'error'

export interface AttemptLite {
  status: AttemptStatus
  createdAt: string
}

/** An attempt that has not finished blocks a new one for this long (the phone prompt lasts about this long). */
export const LIVE_ATTEMPT_MINUTES = 3
/** At most this many attempts per payment: more than this is a person to talk to, not a retry. */
export const MAX_ATTEMPTS = 5

export type AttemptGate = 'ok' | 'in_progress' | 'too_many' | 'already_paid'

export function attemptGate(attempts: readonly AttemptLite[], now: Date): AttemptGate {
  if (attempts.some((a) => a.status === 'successful')) return 'already_paid'
  if (attempts.length >= MAX_ATTEMPTS) return 'too_many'
  const liveSince = now.getTime() - LIVE_ATTEMPT_MINUTES * 60_000
  if (attempts.some((a) => (a.status === 'initiated' || a.status === 'pending') && new Date(a.createdAt).getTime() > liveSince)) return 'in_progress'
  return 'ok'
}

/** How long to wait before asking again: quick at first, then slower, never hammering the provider. */
export function pollDelayMs(checks: number): number {
  return checks < 6 ? 5_000 : checks < 18 ? 10_000 : 30_000
}

/** After this long a prompt nobody answered is treated as gone. */
export const GIVE_UP_MINUTES = 10
export const isStale = (createdAt: string, now: Date): boolean => now.getTime() - new Date(createdAt).getTime() > GIVE_UP_MINUTES * 60_000
