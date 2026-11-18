import { useLiveQuery } from 'dexie-react-hooks'
import { useTranslation } from 'react-i18next'
import { db } from '../../data/db'
import { formatXaf } from '../../domain/money'
import { costWarning, currentQuotes, lastPaid, perBaseUnit, suggestedTotal } from '../../domain/supplierPrices'

/**
 * Under an order line: what this supplier quotes for the chosen unit, what was paid last time, a button to fill the cost from the quote,
 * and a warning when the typed cost is clearly dearer than either. It never changes anything by itself.
 */
export function QuoteHint({ supplierId, productId, unitId, quantity, totalCost, onUse }: {
  supplierId: string; productId: string; unitId: string; quantity: number; totalCost: number; onUse: (total: number) => void
}) {
  const { t, i18n } = useTranslation()
  const info = useLiveQuery(async () => {
    if (!supplierId || !productId) return null
    const [prices, unit, purchases, receipts, receiptLines] = await Promise.all([
      db.supplierPrices.where('supplierId').equals(supplierId).toArray(), unitId ? db.units.get(unitId) : undefined,
      db.purchases.toArray(), db.receipts.toArray(), db.receiptLines.toArray(),
    ])
    const base = unit ?? (await db.units.where('productId').equals(productId).filter((u) => u.isBase).first())
    if (!base) return null
    const quote = currentQuotes(prices).get(`${supplierId}|${productId}|${base.id}`)
    return { quote, factor: base.factor, unitName: base.name, paid: lastPaid(purchases, receipts, receiptLines).get(`${supplierId}|${productId}`) }
  }, [supplierId, productId, unitId])
  if (!info || (!info.quote && !info.paid)) return null

  const enteredPerBase = quantity > 0 && totalCost > 0 ? totalCost / (quantity * info.factor) : null
  const warn = enteredPerBase !== null ? costWarning(enteredPerBase, info.quote ? perBaseUnit(info.quote.price, info.factor) : null, info.paid?.baseCost ?? null) : null

  return (
    <div className="flex flex-col gap-1 text-xs text-slate-600 dark:text-slate-300">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {info.quote && <span>{t('sprice.quoted', { price: formatXaf(info.quote.price), unit: info.unitName })}</span>}
        {info.paid && <span>{t('sprice.lastPaid', { cost: formatXaf(info.paid.baseCost), date: new Date(info.paid.at).toLocaleDateString(i18n.language) })}</span>}
        {info.quote && quantity > 0 && (
          <button type="button" className="font-medium text-teal-700 underline" onClick={() => onUse(suggestedTotal(info.quote!.price, quantity))}>{t('sprice.use', { total: formatXaf(suggestedTotal(info.quote.price, quantity)) })}</button>
        )}
      </div>
      {warn && <p role="alert" className="rounded bg-amber-50 p-1 text-amber-900 dark:bg-amber-950 dark:text-amber-100">{t(`sprice.warn.${warn}`)}</p>}
    </div>
  )
}
