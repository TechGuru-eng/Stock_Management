// StockCM Edge Function: billing-webhook
// Receives "payment succeeded / failed" messages from the payment provider and extends the subscription.
//
// Nothing here is trusted until the signature checks out: the body must carry a valid HMAC-SHA256 in the
// `x-stockcm-signature` header, made with the shared secret in platform_secrets ('billing_webhook_secret').
// Then the database does the rest, idempotently: the amount must match what was asked for, the same provider
// reference can never be used twice, and a retried webhook never extends the subscription twice.
//
// Message (JSON), one per payment:
//   { reference: "STK-XXXXXXXX", provider: "mtn_momo", provider_reference: "...", status: "successful"|"failed",
//     amount: 15000, currency: "XAF" }
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { parseWebhook, verifySignature } from './signature.ts'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  const raw = await req.text()
  if (raw.length > 10_000) return json({ error: 'too_large' }, 413)

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: row } = await admin.from('platform_secrets').select('value').eq('key', 'billing_webhook_secret').maybeSingle()
  if (!row?.value) return json({ error: 'not_configured' }, 503)

  if (!(await verifySignature(raw, req.headers.get('x-stockcm-signature'), row.value))) {
    return json({ error: 'bad_signature' }, 401)
  }
  const msg = parseWebhook(raw)
  if (!msg) return json({ error: 'bad_message' }, 400)

  const { data, error } = await admin.rpc('confirm_billing_payment', {
    p_reference: msg.reference, p_provider: msg.provider, p_provider_ref: msg.providerReference,
    p_amount: msg.amount, p_outcome: msg.outcome,
  })
  if (error || !data) return json({ error: 'server_error' }, 500)
  if (data.ok) return json({ ok: true, already: data.already === true })
  // Refused for a business reason: retrying the same message cannot help, so say so (4xx, not 5xx).
  return json({ ok: false, reason: data.reason }, data.reason === 'unknown_reference' ? 404 : 422)
})
