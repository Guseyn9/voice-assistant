import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

const root = createRoot(document.getElementById('root')!)

if (window.location.pathname.replace(/\/$/, '') === '/seller') {
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
} else {
  void import('./platform-entry').then(({ mountPlatformRuntime }) => {
    mountPlatformRuntime()
  }).catch(error => {
    const host = document.getElementById('root')
    if (host) {
      host.textContent = error instanceof Error ? error.message : String(error)
    }
    throw error
  })
}
