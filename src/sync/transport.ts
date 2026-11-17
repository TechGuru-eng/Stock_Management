export interface WireOp {
  op_id: string
  table: string
  payload: Record<string, unknown>
}

export interface PullResponse {
  rows: Record<string, Record<string, unknown>[]>
  /** Resume point for the next page (a server timestamp, kept as the exact string). */
  cursor: string
  has_more: boolean
  server_time: string
  subscription?: Record<string, unknown> | null
}

/**
 * What the sync engine needs from the server. The real implementation talks to
 * Supabase; tests plug in an in-memory fake that behaves like it.
 */
export interface SyncTransport {
  registerDevice(deviceId: string, tenantId: string, name: string): Promise<void>
  push(deviceId: string, ops: WireOp[]): Promise<{ applied: number; skipped: number }>
  pull(since: string, limit: number): Promise<PullResponse>
  /**
   * OPTIONAL, best effort: tell the platform that an event was refused here, so support can help. Only the kind and
   * the server's own error text are sent, never the business data. Failures are ignored.
   */
  reportIssue?(tenantId: string, deviceId: string, groupId: string, kind: 'rejected' | 'conflict', error: string): Promise<void>
  resolveIssue?(tenantId: string, groupId: string): Promise<void>
}

/**
 *  network   : could not reach the server / temporary server trouble. Retry later, keep everything.
 *  auth      : session expired or missing. Retry after sign-in refresh, keep everything.
 *  permanent : the server understood and REFUSED. Retrying the same data will not help.
 */
export type TransportErrorKind = 'network' | 'auth' | 'permanent'

export class TransportError extends Error {
  kind: TransportErrorKind
  code?: string
  constructor(kind: TransportErrorKind, message: string, code?: string) {
    super(message)
    this.name = 'TransportError'
    this.kind = kind
    this.code = code
  }
}

/** Postgres / PostgREST error -> how the engine should react. */
export function classifyServerError(error: { code?: string | null; message?: string | null }): TransportErrorKind {
  const code = error.code ?? ''
  const msg = error.message ?? ''
  if (!code) return /fetch|network|timeout|offline|abort|failed to/i.test(msg) ? 'network' : 'permanent'
  // SB402 = subscription ended: keep everything and retry after renewal. (SB403, plan limit, stays a refusal.)
  if (code === 'SB402' || /subscription_expired/.test(msg)) return 'auth'
  if (code === '28000' || code === 'PGRST301' || code === 'PGRST303' || /jwt/i.test(msg)) return 'auth'
  // 08 connection, 53 resources, 57 operator/timeouts, XX internal, PGRST0xx server-side trouble
  if (/^(08|53|57|XX)/.test(code) || /^PGRST0/.test(code)) return 'network'
  return 'permanent'
}
