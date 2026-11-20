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
    <div className="space-y-4">
      <p className="text-sm text-slate-600">
        A device reports an issue here when it tries to sync an operation the server rejects (e.g. a blocked oversell)
        or that conflicts with another device's edit. Most clear on their own once the business fixes the underlying
        problem and syncs again; resolve one here only once you have confirmed it is handled.
      </p>
      {list.loading && !list.data ? <Loading /> : <ErrorNote message={list.error} />}
      {list.data && (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm">
          <table className="w-full min-w-[48rem] text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-500"><tr><th className="p-3 font-medium">Business</th><th className="p-3 font-medium">Kind</th><th className="p-3 font-medium">Error</th><th className="p-3 font-medium">Device</th><th className="p-3 font-medium">First seen</th><th className="p-3 font-medium">Last seen</th><th className="p-3" /></tr></thead>
            <tbody>
              {list.data.map((i) => (
                <tr key={i.id} className="border-t border-slate-100 align-top">
                  <td className="p-3 font-medium">{i.business}</td>
                  <td className="p-3">{KIND_LABEL[i.kind]}</td>
                  <td className="p-3 max-w-[20rem] text-xs text-slate-600">{i.error ?? '—'}</td>
                  <td className="p-3 text-xs text-slate-500">{i.device ?? '—'}</td>
                  <td className="p-3">{fmtTime(i.first_seen)}</td>
                  <td className="p-3">{fmtTime(i.last_seen)}</td>
                  <td className="p-3 text-right"><button className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100" onClick={() => setAct(i)}>Resolve</button></td>
                </tr>
              ))}
              {list.data.length === 0 && <tr><td colSpan={7} className="p-6 text-center text-slate-500">No open sync issues.</td></tr>}
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
