import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  Artifact,
  ChatMessage,
  ChatStreamEvent,
  ContentFormat,
  HistoryResponse,
  MessagePart,
} from '../chatTypes'
import type { ProjectSummary } from '../components/ConversationHeader'
import { loadConversationId, saveConversationId } from '../utils'

let messageCounter = 0
const nextId = () => `m${++messageCounter}`

/**
 * Tool audit rows are stored as json blobs. Rebuild the artifact so a reloaded
 * conversation shows the same diffs and file contents it showed live.
 */
function artifactFromToolRow(content: string): MessagePart | null {
  let parsed: { tool?: string; input?: Record<string, unknown>; result?: unknown }
  try {
    parsed = JSON.parse(content)
  } catch {
    return null
  }
  if (!parsed.tool) {
    return null
  }

  let result: Record<string, unknown> = {}
  if (typeof parsed.result === 'string') {
    try {
      result = JSON.parse(parsed.result)
    } catch {
      result = {}
    }
  } else if (parsed.result && typeof parsed.result === 'object') {
    result = parsed.result as Record<string, unknown>
  }

  const input = parsed.input ?? {}
  const asString = (value: unknown) => (typeof value === 'string' ? value : '')

  const build = (artifact: Artifact): MessagePart => ({ kind: 'artifact', artifact })

  if (parsed.tool === 'edit_project_file' && asString(result.diff)) {
    return build({
      kind: 'diff',
      title: asString(result.path) || asString(input.path),
      content: asString(result.diff),
      language: 'diff',
      tool: parsed.tool,
    })
  }
  if (parsed.tool === 'write_project_file' && asString(input.content)) {
    return build({
      kind: 'file',
      title: asString(input.path),
      content: asString(input.content),
      tool: parsed.tool,
    })
  }
  if (parsed.tool === 'read_project_file' && asString(result.content)) {
    return build({
      kind: 'file',
      title: asString(result.path) || asString(input.path),
      content: asString(result.content),
      tool: parsed.tool,
    })
  }
  if (parsed.tool === 'run_terminal_command') {
    const merged = [asString(result.stdout), asString(result.stderr)]
      .filter((part) => part.trim())
      .join('\n')
    if (merged) {
      return build({
        kind: 'terminal',
        title: asString(input.command),
        content: merged,
        language: 'bash',
        tool: parsed.tool,
        exitCode: typeof result.exit_code === 'number' ? result.exit_code : null,
      })
    }
  }

  return { kind: 'tool', tool: parsed.tool, input }
}

