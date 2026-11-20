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
    <div className="stack">
      <h3 className="h5">{t('sync.title')}</h3>
      <p className="body-md">{status === 'pending' ? t('sync.pending', { n: summary.pendingGroups }) : t(`sync.${status}`)}</p>
      <p className="body-sm muted">{t('sync.lastSync', { when })}</p>

      {unsyncedTooLong(summary) && <p role="alert" className="notice notice--amber body-sm">{t('sync.warn48')}</p>}
      {offlineLimitExceeded(summary.lastSyncAt) && <p role="alert" className="notice notice--amber body-sm">{t('sync.offlineLimit')}</p>}
      {engine.revoked && <p role="alert" className="panel panel--flag body-sm">! {t('sync.revoked')}</p>}

      <button
        disabled={!canSync || engine.running || !ctx}
        onClick={() => ctx && void runSync(supabaseTransport, { tenantId: ctx.tenantId, deviceName: navigator.platform || 'web' }, { manual: true })}
        className="btn btn--primary"
      >
        {t('sync.now')}
      </button>

      <section>
        <div className="panel__head">
          <h4 className="h6">{t('sync.issues')}</h4>
          {issues.length > 1 && (
            <button onClick={() => void retryAllFailed()} className="btn btn--tertiary">{t('sync.retryAll')}</button>
          )}
        </div>
        {issues.length === 0 && <p className="body-md muted">{t('sync.noIssues')}</p>}
        <ul className="stack">
          {issues.map(([groupId, rows]) => (
            <li key={groupId} className="panel">
              <p className="body-md">
                {label(rows)} <span className="body-sm muted">({rows[0].status})</span>
              </p>
              {rows[0].status === 'conflict' && <p className="body-sm">{t('sync.conflictHelp')}</p>}
              <p className="field__error">{/plan_limit/.test(rows[0].lastError ?? '') ? t('billing.planLimit') : rows[0].lastError}</p>
              <div className="flex flex-wrap gap-2" style={{ marginTop: 8 }}>
                {rows[0].status === 'conflict' && rows.some((r) => r.table === 'products') && (
                  <button onClick={() => void resolveBarcodeConflict(groupId)} className="btn btn--primary">
                    {t('sync.resolveBarcode')}
                  </button>
                )}
                <button onClick={() => void retryGroup(groupId)} className="btn btn--secondary">{t('sync.retry')}</button>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h4 className="h6" style={{ marginBottom: 10 }}>{t('sync.history')}</h4>
        <ul className="body-sm muted stack" style={{ gap: 4 }}>
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
