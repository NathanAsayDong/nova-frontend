import { useState } from 'react'
import type { ProjectSummary } from '../../nova/components/ConversationHeader'

type MeetingStartFormProps = {
  projects: ProjectSummary[]
  /** Pre-selected: the project the current conversation is attached to. */
  defaultProjectId: number | null
  onStart: (input: { title?: string; projectId: number | null }) => void
  onCancel: () => void
}

/**
 * Title and project, asked once before recording starts.
 *
 * Both are optional — the title is written from the transcript if left blank,
 * and a meeting can belong to no project. Asking here rather than after the
 * fact is what makes filing a meeting a decision rather than a chore.
 */
export function MeetingStartForm({
  projects,
  defaultProjectId,
  onStart,
  onCancel,
}: MeetingStartFormProps) {
  const [title, setTitle] = useState('')
  const [projectId, setProjectId] = useState<string>(
    defaultProjectId != null ? String(defaultProjectId) : '',
  )

  const submit = () => {
    onStart({
      title: title.trim() || undefined,
      projectId: projectId ? Number(projectId) : null,
    })
  }

  return (
    <form
      className="meetingStartForm"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <label className="meetingField wide">
        <span className="meetingFieldLabel">Title</span>
        <input
          className="meetingInput"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Optional — written from the transcript if blank"
          autoFocus
        />
      </label>

      <label className="meetingField">
        <span className="meetingFieldLabel">Project</span>
        <select
          className="meetingInput"
          value={projectId}
          onChange={(event) => setProjectId(event.target.value)}
        >
          <option value="">No project</option>
          {projects.map((project) => (
            <option key={project.id} value={String(project.id)}>
              {project.name ?? `Project ${project.id}`}
            </option>
          ))}
        </select>
      </label>

      <div className="meetingFormActions">
        <button type="button" className="meetingGhostButton" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="meetingPrimaryButton">
          Start recording
        </button>
      </div>
    </form>
  )
}
