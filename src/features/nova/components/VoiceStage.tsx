import type { CSSProperties } from 'react'
import type { UiPhase } from '../types'

type VoiceStageProps = {
  uiPhase: UiPhase
  visualAudioLevel: number
  combinedVoiceLevel: number
  hasSpeechInput: boolean
  assistantText: string
  showMicEnableButton: boolean
  isNovaEnabled: boolean
  onRetry: () => void
}

export function VoiceStage({
  uiPhase,
  visualAudioLevel,
  combinedVoiceLevel,
  hasSpeechInput,
  assistantText,
  showMicEnableButton,
  isNovaEnabled,
  onRetry,
}: VoiceStageProps) {
  const stageStyle = {
    ['--audio-level' as string]: visualAudioLevel.toFixed(3),
    ['--voice-scale-level' as string]: combinedVoiceLevel.toFixed(3),
  } as CSSProperties

  return (
    <section className={`voiceStage phase-${uiPhase}`} style={stageStyle}>
      <div className="stageHeader">
        <p className="eyebrow">Nova Agent Interface</p>
        <h1>NOVA</h1>
      </div>

      <div className={`orb ${hasSpeechInput ? 'active' : ''} ${uiPhase}`} aria-hidden="true">
        <span className="novaGifWrap">
          <img className="novaGif" src="/nova.gif" alt="Nova visualizer" />
        </span>
      </div>

      {assistantText ? (
        <div className="assistantBubble">
          <p className="statusLine">{assistantText}</p>
        </div>
      ) : null}

      {showMicEnableButton ? (
        <button type="button" className="initButton" disabled={!isNovaEnabled} onClick={onRetry}>
          Retry Nova
        </button>
      ) : null}

      <p className="signalTag">Voice Link: {uiPhase.toUpperCase()}</p>
    </section>
  )
}
