/**
 * Acoustic half of turn detection: deciding when the user started and stopped
 * talking, from the microphone level alone.
 *
 * The version this replaces was one comparison against a hardcoded RMS
 * threshold plus a fixed one-second timer. Three things were wrong with it:
 *
 *  - A fixed threshold only fits one room. Below the room's own noise floor it
 *    hears speech constantly; far above it, a quiet voice never registers.
 *    The floor here is measured continuously and the thresholds ride on top of
 *    it, so the same code works in a quiet office and next to a fan.
 *  - One threshold for both starting and stopping makes the boundary chatter:
 *    a voice hovering near it flickers between speaking and silent several
 *    times a second. Opening and closing on different thresholds (hysteresis)
 *    is the standard fix, and it is why an unvoiced consonant no longer reads
 *    as the end of a sentence.
 *  - A fixed silence timeout cannot be right, because how long a pause means
 *    "finished" depends on what was being said. That half of the decision is
 *    semantic and lives on the backend; this detector just applies whatever
 *    window it is currently given, and the backend revises that window on
 *    every live caption.
 *
 * The detector is deliberately free of React: it is driven from the analyser's
 * animation frame and reports transitions through callbacks, so a speaking
 * user costs zero re-renders. The old implementation ran the decision inside a
 * `useEffect` keyed on an audio-level state value, which re-rendered the whole
 * runtime roughly sixty times a second while listening.
 */

/** Floor for the silence window, until the backend says otherwise. */
export const DEFAULT_SILENCE_MS = 700

/**
 * Level must hold above the open threshold this long before it counts as
 * speech. Rejects clicks, coughs, and a chair scraping.
 */
const MIN_SPEECH_MS = 120

/**
 * Measure the room before trusting the gate.
 *
 * The floor is learned from frames the detector believes are silence, and it
 * stops learning during a turn so that a talker cannot teach it their own
 * voice. Those two rules together have a cold start: open the microphone in a
 * room whose noise already sits above the seeded floor and the gate latches
 * open on the noise, at which point the floor never gets a chance to catch up.
 * So the gate stays shut for the first stretch of every stream and the floor
 * is measured with nothing at stake.
 */
const CALIBRATION_MS = 400

/**
 * Never let a single turn run longer than this. A stuck-open gate would
 * otherwise record until the tab closed.
 */
const MAX_UTTERANCE_MS = 30_000

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
const MIN_OPEN_LEVEL = 0.012
const MIN_CLOSE_LEVEL = 0.007
const MAX_OPEN_LEVEL = 0.25

/**
 * Noise-floor tracking rates, per frame. Asymmetric on purpose: the floor
 * follows a room getting quieter quickly, and a room getting louder slowly, so
 * a talker in a gap between sentences cannot drag the floor up to meet their
 * own voice before the gate has a chance to open.
 */
const FLOOR_FALL_RATE = 0.2
const FLOOR_RISE_RATE = 0.02

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
  /** Silence outlasted the current window: the turn is over. */
  onTurnEnd: (reason: 'silence' | 'max_duration') => void
  /** Speaking / not speaking changed, for the UI. Fires only on transitions. */
  onSpeakingChange?: (speaking: boolean) => void
}

export type TurnDetector = {
  /** Feed one analyser frame. `level` is smoothed RMS in 0..1. */
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
   * A turn was force-ended at the duration cap. Waiting for the level to
   * actually drop before arming again, so steady noise loud enough to hold the
   * gate open cannot re-open a turn every thirty seconds forever.
   */
  | 'cooldown'

export function createTurnDetector(callbacks: TurnDetectorCallbacks): TurnDetector {
  let state: DetectorState = 'calibrating'
  // A seed, not an assumption: the first CALIBRATION_MS of every stream
  // replace it with a measurement of the room actually in front of the mic.
  let noiseFloor = 0.004
  let calibrationStartedAt: number | null = null
  let onsetStartedAt = 0
  let speechStartedAt = 0
  let silenceStartedAt = 0
  let silenceWindowMs = DEFAULT_SILENCE_MS
  let speakingReported = false

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

  const trackNoiseFloor = (level: number) => {
    // Only while not in a turn: adapting during speech would teach the floor
    // the user's voice.
    const rate = level < noiseFloor ? FLOOR_FALL_RATE : FLOOR_RISE_RATE
    noiseFloor += (level - noiseFloor) * rate
  }

  const push = (level: number, now: number) => {
    const open = openThreshold()
    const close = closeThreshold()

    switch (state) {
      case 'calibrating': {
        if (calibrationStartedAt === null) {
          calibrationStartedAt = now
          noiseFloor = level
        }
        // The quietest thing heard, not the average. The floor is by
        // definition the quiet part, and a minimum cannot overestimate it —
        // which matters when the mic happens to open while someone is already
        // talking. Real speech dips between phonemes, so even then the
        // minimum lands nearer the room than the voice.
        noiseFloor = Math.min(noiseFloor, level)
        if (now - calibrationStartedAt >= CALIBRATION_MS) {
          state = 'idle'
        }
        return
      }

      case 'cooldown': {
        trackNoiseFloor(level)
        if (level <= close) {
          state = 'idle'
        }
        return
      }

      case 'idle': {
        trackNoiseFloor(level)
        if (level > open) {
          state = 'onset'
          onsetStartedAt = now
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
          trackNoiseFloor(level)
          callbacks.onSpeechAbort?.()
          return
        }
        if (now - onsetStartedAt >= MIN_SPEECH_MS) {
          state = 'speaking'
          speechStartedAt = onsetStartedAt
          reportSpeaking(true)
          callbacks.onSpeechStart()
        }
        return
      }

      case 'speaking': {
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
          state = 'speaking'
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
