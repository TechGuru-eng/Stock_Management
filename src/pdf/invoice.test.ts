import { describe, expect, it } from 'vitest'
import { buildSaleInvoice, buildSubscriptionInvoice, invoiceProblems, qtyText } from '../domain/invoice'
import { cartTotals, type CartLine, type SaleLineRecord, type SaleRecord } from '../domain/pos'
import { invoiceFileName, renderInvoicePdf } from './invoicePdf'

const cart: CartLine[] = [
  { productId: 'p1', productName: 'Eau 1.5L', unitId: 'u1', unitName: 'bouteille', factor: 1, unitPrice: 500, quantity: 4, lineDiscount: 0, taxRateBp: 1925, isService: false },
  { productId: 'p2', productName: 'Riz parfumé (sac 25 kg)', unitId: 'u2', unitName: 'kg', factor: 1, unitPrice: 1000, quantity: 2.5, lineDiscount: 250, taxRateBp: 0, isService: false },
  { productId: 'p3', productName: 'Livraison', unitId: 'u3', unitName: 'course', factor: 1, unitPrice: 333, quantity: 3, lineDiscount: 0, taxRateBp: 1925, isService: true },
]
const totals = cartTotals(cart)
const sale: SaleRecord = {
  id: 's1', tenantId: 't', shopId: 'A', saleNumber: 'A1B2-0042', customerId: 'c1', cashierId: 'u', deviceId: 'd',
  subtotal: totals.subtotal, discount: totals.discount, tax: totals.tax, total: totals.total, collected: 3000, outstanding: totals.total - 3000,
  status: 'completed', occurredAt: '2026-11-17T10:30:00.000Z',
}
const lines: SaleLineRecord[] = cart.map((c, i) => ({
  id: `l${i}`, tenantId: 't', saleId: 's1', productId: c.productId, productName: c.productName, unitId: c.unitId, unitName: c.unitName, quantity: c.quantity,
  baseQuantity: c.quantity, unitPrice: c.unitPrice, lineDiscount: c.lineDiscount, lineTotal: 0, costOfGoods: 0,
}))
const seller = { name: 'Boutique Mbarga', lines: ['Rue Joss, Douala'], phone: '+237 677 12 34 56', taxId: 'M012345678901A' }
const buyer = { name: 'Awa Ndongo', phone: '677000111' }

describe('sale invoice data', () => {
  const inv = buildSaleInvoice({ sale, lines, seller, buyer, payments: [{ method: 'cash', amount: 3000 }], lang: 'fr' })
  it('adds up: lines = subtotal, subtotal - discount + tax = total', () => {
    expect(invoiceProblems(inv)).toEqual([])
    expect(inv.lines.reduce((t, l) => t + l.amount, 0)).toBe(totals.subtotal)
    expect(inv.total).toBe(totals.total)
  })
  it('shows fractional quantities cleanly and the balance still owed', () => {
    expect(inv.lines[1].quantity).toBe('2.5 kg')
    expect(qtyText(2.0000000001)).toBe('2')
    expect(inv.balance).toBe(totals.total - 3000)
    expect(inv.payments).toEqual([{ label: 'Espèces', amount: 3000 }])
  })
  it('returns and later repayments reduce what is still owed, never below zero', () => {
    const settled = buildSaleInvoice({ sale, lines, seller, buyer, payments: [{ method: 'cash', amount: 3000 }], laterPayments: totals.total - 3000, lang: 'en' })
    expect(settled.balance).toBe(0)
    const returned = buildSaleInvoice({ sale, lines, seller, buyer, payments: [{ method: 'cash', amount: 3000 }], returned: 100000, lang: 'en' })
    expect(returned.balance).toBe(0)
  })
  it('a wrong invoice is caught before it reaches a customer', () => {
    expect(invoiceProblems({ ...inv, total: inv.total + 1 })).toContain('subtotal - discount + tax is not the total')
    expect(invoiceProblems({ ...inv, subtotal: inv.subtotal + 5 })).toContain('lines do not add up to the subtotal')
  })
})

describe('subscription invoice data', () => {
  it('has one line, no balance, and is in the chosen language', () => {
    const inv = buildSubscriptionInvoice({ number: 'INV-2026-000010', issuedAt: '2026-11-17T10:00:00Z', planName: 'Business', periodStart: '2026-11-17T10:00:00Z', periodEnd: '2026-12-17T10:00:00Z', amount: 5000, method: 'mtn_momo', seller: { name: 'StockCM' }, buyer: { name: 'Boutique Mbarga' }, lang: 'en' })
    expect(invoiceProblems(inv)).toEqual([])
    expect(inv.title).toBe('SUBSCRIPTION INVOICE')
    expect(inv.balance).toBe(0)
    expect(inv.payments[0]).toEqual({ label: 'MTN MoMo', amount: 5000 })
    expect(inv.lines[0].description).toContain('Business')
  })
})

describe('the PDF itself', () => {
  it('is a real PDF with the number, names and totals in it, and the right title', async () => {
    const inv = buildSaleInvoice({ sale, lines, seller, buyer, payments: [{ method: 'cash', amount: 3000 }], lang: 'fr' })
    const bytes = await renderInvoicePdf(inv)
    const text = new TextDecoder('latin1').decode(bytes)
    expect(text.startsWith('%PDF-')).toBe(true)
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true)
    for (const s of ['A1B2-0042', 'Boutique Mbarga', 'Awa Ndongo', 'M012345678901A', 'FACTURE']) expect(text).toContain(s)
    expect(text).toContain(String(totals.total).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' FCFA')
    expect(bytes.length).toBeGreaterThan(1500)
  })
  it('a long invoice flows onto more pages, with page numbers', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ ...lines[0], id: `m${i}`, productName: `Article numéro ${i + 1}` }))
    const big = buildSaleInvoice({
      sale: { ...sale, subtotal: 60 * 2000, discount: 0, tax: 0, total: 60 * 2000, outstanding: 0 },
      lines: many.map((l) => ({ ...l, quantity: 4, unitPrice: 500, lineDiscount: 0 })), seller, buyer: null, payments: [{ method: 'cash', amount: 120000 }], lang: 'en',
    })
    expect(invoiceProblems(big)).toEqual([])
    const text = new TextDecoder('latin1').decode(await renderInvoicePdf(big))
    expect((text.match(/\/Type \/Page\b/g) ?? []).length).toBeGreaterThanOrEqual(2)
    expect(text).toContain('Page 2/')
  })
  it('names the file safely', () => {
    expect(invoiceFileName('A1B2/0042 ../x')).toBe('facture-a1b2-0042-x.pdf')
  })
})
