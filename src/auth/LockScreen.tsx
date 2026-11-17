import { useEffect, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from './AuthProvider'
import { hasLocalPin, verifyLocalPin } from './localPin'
import { unlock } from './lock'

/**
 * Shown when a staff device has been idle, or when someone taps "Switch person". Anyone who has signed in on this device
 * before can take over by choosing their name and typing their PIN: the PIN is checked on the device (salted PBKDF2, with its
 * own lockout), so this works with no internet. A person who has never signed in on this device needs the internet once.
 */
export function LockScreen({ onUnlocked }: { onUnlocked: () => void }) {
  const { t } = useTranslation()
  const { session, membership, signOut, roster, actingUserId, switchActor } = useAuth()
  const [selected, setSelected] = useState(actingUserId)
  const [usable, setUsable] = useState<Set<string> | null>(null)
  const [pin, setPin] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Only people whose PIN can be checked here are offered.
  useEffect(() => {
    let live = true
    void Promise.all(roster.map(async (p) => [p.userId, await hasLocalPin(p.userId)] as const)).then((r) => {
      if (live) setUsable(new Set(r.filter(([, ok]) => ok).map(([id]) => id)))
    })
    return () => { live = false }
  }, [roster])

  const people = roster.filter((p) => usable?.has(p.userId))

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!session) return
    setBusy(true)
    setError(null)
    const r = await verifyLocalPin(selected, pin)
    setBusy(false)
    setPin('')
    if (r.ok) {
      if (selected !== actingUserId) switchActor(selected)
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

      {people.length > 1 && (
        <div role="radiogroup" aria-label={t('staff.whoAreYou')} className="flex flex-col gap-2">
          <span className="font-medium">{t('staff.whoAreYou')}</span>
          <div className="flex flex-wrap gap-2">
            {people.map((p) => (
              <button
                key={p.userId} type="button" role="radio" aria-checked={selected === p.userId}
                onClick={() => { setSelected(p.userId); setError(null); setPin('') }}
                className={`min-h-12 rounded px-4 ${selected === p.userId ? 'bg-teal-700 font-semibold text-white' : 'border border-slate-300'}`}
              >
                {p.name || t(`staff.roles.${p.role}`, { defaultValue: p.role })}
              </button>
            ))}
          </div>
        </div>
      )}

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
      <p className="text-xs text-slate-500">{t('staff.newPersonHint')}</p>
    </main>
  )
}
