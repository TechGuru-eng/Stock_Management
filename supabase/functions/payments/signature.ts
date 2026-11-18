/**
 * Payment-webhook verification. A payment is only believed if the message carries a valid HMAC-SHA256 signature made
 * with a secret that only StockCM and the payment provider know. Anyone can POST to a public URL; only the provider can
 * produce the signature. Copied into supabase/functions/billing-webhook/signature.ts (a test keeps them identical).
 *
 * Normalised message (a provider adapter turns the provider's own format into this before signing):
 *   { reference, provider, provider_reference, status: 'successful' | 'failed', amount, currency: 'XAF' }
 */

const enc = new TextEncoder()

export async function hmacHex(secret: string, text: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(text)))
  return [...sig].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Compares without stopping at the first difference, so timing reveals nothing about the right signature. */
export function sameHex(a: string, b: string): boolean {
  const x = a.toLowerCase()
  const y = b.toLowerCase()
  if (x.length !== y.length) return false
  let diff = 0
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i)
  return diff === 0
}

export async function verifySignature(rawBody: string, signatureHex: string | null, secret: string | null): Promise<boolean> {
  if (!secret || !signatureHex || !/^[0-9a-fA-F]{64}$/.test(signatureHex)) return false
  return sameHex(await hmacHex(secret, rawBody), signatureHex)
}

export interface WebhookMessage {
  reference: string
  provider: string
  providerReference: string
  outcome: 'successful' | 'failed'
  amount: number
}

/** Strict parsing: anything unexpected is refused rather than guessed at. */
export function parseWebhook(raw: string): WebhookMessage | null {
  try {
    const b = JSON.parse(raw) as Record<string, unknown>
    if (typeof b.reference !== 'string' || !/^STK-[A-Z0-9]{8}$/.test(b.reference)) return null
    if (typeof b.provider !== 'string' || !/^[a-z_]{2,30}$/.test(b.provider)) return null
    if (typeof b.provider_reference !== 'string' || b.provider_reference.length < 1 || b.provider_reference.length > 100) return null
    const s = String(b.status).toLowerCase()
    if (s !== 'successful' && s !== 'failed') return null
    if (typeof b.amount !== 'number' || !Number.isInteger(b.amount) || b.amount <= 0) return null
    if (b.currency !== 'XAF') return null
    return { reference: b.reference, provider: b.provider, providerReference: b.provider_reference, outcome: s, amount: b.amount }
  } catch {
    return null
  }
}
