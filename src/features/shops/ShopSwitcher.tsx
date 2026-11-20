import { useTranslation } from 'react-i18next'
import { useAuth } from '../../auth/AuthProvider'

/** Header control: which shop am I working in. Only shown when this person may use more than one. */
export function ShopSwitcher() {
  const { t } = useTranslation()
  const { membership, selectShop } = useAuth()
  if (!membership || membership.shops.length < 2) return null
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <span className="sr-only">{t('shops.current')}</span>
      <select
        value={membership.shopId}
        onChange={(e) => selectShop(e.target.value)}
        className="input"
        style={{ height: 32, maxWidth: '11rem', padding: '0 8px' }}
      >
        {membership.shops.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
    </label>
  )
}
