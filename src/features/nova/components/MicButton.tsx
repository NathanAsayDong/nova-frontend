type MicButtonProps = {
  isNovaEnabled: boolean
  showMicEnableButton: boolean
  onRetry: () => void
  /**
   * The browser refused to play Nova's voice because nothing has been tapped
   * yet (iOS Safari). The button's tap is what makes the next reply audible.
   */
  needsSoundUnlock?: boolean
  onEnableSound?: () => void
}

/**
 * Mic and sound affordances in the composer: they only appear when the
 * microphone or the speaker actually needs a tap. Speech feedback itself
 * lives in the ambient aura backdrop.
 */
export function MicButton({
  isNovaEnabled,
  showMicEnableButton,
  onRetry,
  needsSoundUnlock = false,
  onEnableSound,
}: MicButtonProps) {
  if (!showMicEnableButton && !needsSoundUnlock) {
    return null
  }

  return (
    <>
      {showMicEnableButton ? (
        <button
          type="button"
          className="micRetry"
          onClick={onRetry}
          disabled={!isNovaEnabled}
          title="Reconnect microphone"
        >
          Enable mic
        </button>
      ) : null}
      {needsSoundUnlock ? (
        <button
          type="button"
          className="micRetry"
          onClick={onEnableSound}
          title="Your browser needs a tap before it will play Nova's voice"
        >
          Enable sound
        </button>
      ) : null}
    </>
  )
}
