import { useEffect, useRef } from 'react'
import type { MeetingPhase, MeetingSegment } from '../types'

type MeetingLiveProps = {
  phase: MeetingPhase
  title: string | null
  projectName: string | null
  segments: MeetingSegment[]
  partial: string
  error: string | null
  onStop: () => void
}

function formatOffset(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

const PHASE_COPY: Record<MeetingPhase, string> = {
  off: 'Not recording',
  starting: 'Starting…',
  recording: 'Recording',
  stopping: 'Stopping…',
  processing: 'Writing it up…',
  error: 'Something went wrong',
}

export function MeetingLive({
  phase,
  title,
  projectName,
  segments,
  partial,
  error,
  onStop,
}: MeetingLiveProps) {
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
    const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight
    pinnedRef.current = distanceFromBottom < 60
  }

  const isLive = phase === 'recording' || phase === 'starting'
  const hasContent = segments.length > 0 || partial.length > 0

  return (
    <section className="meetingLive" aria-label="Meeting transcript">
      <header className="meetingLiveHeader">
        <div className="meetingLiveIdentity">
          <span className={`meetingPill phase-${phase}`}>
            {isLive ? <span className="meetingDot" aria-hidden="true" /> : null}
            {PHASE_COPY[phase]}
          </span>
          <h2 className="meetingLiveTitle">{title || 'Untitled meeting'}</h2>
          {projectName ? (
            <span className="meetingProject">{projectName}</span>
          ) : (
            <span className="meetingProject none">No project</span>
          )}
        </div>

        <button
          type="button"
          className="meetingStopButton"
          onClick={onStop}
          disabled={phase !== 'recording'}
        >
          Stop &amp; write up
        </button>
      </header>

      <p className="meetingLiveNote">
        Nova is transcribing and will not answer until the meeting ends.
      </p>

      {error ? <p className="meetingError">{error}</p> : null}

      <div className="meetingTranscript" ref={scrollRef} onScroll={handleScroll}>
        {!hasContent ? (
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
