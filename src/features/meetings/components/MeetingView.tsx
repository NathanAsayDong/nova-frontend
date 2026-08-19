import { useEffect, useRef } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { MeetingNotes, MeetingPhase, MeetingSegment } from '../types'

type MeetingViewProps = {
  phase: MeetingPhase
  title: string | null
  projectName: string | null
  segments: MeetingSegment[]
  partial: string
  error: string | null
  /** Present once the finished meeting has been written up. */
  notes: MeetingNotes | null
  /** True when the meeting finished but produced no notes. */
  finishedWithoutNotes: boolean
  onStop: () => void
  onDone: () => void
}

function formatOffset(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

const PHASE_COPY: Record<MeetingPhase, string> = {
  off: 'Finished',
  starting: 'Starting…',
  recording: 'Recording',
  stopping: 'Stopping…',
  processing: 'Writing it up…',
  error: 'Something went wrong',
}

/**
 * One view for the whole meeting: recording, writing up, and the finished
 * notes. Deliberately not three screens — bouncing back to the conversation
 * the instant recording stops, only to surface the notes there a moment
 * later, reads as the UI changing its mind twice.
 */
export function MeetingView({
  phase,
  title,
  projectName,
  segments,
  partial,
  error,
  notes,
  finishedWithoutNotes,
  onStop,
  onDone,
}: MeetingViewProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const pinnedRef = useRef(true)

  // Follow the transcript, but stop following the moment the user scrolls up
  // to read something — yanking them back down mid-sentence is maddening.
  useEffect(() => {
    const node = scrollRef.current
    if (node && pinnedRef.current) {
      node.scrollTop = node.scrollHeight
    }
  }, [segments, partial])

  const handleScroll = () => {
    const node = scrollRef.current
    if (!node) {
      return
    }
    pinnedRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 60
  }

  const isLive = phase === 'recording' || phase === 'starting'
  const isFinished = notes !== null || finishedWithoutNotes
  const hasContent = segments.length > 0 || partial.length > 0

  return (
    <section className="meetingView" aria-label="Meeting">
      <header className="meetingViewHeader">
        <div className="meetingViewIdentity">
          <span className={`meetingPill phase-${isFinished ? 'off' : phase}`}>
            {isLive ? <span className="meetingDot" aria-hidden="true" /> : null}
            {isFinished ? 'Written up' : PHASE_COPY[phase]}
          </span>
          <h2 className="meetingViewTitle">{title || 'Untitled meeting'}</h2>
          {projectName ? (
            <span className="meetingProject">{projectName}</span>
          ) : (
            <span className="meetingProject none">No project</span>
          )}
        </div>

        {isFinished ? (
          <button type="button" className="meetingPrimaryButton" onClick={onDone}>
            Back to Nova
          </button>
        ) : (
          <button
            type="button"
            className="meetingPrimaryButton"
            onClick={onStop}
            disabled={phase !== 'recording'}
          >
            Stop &amp; write up
          </button>
        )}
      </header>

      <p className="meetingViewNote">
        {isFinished
          ? 'Nova is listening again. This meeting is saved under Meetings.'
          : phase === 'processing' || phase === 'stopping'
            ? 'Recording stopped. Nova is writing this up — it will appear here.'
            : 'Nova is transcribing and will not answer until the meeting ends.'}
      </p>

      {error ? <p className="meetingError">{error}</p> : null}

      <div className="meetingScroll" ref={scrollRef} onScroll={handleScroll}>
        {notes ? (
          <div className="meetingNotesBlock">
            <h3 className="meetingSectionHeading">Summary</h3>
            <div className="meetingNotesBody">
              <Markdown remarkPlugins={[remarkGfm]}>{notes.summary_md}</Markdown>
            </div>

            {notes.decisions.length > 0 ? (
              <>
                <h3 className="meetingSectionHeading">Decisions</h3>
                <ul className="meetingNotesList">
                  {notes.decisions.map((decision) => (
                    <li key={decision}>{decision}</li>
                  ))}
                </ul>
              </>
            ) : null}

            {notes.action_items.length > 0 ? (
              <>
                <h3 className="meetingSectionHeading">Action items</h3>
                <ul className="meetingActions">
                  {notes.action_items.map((item, index) => (
                    <li key={`${item.task ?? 'item'}-${index}`}>
                      <span className="meetingActionTask">{item.task ?? 'Unnamed task'}</span>
                      {item.owner ? (
                        <span className="meetingActionMeta">{item.owner}</span>
                      ) : null}
                      {item.due ? (
                        <span className="meetingActionMeta due">{item.due}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </div>
        ) : null}

        {finishedWithoutNotes ? (
          <p className="meetingEmpty">
            Nothing was transcribed, so there was nothing to write up.
          </p>
        ) : null}

        {phase === 'processing' && !isFinished ? (
          <p className="meetingEmpty">Writing up the meeting…</p>
        ) : null}

        {isFinished && segments.length > 0 ? (
          <h3 className="meetingSectionHeading">Transcript</h3>
        ) : null}

        {!hasContent && !isFinished ? (
          <p className="meetingEmpty">
            {isLive
              ? 'Listening. Transcript appears a few seconds behind the room.'
              : 'Nothing captured yet.'}
          </p>
        ) : null}

        {segments.map((segment) => (
          <p className="meetingSegment" key={`${segment.startMs}-${segment.endMs}`}>
            <span className="meetingTime">{formatOffset(segment.startMs)}</span>
            <span className="meetingText">{segment.text}</span>
          </p>
        ))}

        {partial ? (
          <p className="meetingSegment draft">
            <span className="meetingTime">live</span>
            <span className="meetingText">{partial}</span>
          </p>
        ) : null}
      </div>
    </section>
  )
}
