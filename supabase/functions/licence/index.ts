// StockCM Edge Function: licence
// Issues the signed licence a device checks offline (see src/domain/licence.ts).
//
// POST { action: 'public-key' }   no login needed: returns the PUBLIC key the app uses to verify licences
// POST { action: 'licence' }      signed in (any member of a business): returns that business's signed licence
//
// The private key is generated on first use and kept in platform_secrets, which no client can read.
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { buildPayload, generateLicenceKeys, signLicence, type LicenceLimits } from './licence.ts'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

// deno-lint-ignore no-explicit-any
async function loadKeys(admin: any): Promise<{ publicJwk: JsonWebKey; privateJwk: JsonWebKey }> {
  const read = async () => {
    const { data } = await admin.from('platform_secrets').select('key, value').in('key', ['licence_public_jwk', 'licence_private_jwk'])
    const m = new Map((data ?? []).map((r: { key: string; value: string }) => [r.key, r.value]))
    return m.get('licence_public_jwk') && m.get('licence_private_jwk')
      ? { publicJwk: JSON.parse(m.get('licence_public_jwk') as string), privateJwk: JSON.parse(m.get('licence_private_jwk') as string) }
      : null
  }
  const existing = await read()
  if (existing) return existing
  const fresh = await generateLicenceKeys()
  // Two requests at the very first moment could both generate: the first insert wins, everyone then reads that one.
  await admin.from('platform_secrets').upsert(
    [{ key: 'licence_public_jwk', value: JSON.stringify(fresh.publicJwk) }, { key: 'licence_private_jwk', value: JSON.stringify(fresh.privateJwk) }],
    { onConflict: 'key', ignoreDuplicates: true },
  )
  return (await read()) ?? fresh
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return json({ error: 'bad_request' }, 400)
  }

  const url = Deno.env.get('SUPABASE_URL')!
  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } })

  try {
    if (body.action === 'public-key') {
      const { publicJwk } = await loadKeys(admin)
      return json({ publicJwk })
    }

    if (body.action === 'licence') {
      const authorization = req.headers.get('Authorization')
      if (!authorization) return json({ error: 'not_signed_in' }, 401)
      const asCaller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
        global: { headers: { Authorization: authorization } }, auth: { persistSession: false, autoRefreshToken: false },
      })
      const { data: who } = await asCaller.auth.getUser()
      if (!who?.user) return json({ error: 'not_signed_in' }, 401)

      // Row-level security decides which business this person belongs to.
      const { data: mem } = await asCaller.from('memberships').select('tenant_id').eq('user_id', who.user.id).eq('active', true).limit(1)
      const tenantId = mem?.[0]?.tenant_id as string | undefined
      if (!tenantId) return json({ error: 'no_business' }, 403)

      const { data: sub } = await admin.from('subscriptions').select('plan_code, status, period_end').eq('tenant_id', tenantId).maybeSingle()
      if (!sub) return json({ error: 'no_subscription' }, 404)
      const { data: plan } = await admin.from('plans').select('max_shops, max_staff, max_products').eq('code', sub.plan_code).maybeSingle()
      const { data: settings } = await admin.from('platform_settings').select('key, value').in('key', ['grace_days', 'offline_limit_days'])
      const num = (k: string, d: number) => Number(settings?.find((s: { key: string }) => s.key === k)?.value ?? d)

      const limits: LicenceLimits = { shops: plan?.max_shops ?? null, staff: plan?.max_staff ?? null, products: plan?.max_products ?? null }
      const payload = buildPayload({
        tenantId, plan: sub.plan_code, limits, base: sub.status === 'suspended' ? 'suspended' : sub.status === 'trial' ? 'trial' : 'active',
        periodEndMs: Date.parse(sub.period_end), graceDays: num('grace_days', 7), offlineDays: num('offline_limit_days', 30), nowMs: Date.now(),
      })
      const { privateJwk } = await loadKeys(admin)
      return json({ token: await signLicence(payload, privateJwk), payload })
    }

    return json({ error: 'unknown_action' }, 400)
  } catch {
    return json({ error: 'server_error' }, 500)
  }
})