export function useNovaChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [isStreaming, setIsStreaming] = useState(false)
  const [isLoadingHistory, setIsLoadingHistory] = useState(false)
  const [error, setError] = useState('')
  const [project, setProject] = useState<ProjectSummary | null>(null)

  const conversationIdRef = useRef<string | null>(loadConversationId())
  const abortRef = useRef<AbortController | null>(null)
  /** Id of the assistant message currently being streamed into. */
  const activeIdRef = useRef<string | null>(null)

  const setConversationId = useCallback((id: string) => {
    conversationIdRef.current = id
    saveConversationId(id)
  }, [])

  /** Append a part to the streaming assistant message, merging consecutive text. */
  const appendPart = useCallback((part: MessagePart) => {
    const targetId = activeIdRef.current
    if (!targetId) {
      return
    }
    setMessages((current) =>
      current.map((message) => {
        if (message.id !== targetId) {
          return message
        }
        const parts = [...message.parts]
        const last = parts[parts.length - 1]
        if (part.kind === 'text' && last?.kind === 'text' && last.format === part.format) {
          // Sentence chunks belong to one paragraph, not one bubble each.
          parts[parts.length - 1] = {
            ...last,
            text: `${last.text}${last.text ? ' ' : ''}${part.text}`,
          }
        } else {
          parts.push(part)
        }
        return { ...message, parts }
      }),
    )
  }, [])

  /**
   * Swap the streamed text for the backend's whitespace-exact version.
   * Sentence chunks arrive stripped, which flattens markdown lists and code
   * fences; this restores them before the markdown renderer runs.
   */
  const replaceLastText = useCallback((text: string, format: ContentFormat) => {
    const targetId = activeIdRef.current
    if (!targetId) {
      return
    }
    setMessages((current) =>
      current.map((message) => {
        if (message.id !== targetId) {
          return message
        }
        const parts = [...message.parts]
        for (let index = parts.length - 1; index >= 0; index -= 1) {
          if (parts[index].kind === 'text') {
            parts[index] = { kind: 'text', text, format }
            return { ...message, parts }
          }
        }
        return { ...message, parts: [...parts, { kind: 'text', text, format }] }
      }),
    )
  }, [])

  /**
   * Re-read just the conversation's state. Nova can attach or switch projects
   * mid-turn, so the header needs reconciling without rebuilding the whole
   * transcript.
   */
  const refreshConversation = useCallback(async () => {
    const conversationId = conversationIdRef.current
    if (!conversationId) {
      setProject(null)
      return
    }
    try {
      const response = await fetch(`/conversations/${conversationId}`)
      if (!response.ok) {
        return
      }
      const data = (await response.json()) as { project?: ProjectSummary | null }
      setProject(data.project ?? null)
    } catch {
      // Header metadata is informational; failures shouldn't surface as errors.
    }
  }, [])

  const loadHistory = useCallback(async () => {
    const conversationId = conversationIdRef.current
    if (!conversationId) {
      return
    }

    setIsLoadingHistory(true)
    try {
      const response = await fetch(`/conversations/${conversationId}/messages`)
      if (response.status === 404) {
        // Conversation was deleted server-side; start fresh rather than error.
        conversationIdRef.current = null
        return
      }
      if (!response.ok) {
        throw new Error(`History failed (${response.status})`)
      }

      const data = (await response.json()) as HistoryResponse
      setProject(data.project ?? null)
      const restored: ChatMessage[] = []

      for (const row of data.messages) {
        if (!row.content) {
          continue
        }

        if (row.role === 'tool') {
          const part = artifactFromToolRow(row.content)
          if (!part) {
            continue
          }
          // Attach tool output to the assistant turn it belongs to.
          const last = restored[restored.length - 1]
          if (last && last.role === 'nova') {
            last.parts.push(part)
          } else {
            restored.push({
              id: nextId(),
              role: 'nova',
              parts: [part],
              createdAt: row.createdAt,
            })
          }
          continue
        }

        restored.push({
          id: nextId(),
          role: row.role,
          parts: [{ kind: 'text', text: row.content, format: row.format ?? 'text' }],
          createdAt: row.createdAt,
        })
      }

      setMessages(restored)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load history.')
    } finally {
      setIsLoadingHistory(false)
    }
  }, [])

  useEffect(() => {
    void loadHistory()
  }, [loadHistory])

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim()
      if (!trimmed || isStreaming) {
        return
      }

      setError('')
      const assistantId = nextId()
      activeIdRef.current = assistantId

      setMessages((current) => [
        ...current,
        { id: nextId(), role: 'user', parts: [{ kind: 'text', text: trimmed, format: 'text' }] },
        { id: assistantId, role: 'nova', parts: [], streaming: true },
      ])
      setIsStreaming(true)

      const controller = new AbortController()
      abortRef.current = controller

      try {
        const response = await fetch('/chat/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
          body: JSON.stringify({
            message: trimmed,
            ...(conversationIdRef.current
              ? { conversationId: conversationIdRef.current }
              : {}),
          }),
          signal: controller.signal,
        })

        if (response.status === 409) {
          throw new Error('This conversation is closed. Start a new one to continue.')
        }
        if (!response.ok || !response.body) {
          throw new Error(`Chat failed (${response.status})`)
        }

        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) {
            break
          }
          buffer += decoder.decode(value, { stream: true })

          // SSE frames are separated by a blank line; keep the remainder.
          const frames = buffer.split('\n\n')
          buffer = frames.pop() ?? ''

          for (const frame of frames) {
            const line = frame.split('\n').find((part) => part.startsWith('data:'))
            if (!line) {
              continue
            }

            let event: ChatStreamEvent
            try {
              event = JSON.parse(line.slice(5).trim()) as ChatStreamEvent
            } catch {
              continue
            }

            switch (event.type) {
              case 'start':
                setConversationId(event.conversationId)
                break
              case 'delta':
                appendPart({
                  kind: 'text',
                  text: event.text,
                  format: event.format ?? 'markdown',
                })
                break
              case 'text_final':
                replaceLastText(event.text, event.format ?? 'markdown')
                break
              case 'status_text':
                appendPart({ kind: 'status', text: event.text })
                break
              case 'tool_call':
                appendPart({ kind: 'tool', tool: event.tool, input: event.input })
                if (event.tool === 'assign_conversation_to_project' || event.tool === 'switch_project') {
                  void refreshConversation()
                }
                break
              case 'artifact':
                appendPart({
                  kind: 'artifact',
                  artifact: {
                    kind: event.kind,
                    title: event.title,
                    content: event.content,
                    language: event.language,
                    tool: event.tool,
                    exitCode: event.exitCode,
                  },
                })
                break
              case 'conversation_switched':
                setConversationId(event.conversationId)
                break
              case 'error':
                setError(event.message)
                break
              case 'done':
                setConversationId(event.conversationId)
                break
            }
          }
        }
      } catch (caught) {
        if ((caught as Error).name !== 'AbortError') {
          setError(caught instanceof Error ? caught.message : 'Chat request failed.')
        }
      } finally {
        const finishedId = activeIdRef.current
        setMessages((current) =>
          current
            .map((message) =>
              message.id === finishedId ? { ...message, streaming: false } : message,
            )
            // An aborted or failed turn can leave an empty bubble behind.
            .filter((message) => message.role !== 'nova' || message.parts.length > 0),
        )
        activeIdRef.current = null
        abortRef.current = null
        setIsStreaming(false)
      }
    },
    [appendPart, isStreaming, refreshConversation, replaceLastText, setConversationId],
  )

  // The in-progress spoken message being live-captioned, if any. Partial
  // transcripts rewrite it in place; the final transcript claims it.
  const voiceDraftIdRef = useRef<string | null>(null)

  /**
   * Live caption for speech still being transcribed. Each call carries the
   * full text so far and replaces the draft; an empty string discards it
   * (the turn ended without a final transcript — stop phrase, error).
   */
  const updateVoiceDraft = useCallback((text: string) => {
    if (!text) {
      const draftId = voiceDraftIdRef.current
      voiceDraftIdRef.current = null
      if (draftId) {
        setMessages((current) => current.filter((message) => message.id !== draftId))
      }
      return
    }

    if (!voiceDraftIdRef.current) {
      const id = nextId()
      voiceDraftIdRef.current = id
      setMessages((current) => [
        ...current,
        {
          id,
          role: 'user',
          parts: [{ kind: 'text', text, format: 'text' }],
          streaming: true,
        },
      ])
      return
    }

    const draftId = voiceDraftIdRef.current
    setMessages((current) =>
      current.map((message) =>
        message.id === draftId
          ? { ...message, parts: [{ kind: 'text', text, format: 'text' }] }
          : message,
      ),
    )
  }, [])

  /**
   * Record a spoken user turn. Speech and chat share one conversation, so a
   * voice turn lands in the same transcript a typed one would. When a live
   * caption draft exists it is finalized in place — the polished transcript
   * replaces whatever the last partial pass showed.
   */
  const addVoiceUserMessage = useCallback((text: string) => {
    const draftId = voiceDraftIdRef.current
    voiceDraftIdRef.current = null
    setMessages((current) => {
      if (draftId && current.some((message) => message.id === draftId)) {
        return current.map((message) =>
          message.id === draftId
            ? {
                ...message,
                streaming: false,
                parts: [{ kind: 'text', text, format: 'text' }],
              }
            : message,
        )
      }
      return [
        ...current,
        { id: nextId(), role: 'user', parts: [{ kind: 'text', text, format: 'text' }] },
      ]
    })
  }, [])

  /** Open (or reuse) the assistant message a voice turn streams into. */
  const beginVoiceAssistantTurn = useCallback(() => {
    if (activeIdRef.current) {
      return
    }
    const id = nextId()
    activeIdRef.current = id
    setMessages((current) => [...current, { id, role: 'nova', parts: [], streaming: true }])
  }, [])

  /** Feed a websocket event from the voice path into the active turn. */
  const applyVoiceEvent = useCallback(
    (event: ChatStreamEvent) => {
      beginVoiceAssistantTurn()
      switch (event.type) {
        case 'delta':
          appendPart({ kind: 'text', text: event.text, format: event.format ?? 'markdown' })
          break
        case 'text_final':
          replaceLastText(event.text, event.format ?? 'markdown')
          break
        case 'status_text':
          appendPart({ kind: 'status', text: event.text })
          break
        case 'tool_call':
          appendPart({ kind: 'tool', tool: event.tool, input: event.input })
          if (event.tool === 'assign_conversation_to_project' || event.tool === 'switch_project') {
            void refreshConversation()
          }
          break
        case 'artifact':
          appendPart({
            kind: 'artifact',
            artifact: {
              kind: event.kind,
              title: event.title,
              content: event.content,
              language: event.language,
              tool: event.tool,
              exitCode: event.exitCode,
            },
          })
          break
      }
    },
    [appendPart, beginVoiceAssistantTurn, refreshConversation, replaceLastText],
  )

  const endVoiceAssistantTurn = useCallback((conversationId?: string) => {
    if (conversationId) {
      setConversationId(conversationId)
    }
    const finishedId = activeIdRef.current
    activeIdRef.current = null
    setMessages((current) =>
      current
        .map((message) =>
          message.id === finishedId ? { ...message, streaming: false } : message,
        )
        .filter((message) => message.role !== 'nova' || message.parts.length > 0),
    )
  }, [setConversationId])

  const stopStreaming = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  const startNewConversation = useCallback(async () => {
    const previous = conversationIdRef.current
    if (previous) {
      // Closed conversations are terminal server-side; fire and forget.
      void fetch(`/conversations/${previous}/close`, { method: 'POST' }).catch(() => {})
    }
    conversationIdRef.current = null
    saveConversationId('')
    setMessages([])
    setError('')
    setProject(null)
  }, [])

  return {
    messages,
    isStreaming,
    isLoadingHistory,
    error,
    conversationId: conversationIdRef.current,
    project,
    sendMessage,
    stopStreaming,
    startNewConversation,
    /**
     * Re-read the transcript from the server. Voice turns persist through the
     * websocket path, so the chat view picks them up by refreshing once a
     * spoken turn finishes.
     */
    refreshHistory: loadHistory,
    refreshConversation,
    addVoiceUserMessage,
    updateVoiceDraft,
    applyVoiceEvent,
    endVoiceAssistantTurn,
  }
}
