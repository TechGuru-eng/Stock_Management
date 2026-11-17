import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { AdminRole } from './permissions'

export interface Whoami { role: AdminRole; aal: 'aal1' | 'aal2' }

export interface Overview {
  businesses: number; trial: number; paying: number; grace: number; expired: number; suspended: number
  mrr_estimate: number; active_shops: number; payments_pending: number; payment_failures_30d: number; revenue_30d: number
  devices: { total: number; synced_24h: number; stale_over_48h: number; stale_over_30d: number }
  open_sync_issues: number
}

export type SubState = 'trial' | 'active' | 'grace' | 'expired' | 'suspended'

export interface BusinessRow {
  id: string; name: string; category: string | null; town: string | null; created_at: string
  plan_code: string; state: SubState; period_end: string; shops: number; staff: number
  last_sync: string | null; open_issues: number; owner_phone_masked: string | null
}

export interface PaymentRow {
  id: string; reference: string; business: string; tenant_id: string; kind: string; plan_code: string; amount: number
  method: string; phone: string | null; status: string; created_at: string; confirmed_at: string | null; confirmed_by: string | null; note: string | null
}

export interface PlanRow {
  code: string; name: string; price_xaf: number | null; max_shops: number | null; max_staff: number | null; max_products: number | null
  active: boolean; subscribers: number
}

export interface PlanInput { code: string; name: string; price: number | null; shops: number | null; staff: number | null; products: number | null; active: boolean }

export interface Revenue {
  by_month: { month: string; amount: number; invoices: number }[]
  by_plan: { plan_code: string; amount: number; invoices: number }[]
}

export interface SupportDetail {
  business: { name: string; category: string | null; language: string | null; created_at: string }
  owner: { name: string | null; phone: string | null; town: string | null } | null
  subscription: { plan: string; state: SubState; period_end: string; next_plan: string | null }
  usage: { shops: number; staff: number; products: number }
  devices: { id: string; name: string | null; last_sync_at: string | null; revoked: boolean }[]
  staff: { name: string | null; role: string; active: boolean }[]
  recent_actions: { action: string; at: string }[]
  sync_issues: { kind: string; error: string | null; last_seen: string; resolved: boolean }[]
  payments: { reference: string; status: string; amount: number; at: string }[]
}

export interface AuditRow { id: number; admin_id: string; action: string; tenant_id: string | null; business: string | null; detail: Record<string, unknown> | null; at: string }

export type Settings = Record<string, unknown>

export interface ReminderRow {
  tenant_id: string; business: string; language: 'fr' | 'en' | null; owner_name: string | null; owner_phone: string | null
  plan_code: string; price_xaf: number | null; period_end: string; state: SubState; last_reminder: string | null
}
export interface Reminders { rows: ReminderRow[]; grace_days: number; templates: Record<string, { fr?: string; en?: string }> }

export interface MfaStart { factorId: string; enroll?: { qr: string; secret: string } }

export interface AdminApi {
  auth: {
    hasSession(): Promise<boolean>
    signIn(email: string, password: string): Promise<void>
    whoami(): Promise<Whoami | null>
    mfaStart(): Promise<MfaStart>
    mfaVerify(factorId: string, code: string): Promise<void>
    signOut(): Promise<void>
  }
  overview(): Promise<Overview>
  businesses(search: string, state: string): Promise<BusinessRow[]>
  setSuspension(tenant: string, suspended: boolean, reason: string): Promise<void>
  extendTrial(tenant: string, days: number, reason: string): Promise<void>
  plans(): Promise<PlanRow[]>
  savePlan(p: PlanInput): Promise<void>
  payments(status: string): Promise<PaymentRow[]>
  confirmPayment(id: string, note: string): Promise<void>
  rejectPayment(id: string, reason: string): Promise<void>
  revenue(): Promise<Revenue>
  startSupport(tenant: string, reason: string): Promise<string>
  endSupport(grant: string): Promise<void>
  supportDetail(tenant: string): Promise<SupportDetail>
  audit(limit: number): Promise<AuditRow[]>
  settings(): Promise<Settings>
  setSetting(key: string, value: unknown): Promise<void>
  webhookSecret(): Promise<string>
  reminders(): Promise<Reminders>
  noteReminder(tenant: string, kind: string): Promise<void>
}

