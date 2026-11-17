import { describe, expect, it } from 'vitest';
import { formatXaf, assertXaf, MoneyError } from './money';
import { toBaseQuantity, breakdown, UnitError, type ProductUnit } from './units';
import { emptyCostState, issue, receive } from './costing';
import {
  settleSale,
  accountBalance,
  allocateRepayment,
  reverseEntry,
  PaymentError,
  type AccountEntry,
} from './payments';
import { reconcile } from './cash';
import { checkOversell, mergeMovements, stockOnHand, type StockMovement } from './inventory';

const bottle: ProductUnit = { id: 'b', name: 'bottle', factor: 1, price: 500 };
const carton: ProductUnit = { id: 'c', name: 'carton', factor: 24, price: 11000 };

describe('money', () => {
  it('formats XAF with spaced thousands', () => {
    expect(formatXaf(30000)).toBe('30 000 FCFA');
    expect(formatXaf(-5000)).toBe('-5 000 FCFA');
  });
  it('rejects decimals', () => {
    expect(() => assertXaf(10.5)).toThrow(MoneyError);
  });
});

describe('unit conversion (test 9)', () => {
  it('1 carton = 24 bottles; selling 3 bottles deducts 3 base units', () => {
    expect(toBaseQuantity(3, bottle)).toBe(3);
    expect(toBaseQuantity(1, carton)).toBe(24);
    expect(toBaseQuantity(2, carton)).toBe(48);
  });
  it('refuses a fraction of a base unit', () => {
    expect(() => toBaseQuantity(0.5, bottle)).toThrow(UnitError);
  });
  it('breaks stock down into cartons and bottles', () => {
    const parts = breakdown(53, [bottle, carton]);
    expect(parts.map((p) => [p.unit.name, p.count])).toEqual([
      ['carton', 2],
      ['bottle', 5],
    ]);
  });
});

describe('weighted average costing', () => {
  it('re-averages on purchase and costs a sale exactly', () => {
    let s = receive(emptyCostState, 10, 10000); // 1000 each
    s = receive(s, 10, 14000); // 1400 each -> value 24000 for 20
    expect(s.value).toBe(24000);
    const sale = issue(s, 5);
    expect(sale.cogs).toBe(6000); // 1200 average
    expect(sale.state.value).toBe(18000);
  });
  it('value reaches exactly 0 when the last unit is sold (no rounding drift)', () => {
    let s = receive(emptyCostState, 3, 1000); // 333.33 each
    for (let i = 0; i < 3; i++) s = issue(s, 1).state;
    expect(s.quantity).toBe(0);
    expect(s.value).toBe(0);
  });
  it('total COGS of all units equals the purchase cost', () => {
    let s = receive(emptyCostState, 3, 1000);
    let cogs = 0;
    for (let i = 0; i < 3; i++) {
      const r = issue(s, 1);
      cogs += r.cogs;
      s = r.state;
    }
    expect(cogs).toBe(1000);
  });
  it('costs oversold units at the last known cost', () => {
    const s = receive(emptyCostState, 2, 2000);
    const r = issue(s, 3);
    expect(r.state.quantity).toBe(-1);
    expect(r.cogs).toBe(3000);
    expect(r.state.value).toBe(0);
  });
});

describe('split and partial payments (test 5)', () => {
  it('30,000 sale: 10,000 cash + 5,000 MTN + 15,000 credit', () => {
    const s = settleSale(
      30000,
      [
        { method: 'cash', amount: 10000 },
        { method: 'mtn_momo', amount: 5000 },
        { method: 'credit', amount: 15000 },
      ],
      { hasCustomer: true },
    );
    expect(s.collected).toBe(15000);
    expect(s.outstanding).toBe(15000);
    expect(s.byMethod.mtn_momo).toBe(5000);
  });
  it('rejects payments that do not add up', () => {
    expect(() =>
      settleSale(30000, [{ method: 'cash', amount: 10000 }], { hasCustomer: true }),
    ).toThrow(PaymentError);
  });
  it('rejects credit with no customer', () => {
    expect(() =>
      settleSale(1000, [{ method: 'credit', amount: 1000 }], { hasCustomer: false }),
    ).toThrow(PaymentError);
  });
});

