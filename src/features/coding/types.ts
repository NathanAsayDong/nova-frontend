/** Wire types for the coding-agent panel (`/coding/*`). */

export type CodingStatus =
  | 'starting'
  | 'queued'
  | 'working'
  | 'idle'
  | 'error'
  | 'closed'

export type CodingSession = {
  sessionId: string
  title: string
  status: CodingStatus
  repo: string
  branch: string | null
  cwd: string | null
  instructions: string
  /** One-line "where it is", maintained by the backend on every event. */
  rollup: string | null
  lastResult: string | null
  lastSeq: number
  projectId: number | null
  createdAt: string | null
  updatedAt: string | null
}

/**
 * One thing the agent did. `payload` is the raw event from the Mac; the
 * fields worth rendering are pulled out in the view.
 */
export type CodingEvent = {
  seq: number
  type: 'started' | 'text' | 'thinking' | 'tool' | 'rate_limit' | 'result' | 'error' | 'closed'
  payload: {
    text?: string
    tool?: string
    artifact?: { kind: 'diff' | 'file' | 'terminal'; title: string; content: string }
    result?: string
    is_error?: boolean
    detail?: string
    reason?: string
    branch?: string
    utilization?: Record<string, number | null>
    num_turns?: number
    total_cost_usd?: number
  }
}

export type CodingSessionDetail = {
  session: CodingSession
  events: CodingEvent[]
  agentConnected: boolean
}
