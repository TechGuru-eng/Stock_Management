import { deviceId } from '../data/db'

/**
 * Talks to the two Edge Functions. The browser only ever holds a public key and a device secret:
 * the service-role key lives in the function, never here.
 */
const base = `${import.meta.env.VITE_SUPABASE_URL as string | undefined ?? ''}/functions/v1`
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export class StaffApiError extends Error {
  status: number
  code: string
  attemptsLeft?: number
  retryAfter?: number
  constructor(status: number, code: string, extra: { attemptsLeft?: number; retryAfter?: number } = {}) {
    super(code)
    this.status = status
    this.code = code
    this.attemptsLeft = extra.attemptsLeft
    this.retryAfter = extra.retryAfter
  }
}

async function call<T>(fn: 'staff-auth' | 'staff-admin', body: Record<string, unknown>, token?: string): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${base}/${fn}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: anonKey ?? '', Authorization: `Bearer ${token ?? anonKey ?? ''}` },
      body: JSON.stringify(body),
    })
  } catch {
    throw new StaffApiError(0, 'network')
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    throw new StaffApiError(res.status, String(data.error ?? data.code ?? 'server_error'), {
      attemptsLeft: typeof data.attempts_left === 'number' ? data.attempts_left : undefined,
      retryAfter: typeof data.retry_after === 'number' ? data.retry_after : undefined,
    })
  }
  return data as T
}

export interface StaffEntry {
  id: string
  full_name: string
  role: 'manager' | 'cashier' | 'storekeeper'
}

export interface StaffLoginResult {
  session: { access_token: string; refresh_token: string }
  staff: { membership_id: string; user_id: string; role: string; full_name: string; tenant_id: string }
}

/* ------------------------ this device's registration ------------------------ */

const K = { secret: 'stockcm.device.secret', tenant: 'stockcm.device.tenant', list: 'stockcm.staffList' }
const read = (k: string) => {
  try { return localStorage.getItem(k) } catch { return null }
}
const write = (k: string, v: string | null) => {
  try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v) } catch { /* storage unavailable */ }
}

export interface Enrollment {
  secret: string
  tenantName: string
}

export function getEnrollment(): Enrollment | null {
  const secret = read(K.secret)
  return secret ? { secret, tenantName: read(K.tenant) ?? '' } : null
}

export function clearEnrollment() {
  write(K.secret, null); write(K.tenant, null); write(K.list, null)
}

export function cachedStaff(): StaffEntry[] {
  try { return JSON.parse(read(K.list) ?? '[]') as StaffEntry[] } catch { return [] }
}

export async function enrollDevice(code: string, deviceName: string): Promise<Enrollment> {
  const r = await call<{ secret: string; tenant_name: string }>('staff-auth', { action: 'enroll', code, deviceId: deviceId(), deviceName })
  write(K.secret, r.secret); write(K.tenant, r.tenant_name)
  return { secret: r.secret, tenantName: r.tenant_name }
}

/** Refresh the list of people who can sign in on this device. Falls back to the last known list offline. */
export async function refreshStaff(): Promise<StaffEntry[]> {
  const e = getEnrollment()
  if (!e) return []
  try {
    const r = await call<{ staff: StaffEntry[] }>('staff-auth', { action: 'staff-list', deviceId: deviceId(), deviceSecret: e.secret })
    write(K.list, JSON.stringify(r.staff))
    return r.staff
  } catch (err) {
    if (err instanceof StaffApiError && err.status === 401) clearEnrollment() // the device was revoked
    if (err instanceof StaffApiError && err.code === 'network') return cachedStaff()
    throw err
  }
}

export async function staffLogin(membershipId: string, pin: string): Promise<StaffLoginResult> {
  const e = getEnrollment()
  if (!e) throw new StaffApiError(401, 'device_not_registered')
  return call<StaffLoginResult>('staff-auth', { action: 'login', deviceId: deviceId(), deviceSecret: e.secret, membershipId, pin })
}

/* ------------------------------ owner actions ------------------------------ */

export async function createStaff(token: string, args: { tenantId: string; fullName: string; role: string; pin: string }) {
  return call<{ membershipId: string }>('staff-admin', { action: 'create-staff', ...args }, token)
}
