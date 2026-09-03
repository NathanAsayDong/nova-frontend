import { useCallback, useEffect, useRef, useState } from 'react'
import {
  fetchCodingSession,
  fetchCodingSessions,
  sendCodingFeedback,
  startCodingSession,
  stopCodingSession,
} from '../api'
import type { CodingEvent, CodingSession, CodingStatus } from '../types'

type CodingPanelProps = {
  onClose: () => void
}

/**
 * How often to ask for new events while a session is live.
 *
 * Polling rather than a socket: the events already survive in the database,
 * the panel only has to be roughly current, and a poll that asks for
 * "everything after seq N" costs an almost-empty response. A second socket
 * would be more machinery for a window nobody watches continuously.
 */
const LIVE_POLL_MS = 1500
const IDLE_POLL_MS = 8000

const STATUS_LABEL: Record<CodingStatus, string> = {
  starting: 'Starting',
  queued: 'Waiting for Mac',
  working: 'Working',
  idle: 'Idle',
  error: 'Error',
  closed: 'Closed',
}

function isLive(status: CodingStatus): boolean {
  return status === 'working' || status === 'starting'
}

function EventRow({ event }: { event: CodingEvent }) {
  const { type, payload } = event

  if (type === 'text') {
    return <p className="coding-event coding-event--text">{payload.text}</p>
  }
  if (type === 'tool') {
    const artifact = payload.artifact
    return (
      <div className="coding-event coding-event--tool">
        <span className="coding-tool-name">{payload.tool}</span>
        {artifact ? (
          <details className="coding-artifact">
            <summary>
              <span className={`coding-artifact-kind coding-artifact-kind--${artifact.kind}`}>
                {artifact.kind}
              </span>
              {artifact.title}
            </summary>
            <pre>{artifact.content}</pre>
          </details>
        ) : null}
      </div>
    )
  }
  if (type === 'result') {
    return (
      <div className={`coding-event coding-event--result${payload.is_error ? ' is-error' : ''}`}>
        <strong>{payload.is_error ? 'Failed' : 'Done'}</strong>
        {payload.result ? <p>{payload.result}</p> : null}
        {payload.num_turns ? <span className="coding-meta">{payload.num_turns} turns</span> : null}
      </div>
    )
  }
  if (type === 'rate_limit') {
    const used = Object.entries(payload.utilization ?? {})
      .filter(([, v]) => v != null)
      .map(([k, v]) => `${k.replace('_', ' ')} ${Math.round((v as number) * 100)}%`)
      .join(' · ')
    return <p className="coding-event coding-event--meta">Usage window: {used || 'ok'}</p>
  }
  if (type === 'error') {
    return (
      <p className="coding-event coding-event--error">
        {payload.reason === 'rate_limit'
          ? 'Paused — the Claude usage window is used up.'
          : payload.detail}
      </p>
    )
  }
  if (type === 'started') {
    return <p className="coding-event coding-event--meta">Branch {payload.branch}</p>
  }
  return null
}

