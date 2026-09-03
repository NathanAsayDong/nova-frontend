/**
 * Acoustic half of turn detection: deciding when the user started and stopped
 * talking, from the microphone level alone.
 *
 * The version this replaces was one comparison against a hardcoded RMS
 * threshold plus a fixed one-second timer. The fixes, each of which earned its
 * place by failing in a real room:
 *
 *  - A fixed threshold only fits one room. The floor here is measured
 *    continuously and the thresholds ride on top of it, so the same code works
 *    on a quiet MacBook and next to a gaming tower's fans.
 *  - Opening and closing use different thresholds (hysteresis), so a voice
 *    hovering near the boundary doesn't flicker between speaking and silent.
 *  - The silence window is variable, driven by the backend's semantic scorer:
 *    a finished sentence ends fast, a trailing-off one gets patience.
 *  - All rate constants are TIME-based, not per-call. The clock driving this
 *    ranges from 25ms ticks on a visible tab to ~1s ticks on a throttled
 *    hidden one (and rAF, which used to drive it, varies 60-144Hz by monitor
 *    and stops entirely when hidden — which left a turn stuck open until the
 *    user refocused the window). Every EMA derives its alpha from the actual
 *    elapsed time.
 *  - Steady sound is not speech. A voice modulates its RMS hard at syllable
 *    rate; a fan, an air vent, or an AGC-boosted hum holds nearly constant.
 *    If "speech" stays statistically flat for a couple of seconds, the
 *    detector calls the turn over and adopts that level as the new noise
 *    floor — the escape hatch for a floor misjudged low, without which a
 *    loud room could hold the gate open forever.
 *
 * The detector is deliberately free of React: it is fed by a timer and reports
 * transitions through callbacks, so a speaking user costs zero re-renders.
 */

/**
 * Floor for the silence window, until the backend says otherwise. Matches the
 * backend's DEFAULT_SILENCE_MS at scale 1.0 — it only governs the moments
 * before the backend's first endpointMs arrives, and the staleness resets.
 */
export const DEFAULT_SILENCE_MS = 1000

/**
 * Level must hold above the open threshold this long before it counts as
 * speech. Rejects clicks, coughs, and a chair scraping.
 */
const MIN_SPEECH_MS = 120

/**
 * Measure the room before trusting the gate.
 *
 * The smoothed level the detector is fed starts at zero and climbs to the
 * room's real value over ~100ms, so the first stretch of samples describes
 * the smoothing filter, not the room. Calibration therefore discards that
 * ramp and averages what remains. (The first version took the minimum over
 * the whole window, which reliably measured the ramp's starting point — a
 * floor of zero on every machine, catastrophic in any room whose ambient
 * noise sits above the absolute minimum thresholds.)
 */
const CALIBRATION_MS = 650
const CALIBRATION_RAMP_SKIP_MS = 250

/**
 * Never let a single turn run longer than this. A stuck-open gate would
 * otherwise record until the tab closed.
 */
const MAX_UTTERANCE_MS = 30_000

/**
 * How much actual speech a turn needs before it is allowed to END.
 *
 * The onset hold (MIN_SPEECH_MS) is enough to reject a click from OPENING a
 * turn, but not enough to make the turn worth submitting: a door closing or a
 * chair scrape clears 120ms easily, then goes quiet, and the silence window
 * expires on ~150ms of noise. That gets transcribed into a garbage one-word
 * turn — which the agent then answers, so it reads as Nova jumping in when
 * nobody addressed it.
 *
 * Accumulated speaking time below this floor means the whole turn was a false
 * trigger: abort it instead of submitting it. Sized under a spoken "yes"
 * (~300ms) so real one-word answers still go through.
 */
const MIN_TURN_SPEECH_MS = 250

/**
 * Steady-noise watchdog. Real speech swings its RMS constantly — syllables
 * modulate it at 4-8Hz, and the mean absolute deviation over any couple of
 * seconds is a large fraction of the mean. A fan or a hum is flat. If a
 * "speaking" state holds this long with relative deviation below the ratio,
 * it is machinery, not a person: end the turn and learn the level as floor.
 */
