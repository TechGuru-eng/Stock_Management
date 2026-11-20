import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../auth/AuthProvider'
import { StaffApiError, createStaff } from '../../auth/staffApi'
import { planLimit } from '../../billing/licenceStore'
import { validatePin } from '../../domain/staffPin'
import { supabase } from '../../lib/supabase'

const input = 'min-h-12 w-full rounded border border-slate-300 bg-transparent px-3'
const btn = 'min-h-12 rounded bg-teal-700 px-4 font-semibold text-white disabled:opacity-60'

interface Member { id: string; role: string; full_name: string | null; active: boolean }
interface Lock { membership_id: string; failed_attempts: number; locked_until: string | null; has_pin: boolean }
interface Device { id: string; name: string; last_sync_at: string | null; revoked_at: string | null }

/** Owner only: add people, set or reset PINs, switch people off, unlock them, register and revoke devices. */
export function StaffScreen() {
  const { t } = useTranslation()
  const { membership } = useAuth()
  const tenantId = membership?.tenantId
  const [members, setMembers] = useState<Member[]>([])
  const [locks, setLocks] = useState<Record<string, Lock>>({})
  const [devices, setDevices] = useState<Device[]>([])
  const [msg, setMsg] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [role, setRole] = useState('cashier')
  const [pin, setPin] = useState('')
  const [newPin, setNewPin] = useState<Record<string, string>>({})
  const [code, setCode] = useState<{ code: string; expires_at: string } | null>(null)
  const [limit, setLimit] = useState<number | null>(null)

  const load = useCallback(async () => {
    if (!supabase || !tenantId || !navigator.onLine) return
    const m = await supabase.from('memberships').select('id, role, full_name, active').eq('tenant_id', tenantId).neq('role', 'owner').order('full_name')
    setMembers((m.data as Member[]) ?? [])
    const l = await supabase.rpc('staff_lock_status', { p_tenant: tenantId })
    setLocks(Object.fromEntries(((l.data as Lock[]) ?? []).map((x) => [x.membership_id, x])))
    const d = await supabase.from('devices').select('id, name, last_sync_at, revoked_at').eq('tenant_id', tenantId).order('name')
    setDevices((d.data as Device[]) ?? [])
    setLimit(await planLimit('staff'))
  }, [tenantId])

  useEffect(() => { void load() }, [load])

  const run = async (fn: () => Promise<unknown>) => {
    setMsg(null)
    try {
      await fn()
      setMsg(t('staff.manage.done'))
      await load()
    } catch (e) {
      const m = e instanceof StaffApiError ? t(`staff.errors.${e.code}`, { defaultValue: e.code }) : (e as Error).message
      setMsg(t('staff.manage.error', { msg: m }))
    }
  }
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    const { error } = await supabase!.rpc(fn, args)
    if (error) throw new Error(error.message)
  }

  if (!navigator.onLine) return <p className="text-slate-500">{t('staff.manage.offline')}</p>
  const activeCount = members.filter((m) => m.active).length
  const mayAdd = limit === null || activeCount < limit

  async function add(e: FormEvent) {
    e.preventDefault()
    const v = validatePin(pin)
    if (!v.ok) return setMsg(t(`staff.problem.${v.problem}`))
    await run(async () => {
      const { data } = await supabase!.auth.getSession()
      await createStaff(data.session!.access_token, { tenantId: tenantId!, fullName: name, role, pin })
      setName(''); setPin('')
    })
  }

  return (
    <div className="flex flex-col gap-4">
      <h3 className="text-lg font-semibold">{t('staff.manage.title')}</h3>

      <form onSubmit={add} className="flex flex-col gap-3 rounded border border-slate-200 p-3">
        <h4 className="font-semibold">{t('staff.manage.add')}</h4>
        {limit !== null && <p className="text-sm text-slate-600 dark:text-slate-300">{t('staff.manage.planAllows', { n: limit, used: activeCount })}</p>}
        <input className={input} required minLength={2} placeholder={t('staff.manage.fullName')} value={name} onChange={(e) => setName(e.target.value)} />
        <select className={input} value={role} onChange={(e) => setRole(e.target.value)} aria-label={t('staff.manage.role')}>
          {(['cashier', 'storekeeper', 'manager'] as const).map((r) => <option key={r} value={r}>{t(`staff.roles.${r}`)}</option>)}
        </select>
        <input className={input} type="password" inputMode="numeric" autoComplete="off" maxLength={6} placeholder={t('staff.manage.pinNew')} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />
        <p className="text-xs text-slate-500">{t('staff.manage.pinRule')}</p>
        <button className={btn} disabled={!mayAdd}>{t('staff.manage.addButton')}</button>
        {!mayAdd && <p className="text-sm text-amber-700">{t('staff.errors.plan_limit_staff')}</p>}
      </form>

      <ul className="flex flex-col gap-3">
        {members.map((m) => {
          const lock = locks[m.id]
          const isLocked = lock?.locked_until ? Date.parse(lock.locked_until) > Date.now() : false
          return (
            <li key={m.id} className="rounded border border-slate-200 p-3">
              <p className="font-medium">{m.full_name} <span className="text-sm font-normal text-slate-500">· {t(`staff.roles.${m.role}`)} · {m.active ? t('staff.manage.active') : t('staff.manage.inactive')}</span></p>
              {isLocked && <p className="text-sm text-red-700">{t('staff.manage.lockedNow')}</p>}
              <div className="mt-2 flex flex-wrap gap-2">
                <input className={`${input} w-36`} type="password" inputMode="numeric" maxLength={6} placeholder={t('staff.manage.pinNew')} value={newPin[m.id] ?? ''} onChange={(e) => setNewPin((p) => ({ ...p, [m.id]: e.target.value.replace(/\D/g, '') }))} />
                <button className="min-h-12 rounded border border-slate-300 px-3" onClick={() => void run(() => rpc('set_staff_pin', { p_membership: m.id, p_pin: newPin[m.id] ?? '' }))}>{t('staff.manage.setPin')}</button>
                {isLocked && <button className="min-h-12 rounded border border-slate-300 px-3" onClick={() => void run(() => rpc('unlock_staff', { p_membership: m.id }))}>{t('staff.manage.unlock')}</button>}
                <button
                  className="min-h-12 rounded border border-red-700 px-3 text-red-700"
                  onClick={() => { if (m.active && !window.confirm(t('staff.manage.confirmOff'))) return; void run(() => rpc('set_staff_active', { p_membership: m.id, p_active: !m.active })) }}
                >
                  {m.active ? t('staff.manage.deactivate') : t('staff.manage.reactivate')}
                </button>
              </div>
            </li>
          )
        })}
      </ul>

      <section className="flex flex-col gap-3 rounded border border-slate-200 p-3">
        <h4 className="font-semibold">{t('staff.manage.devices')}</h4>
        <button className={btn} onClick={() => void run(async () => {
          const { data, error } = await supabase!.rpc('create_enrollment_code', { p_tenant: tenantId })
          if (error) throw new Error(error.message)
          setCode(data as { code: string; expires_at: string })
        })}>{t('staff.manage.newCode')}</button>
        {code && (
          <p className="rounded bg-slate-100 p-3 dark:bg-slate-800">
            <span className="block text-2xl font-bold tracking-widest">{code.code}</span>
            <span className="text-sm text-slate-600 dark:text-slate-300">{t('staff.manage.codeHelp', { time: new Date(code.expires_at).toLocaleTimeString() })}</span>
          </p>
        )}
        <ul className="divide-y divide-slate-200 dark:divide-slate-800">
          {devices.map((d) => (
            <li key={d.id} className="flex items-center justify-between py-2">
              <span>{d.name}<span className="block text-xs text-slate-500">{d.revoked_at ? t('staff.manage.revoked') : d.last_sync_at ? new Date(d.last_sync_at).toLocaleString() : '—'}</span></span>
              {!d.revoked_at && (
                <button className="min-h-12 rounded border border-red-700 px-3 text-red-700"
                  onClick={() => { if (window.confirm(t('staff.manage.confirmRevoke'))) void run(() => rpc('revoke_device', { p_device: d.id })) }}>
                  {t('staff.manage.revoke')}
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>
      {msg && <p role="status" className="text-sm">{msg}</p>}
    </div>
  )
}
