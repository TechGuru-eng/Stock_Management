import { formatXaf } from './money'
import type { SaleLineRecord, SaleRecord } from './pos'

const labels = {
  fr: { receipt: 'Reçu', no: 'N°', date: 'Date', total: 'Total', tax: 'Taxe', discount: 'Remise', paid: 'Encaissé', owed: 'Reste dû', thanks: 'Merci pour votre achat !', cash: 'Espèces', mtn_momo: 'MTN MoMo', orange_money: 'Orange Money' },
  en: { receipt: 'Receipt', no: 'No.', date: 'Date', total: 'Total', tax: 'Tax', discount: 'Discount', paid: 'Paid', owed: 'Balance due', thanks: 'Thank you for your purchase!', cash: 'Cash', mtn_momo: 'MTN MoMo', orange_money: 'Orange Money' },
} as const

export interface ReceiptPayment {
  method: 'cash' | 'mtn_momo' | 'orange_money'
  amount: number
}

/** Plain text receipt: works for WhatsApp, SMS, a thermal printer and the print dialog. */
export function buildReceiptText(
  shopName: string,
  sale: SaleRecord,
  lines: readonly SaleLineRecord[],
  payments: readonly ReceiptPayment[],
  lang: 'fr' | 'en',
): string {
  const l = labels[lang]
  const out: string[] = [shopName, `${l.receipt} ${l.no} ${sale.saleNumber}`, `${l.date}: ${sale.occurredAt.slice(0, 16).replace('T', ' ')}`, '']
  for (const li of lines) {
    out.push(`${li.productName}`)
    out.push(`  ${li.quantity} ${li.unitName} x ${formatXaf(li.unitPrice)} = ${formatXaf(li.lineTotal)}`)
  }
  out.push('')
  if (sale.discount > 0) out.push(`${l.discount}: -${formatXaf(sale.discount)}`)
  if (sale.tax > 0) out.push(`${l.tax}: ${formatXaf(sale.tax)}`)
  out.push(`${l.total}: ${formatXaf(sale.total)}`)
  for (const p of payments) out.push(`${l[p.method]}: ${formatXaf(p.amount)}`)
  if (sale.outstanding > 0) out.push(`${l.owed}: ${formatXaf(sale.outstanding)}`)
  out.push('', l.thanks)
  return out.join('\n')
}

export function whatsappLink(text: string, phone?: string): string {
  const digits = phone?.replace(/\D/g, '')
  return `https://wa.me/${digits ?? ''}?text=${encodeURIComponent(text)}`
}
