import { moneyText } from './reminders'
import type { SaleLineRecord, SaleRecord } from './pos'

/**
 * Everything printed on an invoice, as plain data. The PDF renderer only draws this; all the arithmetic and wording lives
 * here so it can be tested without producing a PDF.
 */
export type Lang = 'fr' | 'en'

export interface Party {
  name: string
  lines?: string[]
  phone?: string
  /** Tax identification number (NIU in Cameroon), shown only when known. */
  taxId?: string
}

export interface InvoiceLine {
  description: string
  quantity: string
  unitPrice: number
  /** Line amount excluding tax, before discounts (the discount is shown once, below the lines). */
  amount: number
}

export interface InvoiceData {
  kind: 'sale' | 'subscription'
  lang: Lang
  title: string
  number: string
  date: string
  seller: Party
  buyer: Party | null
  lines: InvoiceLine[]
  subtotal: number
  discount: number
  tax: number
  total: number
  payments: { label: string; amount: number }[]
  returned: number
  /** Still to be paid by the buyer (0 when settled). */
  balance: number
  notes: string[]
  labels: Labels
}

export interface Labels {
  from: string; to: string; number: string; date: string; description: string; qty: string; unitPrice: string; amount: string
  subtotal: string; discount: string; tax: string; total: string; paid: string; returned: string; balance: string; settled: string; page: string
}

export const LABELS: Record<Lang, Labels> = {
  fr: { from: 'Émetteur', to: 'Client', number: 'N°', date: 'Date', description: 'Désignation', qty: 'Qté', unitPrice: 'Prix unitaire', amount: 'Montant', subtotal: 'Sous-total', discount: 'Remise', tax: 'Taxe', total: 'Total à payer', paid: 'Payé', returned: 'Retours', balance: 'Reste dû', settled: 'Payée en totalité', page: 'Page' },
  en: { from: 'From', to: 'Billed to', number: 'No.', date: 'Date', description: 'Description', qty: 'Qty', unitPrice: 'Unit price', amount: 'Amount', subtotal: 'Subtotal', discount: 'Discount', tax: 'Tax', total: 'Total due', paid: 'Paid', returned: 'Returns', balance: 'Balance due', settled: 'Paid in full', page: 'Page' },
}

const METHOD: Record<Lang, Record<string, string>> = {
  fr: { cash: 'Espèces', mtn_momo: 'MTN MoMo', orange_money: 'Orange Money' },
  en: { cash: 'Cash', mtn_momo: 'MTN MoMo', orange_money: 'Orange Money' },
}

const TITLE = { sale: { fr: 'FACTURE', en: 'INVOICE' }, subscription: { fr: 'FACTURE D’ABONNEMENT', en: 'SUBSCRIPTION INVOICE' } }

/** `3` or `2.5` (never `2.500000001`). */
export function qtyText(q: number): string {
  return String(Math.round(q * 1000) / 1000)
}

export interface SaleInvoiceInput {
  sale: SaleRecord
  lines: readonly SaleLineRecord[]
  seller: Party
  buyer: Party | null
  /** Money actually received for this sale at the till, per method (credit is not a payment). */
  payments: readonly { method: string; amount: number }[]
  /** Customer repayments allocated to this sale later. */
  laterPayments?: number
  /** Value (including tax) handed back through returns of this sale. */
  returned?: number
  lang: Lang
  note?: string
}

export function buildSaleInvoice(i: SaleInvoiceInput): InvoiceData {
  const labels = LABELS[i.lang]
  const lines: InvoiceLine[] = i.lines.map((l) => ({
    description: l.productName,
    quantity: `${qtyText(l.quantity)} ${l.unitName}`,
    unitPrice: l.unitPrice,
    amount: Math.round(l.unitPrice * l.quantity),
  }))
  const payments = i.payments.filter((p) => p.amount !== 0).map((p) => ({ label: METHOD[i.lang][p.method] ?? p.method, amount: p.amount }))
  if (i.laterPayments && i.laterPayments > 0) payments.push({ label: i.lang === 'fr' ? 'Remboursements de dette' : 'Debt repayments', amount: i.laterPayments })
  const paid = payments.reduce((t, p) => t + p.amount, 0)
  const returned = i.returned ?? 0
  const balance = Math.max(i.sale.total - returned - paid, 0)
  return {
    kind: 'sale', lang: i.lang, title: TITLE.sale[i.lang], number: i.sale.saleNumber, date: i.sale.occurredAt,
    seller: i.seller, buyer: i.buyer, lines,
    subtotal: i.sale.subtotal,
    discount: i.sale.discount, tax: i.sale.tax, total: i.sale.total, payments, returned, balance,
    notes: i.note ? [i.note] : [],
    labels,
  }
}

export interface SubscriptionInvoiceInput {
  number: string
  issuedAt: string
  planName: string
  periodStart: string | null
  periodEnd: string
  amount: number
  method?: string
  seller: Party
  buyer: Party
  lang: Lang
}

export function buildSubscriptionInvoice(i: SubscriptionInvoiceInput): InvoiceData {
  const fr = i.lang === 'fr'
  const d = (iso: string) => new Date(iso).toLocaleDateString(fr ? 'fr-FR' : 'en-GB')
  const period = i.periodStart ? `${d(i.periodStart)} – ${d(i.periodEnd)}` : `→ ${d(i.periodEnd)}`
  return {
    kind: 'subscription', lang: i.lang, title: TITLE.subscription[i.lang], number: i.number, date: i.issuedAt,
    seller: i.seller, buyer: i.buyer,
    lines: [{ description: `${fr ? 'Abonnement StockCM' : 'StockCM subscription'} — ${i.planName} (${period})`, quantity: '1', unitPrice: i.amount, amount: i.amount }],
    subtotal: i.amount, discount: 0, tax: 0, total: i.amount,
    payments: [{ label: i.method ? (METHOD[i.lang][i.method] ?? i.method) : (fr ? 'Paiement reçu' : 'Payment received'), amount: i.amount }],
    returned: 0, balance: 0, notes: [], labels: LABELS[i.lang],
  }
}

/** Checks the invoice adds up. A PDF that does not add up must never be handed to a customer. */
export function invoiceProblems(inv: InvoiceData): string[] {
  const out: string[] = []
  const lineSum = inv.lines.reduce((t, l) => t + l.amount, 0)
  if (lineSum !== inv.subtotal) out.push('lines do not add up to the subtotal')
  if (inv.subtotal - inv.discount + inv.tax !== inv.total) out.push('subtotal - discount + tax is not the total')
  if (inv.balance < 0) out.push('negative balance')
  return out
}

export const fmtMoney = moneyText
