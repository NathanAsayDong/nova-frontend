import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { AuthGate } from './features/auth'

// The app mounts only behind a confirmed session: its hooks open sockets and
// load history on mount, and would otherwise all fail at once when a token
// has expired.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthGate>
      <App />
    </AuthGate>
  </StrictMode>,
)
