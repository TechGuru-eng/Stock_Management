// StockCM Edge Function: staff-auth
// The only way a staff member gets a session. Callable without a login (that is the point: the person has not
// signed in yet), so it protects itself: a registered device secret AND a PIN, checked in the database with
// lockout (see supabase/migrations/0010_staff_pin.sql). The service-role key never leaves this function.
//
// POST { action: 'enroll',     code, deviceId, deviceName? }
// POST { action: 'staff-list', deviceId, deviceSecret }
// POST { action: 'login',      deviceId, deviceSecret, membershipId, pin }
import { createClient } from 'jsr:@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v)
const isStr = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max

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
  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  try {
    if (body.action === 'enroll') {
      if (!isStr(body.code, 20) || !isUuid(body.deviceId)) return json({ error: 'bad_request' }, 400)
      const name = typeof body.deviceName === 'string' ? body.deviceName.slice(0, 60) : ''
      const { data, error } = await admin.rpc('redeem_enrollment_code', {
        p_code: body.code, p_device: body.deviceId, p_device_name: name,
      })
      // One answer for every failure: a wrong, used or expired code looks the same.
      if (error) return json({ error: 'invalid_code' }, 400)
      return json(data)
    }

    if (body.action === 'staff-list') {
      if (!isUuid(body.deviceId) || !isStr(body.deviceSecret, 200)) return json({ error: 'bad_request' }, 400)
      const { data, error } = await admin.rpc('list_staff_for_device', { p_device: body.deviceId, p_secret: body.deviceSecret })
      if (error) return json({ error: 'device_not_registered' }, 401)
      return json({ staff: data })
    }

    if (body.action === 'login') {
      if (!isUuid(body.deviceId) || !isStr(body.deviceSecret, 200) || !isUuid(body.membershipId)) return json({ error: 'bad_request' }, 400)
      if (typeof body.pin !== 'string' || !/^[0-9]{4,6}$/.test(body.pin)) return json({ error: 'wrong_pin' }, 401)

      const { data: check, error: checkError } = await admin.rpc('verify_staff_pin', {
        p_device: body.deviceId, p_secret: body.deviceSecret, p_membership: body.membershipId, p_pin: body.pin,
      })
      if (checkError || !check) return json({ error: 'server_error' }, 500)
      if (!check.ok) {
        const status = check.reason === 'locked' || check.reason === 'device_throttled' ? 429 : 401
        return json({ error: check.reason, attempts_left: check.attempts_left, retry_after: check.retry_after }, status)
      }

      // PIN is right. Mint a real session for this staff member (no password exists to steal).
      const { data: user, error: userError } = await admin.auth.admin.getUserById(check.user_id)
      if (userError || !user?.user?.email) return json({ error: 'server_error' }, 500)
      const { data: link, error: linkError } = await admin.auth.admin.generateLink({ type: 'magiclink', email: user.user.email })
      const tokenHash = link?.properties?.hashed_token
      if (linkError || !tokenHash) return json({ error: 'server_error' }, 500)

      const anon = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } })
      let session = null
      for (const type of ['magiclink', 'email'] as const) {
        const r = await anon.auth.verifyOtp({ token_hash: tokenHash, type })
        if (!r.error && r.data.session) { session = r.data.session; break }
      }
      if (!session) return json({ error: 'server_error' }, 500)

      return json({
        session: {
          access_token: session.access_token, refresh_token: session.refresh_token,
          expires_in: session.expires_in, expires_at: session.expires_at, token_type: session.token_type,
        },
        staff: { membership_id: check.membership_id, user_id: check.user_id, role: check.role, full_name: check.full_name, tenant_id: check.tenant_id },
      })
    }

    return json({ error: 'unknown_action' }, 400)
  } catch {
    return json({ error: 'server_error' }, 500)
  }
})
