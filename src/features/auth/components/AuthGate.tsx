import type { ReactNode } from 'react'
import { useAuth } from '../hooks/useAuth'
import { LoginPage } from './LoginPage'

/**
 * Mounts the app only once a session is confirmed.
 *
 * Everything under it can assume it is signed in: the hooks that open the
 * transcribe socket and load history on mount would otherwise all fail at
 * once against a dead token.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const { status, signIn, retry, apiBase } = useAuth()

  if (status === 'signedIn') {
    return <>{children}</>
  }

  if (status === 'checking') {
    return (
      <main className="loginShell">
        <p className="loginChecking">Connecting to Nova…</p>
      </main>
    )
  }

  return (
    <LoginPage
      onSignIn={signIn}
      unreachable={status === 'unreachable'}
      apiBase={apiBase}
      onRetry={retry}
    />
  )
}