const STEADY_NOISE_MIN_MS = 2_000
const STEADY_NOISE_DEV_RATIO = 0.13
const STEADY_STATS_TAU_MS = 400

/**
 * Multipliers over the measured noise floor. Open above close: hysteresis.
 *
 * Kept modest because they compound with the floor. A speaking voice sits
 * maybe 6-20dB over room noise, and the low end of that range is where a loud
 * room lands — a multiplier generous enough to feel safe in a quiet office
 * puts the open threshold above the user's actual voice next to an air vent.
 * The absolute margins below do the work in the quiet case instead, where a
 * multiple of a near-zero floor would be near zero.
 */
const OPEN_OVER_FLOOR = 1.8
const CLOSE_OVER_FLOOR = 1.3

/**
 * Absolute margins added on top, so a near-silent room does not end up with
 * thresholds so low that the microphone's own hiss opens the gate.
 */
const OPEN_MARGIN = 0.008
const CLOSE_MARGIN = 0.004

/** Bounds on the thresholds regardless of what the floor is doing. */
const MIN_OPEN_LEVEL = 0.015
const MIN_CLOSE_LEVEL = 0.01
const MAX_OPEN_LEVEL = 0.25

/**
 * Noise-floor tracking time constants. Asymmetric on purpose: the floor
 * follows a room getting quieter quickly, and a room getting louder slowly,
 * so a talker in a gap between sentences cannot drag the floor up to meet
 * their own voice before the gate has a chance to open.
 */
const FLOOR_FALL_TAU_MS = 90
const FLOOR_RISE_TAU_MS = 700

export type TurnEndReason = 'silence' | 'max_duration' | 'steady_noise'

export type TurnDetectorCallbacks = {
  /**
   * Level just crossed the open threshold — MAYBE speech. Fired before the
   * onset hold confirms it, so the recorder can start immediately: waiting
   * for confirmation would clip the first syllable off every utterance.
   * Followed by either onSpeechStart (real) or onSpeechAbort (a click).
   */
  onSpeechOnset?: () => void
  /** The onset was too brief to be speech. Undo whatever onset started. */
  onSpeechAbort?: () => void
  /** Speech began: the user is starting a turn. */
  onSpeechStart: () => void
  /** Speech stopped and the silence countdown has begun. */
  onSpeechPause: () => void
  /** Speech came back before the countdown expired: it was a pause, not an end. */
  onSpeechResume: () => void
  /** The turn is over — silence outlasted the window, or the sound wasn't a voice. */
  onTurnEnd: (reason: TurnEndReason) => void
  /** Speaking / not speaking changed, for the UI. Fires only on transitions. */
  onSpeakingChange?: (speaking: boolean) => void
}

export type TurnDetector = {
  /** Feed one level sample. `level` is smoothed RMS in 0..1, `now` in ms. */
  push: (level: number, now: number) => void
  /**
   * Set how long silence must last to end the turn. Driven by the backend's
   * endpointing scorer, which revises it on every live caption.
   */
  setSilenceWindow: (ms: number) => void
  /** Forget the turn in progress. Keeps the learned noise floor. */
  reset: () => void
  /** Current thresholds and state, for debugging. */
  snapshot: () => {
    state: DetectorState
    noiseFloor: number
    openThreshold: number
    closeThreshold: number
    silenceWindowMs: number
  }
}

type DetectorState =
  /** Measuring the room. The gate cannot open yet. */
  | 'calibrating'
  /** No speech. The noise floor is being learned. */
  | 'idle'
  /** Level is above the open threshold but has not held long enough yet. */
  | 'onset'
  /** Speech in progress. */
  | 'speaking'
  /** Speech stopped; the silence window is running. */
  | 'trailing'
  /**
   * A turn was force-ended (duration cap or steady-noise verdict). Waiting
   * for the level to actually drop below the close threshold before arming
   * again, so the same sound cannot immediately re-open a turn.
   */
  | 'cooldown'

