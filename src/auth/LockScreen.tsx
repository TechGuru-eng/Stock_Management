import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from './AuthProvider'
import { verifyLocalPin } from './localPin'
import { unlock } from './lock'

/**
 * Shown when a staff device has been idle. The same person types their PIN to carry on, which works offline
 * because it only RESUMES the session the server already issued. Changing to another person needs the internet.
 */
export function LockScreen({ onUnlocked }: { onUnlocked: () => void }) {
  const { t } = useTranslation()
  const { session, membership, signOut } = useAuth()
  const [pin, setPin] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!session) return
    setBusy(true)
    setError(null)
    const r = await verifyLocalPin(session.user.id, pin)
    setBusy(false)
    setPin('')
    if (r.ok) {
      unlock()
      onUnlocked()
    } else if (r.reason === 'locked') {
      setError(t('staff.errors.locked', { min: Math.max(Math.ceil(r.retryAfterSec / 60), 1) }))
    } else if (r.reason === 'wrong') {
      setError(r.retryAfterSec > 0 ? t('staff.errors.locked', { min: Math.max(Math.ceil(r.retryAfterSec / 60), 1) }) : t('staff.errors.wrong_pin', { n: r.attemptsLeft }))
    } else {
      setError(t('staff.errors.no_local_pin'))
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 p-6">
      <h1 className="text-2xl font-semibold">{t('staff.locked')}</h1>
      <p className="text-slate-600 dark:text-slate-300">{membership?.tenantName}</p>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1">
          <span className="font-medium">{t('staff.pin')}</span>
          <input
            className="min-h-12 w-full rounded border border-slate-300 bg-transparent px-3 text-center text-2xl tracking-[0.5em]"
            type="password" inputMode="numeric" autoComplete="off" maxLength={6} autoFocus value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
          />
        </label>
        <button disabled={busy || pin.length < 4} className="min-h-12 rounded bg-teal-700 px-4 font-semibold text-white disabled:opacity-60">{t('staff.unlock')}</button>
      </form>
      {error && <p role="alert" className="text-red-700">{error}</p>}
      <button onClick={() => void signOut()} className="min-h-12 text-sm text-slate-500 underline">{t('staff.switchUser')}</button>
    </main>
  )
}
