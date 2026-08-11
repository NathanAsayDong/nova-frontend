/**
 * Wire types for the text chat protocol (`POST /chat/stream`, SSE).
 *
 * The backend streams three kinds of thing: prose deltas, notice that a tool
 * is running, and renderable artifacts (diffs, files, terminal output). The UI
 * keeps them as separate parts of a message so a code diff is never dumped
 * into a paragraph.
 */

export type ContentFormat = 'markdown' | 'text'

export type ArtifactKind = 'diff' | 'file' | 'terminal'

export type Artifact = {
  kind: ArtifactKind
  title: string
  content: string
  language?: string
  tool?: string
  exitCode?: number | null
}

export type ToolCall = {
  tool: string
  input: Record<string, unknown>
}

/** Server-sent events emitted by POST /chat/stream. */
export type ChatStreamEvent =
  | { type: 'start'; conversationId: string }
  | { type: 'delta'; text: string; seq: number; format?: ContentFormat }
  | { type: 'text_final'; text: string; format?: ContentFormat }
  /** Spoken acknowledgment emitted once before tool work starts. */
  | { type: 'status_text'; text: string }
  | ({ type: 'tool_call' } & ToolCall)
  | ({ type: 'artifact' } & Artifact)
  | { type: 'conversation_switched'; previousConversationId: string; conversationId: string }
  | { type: 'done'; conversationId: string; assistantText: string }
  | { type: 'error'; message: string; code?: string }

/**
 * One rendered part of an assistant turn, in arrival order, so the transcript
 * reads the way the work actually happened: prose, then a diff, then more
 * prose.
 */
export type MessagePart =
  | { kind: 'text'; text: string; format: ContentFormat }
  | { kind: 'status'; text: string }
  | { kind: 'tool'; tool: string; input: Record<string, unknown> }
  | { kind: 'artifact'; artifact: Artifact }

export type ChatRole = 'user' | 'nova' | 'tool' | 'system'

export type ChatMessage = {
  id: string
  role: ChatRole
  parts: MessagePart[]
  createdAt?: string
  /** Set while this message is still streaming, which drives the typing effect. */
  streaming?: boolean
}

/** Shape of GET /conversations/{id}/messages */
export type HistoryResponse = {
  conversationId: string
  isClosed: boolean
  project?: { id: number; name?: string; description?: string } | null
  messages: Array<{
    id: number | string
    role: ChatRole
    content: string
    format: ContentFormat
    createdAt?: string
  }>
}
