import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { FaceMode } from '../features/face/faceTypes'

type FaceProps = {
  mode: FaceMode
  /** Live speaking level, 0..1, written by the socket at ~20Hz. */
  levelRef: RefObject<number>
}

// Quantized mouth shapes: discrete steps read as cartoon lip sync, a
// continuous height reads as a VU meter.
const MOUTH_HEIGHTS = [12, 48, 98, 150]
const MOUTH_WIDTHS = [252, 248, 234, 222]
const MOUTH_CENTER_X = 500
const MOUTH_CENTER_Y = 685

/**
 * Nova's gamified face: black screen, green square eyes, green mouth.
 *
 * Expressions come from the published mode; only the talking mouth is
 * animated in JS (fast attack / slow release smoothing on the level, then
 * snapped to one of four shapes). Everything else — blinks, breathing,
 * glances, the thinking wander — is CSS driven by the mode class.
 */
export function Face({ mode, levelRef }: FaceProps) {
  const talkMouthRef = useRef<SVGRectElement>(null)
  const [isBlinking, setIsBlinking] = useState(false)

  // Random blinks while the face is awake.
  useEffect(() => {
    if (mode === 'off') {
      return
    }

    let openTimer: number | null = null
    let closeTimer: number | null = null

    const schedule = () => {
      openTimer = window.setTimeout(() => {
        setIsBlinking(true)
        closeTimer = window.setTimeout(() => {
          setIsBlinking(false)
          schedule()
        }, 130)
      }, 2800 + Math.random() * 4200)
    }

    schedule()
    return () => {
      if (openTimer !== null) clearTimeout(openTimer)
      if (closeTimer !== null) clearTimeout(closeTimer)
      setIsBlinking(false)
    }
  }, [mode])

  // Drive the talking mouth straight from the level ref — this tab is the
  // visible one, so requestAnimationFrame is reliable here.
  useEffect(() => {
    if (mode !== 'talking') {
      return
    }

    let frame: number | null = null
    let smoothed = 0

    const tick = () => {
      const raw = levelRef.current ?? 0
      // Fast attack so consonants pop, slow release so decays feel natural.
      smoothed += (raw - smoothed) * (raw > smoothed ? 0.5 : 0.16)

      const step = smoothed < 0.05 ? 0 : smoothed < 0.18 ? 1 : smoothed < 0.4 ? 2 : 3
      const rect = talkMouthRef.current
      if (rect) {
        const height = MOUTH_HEIGHTS[step]
        const width = MOUTH_WIDTHS[step]
        rect.style.width = `${width}px`
        rect.style.height = `${height}px`
        rect.style.x = `${MOUTH_CENTER_X - width / 2}px`
        rect.style.y = `${MOUTH_CENTER_Y - height / 2}px`
        rect.style.rx = `${Math.min(height / 2, 30)}px`
      }

      frame = requestAnimationFrame(tick)
    }

    frame = requestAnimationFrame(tick)
    return () => {
      if (frame !== null) {
        cancelAnimationFrame(frame)
      }
    }
  }, [mode, levelRef])

  return (
    <svg
      className={`face mode-${mode}${isBlinking ? ' blinking' : ''}`}
      viewBox="0 0 1000 1000"
      role="img"
      aria-label={`Nova is ${mode}`}
    >
      <g className="faceInner">
        <g className="eyes">
          <rect className="eye" x="292" y="360" width="116" height="116" rx="8" />
          <rect className="eye" x="592" y="360" width="116" height="116" rx="8" />
        </g>

        {/* Mouth variants; the mode class picks which one is visible. */}
        <path className="mouth smile" d="M 285 630 Q 500 778 715 630" />
        <rect className="mouth flatLine" x="440" y="676" width="120" height="16" rx="8" />
        <rect className="mouth oMouth" x="458" y="656" width="84" height="60" rx="28" />
        <rect
          ref={talkMouthRef}
          className="mouth talkMouth"
          x={MOUTH_CENTER_X - MOUTH_WIDTHS[0] / 2}
          y={MOUTH_CENTER_Y - MOUTH_HEIGHTS[0] / 2}
          width={MOUTH_WIDTHS[0]}
          height={MOUTH_HEIGHTS[0]}
          rx="6"
        />

        {/* Meeting mode: quietly recording. */}
        <g className="recDot">
          <circle className="recRing" cx="884" cy="116" r="26" />
          <circle className="recCore" cx="884" cy="116" r="14" />
        </g>
      </g>
    </svg>
  )
}
