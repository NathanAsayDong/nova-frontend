/**
 * Nova's interface sounds, synthesized rather than shipped as files.
 *
 * Each one is a couple of soft bell-like notes: a sine with a faint octave
 * overtone, a fast attack and an exponential tail, so they read as chimes
 * and not as beeps. Built at play time, they start instantly (no file to
 * fetch or decode) and are easy to retune here.
 *
 *  - wake:   a rising fifth. "I heard you, go ahead."
 *  - done:   the same fifth falling. "Finished, back to waiting."
 *  - cancel: one low, quiet note. "Never mind" — woken with nothing asked,
 *            or a stop phrase.
 */

export type Earcon = 'wake' | 'done' | 'cancel'

type Note = { freq: number; at: number; length: number; gain: number }

const E5 = 659.25
const B5 = 987.77
const A4 = 440
const E4 = 329.63

const EARCONS: Record<Earcon, Note[]> = {
  wake: [
    { freq: E5, at: 0, length: 0.32, gain: 0.16 },
    { freq: B5, at: 0.085, length: 0.42, gain: 0.14 },
  ],
  done: [
    { freq: B5, at: 0, length: 0.3, gain: 0.11 },
    { freq: E5, at: 0.11, length: 0.5, gain: 0.12 },
  ],
  cancel: [
    { freq: A4, at: 0, length: 0.22, gain: 0.08 },
    { freq: E4, at: 0.09, length: 0.38, gain: 0.08 },
  ],
}

let context: AudioContext | null = null

function getContext(): AudioContext | null {
  if (!context) {
    try {
      context = new window.AudioContext()
    } catch {
      return null
    }
  }
  return context
}

/**
 * Create or resume the context. Browsers only allow that inside a user
 * gesture, so the runtime calls this from the same taps that unlock Nova's
 * voice; afterwards earcons can play on their own.
 */
export function primeEarcons(): void {
  const ctx = getContext()
  if (ctx && ctx.state === 'suspended') {
    void ctx.resume().catch(() => {})
  }
}

export function playEarcon(name: Earcon): void {
  const ctx = getContext()
  if (!ctx) {
    return
  }
  if (ctx.state === 'suspended') {
    // Not unlocked yet; try anyway, the sound is a nicety.
    void ctx.resume().catch(() => {})
  }

  const start = ctx.currentTime + 0.01
  for (const note of EARCONS[name]) {
    const t0 = start + note.at
    const envelope = ctx.createGain()
    envelope.gain.setValueAtTime(0.0001, t0)
    envelope.gain.exponentialRampToValueAtTime(note.gain, t0 + 0.012)
    envelope.gain.exponentialRampToValueAtTime(0.0001, t0 + note.length)
    envelope.connect(ctx.destination)

    // Fundamental plus a quiet octave: the overtone is what makes it a bell.
    for (const [multiple, level] of [[1, 1], [2, 0.18]] as const) {
      const osc = ctx.createOscillator()
      const partial = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(note.freq * multiple, t0)
      partial.gain.value = level
      osc.connect(partial)
      partial.connect(envelope)
      osc.start(t0)
      osc.stop(t0 + note.length + 0.05)
    }
  }
}
