import { useTranslation } from 'react-i18next'
import { useSyncStatus, type SyncStatus } from '../../sync/status'

const dot: Record<SyncStatus, string> = {
  synced: 'bg-emerald-300',
  pending: 'bg-amber-300',
  syncing: 'bg-sky-300 animate-pulse',
  failed: 'bg-red-400',
  conflict: 'bg-red-400',
}

/** Always-visible synchronisation state. Tapping it opens the details. */
export function SyncBadge({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation()
  const { status, summary } = useSyncStatus()
  const label = status === 'pending' ? t('sync.pending', { n: summary.pendingGroups }) : t(`sync.${status}`)
  return (
    <button onClick={onClick} className="flex min-h-12 items-center gap-2 text-sm" aria-live="polite">
      <span className={`inline-block h-3 w-3 rounded-full ${dot[status]}`} aria-hidden />
      <span>{label}</span>
    </button>
  )
}
