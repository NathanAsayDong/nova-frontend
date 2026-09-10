import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useSettings } from '../hooks/useSettings'
import { fetchSessions, signOut, signOutEverywhere } from '../../auth'
import type { SessionInfo } from '../../auth'
import '../styles/settings-modal.css'

/** "Chrome on iPhone", from a user-agent string. Best effort, for a list. */
function describeAgent(userAgent: string | null): string {
  const ua = userAgent ?? ''
  const device = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Macintosh/.test(ua)
          ? 'Mac'
          : /Windows/.test(ua)
            ? 'Windows'
            : /Linux/.test(ua)
              ? 'Linux'
              : 'Unknown device'
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : ''
  return browser ? `${browser} on ${device}` : device
}

function relativeTime(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} h ago`
  return `${Math.round(hours / 24)} d ago`
}

interface SettingsModalProps {
  isOpen: boolean
  onClose: () => void
}

export const SettingsModal = ({ isOpen, onClose }: SettingsModalProps) => {
  const { models, credits, loading, error, switchModel, refreshCredits } = useSettings()
  const [localError, setLocalError] = useState<string | null>(null)
  const [sessions, setSessions] = useState<{ sessions: SessionInfo[]; currentId: string } | null>(
    null,
  )
  const [signingOut, setSigningOut] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetchSessions()
      .then((result) => {
        if (!cancelled) setSessions(result)
      })
      .catch(() => {
        if (!cancelled) setSessions(null)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const handleSignOut = useCallback(async () => {
    setSigningOut(true)
    await signOut()
  }, [])

  const handleSignOutEverywhere = useCallback(async () => {
    if (!window.confirm('Sign out of Nova on every device, including this one?')) {
      return
    }
    setSigningOut(true)
    try {
      await signOutEverywhere()
    } catch (caught) {
      setSigningOut(false)
      setLocalError(caught instanceof Error ? caught.message : 'Could not sign out everywhere')
    }
  }, [])

  const handleModelChange = useCallback(
    async (e: React.ChangeEvent<HTMLSelectElement>) => {
      setLocalError(null)
      try {
        await switchModel(e.target.value)
      } catch (err) {
        setLocalError(err instanceof Error ? err.message : 'Failed to switch model')
      }
    },
    [switchModel],
  )

  if (!isOpen) return null

  // Rendered into document.body rather than in place. The header that mounts
  // this sets backdrop-filter, which makes it a containing block for
  // position: fixed descendants — so the overlay sized and positioned itself
  // against the header instead of the viewport, landing half off-screen at
  // the header's own width. A portal is what keeps the modal's own CSS
  // honest wherever it gets mounted.
  return createPortal(
    <>
      <div className="settings-modal-overlay" onClick={onClose} />
      <div className="settings-modal">
        <div className="settings-modal-header">
          <h2>Settings</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>

        <div className="settings-modal-content">
          {error && <div className="settings-error">{error}</div>}
          {localError && <div className="settings-error">{localError}</div>}

          {/* Model Selection */}
          <div className="settings-item">
            <label>Claude Model</label>
            {models ? (
              <select
                value={models.current_model_id}
                onChange={handleModelChange}
                disabled={loading}
              >
                {models.models.map(model => (
                  <option key={model.id} value={model.id}>
                    {model.display_name}
                  </option>
                ))}
              </select>
            ) : (
              <p>Loading models...</p>
            )}
          </div>

          {/* Credits Info */}
          <div className="settings-item">
            <label>Claude API Credits</label>
            {credits?.error ? (
              <div className="credits-status error">
                <p>Unable to fetch credits</p>
                <button onClick={refreshCredits} disabled={loading}>
                  {loading ? 'Retrying...' : 'Retry'}
                </button>
              </div>
            ) : typeof credits?.credits_remaining === 'number' ? (
              <div className="credits-status">
                <div className="credits-display">
                  <span className="credits-value">${credits.credits_remaining.toFixed(2)}</span>
                  <span className="credits-label">remaining</span>
                </div>
                <button onClick={refreshCredits} disabled={loading}>
                  {loading ? 'Refreshing...' : 'Refresh'}
                </button>
              </div>
            ) : (
              <p>Loading credits...</p>
            )}
          </div>

          {/* Session */}
          <div className="settings-item">
            <label>Signed-in devices</label>
            {sessions ? (
              <ul className="session-list">
                {sessions.sessions.map((item) => (
                  <li
                    key={item.id}
                    className={item.id === sessions.currentId ? 'current' : ''}
                  >
                    <span className="session-agent">{describeAgent(item.userAgent)}</span>
                    <span className="session-meta">
                      {item.id === sessions.currentId ? 'This device · ' : ''}
                      seen {relativeTime(item.lastSeenAt)}
                      {item.ip ? ` · ${item.ip}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="session-empty">Could not load the device list.</p>
            )}
            <div className="session-actions">
              <button type="button" onClick={handleSignOut} disabled={signingOut}>
                {signingOut ? 'Signing out…' : 'Sign out'}
              </button>
              <button
                type="button"
                className="danger"
                onClick={handleSignOutEverywhere}
                disabled={signingOut}
              >
                Sign out everywhere
              </button>
            </div>
          </div>
        </div>
      </div>
    </>,
    document.body,
  )
}
