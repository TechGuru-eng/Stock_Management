/**
 * LIVE end-to-end test of staff PIN login against a real Supabase project (needs the deployed Edge Functions
 * and migration 0010). Skipped unless E2E_EMAIL / E2E_PASSWORD are set: a throwaway OWNER test user whose
 * business already exists (run src/sync/live.e2e.test.ts once first, or sign in to the app and finish onboarding).
 *
 *   E2E_EMAIL=... E2E_PASSWORD=... npx vitest run src/auth/staff.live.e2e.test.ts
 *
 * It creates one staff member and one device, then revokes the device and deactivates the staff member.
 */
import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'

const env = (globalThis as unknown as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {}
const email = env.E2E_EMAIL
const password = env.E2E_PASSWORD

const store = new Map<string, string>()
;(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  length: 0,
}

describe.skipIf(!email || !password)('staff PIN login against Supabase', () => {
  it('owner creates staff and a device; staff signs in; wrong PINs lock; revoke and deactivate cut access', async () => {
    const { supabase } = await import('../lib/supabase')
    const api = await import('./staffApi')
    const { createClient } = await import('@supabase/supabase-js')
    if (!supabase) throw new Error('Supabase is not configured (.env.local)')

    const signIn = await supabase.auth.signInWithPassword({ email: email!, password: password! })
    expect(signIn.error).toBeNull()
    const token = signIn.data.session!.access_token
    const mem = await supabase.from('memberships').select('tenant_id').eq('user_id', signIn.data.user!.id).eq('role', 'owner').limit(1)
    const tenantId = mem.data![0].tenant_id as string

    // owner creates a staff member; a weak PIN is refused
    await expect(api.createStaff(token, { tenantId, fullName: 'E2E Cashier', role: 'cashier', pin: '1234' })).rejects.toMatchObject({ code: 'weak_pin' })
    const staff = await api.createStaff(token, { tenantId, fullName: 'E2E Cashier', role: 'cashier', pin: '4821' })
    expect(staff.membershipId).toBeTruthy()

    // owner registers a device: one-time code, then the device enrolls
    const code = await supabase.rpc('create_enrollment_code', { p_tenant: tenantId, p_device_name: 'E2E till' })
    expect(code.error).toBeNull()
    const enrolled = await api.enrollDevice((code.data as { code: string }).code, 'E2E till')
    expect(enrolled.secret.length).toBeGreaterThan(20)
    await expect(api.enrollDevice((code.data as { code: string }).code, 'again')).rejects.toMatchObject({ code: 'invalid_code' }) // single use

    const list = await api.refreshStaff()
    expect(list.map((s) => s.full_name)).toContain('E2E Cashier')

    // a wrong PIN is refused and counted
    await expect(api.staffLogin(staff.membershipId, '9999')).rejects.toMatchObject({ code: 'wrong_pin', attemptsLeft: 4 })

    // the right PIN gives a real session, limited to cashier permissions
    const ok = await api.staffLogin(staff.membershipId, '4821')
    expect(ok.staff.role).toBe('cashier')
    const staffClient = createClient(import.meta.env.VITE_SUPABASE_URL as string, import.meta.env.VITE_SUPABASE_ANON_KEY as string, { auth: { persistSession: false } })
    await staffClient.auth.setSession({ access_token: ok.session.access_token, refresh_token: ok.session.refresh_token })
    const mine = await staffClient.from('memberships').select('role').limit(5)
    expect(mine.error).toBeNull()
    const cannot = await staffClient.rpc('create_enrollment_code', { p_tenant: tenantId })
    expect(cannot.error).toBeTruthy() // a cashier cannot register devices

    // five wrong PINs lock the account, even for the right PIN
    for (let i = 0; i < 5; i++) await api.staffLogin(staff.membershipId, '0001').catch(() => undefined)
    await expect(api.staffLogin(staff.membershipId, '4821')).rejects.toMatchObject({ code: 'locked' })
    const unlock = await supabase.rpc('unlock_staff', { p_membership: staff.membershipId })
    expect(unlock.error).toBeNull()
    await expect(api.staffLogin(staff.membershipId, '4821')).resolves.toBeTruthy()

    // deactivating the staff member cuts the login
    await supabase.rpc('set_staff_active', { p_membership: staff.membershipId, p_active: false })
    await expect(api.staffLogin(staff.membershipId, '4821')).rejects.toBeTruthy()

    // revoking the device kills its secret
    const dev = await supabase.from('devices').select('id').eq('tenant_id', tenantId).eq('name', 'E2E till').limit(1)
    await supabase.rpc('revoke_device', { p_device: dev.data![0].id })
    await expect(api.refreshStaff()).rejects.toBeTruthy()
  }, 120_000)
})
