import { useState } from 'react'
import type { SyncIssueRow } from '../api'
import { useAdmin } from '../ctx'
import { ErrorNote, fmtTime, Loading, ReasonDialog, useAsync } from '../ui'

const KIND_LABEL: Record<SyncIssueRow['kind'], string> = { rejected: 'Rejected', conflict: 'Conflict' }

/** Cross-business queue of sync problems a device reported and has not cleared on its own. Resolving one here does
 *  not change any business data — it only marks the problem as handled, with a note kept in the audit log. */
export function SyncIssues() {
  const { api } = useAdmin()
  const list = useAsync(() => api.syncIssues(), [api])
  const [act, setAct] = useState<SyncIssueRow | null>(null)

  return (
    <div className="stack">
      <p className="body-sm muted">
        A device reports an issue here when it tries to sync an operation the server rejects (e.g. a blocked oversell)
        or that conflicts with another device's edit. Most clear on their own once the business fixes the underlying
        problem and syncs again; resolve one here only once you have confirmed it is handled.
      </p>
      {list.loading && !list.data ? <Loading /> : <ErrorNote message={list.error} />}
      {list.data && (
        <div className="table-wrap">
          <table className="table" style={{ minWidth: '48rem' }}>
            <thead><tr><th>Business</th><th>Kind</th><th>Error</th><th>Device</th><th>First seen</th><th>Last seen</th><th /></tr></thead>
            <tbody>
              {list.data.map((i) => (
                <tr key={i.id}>
                  <td className="body-md">{i.business}</td>
                  <td>{KIND_LABEL[i.kind]}</td>
                  <td className="body-sm muted" style={{ maxWidth: '20rem' }}>{i.error ?? '—'}</td>
                  <td className="body-sm muted">{i.device ?? '—'}</td>
                  <td>{fmtTime(i.first_seen)}</td>
                  <td>{fmtTime(i.last_seen)}</td>
                  <td style={{ textAlign: 'right' }}><button className="btn btn--secondary btn--sm" onClick={() => setAct(i)}>Resolve</button></td>
                </tr>
              ))}
              {list.data.length === 0 && <tr><td colSpan={7} className="table-empty">No open sync issues.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      {act && (
        <ReasonDialog title={`Resolve this ${KIND_LABEL[act.kind].toLowerCase()} for ${act.business}?`}
          description="Use this once you've confirmed the problem is handled (the business resynced, or you've checked the data by hand). It will reappear if the same device reports it again." label="What you checked" minLength={5} confirmText="Resolve"
          onConfirm={async (note) => { await api.resolveSyncIssue(act.tenant_id, act.group_id, note); list.reload() }} onClose={() => setAct(null)} />
      )}
    </div>
  )
}
