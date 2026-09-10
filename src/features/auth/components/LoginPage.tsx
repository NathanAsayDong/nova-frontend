import { useState } from 'react'
import type { FormEvent } from 'react'
import '../styles/login.css'

type LoginPageProps = {
  onSignIn: (username: string, password: string) => Promise<void>
  /** The API answered nothing at all; show where we tried instead of a form. */
  unreachable?: boolean
  apiBase: string
  onRetry: () => void
}

export function LoginPage({ onSignIn, unreachable = false, apiBase, onRetry }: LoginPageProps) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) {
      return
    }
    setError(null)
    setBusy(true)
    try {
      await onSignIn(username, password)
    } catch (caught) {
      // fetch() rejects with a TypeError when nothing answered at all; the
      // browser's own wording ("Failed to fetch") says nothing useful.
      if (caught instanceof TypeError) {
        setError(`Could not reach Nova at ${apiBase || 'the API URL'}. Is the tower online?`)
      } else {
        setError(caught instanceof Error ? caught.message : 'Could not sign in.')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="loginShell">
      <div className="loginAura" aria-hidden="true">
        <span className="loginBlob blob-a" />
        <span className="loginBlob blob-b" />
      </div>

      <section className="loginCard" aria-labelledby="loginTitle">
        <header className="loginHeader">
          <span className="loginMark">NOVA</span>
          <h1 id="loginTitle">{unreachable ? 'Nova is unreachable' : 'Sign in'}</h1>
        </header>

        {unreachable ? (
          <div className="loginUnreachable">
            <p>
              Nothing answered at <code>{apiBase || 'the API URL'}</code>. The tower may be off, or
              the tunnel may be down.
            </p>
            <button type="button" className="loginButton" onClick={onRetry}>
              Try again
            </button>
          </div>
        ) : (
          <form className="loginForm" onSubmit={handleSubmit}>
            <label className="loginField">
              <span>Username</span>
              <input
                type="text"
                name="username"
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                disabled={busy}
                required
              />
            </label>

            <label className="loginField">
              <span>Password</span>
              <input
                type="password"
                name="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                disabled={busy}
                required
              />
            </label>

            {error ? (
              <p className="loginError" role="alert">
                {error}
              </p>
            ) : null}

            <button type="submit" className="loginButton" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        )}
      </section>
    </main>
  )
}
