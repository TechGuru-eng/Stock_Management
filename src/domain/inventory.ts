export type MovementType =
  | 'opening'
  | 'purchase_receipt'
  | 'sale'
  | 'return_in'
  | 'damaged'
  | 'expired'
  | 'missing'
  | 'giveaway'
  | 'personal_use'
  | 'count_adjustment'
  | 'transfer_out'
  | 'transfer_in'
  | 'reversal';

/** Append-only. `quantity` is signed, in base units: + adds stock, - removes it. */
export interface StockMovement {
  /** Generated on the device (UUID), so offline records never clash. */
  id: string;
  shopId: string;
  productId: string;
  quantity: number;
  type: MovementType;
  reason?: string;
  staffId: string;
  deviceId: string;
  createdAt: string;
  /** The sale, purchase, count or transfer this movement belongs to. */
  referenceId?: string;
  /** Set on a reversal: the movement it cancels. */
  reversesId?: string;
}

/** Stock on hand is DERIVED from the ledger. */
export function stockOnHand(
  movements: readonly StockMovement[],
  shopId: string,
  productId: string,
): number {
  let total = 0;
  for (const m of movements) {
    if (m.shopId === shopId && m.productId === productId) total += m.quantity;
  }
  return total;
}

/**
 * Merge movements uploaded by a device into the server ledger.
 * Idempotent: replaying the same upload (duplicate sync request, retry after
 * a dropped connection) changes nothing.
 */
export function mergeMovements(
  existing: readonly StockMovement[],
  incoming: readonly StockMovement[],
): { merged: StockMovement[]; accepted: string[]; duplicates: string[] } {
  const seen = new Set(existing.map((m) => m.id));
  const merged = [...existing];
  const accepted: string[] = [];
  const duplicates: string[] = [];
  for (const m of incoming) {
    if (seen.has(m.id)) {
      duplicates.push(m.id);
      continue;
    }
    seen.add(m.id);
    merged.push(m);
    accepted.push(m.id);
  }
  return { merged, accepted, duplicates };
}

export type OversellPolicy = 'allow_and_flag' | 'block';

export interface OversellDecision {
  allowed: boolean;
  /** True when the sale leaves stock negative and a manager must be alerted. */
  flagged: boolean;
}

/** Default policy (decision 2026-11-17): never block the counter, flag for review. */
export function checkOversell(
  onHand: number,
  requested: number,
  policy: OversellPolicy = 'allow_and_flag',
): OversellDecision {
  const short = requested > onHand;
  if (!short) return { allowed: true, flagged: false };
  return policy === 'block'
    ? { allowed: false, flagged: false }
    : { allowed: true, flagged: true };
}
