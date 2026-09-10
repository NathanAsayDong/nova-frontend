import { useCallback, useState } from 'react'
import { createPortal } from 'react-dom'
import { useSettings } from '../hooks/useSettings'
import '../styles/settings-modal.css'

interface SettingsModalProps {
  isOpen: boolean
  onClose: () => void
}

export const SettingsModal = ({ isOpen, onClose }: SettingsModalProps) => {
  const { models, credits, loading, error, switchModel, refreshCredits } = useSettings()
  const [localError, setLocalError] = useState<string | null>(null)

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
            ) : credits?.credits_remaining !== undefined ? (
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
        </div>
      </div>
    </>,
    document.body,
  )
}
