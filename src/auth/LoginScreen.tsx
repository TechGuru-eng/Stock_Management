import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { normalizeCameroonPhone } from '../domain/onboarding'
import { supabase } from '../lib/supabase'

type Step = 'phone' | 'code'

export function LoginScreen() {
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
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 p-6">
      <h1 className="text-2xl font-semibold">{t('auth.title')}</h1>
      <p className="text-slate-600 dark:text-slate-300">{t('auth.subtitle')}</p>
      {offline && <p role="alert" className="rounded bg-amber-100 p-3 text-amber-900">{t('auth.offlineNeeded')}</p>}

      {step === 'phone' ? (
        <form onSubmit={sendCode} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="font-medium">{t('auth.phone')}</span>
            <input
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder={t('auth.phoneHint')}
              value={phoneInput}
              onChange={(e) => setPhoneInput(e.target.value)}
              className="min-h-12 rounded border border-slate-300 bg-transparent px-3"
            />
          </label>
          <button disabled={busy} className="min-h-12 rounded bg-teal-700 px-4 font-semibold text-white disabled:opacity-60">
            {t('auth.sendCode')}
          </button>
        </form>
      ) : (
        <form onSubmit={verify} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="font-medium">{t('auth.code')}</span>
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="min-h-12 rounded border border-slate-300 bg-transparent px-3 tracking-widest"
            />
          </label>
          <button disabled={busy || code.trim().length < 4} className="min-h-12 rounded bg-teal-700 px-4 font-semibold text-white disabled:opacity-60">
            {t('auth.verify')}
          </button>
          <button type="button" onClick={() => { setStep('phone'); setCode('') }} className="min-h-12 text-teal-700 underline">
            {t('auth.changeNumber')}
          </button>
        </form>
      )}

      {error && <p role="alert" className="text-red-700">{error}</p>}
    </main>
  )
}
