type MicButtonProps = {
  isNovaEnabled: boolean
  showMicEnableButton: boolean
  onRetry: () => void
}

/**
 * Mic affordance in the composer: only appears when the microphone actually
 * needs attention. Speech feedback itself lives in the ambient aura backdrop.
 */
export function MicButton({ isNovaEnabled, showMicEnableButton, onRetry }: MicButtonProps) {
  if (!showMicEnableButton) {
    return null
  }

  return (
    <button
      type="button"
      className="micRetry"
      onClick={onRetry}
      disabled={!isNovaEnabled}
      title="Reconnect microphone"
    >
      Enable mic
    </button>
  )
}
