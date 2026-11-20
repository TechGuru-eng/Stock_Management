import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAlerts } from './useAlerts'

const KEY = 'stockcm.alertBannerDismissed'

/** A red strip while something is OUT of stock. It can be put away for this session; it comes back when another product runs out. */
export function StockAlertBanner({ onSee }: { onSee: () => void }) {
  const { t } = useTranslation()
  const state = useAlerts()
  const [dismissed, setDismissed] = useState(() => { try { return sessionStorage.getItem(KEY) ?? '' } catch { return '' } })
  const out = state?.active.filter((a) => a.level === 'out') ?? []
  const sig = out.map((a) => a.productId).sort().join(',')
  if (out.length === 0 || dismissed === sig) return null
  return (
    <div role="status" className="banner banner--flag print:hidden">
      <span>! {t('alerts.bannerOut', { count: out.length, names: out.slice(0, 3).map((a) => a.name).join(', ') + (out.length > 3 ? '…' : '') })}</span>
      <span className="btn-row">
        <button onClick={onSee} className="btn btn--secondary">{t('alerts.seeAll')}</button>
        <button onClick={() => { try { sessionStorage.setItem(KEY, sig) } catch { /* shown again next time */ } setDismissed(sig) }} className="btn btn--tertiary">{t('alerts.dismiss')}</button>
      </span>
    </div>
  )
}
