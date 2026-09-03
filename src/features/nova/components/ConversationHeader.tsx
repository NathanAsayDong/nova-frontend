import { useState } from 'react'
import type { UiPhase } from '../types'
import { McpServerPanel } from './McpServerPanel'

export type ProjectSummary = {
  id: number
  name?: string
  description?: string
}

type ConversationHeaderProps = {
  conversationId: string | null
  project: ProjectSummary | null
  projects: ProjectSummary[]
  uiPhase: UiPhase
  /** A typed turn is streaming; uiPhase only tracks the voice pipeline. */
  isStreaming: boolean
  isNovaEnabled: boolean
  /** A meeting is recording, so Nova is transcribing rather than listening. */
  isMeetingMode: boolean
  /** Blocks the toggle while a meeting is starting or being written up. */
  isMeetingBusy: boolean
  isMeetingsPanelOpen: boolean
  isCodingPanelOpen: boolean
  onNewConversation: () => void
  onTogglePower: () => void
  onToggleMeeting: () => void
  onToggleMeetingsPanel: () => void
  onToggleCodingPanel: () => void
}

const PHASE_LABEL: Record<UiPhase, string> = {
  idle: 'Idle',
  listening: 'Listening',
  thinking: 'Thinking',
  responding: 'Speaking',
}

export function ConversationHeader({
  conversationId,
  project,
  projects,
  uiPhase,
  isStreaming,
  isNovaEnabled,
  isMeetingMode,
  isMeetingBusy,
  isMeetingsPanelOpen,
  isCodingPanelOpen,
  onNewConversation,
  onTogglePower,
  onToggleMeeting,
  onToggleMeetingsPanel,
  onToggleCodingPanel,
}: ConversationHeaderProps) {
  const [showProjects, setShowProjects] = useState(false)

  // Chat and speech are one conversation, so the status reflects either one.
  const phase: UiPhase = isStreaming && uiPhase === 'idle' ? 'thinking' : uiPhase

  return (
    <header className="novaHeader">
      <div className="novaHeaderTop">
        <div className="novaBrand">
          <span className="novaMark">NOVA</span>
          <span
            className={`phasePill phase-${isMeetingMode ? 'idle' : phase} ${
              isNovaEnabled && !isMeetingMode ? '' : 'off'
            }`}
          >
            <span className="phaseDot" aria-hidden="true" />
            {isMeetingMode ? 'In a meeting' : isNovaEnabled ? PHASE_LABEL[phase] : 'Offline'}
          </span>
          <button
            type="button"
            className={`powerToggle ${isNovaEnabled ? 'on' : 'off'}`}
            onClick={onTogglePower}
            role="switch"
            aria-checked={isNovaEnabled}
            aria-label={isNovaEnabled ? 'Turn Nova off (stop listening)' : 'Turn Nova on'}
            title={isNovaEnabled ? 'Stop listening' : 'Turn Nova on'}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M12 3v8"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
              />
              <path
                d="M7.2 6.2a7 7 0 1 0 9.6 0"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        <div className="novaHeaderActions">
          <button
            type="button"
            className={`meetingToggle ${isMeetingsPanelOpen ? 'open' : ''}`}
            onClick={onToggleMeetingsPanel}
            aria-pressed={isMeetingsPanelOpen}
            title="Past meetings, notes, and transcripts"
          >
            Meetings
          </button>

          <button
            type="button"
            className={`meetingToggle ${isCodingPanelOpen ? 'open' : ''}`}
            onClick={onToggleCodingPanel}
            aria-pressed={isCodingPanelOpen}
            title="Coding tasks running on the Mac"
          >
            Coding
          </button>

          <button
            type="button"
            className={`meetingToggle ${isMeetingMode ? 'active' : ''}`}
            onClick={onToggleMeeting}
            disabled={isMeetingBusy || (!isMeetingMode && !isNovaEnabled)}
            aria-pressed={isMeetingMode}
            title={
              isMeetingMode
                ? 'Stop recording and write the meeting up'
                : 'Record a meeting. Nova transcribes and stops answering.'
            }
          >
            {isMeetingMode ? (
              <span className="meetingDot" aria-hidden="true" />
            ) : null}
            {isMeetingBusy
              ? 'Working…'
              : isMeetingMode
                ? 'Stop meeting'
                : 'Start meeting'}
          </button>

          <button type="button" className="headerButton" onClick={onNewConversation}>
            New conversation
          </button>
        </div>
      </div>

      <div className="novaHeaderMeta">
        <span className="metaItem">
          <span className="metaLabel">Conversation</span>
          <code className="metaValue">
            {conversationId ? `${conversationId.slice(0, 8)}…` : 'not started'}
          </code>
        </span>

        <span className="metaItem">
          <span className="metaLabel">Project</span>
          <span className={`metaValue ${project ? 'attached' : 'none'}`}>
            {project ? `${project.name ?? 'unnamed'} (#${project.id})` : 'none'}
          </span>
        </span>

        <button
          type="button"
          className="metaToggle"
          onClick={() => setShowProjects((current) => !current)}
          aria-expanded={showProjects}
        >
          {projects.length} project{projects.length === 1 ? '' : 's'} {showProjects ? '▾' : '▸'}
        </button>
      </div>

      {showProjects ? (
        <ul className="projectList">
          {projects.length === 0 ? <li className="projectEmpty">No projects yet.</li> : null}
          {projects.map((item) => (
            <li
              key={item.id}
              className={`projectItem ${project?.id === item.id ? 'current' : ''}`}
            >
              <span className="projectName">
                #{item.id} {item.name ?? 'unnamed'}
              </span>
              {item.description ? (
                <span className="projectDescription">{item.description}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      <McpServerPanel />
    </header>
  )
}
