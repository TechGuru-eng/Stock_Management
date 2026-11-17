/**
 * Money is always an integer number of XAF (FCFA). XAF has no minor unit,
 * so there are no decimals anywhere in the ledger. Floating point is never
 * used to store or add amounts.
 */
export type Xaf = number;

export class MoneyError extends Error {}

export function assertXaf(value: number, label = 'amount'): Xaf {
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`${label} must be a whole number of XAF, got ${value}`);
  }
  return value;
}

export function assertPositiveXaf(value: number, label = 'amount'): Xaf {
  assertXaf(value, label);
  if (value <= 0) throw new MoneyError(`${label} must be greater than zero`);
  return value;
}

export function sumXaf(values: readonly Xaf[]): Xaf {
  return values.reduce((total, v) => total + assertXaf(v), 0);
}

/** Round a proportional amount (e.g. a discount percentage) to a whole XAF. */
export function roundXaf(value: number): Xaf {
  return Math.round(value);
}

/** "10 000 FCFA" — space separated thousands, as used by shops in Cameroon. */
export function formatXaf(value: Xaf): string {
  assertXaf(value);
  const sign = value < 0 ? '-' : '';
  const digits = String(Math.abs(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${sign}${digits} FCFA`;
}