describe('customer debts (test 3)', () => {
  it('owes 50,000, repays 10,000 -> owes 40,000, original sale unchanged', () => {
    const entries: AccountEntry[] = [{ id: 'e1', amount: 50000, kind: 'sale_credit' }];
    const open = [{ saleId: 's1', createdAt: '2026-11-01', outstanding: 50000 }];
    const alloc = allocateRepayment(10000, open);
    expect(alloc).toEqual([{ saleId: 's1', amount: 10000 }]);
    entries.push({ id: 'e2', amount: -10000, kind: 'repayment' });
    expect(accountBalance(entries)).toBe(40000);
    expect(entries[0].amount).toBe(50000);
  });
  it('allocates across several unpaid sales, oldest first', () => {
    const alloc = allocateRepayment(12000, [
      { saleId: 'b', createdAt: '2026-11-05', outstanding: 9000 },
      { saleId: 'a', createdAt: '2026-11-01', outstanding: 8000 },
    ]);
    expect(alloc).toEqual([
      { saleId: 'a', amount: 8000 },
      { saleId: 'b', amount: 4000 },
    ]);
  });
  it('refuses to repay more than owed', () => {
    expect(() =>
      allocateRepayment(9000, [{ saleId: 'a', createdAt: '1', outstanding: 8000 }]),
    ).toThrow(PaymentError);
  });
  it('a correction is a linked reversal, not an edit (test 8)', () => {
    const original = { id: 'e2', amount: -10000 };
    const rev = reverseEntry(original, 'e3');
    expect(rev).toEqual({ id: 'e3', reversesId: 'e2', amount: 10000 });
    expect(original.amount).toBe(-10000);
  });
});

describe('cash register (test 6)', () => {
  it('opening 20,000 + sales 100,000 - expenses 15,000 = 105,000; counted 100,000 -> -5,000', () => {
    const r = reconcile(
      {
        opening: 20000,
        cashSales: 100000,
        cashRepayments: 0,
        cashDeposits: 0,
        cashRefunds: 0,
        cashExpenses: 15000,
        cashWithdrawals: 0,
        supplierPayments: 0,
      },
      100000,
    );
    expect(r.expected).toBe(105000);
    expect(r.difference).toBe(-5000);
    expect(r.status).toBe('shortage');
  });
});

describe('offline stock and sync (tests 1, 2)', () => {
  const base = { shopId: 's', productId: 'p', staffId: 'u', createdAt: '2026-11-17T08:00:00Z' };
  const opening: StockMovement = { ...base, id: 'm0', quantity: 10, type: 'opening', deviceId: 'srv' };
  const saleA: StockMovement = { ...base, id: 'mA', quantity: -4, type: 'sale', deviceId: 'A' };
  const saleB: StockMovement = { ...base, id: 'mB', quantity: -9, type: 'sale', deviceId: 'B' };

  it('two cashiers sell the same product offline; both sales are kept, stock goes negative and is flagged', () => {
    const { merged } = mergeMovements(mergeMovements([opening], [saleA]).merged, [saleB]);
    expect(stockOnHand(merged, 's', 'p')).toBe(-3);
    expect(checkOversell(6, 9).flagged).toBe(true);
    expect(checkOversell(6, 9).allowed).toBe(true);
  });
  it('replaying the same upload changes nothing', () => {
    const first = mergeMovements([opening], [saleA]);
    const again = mergeMovements(first.merged, [saleA]);
    expect(again.duplicates).toEqual(['mA']);
    expect(stockOnHand(again.merged, 's', 'p')).toBe(6);
  });
  it('block policy refuses an oversell', () => {
    expect(checkOversell(2, 3, 'block')).toEqual({ allowed: false, flagged: false });
  });
});
