import type { UiPhase } from '../types'

type AuraBackdropProps = {
  uiPhase: UiPhase
  isNovaEnabled: boolean
  /** Live audio level, 0..1 — makes the backdrop bloom as it hears speech. */
  voiceLevel: number
  /** True while a typed turn is streaming, so chat lights up the same way. */
  isStreaming: boolean
}

/**
 * Soft green blobs drifting behind the conversation.
 *
 * Replaces the rigid rim glow: the blobs breathe on their own so the app
 * feels alive, and swell with the live audio level while Nova is engaged.
 */
export function AuraBackdrop({
  uiPhase,
  isNovaEnabled,
  voiceLevel,
  isStreaming,
}: AuraBackdropProps) {
  const phase = isStreaming && uiPhase === 'idle' ? 'thinking' : uiPhase
  const state = isNovaEnabled ? phase : 'off'

  return (
    <div
      className={`aura state-${state}`}
      style={{ ['--voice-level' as string]: voiceLevel.toFixed(3) }}
      aria-hidden="true"
    >
      <span className="auraBlob blob-a" />
      <span className="auraBlob blob-b" />
      <span className="auraBlob blob-c" />
    </div>
  )
}
