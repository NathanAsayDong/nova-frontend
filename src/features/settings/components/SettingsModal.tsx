import { useCallback, useState } from 'react'
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

  return (
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
                value={models.current_model}
                onChange={handleModelChange}
                disabled={loading}
              >
                {models.available_models.map(model => (
                  <option key={model} value={model}>
                    {model === 'claude-opus-4-1'
                      ? 'Opus (Most capable)'
                      : model === 'claude-sonnet-4-20250514'
                        ? 'Sonnet (Balanced)'
                        : 'Haiku (Fast & efficient)'}
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
    </>
  )
}
