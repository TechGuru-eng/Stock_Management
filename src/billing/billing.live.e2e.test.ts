/**
 * LIVE end-to-end check of billing against a real Supabase project (needs migrations 0011-0013 and the deployed
 * Edge Functions). Skipped unless E2E_EMAIL / E2E_PASSWORD are set: a throwaway OWNER test user whose business exists.
 *
 *   E2E_EMAIL=... E2E_PASSWORD=... npx vitest run src/billing/billing.live.e2e.test.ts
 *
 * It does NOT move money. It checks the signed licence round trip, that a payment can be started (pending only),
 * and that a client cannot extend its own subscription.
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

describe.skipIf(!email || !password)('billing against Supabase', () => {
  it('issues a signed licence, starts a pending payment, and refuses a client that tries to extend itself', async () => {
    const { supabase } = await import('../lib/supabase')
    const lic = await import('./licenceStore')
    const { licenceStatus } = await import('../domain/licence')
    if (!supabase) throw new Error('Supabase is not configured (.env.local)')

    const signIn = await supabase.auth.signInWithPassword({ email: email!, password: password! })
    expect(signIn.error).toBeNull()
    const token = signIn.data.session!.access_token
    const mem = await supabase.from('memberships').select('tenant_id').eq('user_id', signIn.data.user!.id).eq('role', 'owner').limit(1)
    const tenantId = mem.data![0].tenant_id as string

    // 1. the server signs a licence and this device verifies it with the public key from the app's configuration
    const payload = await lic.refreshLicence(token)
    expect(payload).not.toBeNull()
    expect(payload!.sub).toBe(tenantId)
    expect(['valid', 'grace']).toContain(licenceStatus(payload!, Date.now()))
    expect(await lic.loadLicence()).toMatchObject({ sub: tenantId })

    // 2. a payment can be started; it stays pending until the provider (or an admin) confirms it
    const info = await supabase.rpc('billing_info', { p_tenant: tenantId })
    expect(info.error).toBeNull()
    const sub = await supabase.from('subscriptions').select('plan_code, period_end').eq('tenant_id', tenantId).single()
    const started = await supabase.rpc('create_billing_payment', {
      p_tenant: tenantId, p_kind: 'renewal', p_plan: sub.data!.plan_code, p_months: 1, p_method: 'mtn_momo', p_phone: '+237677000000',
    })
    expect(started.error).toBeNull()
    expect((started.data as { reference: string }).reference).toMatch(/^STK-[A-Z2-9]{8}$/)
    const row = await supabase.from('billing_payments').select('status, confirmed_at').eq('reference', (started.data as { reference: string }).reference).single()
    expect(row.data).toMatchObject({ status: 'pending', confirmed_at: null })

    // 3. the owner cannot confirm their own payment or edit their own subscription
    const before = sub.data!.period_end
    const edit = await supabase.from('subscriptions').update({ period_end: '2099-01-01T00:00:00Z' }).eq('tenant_id', tenantId).select()
    expect(edit.data ?? []).toHaveLength(0)
    const confirm = await supabase.rpc('confirm_billing_payment', { p_reference: (started.data as { reference: string }).reference, p_provider: 'x', p_provider_ref: 'y', p_amount: 1, p_outcome: 'successful' })
    expect(confirm.error).toBeTruthy()
    const forced = await supabase.rpc('admin_confirm_payment', { p_payment: (started.data as { id: string }).id, p_note: 'I paid myself, trust me' })
    expect(forced.error).toBeTruthy()
    const after = await supabase.from('subscriptions').select('period_end').eq('tenant_id', tenantId).single()
    expect(after.data!.period_end).toBe(before)
  }, 120_000)
})
