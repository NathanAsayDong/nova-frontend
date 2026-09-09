import { useCallback } from 'react'
import { useSettings } from '../hooks/useSettings'
import '../styles/settings.css'

export const SettingsPanel = () => {
  const { models, credits, loading, error, switchModel, refreshCredits } = useSettings()

  const handleModelChange = useCallback(
    async (e: React.ChangeEvent<HTMLSelectElement>) => {
      await switchModel(e.target.value)
    },
    [switchModel],
  )

  return (
    <div className="settings-panel">
      <h2>Settings</h2>

      {error && <div className="settings-error">{error}</div>}

      {/* Model Selection */}
      <div className="settings-section">
        <h3>Claude Model</h3>
        {loading ? (
          <p>Loading...</p>
        ) : models ? (
          <div className="model-selector">
            <select value={models.current_model} onChange={handleModelChange}>
              {models.available_models.map(model => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
            <p className="current-model">Current: {models.current_model}</p>
          </div>
        ) : (
          <p>Failed to load models</p>
        )}
      </div>

      {/* Credits Info */}
      <div className="settings-section">
        <h3>Claude API Credits</h3>
        {credits?.error ? (
          <div className="credits-error">
            <p>{credits.error}</p>
            <button onClick={refreshCredits} disabled={loading}>
              {loading ? 'Checking...' : 'Retry'}
            </button>
          </div>
        ) : credits?.credits_remaining !== undefined ? (
          <div className="credits-info">
            <div className="credits-display">
              <span className="credits-label">Remaining:</span>
              <span className="credits-amount">${credits.credits_remaining.toFixed(2)}</span>
            </div>
            {credits.account_status && (
              <p className="account-status">Status: {credits.account_status}</p>
            )}
            <button onClick={refreshCredits} disabled={loading}>
              {loading ? 'Refreshing...' : 'Refresh'}
            </button>
          </div>
        ) : (
          <p>Loading credits...</p>
        )}
      </div>
    </div>
  )
}
