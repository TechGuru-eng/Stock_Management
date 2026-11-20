import { useEffect, useState, type FormEvent } from 'react'
import '../marketing/editorial/styles.css'
import { useEditorialFonts } from '../marketing/editorial/fonts'
import type { AdminApi, MfaStart } from './api'
import { ErrorNote } from './ui'

/** Step 1: email + password. Step 2: the 6-digit code from an authenticator app (set up on the first sign-in). */
export function Login({ api, step, onDone }: { api: AdminApi; step: 'credentials' | 'code'; onDone: () => void }) {
  useEditorialFonts()
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
    <div className="editorial-taste">
      <main className="auth-shell">
        <form onSubmit={submit} className="auth-card" autoComplete="off">
          <div className="auth-card__head">
            <span className="eyebrow">Stockora</span>
            <h1 className="h3">Platform administration</h1>
            <p>
              {step === 'credentials' ? 'Authorised staff only. Every action is recorded.' : mfa?.enroll ? 'Set up two-step verification' : 'Enter the 6-digit code from your authenticator app.'}
            </p>
          </div>

          {step === 'credentials' ? (
            <>
              <label className="field">
                <span>Email</span>
                <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
              </label>
              <label className="field">
                <span>Password</span>
                <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
              </label>
            </>
          ) : (
            <>
              {mfa?.enroll && (
                <div className="notice label-lg" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <span>Scan this with an authenticator app (Google Authenticator, Authy, 1Password…), then type the code it shows.</span>
                  <img src={mfa.enroll.qr} alt="Authenticator QR code" style={{ width: 144, height: 144, alignSelf: 'center' }} />
                  <span style={{ wordBreak: 'break-all', textAlign: 'center' }}>Or enter this key by hand: <code>{mfa.enroll.secret}</code></span>
                </div>
              )}
              <label className="field">
                <span>6-digit code</span>
                <input className="pin-input" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} required />
              </label>
            </>
          )}

          <ErrorNote message={error} />
          <div className="flex items-center justify-between gap-3">
            <button type="submit" className="btn btn--primary" disabled={busy || (step === 'code' && (!mfa || code.length !== 6))}>{busy ? 'Checking…' : step === 'credentials' ? 'Continue' : 'Verify'}</button>
            {step === 'code' && <button type="button" className="btn btn--tertiary" onClick={() => void api.auth.signOut().then(onDone)}>Cancel</button>}
          </div>
        </form>
      </main>
    </div>
  )
}
