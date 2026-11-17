// StockCM Edge Function: staff-admin
// Creates a staff member. Needs the service role (to create the login identity), so it is a function and not
// something the app can do itself. Only a signed-in OWNER of the business may call it: the caller's own token is
// checked with the database's permission function before anything is created.
//
// POST { action: 'create-staff', tenantId, fullName, role, pin }   (Authorization: Bearer <owner token>)
import { createClient } from 'jsr:@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ROLES = ['manager', 'cashier', 'storekeeper']

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  const authorization = req.headers.get('Authorization')
  if (!authorization) return json({ error: 'not_signed_in' }, 401)

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return json({ error: 'bad_request' }, 400)
  }
  if (body.action !== 'create-staff') return json({ error: 'unknown_action' }, 400)

  const { tenantId, fullName, role, pin } = body
  if (typeof tenantId !== 'string' || !UUID.test(tenantId)) return json({ error: 'bad_request' }, 400)
  if (typeof fullName !== 'string' || fullName.trim().length < 2 || fullName.length > 60) return json({ error: 'bad_name' }, 400)
  if (typeof role !== 'string' || !ROLES.includes(role)) return json({ error: 'bad_role' }, 400)
  if (typeof pin !== 'string') return json({ error: 'weak_pin' }, 400)

  const url = Deno.env.get('SUPABASE_URL')!
  // Acts as the caller, so row-level security and permission checks apply to them.
  const asCaller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: who } = await asCaller.auth.getUser()
  if (!who?.user) return json({ error: 'not_signed_in' }, 401)
  const { data: allowed } = await asCaller.rpc('has_permission', { p_tenant: tenantId, p_permission: 'staff.manage' })
  if (allowed !== true) return json({ error: 'forbidden' }, 403)

  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: pinOk } = await admin.rpc('pin_is_acceptable', { p: pin })
  if (pinOk !== true) return json({ error: 'weak_pin' }, 400)

  // 1) the login identity. No email is ever sent: the address is a placeholder and no password is set.
  const email = `staff-${crypto.randomUUID()}@staff.stockcm.invalid`
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email, email_confirm: true, user_metadata: { full_name: fullName.trim() },
  })
  if (createError || !created.user) return json({ error: 'server_error' }, 500)
  const userId = created.user.id

  const undo = async () => {
    await admin.auth.admin.deleteUser(userId)
  }

  // 2) membership and shop access
  const { data: member, error: memberError } = await admin
    .from('memberships')
    .insert({ tenant_id: tenantId, user_id: userId, role, full_name: fullName.trim(), active: true })
    .select('id')
    .single()
  if (memberError || !member) {
    await undo()
    // The database refuses a new staff member beyond the plan's limit (see migration 0011).
    const overLimit = memberError?.message?.includes('plan_limit') === true
    return json({ error: overLimit ? 'plan_limit_staff' : 'server_error' }, overLimit ? 403 : 500)
  }
  const { data: shops } = await admin.from('shops').select('id').eq('tenant_id', tenantId).eq('active', true)
  if (shops?.length) {
    await admin.from('membership_shops').insert(shops.map((s) => ({ membership_id: member.id, shop_id: s.id, tenant_id: tenantId })))
  }

  // 3) the PIN, set the same way the owner would (database hashes it; the owner's own permission is checked again)
  const { error: pinError } = await asCaller.rpc('set_staff_pin', { p_membership: member.id, p_pin: pin })
  if (pinError) {
    await admin.from('memberships').delete().eq('id', member.id)
    await undo()
    return json({ error: 'weak_pin' }, 400)
  }

  await admin.from('audit_logs').insert({
    tenant_id: tenantId, actor_id: who.user.id, action: 'staff.created', entity: 'membership', entity_id: member.id,
    after_state: { role, full_name: fullName.trim() },
  })
  return json({ membershipId: member.id })
})
