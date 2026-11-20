import { describe, expect, it } from 'vitest'
import { toCsv } from './csv'
import { dailyTable, debtors, dayEnd, dayStart, employeePerformance, periodPreset, productPerformance, stockValuation } from './reportTables'
import { summarize } from './reports'
import type { SaleLineRecord, SaleRecord } from './pos'
import type { ReturnLineRecord, ReturnRecord } from './returns'

const T = (d: string) => `2026-11-${d}T10:00:00.000Z`
const from = '2026-11-01T00:00:00.000Z'
const to = '2026-11-30T23:59:59.999Z'

const sale = (id: string, shopId: string, day: string, subtotal: number, discount: number, tax = 0): SaleRecord => ({
  id, tenantId: 't', shopId, saleNumber: id, cashierId: 'u', deviceId: 'd', subtotal, discount, tax, total: subtotal - discount + tax,
  collected: subtotal - discount + tax, outstanding: 0, status: 'completed', occurredAt: T(day),
})
const line = (id: string, saleId: string, productId: string, name: string, qty: number, unitPrice: number, discount: number, cogs: number): SaleLineRecord => ({
  id, tenantId: 't', saleId, productId, productName: name, unitId: 'u', unitName: 'bottle', quantity: qty, baseQuantity: qty, unitPrice,
  lineDiscount: discount, lineTotal: qty * unitPrice - discount, costOfGoods: cogs,
})

const sales = [sale('s1', 'A', '05', 2000, 0), sale('s2', 'A', '05', 1500, 50, 0), sale('s3', 'B', '07', 3000, 0)]
const lines = [
  line('l1', 's1', 'water', 'Eau', 4, 500, 0, 1600),
  line('l2', 's2', 'water', 'Eau', 1, 500, 0, 400),
  line('l3', 's2', 'rice', 'Riz', 1, 1000, 50, 700),
  line('l4', 's3', 'rice', 'Riz', 3, 1000, 0, 2100),
]
const returns: ReturnRecord[] = [{
  id: 'r1', tenantId: 't', shopId: 'A', saleId: 's1', kind: 'return', reason: 'x', totalValue: 500, netValue: 500, refundedAmount: 500, debtReduced: 0,
  createdBy: 'u', occurredAt: T('06'),
}]
const returnLines: ReturnLineRecord[] = [{ id: 'rl1', tenantId: 't', returnId: 'r1', saleLineId: 'l1', productId: 'water', quantity: 1, baseQuantity: 1, value: 500, netValue: 500, restock: true, costReversed: 400 }]

describe('product performance', () => {
  it('adds up exactly to the summary (revenue, cost of goods, profit), with and without returns', () => {
    for (const shopId of [undefined, 'A', 'B']) {
      const rows = productPerformance({ sales, lines, returns, returnLines, from, to, shopId })
      const s = summarize({ sales, lines, txns: [], expenses: [], entries: [], returns, returnLines, from, to, shopId })
      expect(rows.reduce((t, r) => t + r.revenue, 0)).toBe(s.revenue)
      expect(rows.reduce((t, r) => t + r.cogs, 0)).toBe(s.cogs)
      expect(rows.reduce((t, r) => t + r.profit, 0)).toBe(s.grossProfit)
    }
  })
  it('ranks by revenue, nets returns and computes the margin', () => {
    const rows = productPerformance({ sales, lines, returns, returnLines, from, to })
    expect(rows[0].productId).toBe('rice') // 950 + 3000
    const water = rows.find((r) => r.productId === 'water')!
    expect(water.quantity).toBe(4) // 5 sold, 1 came back
    expect(water.revenue).toBe(2000) // 2500 - 500
    expect(water.cogs).toBe(1600) // 2000 - 400
    expect(water.marginBp).toBe(2000) // 20%
  })
  it('respects the period', () => {
    expect(productPerformance({ sales, lines, from: '2026-12-01T00:00:00.000Z', to: '2026-12-31T00:00:00.000Z' })).toEqual([])
  })
})

describe('employee performance', () => {
  const bySale = sales.map((s) => ({ ...s, cashierId: s.id === 's3' ? 'bob' : 'alice' })) // alice: s1+s2, bob: s3
  const names = [{ id: 'alice', name: 'Alice' }]

  it('adds up exactly to the summary revenue, with and without returns', () => {
    for (const shopId of [undefined, 'A', 'B']) {
      const rows = employeePerformance({ sales: bySale, returns, from, to, shopId, names })
      const s = summarize({ sales: bySale, lines, txns: [], expenses: [], entries: [], returns, returnLines, from, to, shopId })
      expect(rows.reduce((t, r) => t + r.revenue, 0)).toBe(s.revenue)
    }
  })
  it('groups by cashier, nets a return against the cashier who rang up the original sale, and resolves names', () => {
    const rows = employeePerformance({ sales: bySale, returns, from, to, names })
    const alice = rows.find((r) => r.cashierId === 'alice')!
    expect(alice.name).toBe('Alice')
    expect(alice.salesCount).toBe(2)
    expect(alice.revenue).toBe(2950) // (2000 + 1450) - the 500 returned on s1
    expect(alice.collected).toBe(2950)
    const bob = rows.find((r) => r.cashierId === 'bob')!
    expect(bob.name).toBeNull() // not in the roster (e.g. the owner)
    expect(bob.salesCount).toBe(1)
    expect(bob.revenue).toBe(3000)
  })
  it('respects the period and the shop filter', () => {
    expect(employeePerformance({ sales: bySale, from: '2026-12-01T00:00:00.000Z', to: '2026-12-31T00:00:00.000Z', names })).toEqual([])
    const onlyA = employeePerformance({ sales: bySale, returns, from, to, shopId: 'A', names })
    expect(onlyA.map((r) => r.cashierId)).toEqual(['alice'])
  })
})

