export type UiPhase = 'idle' | 'listening' | 'thinking' | 'responding'

export type CapturePurpose = 'none' | 'turn' | 'wake_check'

export type SpeechRecognitionLike = {
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((event: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
  onend: (() => void) | null
  onerror: (() => void) | null
  start: () => void
  stop: () => void
}

export type SocketEvent =
  | { type: 'ready'; message: string }
  | { type: 'listening'; message: string }
  | { type: 'chunk_received'; count: number; bytes: number }
  | {
      type: 'assistant_audio_stream_start'
      streamId: string
      mimeType: string
      role: 'progress' | 'final' | 'wake'
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
  | { type: 'error'; message: string }
  | { type: 'pong' }

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
  role: 'progress' | 'final' | 'wake'
  chunks: ArrayBuffer[]
  ended: boolean
  waiters: Array<() => void>
}
