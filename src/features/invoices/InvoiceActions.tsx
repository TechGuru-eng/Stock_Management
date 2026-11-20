import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { db } from '../../data/db'
import { buildSaleInvoice, invoiceProblems, type Party } from '../../domain/invoice'
import { downloadPdf, invoiceFileName, renderInvoicePdf, sharePdf } from '../../pdf/invoicePdf'
import { useSeller } from './useSeller'

/** Everything needed to print a sale as an invoice is read from the device, so it works offline. */
async function loadSaleInvoice(saleId: string, seller: Party, lang: 'fr' | 'en') {
  const sale = await db.sales.get(saleId)
  if (!sale) throw new Error('sale not found')
  const lines = await db.saleLines.where('saleId').equals(saleId).toArray()
  const customer = sale.customerId ? await db.customers.get(sale.customerId) : undefined
  const txns = (await db.transactions.where('saleId').equals(saleId).toArray()).filter((t) => t.txnType === 'sale_collection')
  const byMethod = new Map<string, number>()
  for (const t of txns) byMethod.set(t.method, (byMethod.get(t.method) ?? 0) + t.amount)
  const later = (await db.allocations.where('saleId').equals(saleId).toArray()).reduce((t, a) => t + a.amount, 0)
  const returned = (await db.saleReturns.where('saleId').equals(saleId).toArray()).reduce((t, r) => t + r.totalValue, 0)
  return buildSaleInvoice({
    sale, lines, seller, lang, laterPayments: later, returned,
    buyer: customer ? { name: customer.name, phone: customer.phone } : null,
    payments: [...byMethod].map(([method, amount]) => ({ method, amount })),
  })
}

/** Buttons to save or share one sale as a PDF invoice. */
export function InvoiceActions({ saleId, compact }: { saleId: string; compact?: boolean }) {
  const { t, i18n } = useTranslation()
  const seller = useSeller()
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const lang = i18n.language.startsWith('fr') ? 'fr' : 'en'

  async function make(mode: 'download' | 'share') {
    setBusy(true)
    setMsg(null)
    try {
      const inv = await loadSaleInvoice(saleId, seller, lang)
      const problems = invoiceProblems(inv)
      if (problems.length) throw new Error(problems.join('; '))
      const bytes = await renderInvoicePdf(inv)
      const name = invoiceFileName(inv.number)
      if (mode === 'share' && (await sharePdf(name, bytes, `${inv.title} ${inv.number}`))) return
      downloadPdf(name, bytes)
    } catch (e) {
      setMsg(t('invoices.error', { msg: (e as Error).message }))
    } finally {
      setBusy(false)
    }
  }

  const cls = compact ? 'btn btn--secondary btn--sm' : 'btn btn--secondary flex-1'
  return (
    <span className={compact ? 'flex flex-col items-end gap-1' : 'flex flex-col gap-2'}>
      <span className="flex gap-2">
        <button type="button" disabled={busy} onClick={() => void make('download')} className={cls}>{busy ? '…' : t('invoices.pdf')}</button>
        <button type="button" disabled={busy} onClick={() => void make('share')} className={cls}>{t('invoices.share')}</button>
      </span>
      {msg && <span role="alert" className="field__error">{msg}</span>}
    </span>
  )
}
