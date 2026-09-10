import { useCallback, useEffect, useState } from 'react'
import { API_BASE, getToken, UNAUTHORIZED_EVENT } from '../../../lib/api'
import { fetchSession, login } from '../api'

/**
 * checking     a stored token is being verified against the server
 * signedOut    no token, or the server rejected it
 * signedIn     the token is good; the app may mount
 * unreachable  the API did not answer at all (tower off, tunnel down)
 */
export type AuthStatus = 'checking' | 'signedOut' | 'signedIn' | 'unreachable'

export function useAuth() {
  const [status, setStatus] = useState<AuthStatus>(() =>
    getToken() ? 'checking' : 'signedOut',
  )

  // Verify a remembered token once per "checking" entry. Doing this before
  // mounting the app matters: the app opens sockets on mount, and a dead
  // token would fail every one of them instead of failing here once.
  useEffect(() => {
    if (status !== 'checking') {
      return
    }
    let cancelled = false
    fetchSession()
      .then((session) => {
        if (!cancelled) {
          setStatus(session ? 'signedIn' : 'signedOut')
        }
      })
      .catch(() => {
        if (!cancelled) {
          setStatus('unreachable')
        }
      })
    return () => {
      cancelled = true
    }
  }, [status])

  // Any 401 anywhere in the app, or an explicit sign-out, lands here.
  useEffect(() => {
    const onUnauthorized = () => setStatus('signedOut')
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
  }, [])

  const signIn = useCallback(async (username: string, password: string) => {
    await login(username, password)
    setStatus('signedIn')
  }, [])

  const retry = useCallback(() => {
    setStatus(getToken() ? 'checking' : 'signedOut')
  }, [])

  return { status, signIn, retry, apiBase: API_BASE }
}
