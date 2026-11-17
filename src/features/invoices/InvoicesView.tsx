import { useLiveQuery } from 'dexie-react-hooks'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { db } from '../../data/db'
import { useCtx } from '../../data/useCtx'
import { formatXaf } from '../../domain/money'
import { InvoiceActions } from './InvoiceActions'

/** Sales tab > Invoices: find a past sale of this shop and save or share it as a PDF invoice. */
export function InvoicesView() {
  const { t, i18n } = useTranslation()
  const ctx = useCtx()
  const [q, setQ] = useState('')
  const rows = useLiveQuery(async () => {
    if (!ctx) return []
    const sales = (await db.sales.toArray()).filter((s) => s.shopId === ctx.shopId).sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1))
    const customers = new Map((await db.customers.toArray()).map((c) => [c.id, c.name]))
    return sales.map((s) => ({ s, customer: s.customerId ? customers.get(s.customerId) : undefined }))
  }, [ctx?.shopId]) ?? []

  const needle = q.trim().toLowerCase()
  const shown = rows.filter((r) => !needle || r.s.saleNumber.toLowerCase().includes(needle) || (r.customer ?? '').toLowerCase().includes(needle)).slice(0, 50)

  return (
    <div className="flex flex-col gap-3">
      <input
        className="min-h-12 w-full rounded border border-slate-300 bg-transparent px-3" placeholder={t('invoices.search')} aria-label={t('invoices.search')}
        value={q} onChange={(e) => setQ(e.target.value)}
      />
      {shown.length === 0 && <p className="text-slate-500">{t('invoices.none')}</p>}
      <ul className="divide-y divide-slate-200 dark:divide-slate-800">
        {shown.map(({ s, customer }) => (
          <li key={s.id} className="flex items-center justify-between gap-2 py-2">
            <div>
              <div className="font-medium">{s.saleNumber} · {formatXaf(s.total)}</div>
              <div className="text-sm text-slate-500">{new Date(s.occurredAt).toLocaleString(i18n.language)}{customer ? ` · ${customer}` : ''}{s.outstanding > 0 ? ` · ${t('invoices.onCredit')}` : ''}</div>
            </div>
            <InvoiceActions saleId={s.id} compact />
          </li>
        ))}
      </ul>
      {rows.length > 50 && !needle && <p className="text-xs text-slate-500">{t('invoices.latest')}</p>}
    </div>
  )
}
