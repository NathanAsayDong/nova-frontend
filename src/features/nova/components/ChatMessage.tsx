import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ChatMessage as ChatMessageModel, MessagePart } from '../chatTypes'
import { useTypewriter } from '../hooks/useTypewriter'
import { ArtifactBlock } from './ArtifactBlock'

const TOOL_LABEL: Record<string, string> = {
  read_project_file: 'Reading file',
  write_project_file: 'Writing file',
  edit_project_file: 'Editing file',
  delete_project_file: 'Deleting file',
  list_project_files: 'Listing project files',
  run_terminal_command: 'Running command',
  fetch_memory: 'Searching memory',
  web_search: 'Searching the web',
  create_project: 'Creating project',
  update_project: 'Updating project',
  list_projects: 'Listing projects',
  delete_project: 'Deleting project',
  switch_project: 'Switching project',
  assign_conversation_to_project: 'Attaching to project',
  send_email: 'Sending email',
}

function toolSummary(tool: string, input: Record<string, unknown>) {
  const label = TOOL_LABEL[tool] ?? tool
  const detail = input.path ?? input.command ?? input.prompt ?? input.name ?? ''
  return { label, detail: typeof detail === 'string' ? detail : '' }
}

/**
 * Text part. While the turn streams, characters are revealed progressively;
 * markdown is only rendered once the part is complete, since parsing a
 * half-finished fence produces flickering garbage.
 */
function TextPart({
  text,
  format,
  streaming,
}: {
  text: string
  format: 'markdown' | 'text'
  streaming: boolean
}) {
  const shown = useTypewriter(text, streaming)
  const isComplete = !streaming && shown === text

  if (format === 'markdown' && isComplete) {
    return (
      <div className="messageMarkdown">
        {/* GFM adds tables and strikethrough, which reports lean on. */}
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
      </div>
    )
  }

  return (
    <p className="messageText">
      {shown}
      {/* Keep the caret while catch-up typing finishes after the turn ends. */}
      {streaming || shown !== text ? <span className="caret" aria-hidden="true" /> : null}
    </p>
  )
}

function Part({ part, streaming }: { part: MessagePart; streaming: boolean }) {
  if (part.kind === 'text') {
    return <TextPart text={part.text} format={part.format} streaming={streaming} />
  }

  if (part.kind === 'status') {
    // Pre-tool acknowledgment — visually a passing remark, not the answer.
    return <p className="statusText">{part.text}</p>
  }

  if (part.kind === 'artifact') {
    return <ArtifactBlock artifact={part.artifact} />
  }

  const { label, detail } = toolSummary(part.tool, part.input)
  return (
    <div className="toolChip">
      <span className="toolSpinnerDot" aria-hidden="true" />
      <span className="toolLabel">{label}</span>
      {detail ? <code className="toolDetail">{detail}</code> : null}
    </div>
  )
}

export function ChatMessage({ message }: { message: ChatMessageModel }) {
  const isUser = message.role === 'user'
  const streaming = Boolean(message.streaming)

  return (
    <article className={`chatMessage role-${message.role}`}>
      <div className="messageAuthor">{isUser ? 'You' : 'Nova'}</div>
      <div className="messageBody">
        {message.parts.map((part, index) => (
          <Part
            key={index}
            part={part}
            // Only the final part of a streaming turn is still being typed.
            streaming={streaming && index === message.parts.length - 1}
          />
        ))}
        {streaming && message.parts.length === 0 ? (
          <div className="thinkingDots" aria-label="Nova is thinking">
            <span />
            <span />
            <span />
          </div>
        ) : null}
      </div>
    </article>
  )
}