describe('stock valuation', () => {
  const products = [
    { id: 'p1', name: 'Eau', baseUnit: 'bottle', minStock: 10, isService: false, active: true },
    { id: 'p2', name: 'Riz', baseUnit: 'kg', minStock: 0, isService: false, active: true },
    { id: 'p3', name: 'Coupe', baseUnit: 'job', minStock: 0, isService: true, active: true },
    { id: 'p4', name: 'Vieux', baseUnit: 'pc', minStock: 0, isService: false, active: false },
    { id: 'p5', name: 'Jamais', baseUnit: 'pc', minStock: 0, isService: false, active: true },
  ]
  const costs = [
    { shopId: 'A', productId: 'p1', quantity: 6, value: 3000 },
    { shopId: 'B', productId: 'p1', quantity: 8, value: 4400 },
    { shopId: 'A', productId: 'p2', quantity: 20, value: 20000 },
  ]
  it('values stock per shop and across shops, flags low stock, skips services and inactive items', () => {
    const a = stockValuation(products, costs, 'A')
    expect(a.rows.map((r) => r.name)).toEqual(['Riz', 'Eau'])
    expect(a.totalValue).toBe(23000)
    expect(a.rows.find((r) => r.name === 'Eau')).toMatchObject({ low: true, avgCost: 500 })
    const all = stockValuation(products, costs)
    expect(all.rows.find((r) => r.name === 'Eau')).toMatchObject({ quantity: 14, value: 7400, low: false })
    expect(all.totalValue).toBe(27400)
  })
})

describe('who owes us', () => {
  it('lists only people who owe, biggest first, and ignores later movements', () => {
    const e = (id: string, customerId: string, amount: number, day: string) => ({ id, tenantId: 't', customerId, amount, kind: 'sale_credit' as const, occurredAt: T(day) })
    const r = debtors(
      [{ id: 'c1', name: 'Awa' }, { id: 'c2', name: 'Paul', phone: '677' }, { id: 'c3', name: 'Zoe' }],
      [e('1', 'c1', 5000, '02'), e('2', 'c1', -5000, '03'), e('3', 'c2', 8000, '04'), e('4', 'c3', 1000, '20')],
      T('10'),
    )
    expect(r.rows.map((x) => [x.name, x.balance])).toEqual([['Paul', 8000]]) // Awa paid, Zoe's debt is after the date
    expect(r.total).toBe(8000)
  })
})

describe('daily table', () => {
  it('has every day, nets returns and matches the summary total', () => {
    const rows = dailyTable({ sales, expenses: [], returns, from: dayStart('2026-11-04'), to: dayEnd('2026-11-08') })
    expect(rows.map((d) => d.date)).toEqual(['2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08'])
    expect(rows.find((d) => d.date === '2026-11-06')!.revenue).toBe(-500) // goods came back that day
    expect(rows.reduce((t, d) => t + d.revenue, 0)).toBe(summarize({ sales, lines, txns: [], expenses: [], entries: [], returns, returnLines, from: dayStart('2026-11-04'), to: dayEnd('2026-11-08') }).revenue)
  })
})

describe('periods', () => {
  const now = new Date(2026, 10, 17, 15, 30) // 17 Nov 2026, local
  it('today / last 7 days / this month / last month', () => {
    const d = (iso: string) => new Date(iso)
    const today = periodPreset('today', now)
    expect(d(today.from).getDate()).toBe(17)
    expect(d(today.to).getDate()).toBe(17)
    expect(d(periodPreset('last7', now).from).getDate()).toBe(11)
    expect(d(periodPreset('thisMonth', now).from).getDate()).toBe(1)
    const last = periodPreset('lastMonth', now)
    expect([d(last.from).getMonth(), d(last.from).getDate()]).toEqual([9, 1])
    expect([d(last.to).getMonth(), d(last.to).getDate()]).toEqual([9, 31])
  })
  it('a typed date covers the whole local day', () => {
    expect(new Date(dayStart('2026-11-17')).getHours()).toBe(0)
    expect(new Date(dayEnd('2026-11-17')).getHours()).toBe(23)
  })
})

describe('csv', () => {
  const cols = [{ label: 'Name', value: (r: { n: string; v: number | null }) => r.n }, { label: 'Value', value: (r: { n: string; v: number | null }) => r.v }]
  it('writes a header, a BOM, and quotes what needs quoting', () => {
    const csv = toCsv(cols, [{ n: 'Eau; 1.5L "pure"', v: 1500 }, { n: 'Riz', v: null }])
    expect(csv.startsWith('﻿')).toBe(true)
    expect(csv).toBe('﻿Name;Value\r\n"Eau; 1.5L ""pure""";1500\r\nRiz;\r\n')
  })
  it('uses a comma when asked, and keeps accents', () => {
    expect(toCsv(cols, [{ n: 'Crème, fraîche', v: 2 }], ',')).toBe('﻿Name,Value\r\n"Crème, fraîche",2\r\n')
  })
  it('neutralises spreadsheet formulas in text, but leaves negative numbers alone', () => {
    const csv = toCsv(cols, [{ n: '=HYPERLINK("http://evil")', v: -500 }, { n: '+cmd', v: 1 }, { n: '@x', v: 1 }])
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"")";-500`)
    expect(csv).toContain(`'+cmd;1`)
    expect(csv).toContain(`'@x;1`)
  })
})
