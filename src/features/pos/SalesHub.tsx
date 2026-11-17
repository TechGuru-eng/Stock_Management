import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { InvoicesView } from '../invoices/InvoicesView'
import { ReturnsView } from '../returns/ReturnsView'
import { PosScreen } from './PosScreen'

/** Sales tab: the till, and returns / refunds / cancellations. */
export function SalesHub() {
  const { t } = useTranslation()
  const [sub, setSub] = useState<'sale' | 'returns' | 'invoices'>('sale')
  return (
    <div className="flex flex-col gap-4">
      <div role="tablist" className="grid grid-cols-3 gap-1">
        {(['sale', 'returns', 'invoices'] as const).map((k) => (
          <button
            key={k} role="tab" aria-selected={sub === k} onClick={() => setSub(k)}
            className={`min-h-12 rounded px-1 text-sm ${sub === k ? 'bg-teal-700 font-semibold text-white' : 'border border-slate-300'}`}
          >
            {k === 'invoices' ? t('invoices.tab') : t(`rets.${k}`)}
          </button>
        ))}
      </div>
      {sub === 'sale' && <PosScreen />}
      {sub === 'returns' && <ReturnsView />}
      {sub === 'invoices' && <InvoicesView />}
    </div>
  )
}
