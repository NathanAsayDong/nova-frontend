import { useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ChatMessage as ChatMessageModel } from '../chatTypes'
import { ChatMessage } from './ChatMessage'

type ConversationPanelProps = {
  messages: ChatMessageModel[]
  isStreaming: boolean
  isLoadingHistory: boolean
  error: string
  /** Voice indicator, rendered inside the composer. */
  voiceSlot?: ReactNode
  onSend: (text: string) => void
  onStop: () => void
}

export function ConversationPanel({
  messages,
  isStreaming,
  isLoadingHistory,
  error,
  voiceSlot,
  onSend,
  onStop,
}: ConversationPanelProps) {
  const [draft, setDraft] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const pinnedToBottomRef = useRef(true)

  // Only autoscroll when already at the bottom, so scrolling up to read
  // earlier messages isn't yanked away by incoming tokens.
  const handleScroll = () => {
    const el = scrollRef.current
    if (!el) {
      return
    }
    pinnedToBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && pinnedToBottomRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [messages])

  const submit = () => {
    const text = draft.trim()
    if (!text || isStreaming) {
      return
    }
    onSend(text)
    setDraft('')
  }

  return (
    <section className="conversationPanel">
      <div className="conversationScroll" ref={scrollRef} onScroll={handleScroll}>
        {isLoadingHistory ? <p className="conversationNotice">Loading history…</p> : null}

        {/* Empty state: hint and any error sit together, centered. */}
        {!isLoadingHistory && messages.length === 0 ? (
          <div className="conversationEmpty">
            <p className="conversationNotice">
              Talk to Nova or type below — speech and chat share the same conversation.
            </p>
            {error ? <p className="conversationError">{error}</p> : null}
          </div>
        ) : null}

        {messages.map((message) => (
          <ChatMessage key={message.id} message={message} />
        ))}

        {/* Mid-conversation errors stay in the flow, under the messages. */}
        {messages.length > 0 && error ? <p className="conversationError">{error}</p> : null}
      </div>

      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        {voiceSlot}

        <textarea
          className="composerInput"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends, Shift+Enter makes a newline.
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              submit()
            }
          }}
          placeholder="Message Nova…"
          rows={2}
        />

        {isStreaming ? (
          <button type="button" className="composerButton stop" onClick={onStop}>
            Stop
          </button>
        ) : (
          <button type="submit" className="composerButton" disabled={!draft.trim()}>
            Send
          </button>
        )}
      </form>
    </section>
  )
}
