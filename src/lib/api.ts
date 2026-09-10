/**
 * One place that knows where the backend is and how to prove who we are.
 *
 * The frontend is served from Firebase and the API from the tower through a
 * Cloudflare tunnel, so every request is cross-origin and absolute. The base
 * URL is baked in at build time from VITE_API_URL (vite.config.ts resolves it
 * per mode: localhost, LAN tower, or the public tunnel).
 *
 * Auth is a bearer token from /auth/login, kept in localStorage. The two
 * origins are different sites, so a cookie would be a third-party cookie and
 * Safari would drop it; a header the page sets itself has no such problem.
 * Browsers cannot put headers on a WebSocket, so sockets carry the same token
 * as `?token=` — over TLS that is inside the encrypted stream.
 *
 * A 401 from any request means the session is gone (expired, or signed out
 * from another device). The token is dropped and an event fires so the auth
 * gate can show the login screen, wherever in the tree the request came from.
 */

const rawBase = (import.meta.env.VITE_API_URL as string | undefined) ?? ''

/** The backend origin, no trailing slash. */
export const API_BASE = rawBase.replace(/\/+$/, '')

const TOKEN_KEY = 'nova.authToken'

/** Fired on window when a request comes back 401 or the user signs out. */
export const UNAUTHORIZED_EVENT = 'nova:unauthorized'

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function setToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token)
  } catch {
    // Private mode or storage disabled: the session lasts for this tab only.
  }
}

export function clearToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY)
  } catch {
    // Nothing to clear.
  }
}

export function announceUnauthorized(): void {
  clearToken()
  window.dispatchEvent(new Event(UNAUTHORIZED_EVENT))
}

/** Absolute URL for an API path. */
export function apiUrl(path: string): string {
  return `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`
}

/**
 * Absolute WebSocket URL for an API path.
 *
 * Carries the session token unless `auth: false`, which the face relay uses:
 * it is deliberately open, and a face tab on a kiosk has no login.
 */
export function wsUrl(
  path: string,
  options: { auth?: boolean; params?: Record<string, string> } = {},
): string {
  const url = new URL(apiUrl(path), window.location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  for (const [key, value] of Object.entries(options.params ?? {})) {
    url.searchParams.set(key, value)
  }
  if (options.auth !== false) {
    const token = getToken()
    if (token) {
      url.searchParams.set('token', token)
    }
  }
  return url.toString()
}

/**
 * fetch() against the API with the session attached.
 *
 * Same signature as fetch, path-relative to the API. A 401 response is
 * returned to the caller as usual, but the session is dropped first so the
 * next render is the login screen rather than a wall of failed requests.
 */
export async function authFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  const token = getToken()
  if (token) {
    headers.set('Authorization', `Bearer ${token}`)
  }
  const response = await fetch(apiUrl(path), { ...init, headers })
  if (response.status === 401) {
    announceUnauthorized()
  }
  return response
}
