import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
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
const input = 'min-h-12 w-full rounded border border-slate-300 bg-transparent px-3'

const stepFields: Record<number, (keyof OnboardingInput)[]> = {
  1: ['businessName', 'category'],
  2: ['town', 'ownerName', 'ownerPhone', 'employeeCount'],
  3: [],
}

function Field({ label, error, hint, children }: { label: string; error?: string; hint?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="font-medium">{label}</span>
      {children}
      {hint && <span className="text-sm text-slate-500">{hint}</span>}
      {error && <span role="alert" className="text-sm text-red-700">{error}</span>}
    </label>
  )
}

export function OnboardingWizard() {
  const { t, i18n } = useTranslation()
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
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-4 p-6">
      <header>
        <h1 className="text-2xl font-semibold">{t('onboarding.title')}</h1>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          {t('onboarding.step', { n: step, total: TOTAL })} — {t(`onboarding.s${step}`)}
        </p>
        <div className="mt-2 h-2 rounded bg-slate-200"><div className="h-2 rounded bg-teal-700" style={{ width: `${(step / TOTAL) * 100}%` }} /></div>
      </header>

      {step === 1 && (
        <>
          <Field label={t('onboarding.businessName')} error={err('businessName')}>
            <input className={input} value={form.businessName} onChange={(e) => set('businessName', e.target.value)} />
          </Field>
          <Field label={t('onboarding.category')} hint={t('onboarding.categoryHint')} error={err('category')}>
            <select className={input} value={form.category} onChange={(e) => set('category', e.target.value as OnboardingInput['category'])}>
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
            <input className={input} value={form.town} onChange={(e) => set('town', e.target.value)} />
          </Field>
          <Field label={t('onboarding.address')}>
            <input className={input} value={form.address} onChange={(e) => set('address', e.target.value)} />
          </Field>
          <Field label={t('onboarding.ownerName')} error={err('ownerName')}>
            <input className={input} autoComplete="name" value={form.ownerName} onChange={(e) => set('ownerName', e.target.value)} />
          </Field>
          <Field label={t('onboarding.ownerPhone')} error={err('ownerPhone')}>
            <input className={input} type="tel" inputMode="tel" value={form.ownerPhone} onChange={(e) => set('ownerPhone', e.target.value)} />
          </Field>
          <Field label={t('onboarding.employees')} error={err('employeeCount')}>
            <input className={input} type="number" min={0} max={500} value={form.employeeCount} onChange={(e) => set('employeeCount', Number(e.target.value))} />
          </Field>
        </>
      )}

      {step === 3 && (
        <>
          <Field label={t('onboarding.language')}>
            <select className={input} value={form.language} onChange={(e) => { const l = e.target.value as 'fr' | 'en'; set('language', l); setLanguage(l) }}>
              <option value="fr">Français</option>
              <option value="en">English</option>
            </select>
          </Field>
          <p className="rounded bg-slate-100 p-3 text-sm dark:bg-slate-800">{t('onboarding.currency')}</p>
          <Field label={t('onboarding.taxId')}>
            <input className={input} value={form.taxId} onChange={(e) => set('taxId', e.target.value)} />
          </Field>
          <Field label={t('onboarding.oversell')}>
            <select className={input} value={form.oversellPolicy} onChange={(e) => set('oversellPolicy', e.target.value as OnboardingInput['oversellPolicy'])}>
              <option value="allow_and_flag">{t('onboarding.oversellAllow')}</option>
              <option value="block">{t('onboarding.oversellBlock')}</option>
            </select>
          </Field>
          <p className="text-sm text-slate-600 dark:text-slate-300">{t('onboarding.trialNote')}</p>
          {failed && <p role="alert" className="text-red-700">{t('onboarding.saveFailed')}</p>}
        </>
      )}

      <div className="mt-auto flex gap-3">
        {step > 1 && (
          <button type="button" onClick={() => setStep((s) => s - 1)} className="min-h-12 flex-1 rounded border border-slate-300 px-4">
            {t('onboarding.back')}
          </button>
        )}
        {step < TOTAL ? (
          <button type="button" onClick={next} className="min-h-12 flex-1 rounded bg-teal-700 px-4 font-semibold text-white">
            {t('onboarding.next')}
          </button>
        ) : (
          <button type="button" disabled={busy} onClick={() => void finish()} className="min-h-12 flex-1 rounded bg-teal-700 px-4 font-semibold text-white disabled:opacity-60">
            {busy ? t('onboarding.saving') : t('onboarding.finish')}
          </button>
        )}
      </div>
      <button type="button" onClick={() => void signOut()} className="min-h-12 text-sm text-slate-500 underline">
        {t('auth.signOut')}
      </button>
    </main>
  )
}
