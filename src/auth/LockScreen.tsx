import { useEffect, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import '../marketing/editorial/styles.css'
import { useEditorialFonts } from '../marketing/editorial/fonts'
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
  useEditorialFonts()
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
    <div className="editorial-taste">
      <main className="auth-shell">
        <div className="auth-card">
          <div className="auth-card__head">
            <span className="eyebrow">Stockora</span>
            <h1 className="h3">{t('staff.locked')}</h1>
            <p>{membership?.tenantName}</p>
          </div>

          {people.length > 1 && (
            <div role="radiogroup" aria-label={t('staff.whoAreYou')} className="stack" style={{ gap: 10 }}>
              <span className="label-lg muted">{t('staff.whoAreYou')}</span>
              <div className="flex flex-wrap gap-2">
                {people.map((p) => (
                  <button
                    key={p.userId} type="button" role="radio" aria-checked={selected === p.userId}
                    onClick={() => { setSelected(p.userId); setError(null); setPin('') }}
                    className={selected === p.userId ? 'btn btn--primary' : 'btn btn--secondary'}
                  >
                    {p.name || t(`staff.roles.${p.role}`, { defaultValue: p.role })}
                  </button>
                ))}
              </div>
            </div>
          )}

          <form onSubmit={submit} className="stack">
            <label className="field">
              <span>{t('staff.pin')}</span>
              <input
                className="pin-input"
                type="password" inputMode="numeric" autoComplete="off" maxLength={6} autoFocus value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
              />
            </label>
            <button disabled={busy || pin.length < 4} className="btn btn--primary btn--block">{t('staff.unlock')}</button>
          </form>
          {error && <p role="alert" className="field__error">{error}</p>}
          <button onClick={() => void signOut()} className="btn btn--tertiary">{t('staff.switchUser')}</button>
          <p className="body-sm muted">{t('staff.newPersonHint')}</p>
        </div>
      </main>
    </div>
  )
}
