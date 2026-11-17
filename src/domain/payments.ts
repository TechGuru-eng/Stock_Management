import { assertPositiveXaf, assertXaf, sumXaf, type Xaf } from './money';

export type PaymentMethod = 'cash' | 'mtn_momo' | 'orange_money' | 'credit';

/**
 * A manual MoMo / Orange entry is only `recorded`. It becomes
 * `provider_verified` solely through a trusted integration (verified webhook).
 */
export type VerificationStatus =
  | 'recorded'
  | 'pending'
  | 'provider_verified'
  | 'failed'
  | 'refunded';

export interface PaymentInput {
  method: PaymentMethod;
  amount: Xaf;
}

export interface SaleSettlement {
  total: Xaf;
  /** Money actually received now (cash + mobile money). */
  collected: Xaf;
  /** Amount the customer still owes after this sale. */
  outstanding: Xaf;
  byMethod: Record<PaymentMethod, Xaf>;
}

export class PaymentError extends Error {}

/**
 * Split / partial payment settlement.
 * Every XAF of the total must be accounted for, either as money collected or
 * as customer credit. Credit requires a customer.
 */
export function settleSale(
  total: Xaf,
  payments: readonly PaymentInput[],
  opts: { hasCustomer: boolean },
): SaleSettlement {
  assertXaf(total, 'sale total');
  const byMethod: Record<PaymentMethod, Xaf> = {
    cash: 0,
    mtn_momo: 0,
    orange_money: 0,
    credit: 0,
  };
  for (const p of payments) {
    assertPositiveXaf(p.amount, `${p.method} payment`);
    byMethod[p.method] += p.amount;
  }
  const accounted = sumXaf(Object.values(byMethod));
  if (accounted !== total) {
    throw new PaymentError(
      `payments (${accounted}) must add up to the sale total (${total})`,
    );
  }
  if (byMethod.credit > 0 && !opts.hasCustomer) {
    throw new PaymentError('a credit sale needs a customer');
  }
  return {
    total,
    collected: byMethod.cash + byMethod.mtn_momo + byMethod.orange_money,
    outstanding: byMethod.credit,
    byMethod,
  };
}

/* ---------------------------- customer account ---------------------------- */

export interface AccountEntry {
  id: string;
  /** Positive = customer owes more. Negative = customer owes less. */
  amount: Xaf;
  kind: 'sale_credit' | 'repayment' | 'adjustment' | 'reversal';
}

/** The balance is DERIVED from immutable entries, never edited in place. */
export function accountBalance(entries: readonly AccountEntry[]): Xaf {
  return sumXaf(entries.map((e) => e.amount));
}

export interface OpenSale {
  saleId: string;
  /** Oldest first when sorted by this key. */
  createdAt: string;
  outstanding: Xaf;
}

export interface Allocation {
  saleId: string;
  amount: Xaf;
}

/**
 * Allocate a repayment to unpaid sales, oldest first, or to explicit targets.
 * The original sale amounts are never changed — only allocations are recorded.
 */
export function allocateRepayment(
  amount: Xaf,
  openSales: readonly OpenSale[],
  explicit?: readonly Allocation[],
): Allocation[] {
  assertPositiveXaf(amount, 'repayment');
  const owed = new Map(openSales.map((s) => [s.saleId, s.outstanding]));

  if (explicit) {
    if (sumXaf(explicit.map((a) => a.amount)) !== amount) {
      throw new PaymentError('explicit allocations must add up to the repayment');
    }
    for (const a of explicit) {
      assertPositiveXaf(a.amount, 'allocation');
      const open = owed.get(a.saleId);
      if (open === undefined) throw new PaymentError(`sale ${a.saleId} is not open`);
      if (a.amount > open) throw new PaymentError(`allocation exceeds sale ${a.saleId} balance`);
      owed.set(a.saleId, open - a.amount);
    }
    return explicit.map((a) => ({ ...a }));
  }

  const totalOwed = sumXaf(openSales.map((s) => s.outstanding));
  if (amount > totalOwed) {
    throw new PaymentError('repayment is larger than the amount owed');
  }
  const out: Allocation[] = [];
  let remaining = amount;
  const oldestFirst = [...openSales].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const sale of oldestFirst) {
    if (remaining === 0) break;
    const part = Math.min(remaining, sale.outstanding);
    if (part > 0) {
      out.push({ saleId: sale.saleId, amount: part });
      remaining -= part;
    }
  }
  return out;
}

/** A correction is a NEW linked entry with the opposite sign — history is untouched. */
export function reverseEntry<T extends { id: string; amount: Xaf }>(
  entry: T,
  newId: string,
): { id: string; reversesId: string; amount: Xaf } {
  return { id: newId, reversesId: entry.id, amount: -entry.amount };
}
