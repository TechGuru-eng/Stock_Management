import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { PurchasesView, SuppliersView } from '../purchasing/PurchasingScreens'
import { StockScreen } from './StockScreen'

type Sub = 'products' | 'purchases' | 'suppliers'

/** Stock tab: products and levels, purchase orders and deliveries, and suppliers. */
export function StockHub() {
  const { t } = useTranslation()
  const [sub, setSub] = useState<Sub>('products')
  const tabs: Sub[] = ['products', 'purchases', 'suppliers']
  return (
    <div className="flex flex-col gap-4">
      <div role="tablist" className="grid grid-cols-3 gap-1">
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
    </div>
  )
}
