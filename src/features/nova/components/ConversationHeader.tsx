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
  onNewConversation: () => void
  onTogglePower: () => void
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
  onNewConversation,
  onTogglePower,
}: ConversationHeaderProps) {
  const [showProjects, setShowProjects] = useState(false)

  // Chat and speech are one conversation, so the status reflects either one.
  const phase: UiPhase = isStreaming && uiPhase === 'idle' ? 'thinking' : uiPhase

  return (
    <header className="novaHeader">
      <div className="novaHeaderTop">
        <div className="novaBrand">
          <span className="novaMark">NOVA</span>
          <span className={`phasePill phase-${phase} ${isNovaEnabled ? '' : 'off'}`}>
            <span className="phaseDot" aria-hidden="true" />
            {isNovaEnabled ? PHASE_LABEL[phase] : 'Offline'}
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

        <button type="button" className="headerButton" onClick={onNewConversation}>
          New conversation
        </button>
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
