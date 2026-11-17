import { supabase } from '../lib/supabase'
import { classifyServerError, TransportError, type PullResponse, type SyncTransport } from './transport'

function fail(error: { code?: string | null; message?: string | null }): never {
  throw new TransportError(classifyServerError(error), error.message ?? 'sync error', error.code ?? undefined)
}

/** The real transport: Supabase database functions (see supabase/migrations/0005_sync.sql). */
export const supabaseTransport: SyncTransport = {
  async registerDevice(deviceId, tenantId, name) {
    if (!supabase) throw new TransportError('network', 'not configured')
    const { error } = await supabase.rpc('register_device', { p_device: deviceId, p_tenant: tenantId, p_name: name })
    if (error) fail(error)
  },
  async push(deviceId, ops) {
    if (!supabase) throw new TransportError('network', 'not configured')
    const { data, error } = await supabase.rpc('sync_push', { p_device: deviceId, p_ops: ops })
    if (error) fail(error)
    return data as { applied: number; skipped: number }
  },
  async pull(since, limit) {
    if (!supabase) throw new TransportError('network', 'not configured')
    const { data, error } = await supabase.rpc('sync_pull', { p_since: since, p_limit: limit })
    if (error) fail(error)
    return data as PullResponse
  },
}
