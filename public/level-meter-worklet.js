/**
 * Amplitude meter that runs on the audio rendering thread.
 *
 * The face tab (and the aura) need Nova's speaking level even when the app
 * tab is hidden — requestAnimationFrame stalls in background tabs, but the
 * audio thread keeps rendering as long as sound is playing. Audio passes
 * through unchanged; a smoothed RMS is posted out roughly every 46ms.
 */
class LevelMeterProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this._sumSquares = 0
    this._sampleCount = 0
  }

  process(inputs, outputs) {
    const input = inputs[0]
    const output = outputs[0]

    if (input && input.length > 0) {
      for (let channel = 0; channel < input.length; channel += 1) {
        const inChannel = input[channel]
        const outChannel = output[channel] || output[0]
        if (outChannel) {
          outChannel.set(inChannel)
        }
        if (channel === 0) {
          for (let i = 0; i < inChannel.length; i += 1) {
            this._sumSquares += inChannel[i] * inChannel[i]
          }
          this._sampleCount += inChannel.length
        }
      }
    }

    if (this._sampleCount >= 2048) {
      const rms = Math.sqrt(this._sumSquares / this._sampleCount)
      // Same amplification the old analyser used, so the aura feels identical.
      this.port.postMessage(Math.min(1, rms * 4.4))
      this._sumSquares = 0
      this._sampleCount = 0
    }

    return true
  }
}

registerProcessor('level-meter', LevelMeterProcessor)
