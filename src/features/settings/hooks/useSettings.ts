import { useState, useEffect, useCallback } from 'react'
import { authFetch } from '../../../lib/api'

export interface ModelOption {
  id: string
  display_name: string
}

interface ModelInfo {
  /**
   * What a picker renders: the id to send back, and the name to show. Both
   * come from Anthropic via the backend, so a newly released model arrives
   * already labelled and nothing here needs editing.
   */
  models: ModelOption[]
  /** The same set as bare ids. Kept for callers that only need the values. */
  available_models: string[]
  current_model: string
  /** The listed id `current_model` resolves to — what a <select> matches on. */
  current_model_id: string
  /**
   * The current model's display name, resolved server-side. The stored id can
   * be an alias (claude-haiku-4-5) while the list carries the dated snapshot
   * it names, so matching the two here would show a bare id.
   */
  current_model_name: string
}

interface CreditsInfo {
  credits_remaining?: number
  account_status?: string
  error?: string
}

export const useSettings = () => {
  const [models, setModels] = useState<ModelInfo | null>(null)
  const [credits, setCredits] = useState<CreditsInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchModels = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const response = await authFetch('/api/settings/models')
      if (!response.ok) throw new Error('Failed to fetch models')
      const data = await response.json()
      setModels(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }, [])

  const switchModel = useCallback(async (model: string) => {
    try {
      setLoading(true)
      setError(null)
      const response = await authFetch('/api/settings/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
      })
      if (!response.ok) throw new Error('Failed to switch model')
      const data = await response.json()
      if (data.success) {
        setModels(prev =>
          prev
            ? {
                ...prev,
                current_model: data.current_model,
                current_model_id: data.current_model_id,
                current_model_name: data.current_model_name,
              }
            : null,
        )
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }, [])

  const fetchCredits = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const response = await authFetch('/api/settings/claude-credits')
      if (!response.ok) throw new Error('Failed to fetch credits')
      const data = await response.json()
      setCredits(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
      setCredits({ error: err instanceof Error ? err.message : 'Unknown error' })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchModels()
    fetchCredits()
  }, [fetchModels, fetchCredits])

  return {
    models,
    credits,
    loading,
    error,
    switchModel,
    refreshCredits: fetchCredits,
  }
}
