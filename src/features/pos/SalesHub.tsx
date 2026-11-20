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
    <div className="stack">
      <div role="tablist" className="auth-tabs" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        {(['sale', 'returns', 'invoices'] as const).map((k) => (
          <button key={k} role="tab" aria-selected={sub === k} onClick={() => setSub(k)}>
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
