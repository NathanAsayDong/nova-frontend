import type { ClaudeThread, CodingSession, CodingSessionDetail } from './types'

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let detail = `Request failed (${response.status})`
    try {
      const body = (await response.json()) as { detail?: string }
      if (body?.detail) {
        detail = body.detail
      }
    } catch {
      // Non-JSON error body; the status line is all we have.
    }
    throw new Error(detail)
  }
  return (await response.json()) as T
}

export async function fetchCodingSessions(): Promise<{
  sessions: CodingSession[]
  agentConnected: boolean
}> {
  return readJson(await fetch('/coding/sessions'))
}

/**
 * A session and the events after `afterSeq`.
 *
 * The panel polls with the last seq it has rather than refetching the whole
 * tail, so a long-running task costs a near-empty response per tick.
 */
export async function fetchCodingSession(
  sessionId: string,
  afterSeq = 0,
): Promise<CodingSessionDetail> {
  return readJson(
    await fetch(`/coding/sessions/${sessionId}?afterSeq=${afterSeq}`),
  )
}

export async function startCodingSession(input: {
  repo: string
  instructions: string
  title?: string
  projectId?: number | null
}): Promise<{ sessionId: string; status: string; branch?: string; message?: string }> {
  return readJson(
    await fetch('/coding/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  )
}

export async function sendCodingFeedback(
  sessionId: string,
  text: string,
  steer = false,
): Promise<{ queued: boolean }> {
  return readJson(
    await fetch(`/coding/sessions/${sessionId}/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, steer }),
    }),
  )
}

export async function stopCodingSession(sessionId: string): Promise<{ status: string }> {
  return readJson(await fetch(`/coding/sessions/${sessionId}/stop`, { method: 'POST' }))
}

/** Claude Code threads already on the Mac for this repo, newest first. */
export async function fetchClaudeThreads(
  repo: string,
): Promise<{ repo: string; sessions: ClaudeThread[] }> {
  return readJson(await fetch(`/coding/repos/${encodeURIComponent(repo)}/threads`))
}

/**
 * Pick up an existing thread so Nova can carry it on.
 *
 * The agent resumes that conversation with all of its context rather than
 * starting cold, and it becomes a normal session in the list above.
 */
export async function adoptClaudeThread(
  repo: string,
  sessionId: string,
  instructions?: string,
): Promise<{ sessionId: string; status: string }> {
  return readJson(
    await fetch(
      `/coding/repos/${encodeURIComponent(repo)}/threads/${sessionId}/adopt`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instructions }),
      },
    ),
  )
}
