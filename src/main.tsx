import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './i18n'
import App from './App.tsx'

async function start() {
  let Root = App
  // Development only: `?dev=1` opens the app with a fake signed-in owner so the offline
  // screens can be exercised without an SMS provider. Removed from production builds.
  if (import.meta.env.DEV && new URLSearchParams(location.search).has('dev')) {
    Root = (await import('./dev/DevApp')).DevApp
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Root />
    </StrictMode>,
  )
}
void start()
