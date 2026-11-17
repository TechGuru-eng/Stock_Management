import { useAdmin } from '../ctx'
import { ErrorNote, fmtTime, Loading, useAsync } from '../ui'

export function Audit() {
  const { api } = useAdmin()
  const log = useAsync(() => api.audit(200), [api])
  if (log.loading && !log.data) return <Loading />
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">Every administrator action and every sensitive view, newest first. This record cannot be edited or deleted.</p>
      <ErrorNote message={log.error} />
      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm">
        <table className="w-full min-w-[40rem] text-sm">
          <thead className="bg-slate-50 text-left text-xs text-slate-500"><tr><th className="p-3 font-medium">When</th><th className="p-3 font-medium">Action</th><th className="p-3 font-medium">Business</th><th className="p-3 font-medium">Details</th><th className="p-3 font-medium">Admin</th></tr></thead>
          <tbody>
            {log.data?.map((r) => (
              <tr key={r.id} className="border-t border-slate-100 align-top">
                <td className="whitespace-nowrap p-3">{fmtTime(r.at)}</td>
                <td className="p-3 font-mono text-xs">{r.action}</td>
                <td className="p-3">{r.business ?? '—'}</td>
                <td className="max-w-xs break-words p-3 text-xs text-slate-600">{r.detail ? Object.entries(r.detail).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(' · ') : ''}</td>
                <td className="p-3 font-mono text-xs text-slate-500">{r.admin_id.slice(0, 8)}</td>
              </tr>
            ))}
            {log.data?.length === 0 && <tr><td colSpan={5} className="p-6 text-center text-slate-500">Nothing recorded yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  )
}
