import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { MeetingDetail } from '../types'

type MeetingNotesCardProps = {
  detail: MeetingDetail
  onDismiss: () => void
}

export function MeetingNotesCard({ detail, onDismiss }: MeetingNotesCardProps) {
  const { meeting, notes } = detail

  return (
    <section className="meetingNotesCard" aria-label="Meeting notes">
      <header className="meetingNotesHeader">
        <div>
          <span className="meetingNotesEyebrow">Meeting written up</span>
          <h2 className="meetingNotesTitle">{meeting.title || 'Untitled meeting'}</h2>
        </div>
        <button type="button" className="meetingDismiss" onClick={onDismiss}>
          Dismiss
        </button>
      </header>

      {!notes ? (
        <p className="meetingEmpty">
          {meeting.status === 'failed'
            ? 'This meeting could not be written up. The transcript is still saved.'
            : 'No notes were produced — there may have been nothing to transcribe.'}
        </p>
      ) : (
        <>
          <div className="meetingNotesBody">
            <Markdown remarkPlugins={[remarkGfm]}>{notes.summary_md}</Markdown>
          </div>

          {notes.decisions.length > 0 ? (
            <div className="meetingNotesGroup">
              <h3>Decisions</h3>
              <ul>
                {notes.decisions.map((decision) => (
                  <li key={decision}>{decision}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {notes.action_items.length > 0 ? (
            <div className="meetingNotesGroup">
              <h3>Action items</h3>
              <ul className="meetingActions">
                {notes.action_items.map((item, index) => (
                  <li key={`${item.task ?? 'item'}-${index}`}>
                    <span className="meetingActionTask">{item.task ?? 'Unnamed task'}</span>
                    {item.owner ? <span className="meetingActionMeta">{item.owner}</span> : null}
                    {item.due ? (
                      <span className="meetingActionMeta due">{item.due}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}
    </section>
  )
}
