import { db } from '../data/db'
import { setReadOnly } from '../data/writeGuard'
import i18n from '../i18n'
import { licenceAllowsWrites, licenceStatus, verifyLicence, type LicencePayload, type LicenceStatus } from '../domain/licence'

const base = `${(import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? ''}/functions/v1`
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

/** The PUBLIC key licences are checked with. It cannot sign anything, so it is safe to ship in the app. */
export function licencePublicKey(): JsonWebKey | null {
  // DEVELOPMENT ONLY: lets the browser test harness use a throw-away key pair. Compiled out of production builds.
  if (import.meta.env.DEV) {
    try {
      const dev = localStorage.getItem('dev.licence.pub')
      if (dev) return JSON.parse(dev) as JsonWebKey
    } catch { /* ignore */ }
  }
  try {
    return JSON.parse((import.meta.env.VITE_LICENCE_PUBLIC_KEY as string | undefined) ?? '') as JsonWebKey
  } catch {
    return null
  }
}

/** The newest time this device has ever seen. A clock set back below it is noticed. */
async function noteTime(now: number): Promise<number> {
  const seen = ((await db.meta.get('maxTimeSeen'))?.value as number | undefined) ?? 0
  if (now > seen) await db.meta.put({ key: 'maxTimeSeen', value: now })
  return seen
}

export async function loadLicence(): Promise<LicencePayload | null> {
  const key = licencePublicKey()
  const token = (await db.meta.get('licence'))?.value as string | undefined
  if (!key || !token) return null
  return verifyLicence(token, key)
}

export interface LicenceView {
  payload: LicencePayload
  status: LicenceStatus
}

export async function evaluateLicence(now = Date.now()): Promise<LicenceView | null> {
  const payload = await loadLicence()
  if (!payload) return null
  const seen = await noteTime(now)
  return { payload, status: licenceStatus(payload, now, seen) }
}

/** Switch read-only mode on or off according to the licence. No licence yet (fresh install): do not block. */
export async function applyGuard(now = Date.now()): Promise<LicenceView | null> {
  const v = await evaluateLicence(now)
  if (!v || licenceAllowsWrites(v.status)) setReadOnly(null)
  else setReadOnly(v.status, i18n.t(`billing.readOnly.${v.status}`))
  return v
}

/** Fetch a fresh signed licence from the server and keep it only if the signature is valid. */
export async function refreshLicence(accessToken: string): Promise<LicencePayload | null> {
  const key = licencePublicKey()
  if (!key) return null
  let res: Response
  try {
    res = await fetch(`${base}/licence`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: anonKey ?? '', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ action: 'licence' }),
    })
  } catch {
    return null // offline: keep the licence we have
  }
  if (!res.ok) return null
  const { token } = (await res.json()) as { token?: string }
  if (!token) return null
  const payload = await verifyLicence(token, key)
  if (!payload) return null
  await db.meta.put({ key: 'licence', value: token })
  await applyGuard()
  return payload
}

/** What the plan allows, from the signed licence (null = no licence yet or unlimited). */
export async function planLimit(kind: 'shops' | 'staff' | 'products'): Promise<number | null> {
  return (await loadLicence())?.limits[kind] ?? null
}

/** Whether the signed licence includes a gated feature (e.g. 'verified_momo', 'loyalty'). No licence yet (fresh
 *  install, same as `applyGuard`): not blocked. A licence that doesn't list the feature: blocked. An old cached
 *  licence from before this field existed has no `features` array at all, which counts as "lists none". */
export async function planHasFeature(feature: string): Promise<boolean> {
  const payload = await loadLicence()
  return payload ? (payload.features?.includes(feature) ?? false) : true
}