/** Coding tasks Nova has running on the Mac: watch one, steer it, stop it. */
export function CodingPanel({ onClose }: CodingPanelProps) {
  const [sessions, setSessions] = useState<CodingSession[]>([])
  const [agentConnected, setAgentConnected] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<CodingSession | null>(null)
  const [events, setEvents] = useState<CodingEvent[]>([])
  const [error, setError] = useState<string | null>(null)
  const [feedback, setFeedback] = useState('')
  const [isSending, setIsSending] = useState(false)
  const [showStart, setShowStart] = useState(false)
  const [draft, setDraft] = useState({ repo: 'nova-backend', title: '', instructions: '' })

  // Tracks how far the event list has been filled so each poll can ask only
  // for what is new. A ref, not state: changing it must not re-trigger the
  // effect that reads it.
  const seqRef = useRef(0)
  const tailRef = useRef<HTMLDivElement | null>(null)

  const loadSessions = useCallback(async () => {
    try {
      const body = await fetchCodingSessions()
      setSessions(body.sessions)
      setAgentConnected(body.agentConnected)
      setSelectedId((current) => current ?? body.sessions[0]?.sessionId ?? null)
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : 'Could not load coding tasks.')
    }
  }, [])

  useEffect(() => {
    void loadSessions()
  }, [loadSessions])

  // Selecting a different task resets the cursor, or the new task's events
  // would be filtered out by the previous one's high-water mark.
  useEffect(() => {
    seqRef.current = 0
    setEvents([])
    setDetail(null)
  }, [selectedId])

  useEffect(() => {
    if (!selectedId) {
      return
    }
    let cancelled = false
    let timer: number | undefined

    const tick = async () => {
      try {
        const body = await fetchCodingSession(selectedId, seqRef.current)
        if (cancelled) {
          return
        }
        setDetail(body.session)
        setAgentConnected(body.agentConnected)
        if (body.events.length > 0) {
          seqRef.current = body.events[body.events.length - 1].seq
          setEvents((current) => [...current, ...body.events])
        }
        const delay = isLive(body.session.status) ? LIVE_POLL_MS : IDLE_POLL_MS
        timer = window.setTimeout(tick, delay)
      } catch (exc) {
        if (!cancelled) {
          setError(exc instanceof Error ? exc.message : 'Lost track of that task.')
          timer = window.setTimeout(tick, IDLE_POLL_MS)
        }
      }
    }

    void tick()
    return () => {
      cancelled = true
      if (timer) {
        window.clearTimeout(timer)
      }
    }
  }, [selectedId])

  useEffect(() => {
    tailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [events.length])

  const submitFeedback = async (steer: boolean) => {
    const text = feedback.trim()
    if (!text || !selectedId) {
      return
    }
    setIsSending(true)
    try {
      await sendCodingFeedback(selectedId, text, steer)
      setFeedback('')
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : 'Could not send that.')
    } finally {
      setIsSending(false)
    }
  }

  const submitStart = async () => {
    if (!draft.repo.trim() || !draft.instructions.trim()) {
      return
    }
    try {
      const created = await startCodingSession({
        repo: draft.repo.trim(),
        instructions: draft.instructions.trim(),
        title: draft.title.trim() || undefined,
      })
      setShowStart(false)
      setDraft({ repo: draft.repo, title: '', instructions: '' })
      await loadSessions()
      setSelectedId(created.sessionId)
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : 'Could not start that task.')
    }
  }

  return (
    <section className="coding-panel">
      <header className="coding-panel__header">
        <div>
          <h2>Coding</h2>
          <span className={`coding-agent-dot${agentConnected ? ' is-online' : ''}`}>
            {agentConnected ? 'Mac connected' : 'Mac offline'}
          </span>
        </div>
        <div className="coding-panel__actions">
          <button type="button" onClick={() => setShowStart((v) => !v)} disabled={!agentConnected}>
            New task
          </button>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </header>

      {error ? <p className="coding-error">{error}</p> : null}

      {showStart ? (
        <div className="coding-start">
          <input
            value={draft.repo}
            onChange={(e) => setDraft({ ...draft, repo: e.target.value })}
            placeholder="repo (e.g. nova-backend)"
          />
          <input
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            placeholder="short title — becomes the branch name"
          />
          <textarea
            value={draft.instructions}
            onChange={(e) => setDraft({ ...draft, instructions: e.target.value })}
            placeholder="What should it build? Brief it like an engineer who can't ask a follow-up."
            rows={4}
          />
          <button type="button" onClick={() => void submitStart()}>
            Start
          </button>
        </div>
      ) : null}

      <div className="coding-panel__body">
        <ul className="coding-list">
          {sessions.length === 0 ? <li className="coding-empty">No coding tasks yet.</li> : null}
          {sessions.map((session) => (
            <li key={session.sessionId}>
              <button
                type="button"
                className={session.sessionId === selectedId ? 'is-selected' : ''}
                onClick={() => setSelectedId(session.sessionId)}
              >
                <span className={`coding-status coding-status--${session.status}`}>
                  {STATUS_LABEL[session.status] ?? session.status}
                </span>
                <strong>{session.title}</strong>
                <small>{session.branch ?? session.repo}</small>
              </button>
            </li>
          ))}
        </ul>

        <div className="coding-detail">
          {detail ? (
            <>
              <div className="coding-detail__head">
                <h3>{detail.title}</h3>
                <p className="coding-rollup">{detail.rollup}</p>
                <small>
                  {detail.repo}
                  {detail.branch ? ` · ${detail.branch}` : ''}
                </small>
              </div>

              <div className="coding-stream">
                {events.map((event) => (
                  <EventRow key={event.seq} event={event} />
                ))}
                <div ref={tailRef} />
              </div>

              <div className="coding-feedback">
                <textarea
                  value={feedback}
                  onChange={(e) => setFeedback(e.target.value)}
                  placeholder="Send feedback into this task…"
                  rows={2}
                  disabled={!agentConnected || detail.status === 'closed'}
                />
                <div className="coding-feedback__actions">
                  <button
                    type="button"
                    onClick={() => void submitFeedback(false)}
                    disabled={isSending || !feedback.trim() || !agentConnected}
                  >
                    Send
                  </button>
                  <button
                    type="button"
                    title="Interrupt what it's doing and apply this now"
                    onClick={() => void submitFeedback(true)}
                    disabled={isSending || !feedback.trim() || !agentConnected}
                  >
                    Steer
                  </button>
                  <button
                    type="button"
                    className="coding-stop"
                    onClick={() => void stopCodingSession(detail.sessionId).then(loadSessions)}
                    disabled={detail.status === 'closed'}
                  >
                    Stop
                  </button>
                </div>
              </div>
            </>
          ) : (
            <p className="coding-empty">Pick a task to watch it work.</p>
          )}
        </div>
      </div>
    </section>
  )
}
