import { describe, expect, it } from 'vitest'
import { buildReceiptText, whatsappLink } from './receipt'
import type { SaleLineRecord, SaleRecord } from './pos'

const sale: SaleRecord = {
  id: 's', tenantId: 't', shopId: 'sh', saleNumber: 'AB12-0007', cashierId: 'u', deviceId: 'd',
  subtotal: 30000, discount: 0, tax: 0, total: 30000, collected: 15000, outstanding: 15000,
  status: 'completed', occurredAt: '2026-11-17T09:30:00Z',
}
const line: SaleLineRecord = {
  id: 'l', tenantId: 't', saleId: 's', productId: 'p', productName: 'Riz 25kg', unitId: 'u', unitName: 'sac',
  quantity: 2, baseQuantity: 2, unitPrice: 15000, lineDiscount: 0, lineTotal: 30000, costOfGoods: 0,
}

describe('receipt', () => {
  it('shows what was collected and what is still owed', () => {
    const text = buildReceiptText('Boutique Mama', sale, [line], [{ method: 'cash', amount: 10000 }, { method: 'mtn_momo', amount: 5000 }], 'fr')
    expect(text).toContain('Reçu N° AB12-0007')
    expect(text).toContain('Riz 25kg')
    expect(text).toContain('Total: 30 000 FCFA')
    expect(text).toContain('Espèces: 10 000 FCFA')
    expect(text).toContain('MTN MoMo: 5 000 FCFA')
    expect(text).toContain('Reste dû: 15 000 FCFA')
  })
  it('builds a WhatsApp link with an encoded message', () => {
    const url = whatsappLink('Total: 5 000', '+237 677 12 34 56')
    expect(url.startsWith('https://wa.me/237677123456?text=')).toBe(true)
    expect(url).toContain(encodeURIComponent('Total: 5 000'))
  })
})
