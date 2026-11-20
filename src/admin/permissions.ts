/**
 * What each platform-staff role may do. This is a COPY of the rule in the database (admin_perm_ok in migration 0014),
 * used only to decide which buttons and menus to show. The database enforces the real rule on every call.
 */
export type AdminRole = 'super' | 'finance' | 'support'
export type AdminPerm = 'overview' | 'businesses' | 'billing' | 'plans' | 'revenue' | 'support' | 'sync' | 'announcements' | 'settings'

const MAP: Record<Exclude<AdminRole, 'super'>, AdminPerm[]> = {
  finance: ['overview', 'billing', 'plans', 'revenue'],
  support: ['overview', 'businesses', 'support', 'sync', 'announcements'],
}

export function can(role: AdminRole | null | undefined, perm: AdminPerm): boolean {
  if (!role) return false
  if (role === 'super') return true
  return MAP[role]?.includes(perm) ?? false
}

export type AdminPage = 'overview' | 'businesses' | 'payments' | 'reminders' | 'plans' | 'syncIssues' | 'audit' | 'settings'

/** Which page needs which permission. */
export const PAGE_PERM: Record<AdminPage, AdminPerm> = {
  overview: 'overview',
  businesses: 'businesses',
  payments: 'billing',
  reminders: 'billing',
  plans: 'plans',
  syncIssues: 'sync',
  audit: 'support',
  settings: 'settings',
}

export function pagesFor(role: AdminRole): AdminPage[] {
  return (Object.keys(PAGE_PERM) as AdminPage[]).filter((p) => can(role, PAGE_PERM[p]))
}
