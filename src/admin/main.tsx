import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../index.css'
import { AdminApp } from './AdminApp'
import { realApi, type AdminApi } from './api'

async function pickApi(): Promise<AdminApi> {
  // DEVELOPMENT ONLY: `?dev=1` uses an in-memory fake so the screens can be tried without an admin account.
  if (import.meta.env.DEV && new URLSearchParams(location.search).get('dev') === '1') {
    return (await import('./devApi')).makeDevApi()
  }
  return realApi
}

void pickApi().then((api) => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <AdminApp api={api} />
    </StrictMode>,
  )
})
