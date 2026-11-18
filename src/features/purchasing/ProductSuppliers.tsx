import { useLiveQuery } from 'dexie-react-hooks'
import { useTranslation } from 'react-i18next'
import { db } from '../../data/db'
import { formatXaf } from '../../domain/money'
import { bestSuppliers, currentQuotes } from '../../domain/supplierPrices'

/** On a product: which suppliers quote it and at what price per base unit, cheapest first. Hidden when nobody has quoted it. */
export function ProductSuppliers({ productId }: { productId: string }) {
  const { t, i18n } = useTranslation()
  const data = useLiveQuery(async () => {
    const [prices, units, suppliers] = await Promise.all([db.supplierPrices.where('productId').equals(productId).toArray(), db.units.where('productId').equals(productId).toArray(), db.suppliers.toArray()])
    return { prices, units: new Map(units.map((u) => [u.id, { name: u.name, factor: u.factor }])), names: new Map(suppliers.map((s) => [s.id, s.name])) }
  }, [productId])
  if (!data || data.prices.length === 0) return null
  const best = bestSuppliers(productId, currentQuotes(data.prices), data.units)
  return (
    <section className="rounded border border-slate-200 p-3 text-sm dark:border-slate-700">
      <h4 className="mb-1 font-semibold">{t('sprice.suppliers')}</h4>
      <ul className="flex flex-col gap-1">
        {best.rows.map((r, i) => (
          <li key={r.supplierId} className="flex justify-between gap-2">
            <span>{data.names.get(r.supplierId) ?? '—'}{i === 0 && best.rows.length > 1 && <span className="ml-2 rounded bg-teal-100 px-1.5 py-0.5 text-xs font-medium text-teal-800">{t('sprice.cheapest')}</span>}</span>
            <span className="tabular-nums">{formatXaf(r.price)} / {r.unitName}<span className="block text-right text-xs text-slate-500">{formatXaf(r.perBase)} / {t('sprice.base')} · {new Date(r.recordedAt).toLocaleDateString(i18n.language)}</span></span>
          </li>
        ))}
      </ul>
      {best.cheapestSavingBp !== null && best.cheapestSavingBp < 0 && <p className="mt-1 text-xs text-slate-500">{t('sprice.saving', { pct: Math.abs(best.cheapestSavingBp / 100).toFixed(0) })}</p>}
    </section>
  )
}
