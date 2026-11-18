import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../auth/AuthProvider'
import { can } from '../../domain/permissions'
import { CountsView } from '../counts/CountsView'
import { TransferView } from '../shops/TransferView'
import { PurchasesView, SuppliersView } from '../purchasing/PurchasingScreens'
import { StockScreen } from './StockScreen'

type Sub = 'products' | 'purchases' | 'suppliers' | 'transfers' | 'counts'

/** Stock tab: products and levels, purchase orders and deliveries, and suppliers. */
export function StockHub() {
  const { t } = useTranslation()
  const [sub, setSub] = useState<Sub>('products')
  const { membership } = useAuth()
  // Transfers only make sense with a second shop, and need the right to adjust stock.
  const canTransfer = Boolean(membership && membership.shops.length > 1 && can(membership.role, 'stock.adjust_approve'))
  const canCount = Boolean(membership && can(membership.role, 'stock.count'))
  const tabs: Sub[] = ['products', 'purchases', 'suppliers', ...(canTransfer ? (['transfers'] as const) : []), ...(canCount ? (['counts'] as const) : [])]
  return (
    <div className="flex flex-col gap-4">
      <div role="tablist" className={`grid gap-1 ${tabs.length >= 5 ? 'grid-cols-5' : tabs.length === 4 ? 'grid-cols-4' : 'grid-cols-3'}`}>
        {tabs.map((k) => (
          <button
            key={k} role="tab" aria-selected={sub === k} onClick={() => setSub(k)}
            className={`min-h-12 rounded px-1 text-sm ${sub === k ? 'bg-teal-700 font-semibold text-white' : 'border border-slate-300'}`}
          >
            {t(`purch.${k}`)}
          </button>
        ))}
      </div>
      {sub === 'products' && <StockScreen />}
      {sub === 'purchases' && <PurchasesView />}
      {sub === 'suppliers' && <SuppliersView />}
      {sub === 'transfers' && canTransfer && <TransferView />}
      {sub === 'counts' && canCount && <CountsView />}
    </div>
  )
}
