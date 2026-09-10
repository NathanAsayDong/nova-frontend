import { announceUnauthorized, apiUrl, authFetch, setToken } from '../../lib/api'

export interface SessionInfo {
  id: string
  createdAt: string
  expiresAt: string
  lastSeenAt: string
  userAgent: string | null
  ip: string | null
}

async function detailOf(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { detail?: string }
    if (body?.detail) {
      return body.detail
    }
  } catch {
    // Non-JSON error body; use the fallback.
  }
  return fallback
}

/**
 * Exchange the username and password for a session token.
 *
 * Plain fetch, not authFetch: a 401 here means the password was wrong, not
 * that an existing session died, and must not bounce the user around.
 */
export async function login(username: string, password: string): Promise<SessionInfo> {
  const response = await fetch(apiUrl('/auth/login'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  if (response.status === 401) {
    throw new Error('Wrong username or password.')
  }
  if (response.status === 429) {
    throw new Error(await detailOf(response, 'Too many attempts. Try again in a few minutes.'))
  }
  if (response.status === 503) {
    throw new Error(await detailOf(response, 'Login is not configured on the server.'))
  }
  if (!response.ok) {
    throw new Error(await detailOf(response, `Login failed (${response.status}).`))
  }
  const body = (await response.json()) as { token: string; session: SessionInfo }
  setToken(body.token)
  return body.session
}

/** The current session, or null if the token is no longer good. */
export async function fetchSession(): Promise<SessionInfo | null> {
  const response = await authFetch('/auth/session')
  if (response.status === 401) {
    return null
  }
  if (!response.ok) {
    throw new Error(`Session check failed (${response.status}).`)
  }
  const body = (await response.json()) as { session: SessionInfo }
  return body.session
}

export async function fetchSessions(): Promise<{ sessions: SessionInfo[]; currentId: string }> {
  const response = await authFetch('/auth/sessions')
  if (!response.ok) {
    throw new Error(await detailOf(response, `Could not list sessions (${response.status}).`))
  }
  return (await response.json()) as { sessions: SessionInfo[]; currentId: string }
}

/** Sign this device out. The local token goes even if the server is unreachable. */
export async function signOut(): Promise<void> {
  try {
    await authFetch('/auth/logout', { method: 'POST' })
  } catch {
    // Offline: the token is dropped locally regardless.
  } finally {
    announceUnauthorized()
  }
}

/** Sign every device out, this one included. */
export async function signOutEverywhere(): Promise<void> {
  try {
    await authFetch('/auth/logout-all', { method: 'POST' })
  } finally {
    announceUnauthorized()
  }
}