/** The database's own messages are written to be shown; anything else is shown generically. */
function fail(error: { message: string; hint?: string | null; code?: string } | null): never {
  const msg = error?.message ?? 'Something went wrong'
  throw new Error(msg)
}

let client: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (client) return client
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
  if (!url || !key) throw new Error('Supabase is not configured (.env.local)')
  // The admin session lives in sessionStorage only (gone when the tab closes) and is kept apart from the shop app's.
  client = createClient(url, key, {
    auth: { persistSession: true, storage: window.sessionStorage, storageKey: 'stockcm-admin-auth', autoRefreshToken: true, detectSessionInUrl: false },
  })
  return client
}

async function rpc<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await sb().rpc(name, args)
  if (error) fail(error)
  return data as T
}

export const realApi: AdminApi = {
  auth: {
    async hasSession() {
      return Boolean((await sb().auth.getSession()).data.session)
    },
    async signIn(email, password) {
      const { error } = await sb().auth.signInWithPassword({ email, password })
      if (error) throw new Error('Wrong email or password')
    },
    async whoami() {
      const { data, error } = await sb().rpc('admin_whoami')
      if (error || !data) return null
      return data as Whoami
    },
    async mfaStart() {
      const mfa = sb().auth.mfa
      const list = await mfa.listFactors()
      if (list.error) fail(list.error)
      const verified = list.data.totp.find((f) => f.status === 'verified')
      if (verified) return { factorId: verified.id }
      for (const f of list.data.all.filter((x) => x.factor_type === 'totp' && x.status !== 'verified')) await mfa.unenroll({ factorId: f.id })
      const enr = await mfa.enroll({ factorType: 'totp', friendlyName: 'StockCM admin' })
      if (enr.error) fail(enr.error)
      return { factorId: enr.data.id, enroll: { qr: enr.data.totp.qr_code, secret: enr.data.totp.secret } }
    },
    async mfaVerify(factorId, code) {
      const mfa = sb().auth.mfa
      const ch = await mfa.challenge({ factorId })
      if (ch.error) fail(ch.error)
      const v = await mfa.verify({ factorId, challengeId: ch.data.id, code })
      if (v.error) throw new Error('That code is not correct')
    },
    async signOut() {
      await sb().auth.signOut()
    },
  },
  overview: () => rpc('admin_overview'),
  businesses: (search, state) => rpc('admin_list_businesses', { p_search: search || null, p_state: state || null, p_limit: 100, p_offset: 0 }),
  setSuspension: (tenant, suspended, reason) => rpc('admin_set_suspension', { p_tenant: tenant, p_suspended: suspended, p_reason: reason }),
  extendTrial: async (tenant, days, reason) => void (await rpc('admin_extend_trial', { p_tenant: tenant, p_days: days, p_reason: reason })),
  plans: () => rpc('admin_list_plans'),
  savePlan: (p) =>
    rpc('admin_upsert_plan', { p_code: p.code, p_name: p.name, p_price: p.price, p_max_shops: p.shops, p_max_staff: p.staff, p_max_products: p.products, p_active: p.active }),
  payments: (status) => rpc('admin_list_payments', { p_status: status || null, p_limit: 100 }),
  confirmPayment: async (id, note) => void (await rpc('admin_confirm_payment', { p_payment: id, p_note: note })),
  rejectPayment: (id, reason) => rpc('admin_reject_payment', { p_payment: id, p_reason: reason }),
  revenue: () => rpc('admin_revenue', { p_months: 12 }),
  startSupport: (tenant, reason) => rpc('admin_start_support', { p_tenant: tenant, p_reason: reason }),
  endSupport: (grant) => rpc('admin_end_support', { p_grant: grant }),
  supportDetail: (tenant) => rpc('admin_support_detail', { p_tenant: tenant }),
  audit: (limit) => rpc('admin_audit', { p_limit: limit, p_tenant: null }),
  settings: () => rpc('admin_list_settings'),
  setSetting: (key, value) => rpc('admin_set_setting', { p_key: key, p_value: value }),
  webhookSecret: () => rpc('admin_webhook_secret'),
  reminders: () => rpc('admin_renewal_reminders'),
  noteReminder: (tenant, kind) => rpc('admin_note_reminder', { p_tenant: tenant, p_kind: kind }),
}
