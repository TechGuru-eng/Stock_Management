import { useEffect, useState, type FormEvent } from 'react'
import type { AdminApi, MfaStart } from './api'
import { Button, ErrorNote, inputCls } from './ui'

/** Step 1: email + password. Step 2: the 6-digit code from an authenticator app (set up on the first sign-in). */
export function Login({ api, step, onDone }: { api: AdminApi; step: 'credentials' | 'code'; onDone: () => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [mfa, setMfa] = useState<MfaStart | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (step !== 'code') return
    let live = true
    api.auth.mfaStart().then((m) => live && setMfa(m), (e: unknown) => live && setError(e instanceof Error ? e.message : 'Failed'))
    return () => { live = false }
  }, [api, step])

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true); setError(null)
    try {
      if (step === 'credentials') await api.auth.signIn(email.trim(), password)
      else await api.auth.mfaVerify(mfa!.factorId, code.trim())
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-slate-100 p-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-lg border border-slate-200 bg-white p-6 shadow-sm" autoComplete="off">
        <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-teal-700">StockCM</div>
        <h1 className="text-lg font-semibold text-slate-900">Platform administration</h1>
        <p className="mb-4 mt-1 text-sm text-slate-600">
          {step === 'credentials' ? 'Authorised staff only. Every action is recorded.' : mfa?.enroll ? 'Set up two-step verification' : 'Enter the 6-digit code from your authenticator app.'}
        </p>

        {step === 'credentials' ? (
          <div className="space-y-3">
            <label className="block text-sm font-medium text-slate-700">Email
              <input className={`${inputCls} mt-1`} type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </label>
            <label className="block text-sm font-medium text-slate-700">Password
              <input className={`${inputCls} mt-1`} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </label>
          </div>
        ) : (
          <div className="space-y-3">
            {mfa?.enroll && (
              <div className="rounded-md bg-slate-50 p-3 text-sm text-slate-700">
                <p>Scan this with an authenticator app (Google Authenticator, Authy, 1Password…), then type the code it shows.</p>
                <img src={mfa.enroll.qr} alt="Authenticator QR code" className="mx-auto my-2 h-36 w-36" />
                <p className="break-all text-center text-xs text-slate-500">Or enter this key by hand: <code>{mfa.enroll.secret}</code></p>
              </div>
            )}
            <label className="block text-sm font-medium text-slate-700">6-digit code
              <input className={`${inputCls} mt-1 text-center text-lg tracking-widest`} inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} required />
            </label>
          </div>
        )}

        <div className="mt-3"><ErrorNote message={error} /></div>
        <div className="mt-4 flex items-center justify-between">
          <Button type="submit" disabled={busy || (step === 'code' && (!mfa || code.length !== 6))}>{busy ? 'Checking…' : step === 'credentials' ? 'Continue' : 'Verify'}</Button>
          {step === 'code' && <button type="button" className="text-sm text-slate-500 underline" onClick={() => void api.auth.signOut().then(onDone)}>Cancel</button>}
        </div>
      </form>
    </main>
  )
}
