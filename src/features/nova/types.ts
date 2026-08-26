export type UiPhase = 'idle' | 'listening' | 'thinking' | 'responding'

export type CapturePurpose = 'none' | 'turn' | 'wake_check'

export type SpeechRecognitionLike = {
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((event: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
  onend: (() => void) | null
  onerror: ((event: { error?: string }) => void) | null
  start: () => void
  stop: () => void
}

export type SocketEvent =
  | { type: 'ready'; message: string }
  // `endpointMs` is the starting silence window for the turn, before any
  // transcript exists to score. Owned by the backend so the windows have a
  // single source of truth.
  | { type: 'listening'; message: string; endpointMs?: number }
  | { type: 'chunk_received'; count: number; bytes: number }
  | {
      type: 'assistant_audio_stream_start'
      streamId: string
      mimeType: string
      role: 'progress' | 'status' | 'final' | 'wake'
      iteration?: number
    }
  | {
      type: 'assistant_audio_stream_chunk'
      streamId: string
      chunkBase64: string
      seq: number
    }
  | { type: 'assistant_audio_stream_end'; streamId: string }
  | { type: 'wake_greeting_done'; message: string }
  | { type: 'wake_not_detected'; message: string }
  | { type: 'follow_up_stopped'; message: string }
  | { type: 'no_speech'; message: string }
  | {
      type: 'assistant_text'
      text: string
      seq: number
      conversationId: string
      markdownDisplay?: string
    }
  | {
      type: 'done'
      message: string
      conversationId: string
      assistantText: string
      markdownDisplay?: string
    }
  | { type: 'error'; message: string; code?: string }
  | { type: 'pong' }
  // Speech and chat share one conversation, so the socket carries the same
  // structured turn events the chat stream does.
  // Live caption, plus the revised silence window for the utterance so far:
  // how long the client should wait out silence before calling the turn over,
  // given what has been said. Short for a finished sentence, long for one that
  // trails off mid-thought. `endpointReason` is the evidence, for debugging.
  | {
      type: 'partial_transcript'
      text: string
      seq: number
      endpointMs?: number
      endpointReason?: string
    }
  | { type: 'user_transcript'; text: string; conversationId: string }
  | { type: 'text_final'; text: string; format?: string; conversationId: string }
  // Pre-tool acknowledgment: spoken via the TTS stream and shown as a
  // lightweight status line in the transcript.
  | { type: 'status_text'; text: string; conversationId: string }
  | {
      type: 'tool_call'
      tool: string
      input: Record<string, unknown>
      conversationId: string
    }
  | {
      type: 'artifact'
      kind: 'diff' | 'file' | 'terminal'
      title: string
      content: string
      language?: string
      tool?: string
      exitCode?: number | null
      conversationId: string
    }

export type ToolSummary = {
  name: string
  description: string
  enabled: boolean
  handler_id: string
  json_schema: Record<string, unknown>
}

export type AudioQueueItem = { kind: 'stream'; streamId: string }

export type StreamAudioBuffer = {
  streamId: string
  mimeType: string
  role: 'progress' | 'status' | 'final' | 'wake'
  chunks: ArrayBuffer[]
  ended: boolean
  waiters: Array<() => void>
}
