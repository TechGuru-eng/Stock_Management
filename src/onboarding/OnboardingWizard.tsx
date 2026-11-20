import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import '../marketing/editorial/styles.css'
import { useEditorialFonts } from '../marketing/editorial/fonts'
import { useAuth } from '../auth/AuthProvider'
import {
  businessCategories,
  toOnboardingPayload,
  validateOnboarding,
  type OnboardingErrors,
  type OnboardingInput,
} from '../domain/onboarding'
import { setLanguage } from '../i18n'
import { supabase } from '../lib/supabase'

const TOTAL = 3

const stepFields: Record<number, (keyof OnboardingInput)[]> = {
  1: ['businessName', 'category'],
  2: ['town', 'ownerName', 'ownerPhone', 'employeeCount'],
  3: [],
}

function Field({ label, error, hint, children }: { label: string; error?: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <span className="field__hint">{hint}</span>}
      {error && <span role="alert" className="field__error">{error}</span>}
    </label>
  )
}

export function OnboardingWizard() {
  const { t, i18n } = useTranslation()
  useEditorialFonts()
  const { session, refreshMembership, signOut } = useAuth()
  const [step, setStep] = useState(1)
  const [errors, setErrors] = useState<OnboardingErrors>({})
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [form, setForm] = useState<OnboardingInput>({
    businessName: '',
    category: 'general_store',
    town: '',
    address: '',
    ownerName: '',
    ownerPhone: session?.user.phone ?? '',
    language: i18n.language === 'en' ? 'en' : 'fr',
    taxId: '',
    employeeCount: 1,
    oversellPolicy: 'allow_and_flag',
  })

  const set = <K extends keyof OnboardingInput>(key: K, value: OnboardingInput[K]) =>
    setForm((f) => ({ ...f, [key]: value }))
  const err = (k: keyof OnboardingInput) => (errors[k] ? t(`onboarding.errors.${errors[k]}`) : undefined)

  function next() {
    const all = validateOnboarding(form)
    const mine = Object.fromEntries(Object.entries(all).filter(([k]) => stepFields[step].includes(k as keyof OnboardingInput)))
    setErrors(mine)
    if (Object.keys(mine).length === 0) setStep((s) => s + 1)
  }

  async function finish() {
    const all = validateOnboarding(form)
    setErrors(all)
    if (Object.keys(all).length > 0 || !supabase) return
    setBusy(true)
    setFailed(false)
    const { error } = await supabase.rpc('onboard_business', { p: toOnboardingPayload(form) })
    if (error) {
      setBusy(false)
      setFailed(true)
      return
    }
    setLanguage(form.language)
    await refreshMembership()
    setBusy(false)
  }

  return (
    <div className="editorial-taste">
      <main className="auth-shell">
        <div className="auth-card auth-card--wide">
          <header className="auth-card__head">
            <span className="eyebrow">{t('onboarding.step', { n: step, total: TOTAL })}</span>
            <h1 className="h3">{t('onboarding.title')}</h1>
            <p>{t(`onboarding.s${step}`)}</p>
            <div className="progress"><div className="progress__bar" style={{ width: `${(step / TOTAL) * 100}%` }} /></div>
          </header>

          {step === 1 && (
            <>
              <Field label={t('onboarding.businessName')} error={err('businessName')}>
                <input value={form.businessName} onChange={(e) => set('businessName', e.target.value)} />
              </Field>
              <Field label={t('onboarding.category')} hint={t('onboarding.categoryHint')} error={err('category')}>
                <select value={form.category} onChange={(e) => set('category', e.target.value as OnboardingInput['category'])}>
                  {businessCategories.map((c) => (
                    <option key={c} value={c}>{t(`categories.${c}`)}</option>
                  ))}
                </select>
              </Field>
            </>
          )}

          {step === 2 && (
            <>
              <Field label={t('onboarding.town')} error={err('town')}>
                <input value={form.town} onChange={(e) => set('town', e.target.value)} />
              </Field>
              <Field label={t('onboarding.address')}>
                <input value={form.address} onChange={(e) => set('address', e.target.value)} />
              </Field>
              <Field label={t('onboarding.ownerName')} error={err('ownerName')}>
                <input autoComplete="name" value={form.ownerName} onChange={(e) => set('ownerName', e.target.value)} />
              </Field>
              <Field label={t('onboarding.ownerPhone')} error={err('ownerPhone')}>
                <input type="tel" inputMode="tel" value={form.ownerPhone} onChange={(e) => set('ownerPhone', e.target.value)} />
              </Field>
              <Field label={t('onboarding.employees')} error={err('employeeCount')}>
                <input type="number" min={0} max={500} value={form.employeeCount} onChange={(e) => set('employeeCount', Number(e.target.value))} />
              </Field>
            </>
          )}

          {step === 3 && (
            <>
              <Field label={t('onboarding.language')}>
                <select value={form.language} onChange={(e) => { const l = e.target.value as 'fr' | 'en'; set('language', l); setLanguage(l) }}>
                  <option value="fr">Français</option>
                  <option value="en">English</option>
                </select>
              </Field>
              <p className="notice label-lg">{t('onboarding.currency')}</p>
              <Field label={t('onboarding.taxId')}>
                <input value={form.taxId} onChange={(e) => set('taxId', e.target.value)} />
              </Field>
              <Field label={t('onboarding.oversell')}>
                <select value={form.oversellPolicy} onChange={(e) => set('oversellPolicy', e.target.value as OnboardingInput['oversellPolicy'])}>
                  <option value="allow_and_flag">{t('onboarding.oversellAllow')}</option>
                  <option value="block">{t('onboarding.oversellBlock')}</option>
                </select>
              </Field>
              <p className="body-md muted">{t('onboarding.trialNote')}</p>
              {failed && <p role="alert" className="field__error">{t('onboarding.saveFailed')}</p>}
            </>
          )}

          <div className="flex gap-3">
            {step > 1 && (
              <button type="button" onClick={() => setStep((s) => s - 1)} className="btn btn--secondary" style={{ flex: 1 }}>
                {t('onboarding.back')}
              </button>
            )}
            {step < TOTAL ? (
              <button type="button" onClick={next} className="btn btn--primary" style={{ flex: 1 }}>
                {t('onboarding.next')}
              </button>
            ) : (
              <button type="button" disabled={busy} onClick={() => void finish()} className="btn btn--primary" style={{ flex: 1 }}>
                {busy ? t('onboarding.saving') : t('onboarding.finish')}
              </button>
            )}
          </div>
          <button type="button" onClick={() => void signOut()} className="btn btn--tertiary">
            {t('auth.signOut')}
          </button>
        </div>
      </main>
    </div>
  )
}
