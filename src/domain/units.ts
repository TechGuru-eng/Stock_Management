/**
 * Stock is always held in the smallest base unit of a product (piece, gram,
 * millilitre, centimetre). Larger units are defined by an integer factor.
 * Example: bottle = 1 base unit, carton = 24 base units.
 */
export interface ProductUnit {
  id: string;
  name: string;
  /** How many base units one of this unit contains. Positive integer. */
  factor: number;
  /** Selling price of ONE of this unit, in XAF. */
  price: number;
}

export class UnitError extends Error {}

/** Convert a sold or received quantity in `unit` into whole base units. */
export function toBaseQuantity(quantity: number, unit: ProductUnit): number {
  if (!Number.isInteger(unit.factor) || unit.factor <= 0) {
    throw new UnitError(`unit ${unit.name} has an invalid factor ${unit.factor}`);
  }
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new UnitError('quantity must be greater than zero');
  }
  const base = quantity * unit.factor;
  // Allow tiny binary float noise (0.1 * 3), but never a real fraction of a base unit.
  const rounded = Math.round(base);
  if (Math.abs(base - rounded) > 1e-9) {
    throw new UnitError(
      `${quantity} ${unit.name} is not a whole number of base units`,
    );
  }
  return rounded;
}

/** Express a base-unit quantity as "2 cartons + 5" using the largest unit first. */
export function breakdown(
  baseQuantity: number,
  units: readonly ProductUnit[],
): { unit: ProductUnit; count: number }[] {
  const sorted = [...units].sort((a, b) => b.factor - a.factor);
  const out: { unit: ProductUnit; count: number }[] = [];
  let remaining = Math.abs(baseQuantity);
  for (const unit of sorted) {
    const count = Math.floor(remaining / unit.factor);
    if (count > 0) {
      out.push({ unit, count });
      remaining -= count * unit.factor;
    }
  }
  return out;
}
