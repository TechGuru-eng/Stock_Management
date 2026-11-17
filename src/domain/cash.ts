import { assertXaf, type Xaf } from './money';

export interface CashSessionTotals {
  opening: Xaf;
  cashSales: Xaf;
  /** Customer debt repayments received in cash. */
  cashRepayments: Xaf;
  cashDeposits: Xaf;
  cashRefunds: Xaf;
  cashExpenses: Xaf;
  cashWithdrawals: Xaf;
  /** Cash paid to suppliers from the till. */
  supplierPayments: Xaf;
}

export function expectedClosing(t: CashSessionTotals): Xaf {
  for (const [k, v] of Object.entries(t)) assertXaf(v, k);
  return (
    t.opening +
    t.cashSales +
    t.cashRepayments +
    t.cashDeposits -
    t.cashRefunds -
    t.cashExpenses -
    t.cashWithdrawals -
    t.supplierPayments
  );
}

export interface Reconciliation {
  expected: Xaf;
  counted: Xaf;
  /** counted - expected: negative = shortage, positive = surplus. */
  difference: Xaf;
  status: 'balanced' | 'shortage' | 'surplus';
}

export function reconcile(totals: CashSessionTotals, counted: Xaf): Reconciliation {
  assertXaf(counted, 'counted cash');
  const expected = expectedClosing(totals);
  const difference = counted - expected;
  return {
    expected,
    counted,
    difference,
    status: difference === 0 ? 'balanced' : difference < 0 ? 'shortage' : 'surplus',
  };
}
