/**
 * DEVELOPMENT ONLY: an in-memory stand-in for the admin API so the screens can be exercised without a platform-admin
 * account. It is only imported behind `import.meta.env.DEV`, so it is not part of production builds.
 * Sign in with any email/password; the two-step code is 123456; the email picks the role (finance@ / support@ / anything else = super).
 */
import type { AdminApi, AuditRow, BusinessRow, PaymentRow, PlanRow, Settings, SubState } from './api'
import type { AdminRole } from './permissions'
import { can, type AdminPerm } from './permissions'

const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString()

export function makeDevApi(): AdminApi {
  let role: AdminRole | null = null
  let aal: 'aal1' | 'aal2' = 'aal1'
  let signed = false
  const grants = new Set<string>()
  const audit: AuditRow[] = []
  let auditId = 1
  const log = (action: string, tenant: string | null, detail: Record<string, unknown> = {}) => {
    audit.unshift({ id: auditId++, admin_id: 'dev-admin', action, tenant_id: tenant, business: biz.find((b) => b.id === tenant)?.name ?? null, detail, at: new Date().toISOString() })
  }
  const need = (perm: AdminPerm) => {
    if (!signed) throw new Error('not signed in')
    if (aal !== 'aal2') throw new Error('two-step verification required')
    if (!can(role, perm)) throw new Error('your role is not allowed to do this')
  }

  const biz: BusinessRow[] = [
    { id: 'b1', name: 'Boutique Mbarga', category: 'general_store', town: 'Douala', created_at: iso(60), plan_code: 'business', state: 'active', period_end: iso(-12), shops: 1, staff: 3, last_sync: iso(0.1), open_issues: 0, owner_phone_masked: '67712••••456' },
    { id: 'b2', name: 'Pharmacie du Centre', category: 'pharmacy', town: 'Yaoundé', created_at: iso(20), plan_code: 'starter', state: 'trial', period_end: iso(-10), shops: 1, staff: 1, last_sync: iso(2), open_issues: 2, owner_phone_masked: '69988••••221' },
    { id: 'b3', name: 'Quincaillerie Fotso', category: 'hardware', town: 'Bafoussam', created_at: iso(90), plan_code: 'pro', state: 'grace', period_end: iso(3), shops: 2, staff: 8, last_sync: iso(40), open_issues: 0, owner_phone_masked: '65011••••902' },
    { id: 'b4', name: 'Alimentation Njoya', category: 'general_store', town: 'Garoua', created_at: iso(120), plan_code: 'starter', state: 'expired', period_end: iso(30), shops: 1, staff: 0, last_sync: iso(35), open_issues: 0, owner_phone_masked: '67433••••118' },
  ]
  const pays: PaymentRow[] = [
    { id: 'p1', reference: 'STK-AB23CD45', business: 'Pharmacie du Centre', tenant_id: 'b2', kind: 'renewal', plan_code: 'starter', amount: 2500, method: 'mtn_momo', phone: '699886221', status: 'pending', created_at: iso(0.2), confirmed_at: null, confirmed_by: null, note: null },
    { id: 'p2', reference: 'STK-ZX98YW76', business: 'Boutique Mbarga', tenant_id: 'b1', kind: 'renewal', plan_code: 'business', amount: 5000, method: 'orange_money', phone: '677123456', status: 'provider_verified', created_at: iso(18), confirmed_at: iso(18), confirmed_by: 'provider', note: null },
  ]
  const plans: PlanRow[] = [
    { code: 'starter', name: 'Starter', price_xaf: 2500, max_shops: 1, max_staff: 2, max_products: 500, active: true, subscribers: 2 },
    { code: 'business', name: 'Business', price_xaf: 5000, max_shops: 1, max_staff: 5, max_products: 5000, active: true, subscribers: 1 },
    { code: 'pro', name: 'Pro', price_xaf: 10000, max_shops: 3, max_staff: 15, max_products: null, active: true, subscribers: 1 },
    { code: 'enterprise', name: 'Enterprise', price_xaf: null, max_shops: null, max_staff: null, max_products: null, active: true, subscribers: 0 },
  ]
  let settings: Settings = {
    trial_days: 30, grace_days: 7, offline_limit_days: 30, payment_mode: 'manual',
    billing_terms: [{ months: 1, bonus: 0 }, { months: 3, bonus: 0 }, { months: 6, bonus: 1 }, { months: 12, bonus: 2 }],
    merchant_numbers: {}, announcement: { active: false, level: 'info', fr: '', en: '' }, maintenance: { active: false, fr: '', en: '' },
    feature_flags: {}, notification_templates: {}, provider_config: { name: '', enabled: false },
  }

  return {
    auth: {
      async hasSession() { return signed },
      async signIn(email) {
        signed = true; aal = 'aal1'
        role = email.startsWith('finance') ? 'finance' : email.startsWith('support') ? 'support' : 'super'
      },
      async whoami() { return signed ? { role: role!, aal } : null },
      async mfaStart() { return { factorId: 'f1', enroll: { qr: 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140"><rect width="140" height="140" fill="#e5e7eb"/><text x="70" y="75" font-size="12" text-anchor="middle">QR (dev)</text></svg>'), secret: 'DEVSECRET234567' } } },
      async mfaVerify(_f, code) { if (code !== '123456') throw new Error('That code is not correct'); aal = 'aal2' },
      async signOut() { signed = false; role = null; aal = 'aal1'; grants.clear() },
    },
    async overview() {
      need('overview')
      const n = (s: SubState) => biz.filter((b) => b.state === s).length
      return {
        businesses: biz.length, trial: n('trial'), paying: n('active'), grace: n('grace'), expired: n('expired'), suspended: n('suspended'),
        mrr_estimate: 5000, active_shops: 5, payments_pending: pays.filter((p) => p.status === 'pending').length, payment_failures_30d: 1, revenue_30d: 5000,
        devices: { total: 9, synced_24h: 6, stale_over_48h: 3, stale_over_30d: 1 }, open_sync_issues: 2,
      }
    },
    async businesses(search, state) {
      need('businesses')
      return biz.filter((b) => (!search || b.name.toLowerCase().includes(search.toLowerCase())) && (!state || b.state === state))
    },
    async setSuspension(id, suspended, reason) {
      need('businesses'); if (reason.trim().length < 5) throw new Error('give a reason')
      const b = biz.find((x) => x.id === id)!; b.state = suspended ? 'suspended' : 'active'
      log(suspended ? 'business.suspended' : 'business.reactivated', id, { reason })
    },
    async extendTrial(id, days, reason) {
      need('billing'); if (days < 1 || days > 90) throw new Error('between 1 and 90 days'); if (reason.trim().length < 5) throw new Error('give a reason')
      const b = biz.find((x) => x.id === id)!; b.period_end = new Date(new Date(b.period_end).getTime() + days * 86_400_000).toISOString()
      log('subscription.extended', id, { days, reason })
    },
    async plans() { need('plans'); return plans.map((p) => ({ ...p })) },
    async savePlan(p) {
      need('plans')
      if (!/^[a-z][a-z_]{2,19}$/.test(p.code)) throw new Error('plan code: 3-20 lowercase letters')
      const i = plans.findIndex((x) => x.code === p.code)
      const row: PlanRow = { code: p.code, name: p.name, price_xaf: p.price, max_shops: p.shops, max_staff: p.staff, max_products: p.products, active: p.active, subscribers: i >= 0 ? plans[i].subscribers : 0 }
      if (i >= 0) plans[i] = row; else plans.push(row)
      log('plan.saved', null, { code: p.code })
    },
    async payments(status) { need('billing'); return pays.filter((p) => !status || p.status === status).map((p) => ({ ...p })) },
    async confirmPayment(id, note) {
      need('billing'); if (note.trim().length < 5) throw new Error('write what proof you saw (reference, sender, time)')
      const p = pays.find((x) => x.id === id)!; p.status = 'recorded'; p.confirmed_at = new Date().toISOString(); p.confirmed_by = 'admin:dev'; p.note = note
      log('payment.confirmed_manually', p.tenant_id, { payment: id, note })
    },
    async rejectPayment(id, reason) {
      need('billing'); const p = pays.find((x) => x.id === id)!
      if (p.status !== 'pending') throw new Error('only a pending payment can be rejected')
      p.status = 'failed'; p.note = reason; log('payment.rejected', p.tenant_id, { payment: id, reason })
    },
    async revenue() { need('revenue'); return { by_month: [{ month: '2026-11', amount: 5000, invoices: 1 }, { month: '2026-10', amount: 17500, invoices: 3 }], by_plan: [{ plan_code: 'business', amount: 15000, invoices: 3 }, { plan_code: 'starter', amount: 7500, invoices: 3 }] } },
    async startSupport(id, reason) {
      need('support'); if (reason.trim().length < 10) throw new Error('write the reason for looking at this account (10+ characters)')
      grants.add(id); log('support.started', id, { reason }); return 'g-' + id
    },
    async endSupport(grant) { need('support'); grants.delete(grant.replace('g-', '')); log('support.ended', grant.replace('g-', ''), {}) },
    async supportDetail(id) {
      need('support'); if (!grants.has(id)) throw new Error('start a support session first')
      const b = biz.find((x) => x.id === id)!; log('support.viewed_detail', id, {})
      return {
        business: { name: b.name, category: b.category, language: 'fr', created_at: b.created_at },
        owner: { name: 'Jean Mbarga', phone: '677123456', town: b.town },
        subscription: { plan: b.plan_code, state: b.state, period_end: b.period_end, next_plan: null },
        usage: { shops: b.shops, staff: b.staff, products: 142 },
        devices: [{ id: 'd1', name: 'Tablet counter', last_sync_at: b.last_sync, revoked: false }, { id: 'd2', name: 'Old phone', last_sync_at: iso(50), revoked: true }],
        staff: [{ name: 'Marie', role: 'cashier', active: true }, { name: 'Paul', role: 'stock_manager', active: false }],
        recent_actions: [{ action: 'sale.created', at: iso(0.1) }, { action: 'stock.received', at: iso(0.5) }],
        sync_issues: b.open_issues ? [{ kind: 'rejected', error: 'oversell blocked', last_seen: iso(0.3), resolved: false }] : [],
        payments: pays.filter((p) => p.tenant_id === id).map((p) => ({ reference: p.reference, status: p.status, amount: p.amount, at: p.created_at })),
      }
    },
    async audit(limit) { need('support'); return audit.slice(0, limit) },
    async settings() { need('settings'); return JSON.parse(JSON.stringify(settings)) as Settings },
    async setSetting(key, value) {
      need('settings')
      if (key === 'grace_days' && (Number(value) < 0 || Number(value) > 60)) throw new Error('value out of range')
      settings = { ...settings, [key]: value }; log('setting.changed', null, { key })
    },
    async webhookSecret() { need('settings'); log('secret.revealed', null, {}); return 'dev-secret-0123456789abcdef' },
  }
}
