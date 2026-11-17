import { useLiveQuery } from 'dexie-react-hooks'
import { useTranslation } from 'react-i18next'
import { db, type OutboxRec } from '../../data/db'
import { useCtx } from '../../data/useCtx'
import { resolveBarcodeConflict, retryAllFailed, retryGroup, runSync } from '../../sync/engine'
import { offlineLimitExceeded, unsyncedTooLong, useSyncStatus } from '../../sync/status'
import { supabaseTransport } from '../../sync/supabaseTransport'

function label(rows: OutboxRec[]): string {
  const first = rows[0].payload as { saleNumber?: string; name?: string }
  const kind = rows.find((r) => r.table === 'sales') ? 'Sale' : rows.find((r) => r.table === 'products') ? 'Product' : rows[0].table
  return `${kind} ${first.saleNumber ?? first.name ?? ''}`.trim()
}

export function SyncScreen({ canSync }: { canSync: boolean }) {
  const { t } = useTranslation()
  const ctx = useCtx()
  const { summary, engine, status } = useSyncStatus()

  const issues =
    useLiveQuery(async () => {
      const rows = await db.outbox.where('status').anyOf('rejected', 'conflict').sortBy('seq')
      const groups = new Map<string, OutboxRec[]>()
      for (const r of rows) groups.set(r.groupId, [...(groups.get(r.groupId) ?? []), r])
      return [...groups.entries()]
    }, []) ?? []
  const history = useLiveQuery(() => db.syncLog.orderBy('id').reverse().limit(8).toArray(), []) ?? []

  const when = summary.lastSyncAt ? new Date(summary.lastSyncAt).toLocaleString() : t('sync.never')

  return (
    <div className="flex flex-col gap-4">
      <h3 className="text-lg font-semibold">{t('sync.title')}</h3>
      <p>{status === 'pending' ? t('sync.pending', { n: summary.pendingGroups }) : t(`sync.${status}`)}</p>
      <p className="text-sm text-slate-600 dark:text-slate-300">{t('sync.lastSync', { when })}</p>

      {unsyncedTooLong(summary) && <p role="alert" className="rounded bg-amber-100 p-3 text-amber-900">{t('sync.warn48')}</p>}
      {offlineLimitExceeded(summary.lastSyncAt) && <p role="alert" className="rounded bg-amber-100 p-3 text-amber-900">{t('sync.offlineLimit')}</p>}
      {engine.revoked && <p role="alert" className="rounded bg-red-100 p-3 text-red-900">{t('sync.revoked')}</p>}

      <button
        disabled={!canSync || engine.running || !ctx}
        onClick={() => ctx && void runSync(supabaseTransport, { tenantId: ctx.tenantId, deviceName: navigator.platform || 'web' }, { manual: true })}
        className="min-h-12 rounded bg-teal-700 px-4 font-semibold text-white disabled:opacity-60"
      >
        {t('sync.now')}
      </button>

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h4 className="font-semibold">{t('sync.issues')}</h4>
          {issues.length > 1 && (
            <button onClick={() => void retryAllFailed()} className="min-h-12 text-teal-700 underline">{t('sync.retryAll')}</button>
          )}
        </div>
        {issues.length === 0 && <p className="text-slate-500">{t('sync.noIssues')}</p>}
        <ul className="flex flex-col gap-3">
          {issues.map(([groupId, rows]) => (
            <li key={groupId} className="rounded border border-slate-200 p-3">
              <p className="font-medium">
                {label(rows)} <span className="text-sm font-normal text-slate-500">({rows[0].status})</span>
              </p>
              {rows[0].status === 'conflict' && <p className="text-sm">{t('sync.conflictHelp')}</p>}
              <p className="text-sm text-red-700">{rows[0].lastError}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {rows[0].status === 'conflict' && rows.some((r) => r.table === 'products') && (
                  <button onClick={() => void resolveBarcodeConflict(groupId)} className="min-h-12 rounded bg-teal-700 px-3 text-white">
                    {t('sync.resolveBarcode')}
                  </button>
                )}
                <button onClick={() => void retryGroup(groupId)} className="min-h-12 rounded border border-slate-300 px-3">{t('sync.retry')}</button>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h4 className="mb-2 font-semibold">{t('sync.history')}</h4>
        <ul className="text-sm text-slate-600 dark:text-slate-300">
          {history.map((h) => (
            <li key={h.id}>
              {new Date(h.at).toLocaleTimeString()} · {h.outcome === 'conflict' ? t('sync.conflictLog') : t(`sync.${h.outcome}`)}
              {h.message ? ` · ${h.message}` : ''}
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
