export type Role = 'owner' | 'manager' | 'cashier' | 'storekeeper'

/**
 * Mirrors the default role_permissions rows in the database (0001_core.sql).
 * The database is the real enforcement point; this copy only lets the offline
 * app hide actions a user could not perform and apply the same rules without a network.
 */
const defaults: Record<Role, readonly string[]> = {
  owner: ['*'],
  manager: [
    'sales.create', 'sales.refund_approve', 'stock.adjust_approve', 'purchases.manage',
    'cash.close', 'reports.operational', 'products.write', 'expenses.write',
    'products.read', 'stock.receive', 'stock.count', 'payments.receive',
  ],
  cashier: ['sales.create', 'sales.request_refund', 'products.read', 'payments.receive'],
  storekeeper: ['stock.receive', 'stock.count', 'products.read', 'stock.adjust_request'],
}

export function can(role: Role, permission: string): boolean {
  const list = defaults[role]
  return list.includes('*') || list.includes(permission)
}

/** Cashiers may discount a line up to this share without a manager (basis points). */
export const CASHIER_MAX_DISCOUNT_BP = 1000 // 10%

export function discountNeedsApproval(gross: number, discount: number, role: Role): boolean {
  if (discount <= 0) return false
  if (role === 'owner' || role === 'manager') return false
  return discount * 10000 > gross * CASHIER_MAX_DISCOUNT_BP
}
