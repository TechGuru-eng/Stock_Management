import { describe, expect, it } from 'vitest'
import sql from '../../supabase/migrations/0014_admin.sql?raw'
import { can, pagesFor, type AdminPerm, type AdminRole } from './permissions'

const roles: AdminRole[] = ['super', 'finance', 'support']
const perms: AdminPerm[] = ['overview', 'businesses', 'billing', 'plans', 'revenue', 'support', 'sync', 'announcements', 'settings']

describe('admin roles', () => {
  it('super can do everything', () => {
    for (const p of perms) expect(can('super', p)).toBe(true)
  })
  it('finance handles money but cannot suspend, support or change settings', () => {
    expect(can('finance', 'billing')).toBe(true)
    expect(can('finance', 'plans')).toBe(true)
    expect(can('finance', 'revenue')).toBe(true)
    expect(can('finance', 'businesses')).toBe(false)
    expect(can('finance', 'support')).toBe(false)
    expect(can('finance', 'settings')).toBe(false)
  })
  it('support helps businesses but cannot touch money, plans or settings', () => {
    expect(can('support', 'businesses')).toBe(true)
    expect(can('support', 'support')).toBe(true)
    expect(can('support', 'billing')).toBe(false)
    expect(can('support', 'plans')).toBe(false)
    expect(can('support', 'revenue')).toBe(false)
    expect(can('support', 'settings')).toBe(false)
  })
  it('nobody and unknown roles can do nothing', () => {
    expect(can(null, 'overview')).toBe(false)
    expect(can('hacker' as AdminRole, 'overview')).toBe(false)
  })
  it('menus match the roles', () => {
    expect(pagesFor('finance')).toEqual(['overview', 'payments', 'reminders', 'plans'])
    expect(pagesFor('support')).toEqual(['overview', 'businesses', 'audit'])
    expect(pagesFor('super')).toHaveLength(7)
  })
  it('stays identical to the rule in the database migration', () => {
    for (const role of roles) {
      if (role === 'super') continue
      const m = sql.match(new RegExp(`when '${role}' then p_perm in \\(([^)]*)\\)`))
      expect(m, role).toBeTruthy()
      const inSql = m![1].split(',').map((s) => s.trim().replace(/'/g, '')).sort()
      const inTs = perms.filter((p) => can(role, p)).sort()
      expect(inTs).toEqual(inSql)
    }
  })
})
