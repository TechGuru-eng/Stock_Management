import { db } from './db'

/**
 * Read-only mode. When the subscription has lapsed (or the device must sync), nothing NEW may be recorded on this
 * device. Everything already there stays visible and exportable, and records downloaded from the server are still
 * stored, because those happened elsewhere. The server enforces the same rule; this makes it work with no connection.
 */
export class WriteBlockedError extends Error {
  reason: string
  constructor(reason: string, message: string) {
    super(message)
    this.name = 'WriteBlockedError'
    this.reason = reason
  }
}

let reason: string | null = null
let message = 'read-only'
let pulling = 0

export function setReadOnly(r: string | null, text = 'read-only'): void {
  reason = r
  message = text
}
export const getReadOnlyReason = (): string | null => reason

/** Records that arrive from the server are allowed even in read-only mode. */
export async function whilePulling<T>(fn: () => Promise<T>): Promise<T> {
  pulling++
  try {
    return await fn()
  } finally {
    pulling--
  }
}

let installed = false

/** Stops creating new business records while read-only. (Cash-session closing is left alone so a day can always be closed.) */
export function installWriteGuard(): void {
  if (installed) return
  installed = true
  const guard = () => {
    if (reason && pulling === 0) throw new WriteBlockedError(reason, message)
  }
  const tables = [
    db.products, db.units, db.movements, db.sales, db.saleLines, db.transactions, db.customers, db.customerEntries,
    db.payments, db.allocations, db.expenses, db.cashSessions, db.suppliers, db.purchases, db.purchaseLines,
    db.receipts, db.receiptLines, db.supplierEntries, db.saleReturns, db.returnLines, db.approvalRequests, db.approvalDecisions,
    db.stockCounts, db.countLines, db.countDecisions, db.supplierPrices, db.stockBatches, db.loyaltyRules, db.loyaltyEntries,
  ]
  for (const t of tables) t.hook('creating', () => { guard() })
}
