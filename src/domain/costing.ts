import { assertXaf, type Xaf } from './money';

/**
 * Weighted-average costing (decision: 2026-11-17).
 *
 * To stay exact in whole XAF we track the TOTAL value of stock on hand
 * (an integer) instead of a fractional per-unit cost. Cost of goods sold for
 * a sale is proportional to that value, and the remainder stays on hand, so
 * rounding differences never accumulate and value reaches exactly 0 when
 * the last unit is sold.
 */
export interface CostState {
  /** Base units on hand. May be negative after an offline oversell. */
  quantity: number;
  /** Total value of the units on hand, in XAF. Never negative. */
  value: Xaf;
  /** Last known cost per base unit, used to cost oversold units. */
  lastUnitCost: number;
}

export const emptyCostState: CostState = { quantity: 0, value: 0, lastUnitCost: 0 };

/** Goods received: `totalCost` is the full purchase cost of `quantity` base units. */
export function receive(state: CostState, quantity: number, totalCost: Xaf): CostState {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Error('received quantity must be a positive whole number');
  }
  assertXaf(totalCost, 'purchase cost');
  const unitCost = totalCost / quantity;
  const newQuantity = state.quantity + quantity;
  // If stock was negative, the first units received cover the deficit,
  // and only the remaining units carry value.
  const covered = state.quantity < 0 ? Math.min(quantity, -state.quantity) : 0;
  const addedValue =
    covered === 0 ? totalCost : Math.round((totalCost * (quantity - covered)) / quantity);
  return {
    quantity: newQuantity,
    value: newQuantity > 0 ? state.value + addedValue : 0,
    lastUnitCost: unitCost,
  };
}

export interface SaleCost {
  state: CostState;
  /** Cost of goods sold for this issue, in XAF. */
  cogs: Xaf;
}

/** Goods leaving stock (sale, damage, giveaway…): returns the new state and its cost. */
export function issue(state: CostState, quantity: number): SaleCost {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Error('issued quantity must be a positive whole number');
  }
  const available = Math.max(state.quantity, 0);
  const fromStock = Math.min(quantity, available);
  const oversold = quantity - fromStock;

  let stockCost = 0;
  if (fromStock > 0) {
    stockCost =
      fromStock === state.quantity
        ? state.value
        : Math.round((state.value * fromStock) / state.quantity);
  }
  const oversoldCost = Math.round(oversold * state.lastUnitCost);

  return {
    cogs: stockCost + oversoldCost,
    state: {
      quantity: state.quantity - quantity,
      value: state.value - stockCost,
      lastUnitCost: state.lastUnitCost,
    },
  };
}

/** Average cost per base unit, for display only (never used to post to the ledger). */
export function averageUnitCost(state: CostState): number {
  return state.quantity > 0 ? state.value / state.quantity : state.lastUnitCost;
}
