import { useTranslation } from 'react-i18next'
import { useAuth } from './AuthProvider'
import { requestLock } from './lock'

/** Header button on a shared till: lock now, so the next person can take over with their PIN. Hidden when nobody else could. */
export function SwitchPerson() {
  const { t } = useTranslation()
  const { membership, roster } = useAuth()
  if (!membership || membership.role === 'owner' && roster.length === 0 || roster.length < 2) return null
  return (
    <button onClick={requestLock} className="btn btn--secondary btn--sm">{t('staff.switchPerson')}</button>
  )
}
