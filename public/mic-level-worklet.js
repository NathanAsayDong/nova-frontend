/**
 * Microphone level for the turn detector, measured on the audio thread.
 *
 * The detector used to be fed from a 25ms setInterval reading an
 * AnalyserNode. Chrome throttles timers in hidden tabs — after five minutes
 * hidden, to about one wake-up a minute — so a Sentry tab left in the
 * background heard "Hey Nova" (the speech recognizer is event-driven) but its
 * detector was too starved to notice the request that followed. The audio
 * thread is not throttled, and messages it posts are not timers, so the
 * detector keeps its cadence however long the tab sits hidden.
 *
 * Posts the plain RMS of each ~1024-sample window (about 21ms at 48kHz, the
 * same window the analyser read), so the detector's tuning is unchanged.
 */
class MicLevelProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this._sumSquares = 0
    this._sampleCount = 0
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (channel) {
      for (let i = 0; i < channel.length; i += 1) {
        this._sumSquares += channel[i] * channel[i]
      }
      this._sampleCount += channel.length
    }

    if (this._sampleCount >= 1024) {
      this.port.postMessage(Math.sqrt(this._sumSquares / this._sampleCount))
      this._sumSquares = 0
      this._sampleCount = 0
    }

    return true
  }
}

registerProcessor('mic-level', MicLevelProcessor)
