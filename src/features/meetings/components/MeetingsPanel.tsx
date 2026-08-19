import { useCallback, useEffect, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ProjectSummary } from '../../nova/components/ConversationHeader'
import {
  deleteMeeting,
  fetchMeeting,
  fetchMeetingSegments,
  fetchMeetings,
  updateMeeting,
} from '../api'
import type { Meeting, MeetingDetail, MeetingSegment } from '../types'

type MeetingsPanelProps = {
  projects: ProjectSummary[]
  onClose: () => void
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

function formatOffset(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/** Past meetings: read the notes, retitle, refile, or delete. */
export function MeetingsPanel({ projects, onClose }: MeetingsPanelProps) {
  const [meetings, setMeetings] = useState<Meeting[]>([])
  const [selected, setSelected] = useState<MeetingDetail | null>(null)
  const [segments, setSegments] = useState<MeetingSegment[]>([])
  const [showTranscript, setShowTranscript] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [draftTitle, setDraftTitle] = useState('')
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const load = useCallback(async () => {
    setIsLoading(true)
    try {
      setMeetings(await fetchMeetings(50))
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const open = useCallback(async (uuid: string) => {
    setShowTranscript(false)
    setConfirmingDelete(false)
    try {
      const detail = await fetchMeeting(uuid)
      setSelected(detail)
      setDraftTitle(detail.meeting.title ?? '')
      setSegments(await fetchMeetingSegments(uuid).catch(() => []))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [])

  const applyChange = useCallback(
    async (changes: { title?: string; projectId?: number | null; clearProject?: boolean }) => {
      if (!selected) {
        return
      }
      try {
        const updated = await updateMeeting(selected.meeting.uuid, changes)
        setSelected({ ...selected, meeting: updated })
        setMeetings((current) =>
          current.map((item) => (item.uuid === updated.uuid ? updated : item)),
        )
        setError(null)
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught))
      }
    },
    [selected],
  )

  const remove = useCallback(async () => {
    if (!selected) {
      return
    }
    try {
      await deleteMeeting(selected.meeting.uuid)
      setMeetings((current) =>
        current.filter((item) => item.uuid !== selected.meeting.uuid),
      )
      setSelected(null)
      setConfirmingDelete(false)
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [selected])

  return (
    <section className="meetingsPanel" aria-label="Meetings">
      <header className="meetingsPanelHeader">
        <h2 className="meetingsPanelTitle">
          {selected ? selected.meeting.title || 'Untitled meeting' : 'Meetings'}
        </h2>
        {selected ? (
          <button
            type="button"
            className="meetingGhostButton"
            onClick={() => setSelected(null)}
          >
            All meetings
          </button>
        ) : null}
        <button type="button" className="meetingGhostButton" onClick={onClose}>
          Back to Nova
        </button>
      </header>

      {error ? <p className="meetingError">{error}</p> : null}

      <div className="meetingsPanelBody">
        {!selected ? (
          <>
            {isLoading ? <p className="meetingEmpty">Loading…</p> : null}
            {!isLoading && meetings.length === 0 ? (
              <p className="meetingEmpty">
                No meetings yet. Start one from the header, or ask Nova to take notes.
              </p>
            ) : null}

            <ul className="meetingsList">
              {meetings.map((meeting) => (
                <li key={meeting.uuid}>
                  <button
                    type="button"
                    className="meetingsListItem"
                    onClick={() => void open(meeting.uuid)}
                  >
                    <span className="meetingsListTitle">
                      {meeting.title || 'Untitled meeting'}
                    </span>
                    <span className="meetingsListMeta">
                      <span>{formatWhen(meeting.started_at)}</span>
                      {meeting.project ? (
                        <span className="meetingProject">
                          {meeting.project.name ?? `Project ${meeting.project.id}`}
                        </span>
                      ) : null}
                      {meeting.status !== 'complete' ? (
                        <span className={`meetingPill phase-${meeting.status}`}>
                          {meeting.status}
                        </span>
                      ) : null}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <div className="meetingDetail">
            <div className="meetingDetailControls">
              <label className="meetingField wide">
                <span className="meetingFieldLabel">Title</span>
                <input
                  className="meetingInput"
                  value={draftTitle}
                  onChange={(event) => setDraftTitle(event.target.value)}
                  onBlur={() => {
                    const next = draftTitle.trim()
                    if (next && next !== (selected.meeting.title ?? '')) {
                      void applyChange({ title: next })
                    }
                  }}
                  placeholder="Untitled meeting"
                />
              </label>

              <label className="meetingField">
                <span className="meetingFieldLabel">Project</span>
                <select
                  className="meetingInput"
                  value={selected.meeting.project ? String(selected.meeting.project.id) : ''}
                  onChange={(event) => {
                    const value = event.target.value
                    void applyChange(
                      value ? { projectId: Number(value) } : { clearProject: true },
                    )
                  }}
                >
                  <option value="">No project</option>
                  {projects.map((project) => (
                    <option key={project.id} value={String(project.id)}>
                      {project.name ?? `Project ${project.id}`}
                    </option>
                  ))}
                </select>
              </label>

              {confirmingDelete ? (
                <div className="meetingDeleteConfirm">
                  <span>Delete this meeting and its transcript?</span>
                  <button type="button" className="meetingDangerButton" onClick={() => void remove()}>
                    Delete
                  </button>
                  <button
                    type="button"
                    className="meetingGhostButton"
                    onClick={() => setConfirmingDelete(false)}
                  >
                    Keep
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="meetingGhostButton danger"
                  onClick={() => setConfirmingDelete(true)}
                >
                  Delete meeting
                </button>
              )}
            </div>

            {selected.notes ? (
              <>
                <h3 className="meetingSectionHeading">Summary</h3>
                <div className="meetingNotesBody">
                  <Markdown remarkPlugins={[remarkGfm]}>{selected.notes.summary_md}</Markdown>
                </div>

                {selected.notes.decisions.length > 0 ? (
                  <>
                    <h3 className="meetingSectionHeading">Decisions</h3>
                    <ul className="meetingNotesList">
                      {selected.notes.decisions.map((decision) => (
                        <li key={decision}>{decision}</li>
                      ))}
                    </ul>
                  </>
                ) : null}

                {selected.notes.action_items.length > 0 ? (
                  <>
                    <h3 className="meetingSectionHeading">Action items</h3>
                    <ul className="meetingActions">
                      {selected.notes.action_items.map((item, index) => (
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
              </>
            ) : (
              <p className="meetingEmpty">{selected.note ?? 'No notes for this meeting.'}</p>
            )}

            {segments.length > 0 ? (
              <>
                <button
                  type="button"
                  className="meetingGhostButton"
                  onClick={() => setShowTranscript((current) => !current)}
                  aria-expanded={showTranscript}
                >
                  {showTranscript ? 'Hide' : 'Show'} transcript ({segments.length})
                </button>

                {showTranscript ? (
                  <div className="meetingTranscriptBlock">
                    {segments.map((segment) => (
                      <p
                        className="meetingSegment"
                        key={`${segment.startMs}-${segment.endMs}`}
                      >
                        <span className="meetingTime">{formatOffset(segment.startMs)}</span>
                        <span className="meetingText">{segment.text}</span>
                      </p>
                    ))}
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        )}
      </div>
    </section>
  )
}
