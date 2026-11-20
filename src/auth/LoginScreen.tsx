import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import '../marketing/editorial/styles.css'
import { useEditorialFonts } from '../marketing/editorial/fonts'
import { normalizeCameroonPhone } from '../domain/onboarding'
import { supabase } from '../lib/supabase'
import { StaffLogin } from './StaffLogin'

type Step = 'phone' | 'code'

function OwnerLogin() {
  const { t } = useTranslation()
  const [step, setStep] = useState<Step>('phone')
  const [phoneInput, setPhoneInput] = useState('')
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const offline = !navigator.onLine

  async function sendCode(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const normalized = normalizeCameroonPhone(phoneInput)
    if (!normalized) return setError(t('auth.invalidPhone'))
    if (offline || !supabase) return setError(t('auth.offlineNeeded'))
    setBusy(true)
    const { error: err } = await supabase.auth.signInWithOtp({ phone: normalized })
    setBusy(false)
    if (err) return setError(t('auth.sendFailed'))
    setPhone(normalized)
    setStep('code')
  }

  async function verify(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!supabase) return
    setBusy(true)
    const { error: err } = await supabase.auth.verifyOtp({ phone, token: code.trim(), type: 'sms' })
    setBusy(false)
    if (err) setError(t('auth.verifyFailed'))
    // On success the AuthProvider receives the session and routes onward.
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="body-md">{t('auth.subtitle')}</p>
      {offline && <p role="alert" className="notice notice--amber label-lg">{t('auth.offlineNeeded')}</p>}

      {step === 'phone' ? (
        <form onSubmit={sendCode} className="flex flex-col gap-4">
          <label className="field">
            <span>{t('auth.phone')}</span>
            <input type="tel" inputMode="tel" autoComplete="tel" placeholder={t('auth.phoneHint')} value={phoneInput} onChange={(e) => setPhoneInput(e.target.value)} />
          </label>
          <button disabled={busy} className="btn btn--primary btn--block">{t('auth.sendCode')}</button>
        </form>
      ) : (
        <form onSubmit={verify} className="flex flex-col gap-4">
          <label className="field">
            <span>{t('auth.code')}</span>
            <input className="pin-input" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} />
          </label>
          <button disabled={busy || code.trim().length < 4} className="btn btn--primary btn--block">{t('auth.verify')}</button>
          <button type="button" onClick={() => { setStep('phone'); setCode('') }} className="btn btn--tertiary">{t('auth.changeNumber')}</button>
        </form>
      )}
      {error && <p role="alert" className="field__error">{error}</p>}
    </div>
  )
}

export function LoginScreen() {
  const { t } = useTranslation()
  useEditorialFonts()
  const [who, setWho] = useState<'owner' | 'staff'>('owner')
  return (
    <div className="editorial-taste">
      <main className="auth-shell">
        <div className="auth-card">
          <div className="auth-card__head">
            <span className="eyebrow">Stockora</span>
            <h1 className="h3">{t('auth.title')}</h1>
          </div>
          <div role="tablist" className="auth-tabs">
            {(['owner', 'staff'] as const).map((k) => (
              <button key={k} role="tab" aria-selected={who === k} onClick={() => setWho(k)}>{t(`staff.mode.${k}`)}</button>
            ))}
          </div>
          {who === 'owner' ? <OwnerLogin /> : <StaffLogin />}
        </div>
      </main>
    </div>
  )
}
