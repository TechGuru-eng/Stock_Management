import { useTranslation } from 'react-i18next'
import { useAuth } from '../../auth/AuthProvider'

/** Header control: which shop am I working in. Only shown when this person may use more than one. */
export function ShopSwitcher() {
  const { t } = useTranslation()
  const { membership, selectShop } = useAuth()
  if (!membership || membership.shops.length < 2) return null
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="sr-only">{t('shops.current')}</span>
      <select
        value={membership.shopId}
        onChange={(e) => selectShop(e.target.value)}
        className="min-h-10 max-w-[11rem] rounded border border-white/60 bg-teal-800 px-2 text-white"
      >
        {membership.shops.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
    </label>
  )
}