/** EMA weight for a step of `dt` toward a time constant of `tau`. */
const alphaFor = (dtMs: number, tauMs: number) => 1 - Math.exp(-dtMs / tauMs)

export function createTurnDetector(callbacks: TurnDetectorCallbacks): TurnDetector {
  let state: DetectorState = 'calibrating'
  // A seed, not an assumption: calibration replaces it with a measurement of
  // the room actually in front of the mic.
  let noiseFloor = 0.004
  let lastPushAt: number | null = null
  let calibrationStartedAt: number | null = null
  let calibrationSum = 0
  let calibrationSamples = 0
  let onsetStartedAt = 0
  let speechStartedAt = 0
  // Speaking time accumulated across this whole turn, pauses excluded. A turn
  // spans multiple speaking stretches when the user pauses mid-sentence, so
  // this resets per TURN (at onset), not per stretch.
  let speechAccumMs = 0
  let silenceStartedAt = 0
  let silenceWindowMs = DEFAULT_SILENCE_MS
  let speakingReported = false
  // Steady-noise watchdog stats, reset on every entry into 'speaking'.
  let steadySince = 0
  let steadyMean = 0
  let steadyDeviation = 0

  const openThreshold = () =>
    Math.min(
      MAX_OPEN_LEVEL,
      Math.max(MIN_OPEN_LEVEL, noiseFloor * OPEN_OVER_FLOOR + OPEN_MARGIN),
    )

  const closeThreshold = () =>
    Math.max(MIN_CLOSE_LEVEL, noiseFloor * CLOSE_OVER_FLOOR + CLOSE_MARGIN)

  const reportSpeaking = (speaking: boolean) => {
    if (speaking === speakingReported) {
      return
    }
    speakingReported = speaking
    callbacks.onSpeakingChange?.(speaking)
  }

  const trackNoiseFloor = (level: number, dt: number) => {
    // Only while not in a turn: adapting during speech would teach the floor
    // the user's voice.
    const tau = level < noiseFloor ? FLOOR_FALL_TAU_MS : FLOOR_RISE_TAU_MS
    noiseFloor += (level - noiseFloor) * alphaFor(dt, tau)
  }

  const enterSpeaking = (now: number, startedAt: number) => {
    state = 'speaking'
    speechStartedAt = startedAt
    steadySince = now
    steadyMean = 0
    steadyDeviation = 0
  }

  const updateSteadyStats = (level: number, dt: number) => {
    const alpha = alphaFor(dt, STEADY_STATS_TAU_MS)
    if (steadyMean === 0) {
      // First sample after entering speaking: seed the deviation high so the
      // verdict needs sustained flatness, not just a quiet first moment.
      steadyMean = level
      steadyDeviation = level * 0.5
      return
    }
    steadyMean += (level - steadyMean) * alpha
    steadyDeviation += (Math.abs(level - steadyMean) - steadyDeviation) * alpha
  }

  const isSteadyNoise = (now: number) =>
    now - steadySince >= STEADY_NOISE_MIN_MS &&
    steadyDeviation < steadyMean * STEADY_NOISE_DEV_RATIO

  const endAsSteadyNoise = () => {
    // Machinery, not a person. Learn the hum as the floor so the thresholds
    // climb above it and the gate cannot immediately re-open on it.
    noiseFloor = Math.max(noiseFloor, steadyMean)
    state = 'cooldown'
    reportSpeaking(false)
    callbacks.onTurnEnd('steady_noise')
  }

  const push = (level: number, now: number) => {
    const dt = lastPushAt === null ? 25 : Math.max(1, now - lastPushAt)
    lastPushAt = now

    const open = openThreshold()
    const close = closeThreshold()

    switch (state) {
      case 'calibrating': {
        if (calibrationStartedAt === null) {
          calibrationStartedAt = now
        }
        const elapsed = now - calibrationStartedAt
        if (elapsed >= CALIBRATION_RAMP_SKIP_MS) {
          calibrationSum += level
          calibrationSamples += 1
        }
        if (elapsed >= CALIBRATION_MS) {
          if (calibrationSamples > 0) {
            noiseFloor = calibrationSum / calibrationSamples
          }
          state = 'idle'
        }
        return
      }

      case 'cooldown': {
        trackNoiseFloor(level, dt)
        if (level <= close) {
          state = 'idle'
        }
        return
      }

      case 'idle': {
        trackNoiseFloor(level, dt)
        if (level > open) {
          state = 'onset'
          onsetStartedAt = now
          speechAccumMs = 0
          // A fresh utterance: whatever window the last caption left behind
          // describes speech that is over. Start neutral.
          silenceWindowMs = DEFAULT_SILENCE_MS
          callbacks.onSpeechOnset?.()
        }
        return
      }

      case 'onset': {
        if (level <= close) {
          // Too brief to be speech — a click or a knock.
          state = 'idle'
          trackNoiseFloor(level, dt)
          callbacks.onSpeechAbort?.()
          return
        }
        if (now - onsetStartedAt >= MIN_SPEECH_MS) {
          // The onset window was speech too — it was above the open threshold
          // the whole time, which is what confirmed it. Bank it, or a real
          // one-word answer ("yes", ~350ms) banks only the ~230ms after
          // confirmation and gets discarded as a false trigger.
          speechAccumMs += now - onsetStartedAt
          enterSpeaking(now, onsetStartedAt)
          reportSpeaking(true)
          callbacks.onSpeechStart()
        }
        return
      }

      case 'speaking': {
        speechAccumMs += dt
        updateSteadyStats(level, dt)
        if (isSteadyNoise(now)) {
          endAsSteadyNoise()
          return
        }
        if (now - speechStartedAt >= MAX_UTTERANCE_MS) {
          state = 'cooldown'
          reportSpeaking(false)
          callbacks.onTurnEnd('max_duration')
          return
        }
        if (level < close) {
          state = 'trailing'
          silenceStartedAt = now
          reportSpeaking(false)
          callbacks.onSpeechPause()
        }
        return
      }

      case 'trailing': {
        if (level > open) {
          // A pause inside a sentence, not the end of one. New words also
          // invalidate any SHORTENED window a caption granted — the caption
          // has not seen them, so "that sentence was complete" no longer
          // holds. A lengthened window (a known dangle) keeps its hold until
          // a fresher caption rules on the new words.
          const startedAt = speechStartedAt
          enterSpeaking(now, startedAt)
          silenceWindowMs = Math.max(silenceWindowMs, DEFAULT_SILENCE_MS)
          reportSpeaking(true)
          callbacks.onSpeechResume()
          return
        }
        if (now - speechStartedAt >= MAX_UTTERANCE_MS) {
          state = 'cooldown'
          callbacks.onTurnEnd('max_duration')
          return
        }
        if (now - silenceStartedAt >= silenceWindowMs) {
          state = 'idle'
          if (speechAccumMs < MIN_TURN_SPEECH_MS) {
            // Not enough speech in the whole turn to be a real utterance.
            // Discard rather than hand the backend a scrape to transcribe.
            callbacks.onSpeechAbort?.()
            return
          }
          callbacks.onTurnEnd('silence')
        }
        return
      }
    }
  }

  return {
    push,
    setSilenceWindow: (ms: number) => {
      if (Number.isFinite(ms) && ms > 0) {
        silenceWindowMs = ms
      }
    },
    reset: () => {
      // Keeps the learned floor — it describes the room, not the turn. A
      // calibrated detector stays calibrated; one interrupted mid-calibration
      // finishes it.
      state = state === 'calibrating' ? 'calibrating' : 'idle'
      silenceWindowMs = DEFAULT_SILENCE_MS
      reportSpeaking(false)
    },
    snapshot: () => ({
      state,
      noiseFloor,
      openThreshold: openThreshold(),
      closeThreshold: closeThreshold(),
      silenceWindowMs,
    }),
  }
}
