import { useTranslation } from 'react-i18next'
import { useSyncStatus, type SyncStatus } from '../../sync/status'

const dot: Record<SyncStatus, string> = {
  synced: 'sync-dot sync-dot--solid',
  pending: 'sync-dot',
  syncing: 'sync-dot sync-dot--solid sync-dot--pulse',
  failed: 'sync-dot sync-dot--solid',
  conflict: 'sync-dot sync-dot--solid',
}
const needsAttention: SyncStatus[] = ['failed', 'conflict']

/** Always-visible synchronisation state. Tapping it opens the details. */
export function SyncBadge({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation()
  const { status, summary } = useSyncStatus()
  const label = status === 'pending' ? t('sync.pending', { n: summary.pendingGroups }) : t(`sync.${status}`)
  return (
    <button onClick={onClick} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minHeight: 32 }} aria-live="polite">
      <span className={dot[status]} aria-hidden />
      <span>{needsAttention.includes(status) ? `! ${label}` : label}</span>
    </button>
  )
}
