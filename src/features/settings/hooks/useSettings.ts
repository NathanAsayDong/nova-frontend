import { useState, useEffect, useCallback } from 'react'

interface ModelInfo {
  available_models: string[]
  current_model: string
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
      const response = await fetch('http://localhost:8000/api/settings/models')
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
      const response = await fetch('http://localhost:8000/api/settings/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
      })
      if (!response.ok) throw new Error('Failed to switch model')
      const data = await response.json()
      if (data.success) {
        setModels(prev => prev ? { ...prev, current_model: data.current_model } : null)
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
      const response = await fetch('http://localhost:8000/api/settings/claude-credits')
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
