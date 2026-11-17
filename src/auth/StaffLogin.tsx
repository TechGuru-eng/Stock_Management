import { useEffect, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { supabase } from '../lib/supabase'
import { enrollLocalPin } from './localPin'
import { markLoggedIn } from './lock'
import {
  StaffApiError, cachedStaff, clearEnrollment, enrollDevice, getEnrollment, refreshStaff, staffLogin, type StaffEntry,
} from './staffApi'

const input = 'min-h-12 w-full rounded border border-slate-300 bg-transparent px-3'
const btn = 'min-h-12 rounded bg-teal-700 px-4 font-semibold text-white disabled:opacity-60'

/** Staff sign in: pick your name, enter your PIN. Only works on a device the owner has registered. */
export function StaffLogin() {
  const { t } = useTranslation()
  const [enrollment, setEnrollment] = useState(getEnrollment())
  const [staff, setStaff] = useState<StaffEntry[]>(cachedStaff())
  const [picked, setPicked] = useState<StaffEntry | null>(null)
  const [pin, setPin] = useState('')
  const [code, setCode] = useState('')
  const [deviceName, setDeviceName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!enrollment || !navigator.onLine) return
    refreshStaff().then(setStaff).catch(() => setEnrollment(getEnrollment()))
  }, [enrollment])

  const explain = (e: unknown): string => {
    if (!(e instanceof StaffApiError)) return t('staff.errors.server_error')
    if (e.code === 'wrong_pin') return t('staff.errors.wrong_pin', { n: e.attemptsLeft ?? 0 })
    if (e.code === 'locked' || e.code === 'device_throttled') return t('staff.errors.locked', { min: Math.max(Math.ceil((e.retryAfter ?? 300) / 60), 1) })
    return t(`staff.errors.${e.code}`, { defaultValue: t('staff.errors.server_error') })
  }

  async function enroll(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!navigator.onLine) return setError(t('staff.errors.network'))
    setBusy(true)
    try {
      setEnrollment(await enrollDevice(code, deviceName))
      setCode('')
    } catch (err) {
      setError(explain(err))
    } finally {
      setBusy(false)
    }
  }

  async function login(e: FormEvent) {
    e.preventDefault()
    if (!picked || !supabase) return
    setError(null)
    if (!navigator.onLine) return setError(t('staff.errors.network'))
    setBusy(true)
    try {
      const r = await staffLogin(picked.id, pin)
      const { error: sessionError } = await supabase.auth.setSession({ access_token: r.session.access_token, refresh_token: r.session.refresh_token })
      if (sessionError) throw new StaffApiError(500, 'server_error')
      // Remember a salted check value so this person can unlock the device offline later. The PIN itself is not kept.
      await enrollLocalPin(r.staff.user_id, pin, r.staff.full_name)
      markLoggedIn()
      setPin('')
    } catch (err) {
      setPin('')
      if (err instanceof StaffApiError && err.code === 'device_not_registered') setEnrollment(getEnrollment())
      setError(explain(err))
    } finally {
      setBusy(false)
    }
  }

  if (!enrollment) {
    return (
      <form onSubmit={enroll} className="flex flex-col gap-3">
        <p className="text-slate-600 dark:text-slate-300">{t('staff.enrollIntro')}</p>
        <label className="flex flex-col gap-1">
          <span className="font-medium">{t('staff.enrollCode')}</span>
          <input className={`${input} uppercase tracking-widest`} autoComplete="off" autoCapitalize="characters" placeholder="XXXX-XXXX-XX" value={code} onChange={(e) => setCode(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-medium">{t('staff.deviceName')}</span>
          <input className={input} placeholder={t('staff.deviceNameHint')} value={deviceName} onChange={(e) => setDeviceName(e.target.value)} />
        </label>
        <button disabled={busy || code.trim().length < 8} className={btn}>{t('staff.enroll')}</button>
        {error && <p role="alert" className="text-red-700">{error}</p>}
      </form>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-slate-600 dark:text-slate-300">{enrollment.tenantName}</p>
      {!picked ? (
        <>
          <p className="font-medium">{t('staff.whoAreYou')}</p>
          {staff.length === 0 && <p className="text-slate-500">{t('staff.noStaff')}</p>}
          <ul className="flex flex-col gap-2">
            {staff.map((s) => (
              <li key={s.id}>
                <button onClick={() => { setPicked(s); setError(null) }} className="min-h-14 w-full rounded border border-slate-300 px-4 text-left">
                  <span className="font-semibold">{s.full_name}</span> <span className="text-sm text-slate-500">· {t(`staff.roles.${s.role}`)}</span>
                </button>
              </li>
            ))}
          </ul>
          <button onClick={() => { clearEnrollment(); setEnrollment(null); setStaff([]) }} className="min-h-12 self-start text-sm text-slate-500 underline">{t('staff.unenroll')}</button>
        </>
      ) : (
        <form onSubmit={login} className="flex flex-col gap-3">
          <p className="text-lg font-semibold">{picked.full_name}</p>
          <label className="flex flex-col gap-1">
            <span className="font-medium">{t('staff.pin')}</span>
            <input
              className={`${input} text-center text-2xl tracking-[0.5em]`} type="password" inputMode="numeric" autoComplete="off"
              maxLength={6} autoFocus value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
            />
          </label>
          <button disabled={busy || pin.length < 4} className={btn}>{t('staff.signIn')}</button>
          <button type="button" onClick={() => { setPicked(null); setPin(''); setError(null) }} className="min-h-12 text-teal-700 underline">{t('staff.notYou')}</button>
        </form>
      )}
      {error && <p role="alert" className="text-red-700">{error}</p>}
    </div>
  )
}
