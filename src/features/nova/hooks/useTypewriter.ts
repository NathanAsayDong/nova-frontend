import { useEffect, useRef, useState } from 'react'

/**
 * Reveal text a character at a time as it arrives.
 *
 * The backend streams sentence-sized chunks, so text would otherwise appear in
 * visible jumps. This keeps a target string and walks the rendered string
 * toward it on each animation frame, which reads as continuous typing even
 * though the transport is chunky.
 *
 * When `enabled` goes false (the turn finished) mid-animation, the remaining
 * text types out at a faster catch-up pace rather than snapping in all at
 * once. Text that was never animated (history loads, completed parts) still
 * shows immediately — nobody should wait on an animation to read old replies.
 */
export function useTypewriter(target: string, enabled: boolean, charsPerSecond = 60) {
  const [shown, setShown] = useState(enabled ? '' : target)
  const frameRef = useRef<number | null>(null)
  const shownLengthRef = useRef(shown.length)
  const lastTickRef = useRef(0)
  const everEnabledRef = useRef(enabled)
  // Fractional characters carried between frames, so the pace stays the same
  // on 60Hz and 120Hz displays (never "at least one char per frame").
  const carryRef = useRef(0)

  useEffect(() => {
    if (enabled) {
      everEnabledRef.current = true
    }

    const caughtUp = shownLengthRef.current >= target.length
    if (!enabled && (!everEnabledRef.current || caughtUp)) {
      shownLengthRef.current = target.length
      setShown(target)
      return
    }

    // The text only ever grows; a shorter target means a new turn started.
    if (target.length < shownLengthRef.current) {
      shownLengthRef.current = 0
    }

    // Once the turn is over there's nothing left to pace against, so finish
    // the reveal briskly instead of making the reader wait.
    const speed = enabled ? charsPerSecond : charsPerSecond * 3

    const step = (timestamp: number) => {
      if (!lastTickRef.current) {
        lastTickRef.current = timestamp
      }
      const elapsed = (timestamp - lastTickRef.current) / 1000
      lastTickRef.current = timestamp

      if (shownLengthRef.current < target.length) {
        carryRef.current += speed * elapsed
        const advance = Math.floor(carryRef.current)
        if (advance > 0) {
          carryRef.current -= advance
          shownLengthRef.current = Math.min(target.length, shownLengthRef.current + advance)
          setShown(target.slice(0, shownLengthRef.current))
        }
      } else if (!enabled) {
        // Catch-up finished; no new chunks are coming.
        frameRef.current = null
        return
      }

      frameRef.current = requestAnimationFrame(step)
    }

    frameRef.current = requestAnimationFrame(step)
    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current)
      }
      lastTickRef.current = 0
    }
  }, [target, enabled, charsPerSecond])

  return shown
}
