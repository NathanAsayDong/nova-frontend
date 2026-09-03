import { useCallback, useEffect, useRef, useState } from 'react'
import {
  adoptClaudeThread,
  fetchClaudeThreads,
  fetchCodingSession,
  fetchCodingSessions,
  sendCodingFeedback,
  startCodingSession,
  stopCodingSession,
} from '../api'
import type { ClaudeThread, CodingEvent, CodingSession, CodingStatus } from '../types'

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

function formatWhen(value: string): string {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return value
  }
  return parsed.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

const STATUS_CLASS: Record<CodingStatus, string> = {
  starting: 'codingStatusWorking',
  queued: 'codingStatusQueued',
  working: 'codingStatusWorking',
  idle: 'codingStatusIdle',
  error: 'codingStatusError',
  closed: 'codingStatusClosed',
}

function isLive(status: CodingStatus): boolean {
  return status === 'working' || status === 'starting'
}

function EventRow({ event }: { event: CodingEvent }) {
  const { type, payload } = event

  if (type === 'text') {
    return <p className="codingEvent">{payload.text}</p>
  }
  if (type === 'tool') {
    const artifact = payload.artifact
    return (
      <div className="codingEvent codingEventTool">
        <span className="codingToolName">{payload.tool}</span>
        {artifact ? (
          <details className="codingArtifact">
            <summary>
              <span className={`codingArtifactKind${artifact.kind === 'diff' ? ' codingArtifactKindDiff' : ''}`}>
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
      <div className={`codingEventResult${payload.is_error ? ' isError' : ''}`}>
        <strong>{payload.is_error ? 'Failed' : 'Done'}</strong>
        {payload.result ? <p>{payload.result}</p> : null}
        {payload.num_turns ? <span className="codingResultMeta">{payload.num_turns} turns</span> : null}
      </div>
    )
  }
  if (type === 'rate_limit') {
    const used = Object.entries(payload.utilization ?? {})
      .filter(([, v]) => v != null)
      .map(([k, v]) => `${k.replace('_', ' ')} ${Math.round((v as number) * 100)}%`)
      .join(' · ')
    return <p className="codingEvent codingEventMeta">Usage window: {used || 'ok'}</p>
  }
  if (type === 'error') {
    return (
      <p className="codingEvent codingEventError">
        {payload.reason === 'rate_limit'
          ? 'Paused — the Claude usage window is used up.'
          : payload.detail}
      </p>
    )
  }
  if (type === 'started') {
    return <p className="codingEvent codingEventMeta">Branch {payload.branch}</p>
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
  const [threads, setThreads] = useState<ClaudeThread[] | null>(null)
  const [isLoadingThreads, setIsLoadingThreads] = useState(false)

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

  /**
   * Threads Claude Code already has for this repo, Nova's or not.
   *
   * Loaded on demand rather than with the panel: it reads the Mac's disk
   * through the websocket, which is pointless to do for someone who only
   * wanted to glance at a running task.
   */
  const loadThreads = async () => {
    const repo = draft.repo.trim()
    if (!repo) {
      return
    }
    setIsLoadingThreads(true)
    try {
      const body = await fetchClaudeThreads(repo)
      setThreads(body.sessions)
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : 'Could not read the Mac\'s threads.')
    } finally {
      setIsLoadingThreads(false)
    }
  }

  const adopt = async (thread: ClaudeThread) => {
    try {
      const picked = await adoptClaudeThread(draft.repo.trim(), thread.session_id)
      await loadSessions()
      setSelectedId(picked.sessionId)
      setThreads(null)
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : 'Could not pick up that thread.')
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
    <section className="codingPanel">
      <header className="codingPanelHeader">
        <div className="codingPanelHeading">
          <h2 className="codingPanelTitle">Coding</h2>
          <span className={`codingAgentPill${agentConnected ? ' isOnline' : ''}`}>
            {agentConnected ? 'Mac connected' : 'Mac offline'}
          </span>
        </div>
        <div className="codingPanelActions">
          <button type="button" className="codingButton" onClick={() => setShowStart((v) => !v)} disabled={!agentConnected}>
            New task
          </button>
          <button
            type="button"
            className="codingButton"
            onClick={() => (threads === null ? void loadThreads() : setThreads(null))}
            disabled={!agentConnected || isLoadingThreads}
            title="Conversations Claude Code already has for this repo, including ones from the desktop app"
          >
            {isLoadingThreads ? 'Reading…' : threads === null ? 'Existing threads' : 'Hide threads'}
          </button>
          <button type="button" className="codingButton" onClick={onClose}>
            Close
          </button>
        </div>
      </header>

      {error ? <p className="codingError">{error}</p> : null}

      {showStart ? (
        <div className="codingStartForm">
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
          <button type="button" className="codingButton" onClick={() => void submitStart()}>
            Start
          </button>
        </div>
      ) : null}

      {threads !== null ? (
        <div className="codingThreads">
          <p className="codingThreadsHint">
            Claude Code threads for <strong>{draft.repo}</strong> on your Mac. Picking
            one up resumes that conversation with its context, in the real working tree.
          </p>
          {threads.length === 0 ? (
            <p className="codingEmpty">No Claude Code history for that repo.</p>
          ) : null}
          <ul className="codingThreadList">
            {threads.map((thread) => (
              <li key={thread.session_id}>
                <div className="codingThreadInfo">
                  <span className="codingListItemTitle">
                    {thread.title ?? thread.first_prompt ?? thread.session_id}
                  </span>
                  <span className="codingListItemMeta">
                    {thread.git_branch ?? 'no branch'}
                    {thread.last_modified ? ` · ${formatWhen(thread.last_modified)}` : ''}
                    {thread.attached ? ' · already open' : ''}
                  </span>
                </div>
                <button
                  type="button"
                  className="codingButton"
                  onClick={() => void adopt(thread)}
                  disabled={!agentConnected}
                >
                  {thread.attached ? 'Open' : 'Pick up'}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="codingBody">
        <ul className="codingList">
          {sessions.length === 0 ? <li className="codingEmpty">No coding tasks yet.</li> : null}
          {sessions.map((session) => (
            <li key={session.sessionId}>
              <button
                type="button"
                className={`codingListItem${session.sessionId === selectedId ? ' isSelected' : ''}`}
                onClick={() => setSelectedId(session.sessionId)}
              >
                <span className={`codingStatus ${STATUS_CLASS[session.status] ?? ''}`}>
                  {STATUS_LABEL[session.status] ?? session.status}
                </span>
                <span className="codingListItemTitle">{session.title}</span>
                <span className="codingListItemMeta">{session.branch ?? session.repo}</span>
              </button>
            </li>
          ))}
        </ul>

        <div className="codingDetail">
          {detail ? (
            <>
              <div className="codingDetailHead">
                <h3 className="codingDetailTitle">{detail.title}</h3>
                <p className="codingRollup">{detail.rollup}</p>
                <span className="codingDetailMeta">
                  {detail.repo}
                  {detail.branch ? ` · ${detail.branch}` : ''}
                </span>
              </div>

              <div className="codingStream">
                {events.map((event) => (
                  <EventRow key={event.seq} event={event} />
                ))}
                <div ref={tailRef} />
              </div>

              <div className="codingFeedback">
                <textarea
                  value={feedback}
                  onChange={(e) => setFeedback(e.target.value)}
                  placeholder="Send feedback into this task…"
                  rows={2}
                  disabled={!agentConnected || detail.status === 'closed'}
                />
                <div className="codingFeedbackActions">
                  <button
                    type="button"
                    className="codingButton"
                    onClick={() => void submitFeedback(false)}
                    disabled={isSending || !feedback.trim() || !agentConnected}
                  >
                    Send
                  </button>
                  <button
                    type="button"
                    className="codingButton"
                    title="Interrupt what it's doing and apply this now"
                    onClick={() => void submitFeedback(true)}
                    disabled={isSending || !feedback.trim() || !agentConnected}
                  >
                    Steer
                  </button>
                  <button
                    type="button"
                    className="codingButton codingButtonDanger"
                    onClick={() => void stopCodingSession(detail.sessionId).then(loadSessions)}
                    disabled={detail.status === 'closed'}
                  >
                    Stop
                  </button>
                </div>
              </div>
            </>
          ) : (
            <p className="codingEmpty">Pick a task to watch it work.</p>
          )}
        </div>
      </div>
    </section>
  )
}
