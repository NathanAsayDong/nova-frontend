import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { FaceMode } from '../features/face/faceTypes'

interface FaceProps {
  mode: FaceMode
  /** Live speaking level 0..1, written by the socket at ~20Hz. */
  levelRef: RefObject<number>
}

const MOUTH_CX = 500
const MOUTH_CY = 715
const EYE_LEFT_CX = 350
const EYE_RIGHT_CX = 650
const EYE_CY = 432

/** Where the eyes look per mode when nothing else is pulling them (x, y in -1..1). */
const GAZE_BY_MODE: Record<FaceMode, [number, number]> = {
  off: [0, 0.3],
  idle: [0, 0],
  listening: [0, -0.1],
  thinking: [0.7, -0.8],
  talking: [0, 0],
  meeting: [0, 0.1],
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t

/**
 * Nova's gamified face, v3.
 *
 * One requestAnimationFrame loop drives everything that needs to feel alive:
 * eye gaze (cursor tracking + idle saccades + thinking wander), eyelid
 * openness (blinks, squints, sleep), and a continuously morphing mouth path
 * that follows the speech level with fast attack and slow release. Expression
 * colors and the ambient glow come from the mode class in CSS.
 */
export function Face({ mode, levelRef }: FaceProps) {
  const svgRef = useRef<SVGSVGElement>(null)
  const eyesRef = useRef<SVGGElement>(null)
  const pupilLeftRef = useRef<SVGRectElement>(null)
  const pupilRightRef = useRef<SVGRectElement>(null)
  const lidLeftRef = useRef<SVGRectElement>(null)
  const lidRightRef = useRef<SVGRectElement>(null)
  const mouthRef = useRef<SVGPathElement>(null)
  const browLeftRef = useRef<SVGPathElement>(null)
  const browRightRef = useRef<SVGPathElement>(null)
  const modeRef = useRef<FaceMode>(mode)
  const cursorRef = useRef<[number, number] | null>(null)
  const cursorSeenAtRef = useRef(0)
  const [isBlinking, setIsBlinking] = useState(false)

  useEffect(() => {
    modeRef.current = mode
  }, [mode])

  // Cursor tracking: eyes follow the pointer, then drift back after it rests.
  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const svg = svgRef.current
      if (!svg) return
      const rect = svg.getBoundingClientRect()
      const nx = ((event.clientX - rect.left) / rect.width - 0.5) * 2
      const ny = ((event.clientY - rect.top) / rect.height - 0.5) * 2
      cursorRef.current = [Math.max(-1, Math.min(1, nx)), Math.max(-1, Math.min(1, ny))]
      cursorSeenAtRef.current = performance.now()
    }
    window.addEventListener('pointermove', onMove)
    return () => window.removeEventListener('pointermove', onMove)
  }, [])

  // Random blinks while awake, with the occasional double blink.
  useEffect(() => {
    if (mode === 'off') return
    let t1: number | null = null
    let t2: number | null = null
    let t3: number | null = null
    const schedule = () => {
      t1 = window.setTimeout(
        () => {
          setIsBlinking(true)
          t2 = window.setTimeout(() => {
            setIsBlinking(false)
            if (Math.random() < 0.18) {
              t3 = window.setTimeout(() => {
                setIsBlinking(true)
                window.setTimeout(() => setIsBlinking(false), 110)
              }, 160)
            }
            schedule()
          }, 120)
        },
        2600 + Math.random() * 4400,
      )
    }
    schedule()
    return () => {
      if (t1 !== null) clearTimeout(t1)
      if (t2 !== null) clearTimeout(t2)
      if (t3 !== null) clearTimeout(t3)
      setIsBlinking(false)
    }
  }, [mode])

  // The animation loop.
  useEffect(() => {
    let frame = 0
    let last = performance.now()
    let gazeX = 0
    let gazeY = 0
    let saccadeX = 0
    let saccadeY = 0
    let nextSaccadeAt = last + 1500
    let smoothed = 0
    let openness = 0 // 0 closed .. 1 wide
    let mouthOpen = 0
    let mouthWide = 0
    let mouthSmile = 0
    let mouthShift = 0
    let browLift = 0
    let wobblePhase = 0

    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      const currentMode = modeRef.current
      const raw = levelRef.current ?? 0
      smoothed += (raw - smoothed) * (raw > smoothed ? 0.45 : 0.14)
      wobblePhase += dt

      // ----- Gaze -----
      if (now > nextSaccadeAt) {
        saccadeX = (Math.random() - 0.5) * 0.9
        saccadeY = (Math.random() - 0.5) * 0.5
        nextSaccadeAt = now + 1200 + Math.random() * 3200
      }
      let [targetX, targetY] = GAZE_BY_MODE[currentMode]
      if (currentMode === 'thinking') {
        targetX = Math.sin(wobblePhase * 0.9) * 0.8
        targetY = -0.7 + Math.sin(wobblePhase * 1.7) * 0.2
      } else if (currentMode === 'idle' || currentMode === 'talking' || currentMode === 'meeting') {
        targetX += saccadeX * (currentMode === 'idle' ? 1 : 0.35)
        targetY += saccadeY * (currentMode === 'idle' ? 1 : 0.35)
      }
      const cursor = cursorRef.current
      const cursorFresh = cursor !== null && now - cursorSeenAtRef.current < 4000
      if (cursor && cursorFresh && currentMode !== 'off' && currentMode !== 'thinking') {
        targetX = cursor[0]
        targetY = cursor[1]
      }
      gazeX += (targetX - gazeX) * (1 - Math.exp(-dt * 9))
      gazeY += (targetY - gazeY) * (1 - Math.exp(-dt * 9))

      // ----- Eyelids -----
      let targetOpen = 1
      if (currentMode === 'off') targetOpen = 0.06
      else if (currentMode === 'meeting') targetOpen = 0.62
      else if (currentMode === 'thinking') targetOpen = 0.78
      else if (currentMode === 'listening') targetOpen = 1.1
      else if (currentMode === 'talking') targetOpen = 1 - smoothed * 0.18
      openness += (targetOpen - openness) * (1 - Math.exp(-dt * 14))

      // ----- Mouth targets -----
      let tOpen = 0.02
      let tWide = 1
      let tSmile = 0
      let tShift = 0
      switch (currentMode) {
        case 'idle':
          tSmile = 1
          tOpen = 0.0
          break
        case 'listening':
          tOpen = 0.16
          tWide = 0.26
          tSmile = 0.15
          break
        case 'thinking':
          tOpen = 0.02
          tWide = 0.48
          tSmile = -0.12
          tShift = 0.5
          break
        case 'talking': {
          const jitter = Math.sin(wobblePhase * 23) * 0.05 * smoothed
          tOpen = Math.min(1, smoothed * 1.55 + jitter)
          tWide = 1 - Math.min(0.5, smoothed * 0.65)
          tSmile = smoothed < 0.06 ? 0.45 : 0.1
          break
        }
        case 'meeting':
          tSmile = 0.5
          tWide = 0.68
          break
        case 'off':
          tWide = 0.7
          break
      }
      const mouthRate = currentMode === 'talking' ? 1 - Math.exp(-dt * 26) : 1 - Math.exp(-dt * 9)
      mouthOpen += (tOpen - mouthOpen) * mouthRate
      mouthWide += (tWide - mouthWide) * mouthRate
      mouthSmile += (tSmile - mouthSmile) * mouthRate
      mouthShift += (tShift - mouthShift) * (1 - Math.exp(-dt * 7))

      // ----- Brows -----
      const tBrow =
        currentMode === 'listening' ? 1 : currentMode === 'thinking' ? 0.5 : currentMode === 'talking' ? smoothed * 0.6 : 0
      browLift += (tBrow - browLift) * (1 - Math.exp(-dt * 10))

      // ----- Write to the DOM -----
      const pupilTravel = 24
      const px = gazeX * pupilTravel
      const py = gazeY * pupilTravel * 0.8
      const eyeShift = `translate(${(gazeX * 4).toFixed(2)} ${(gazeY * 3).toFixed(2)})`
      eyesRef.current?.setAttribute('transform', eyeShift)
      for (const [ref, cx] of [
        [pupilLeftRef, EYE_LEFT_CX],
        [pupilRightRef, EYE_RIGHT_CX],
      ] as const) {
        const pupil = ref.current
        if (pupil) {
          pupil.setAttribute('x', (cx - 26 + px).toFixed(2))
          pupil.setAttribute('y', (EYE_CY - 26 + py * 0.5).toFixed(2))
        }
      }
      const lidHeight = Math.max(0, (1 - Math.min(openness, 1)) * 120 + 0.5)
      const lidLeft = lidLeftRef.current
      const lidRight = lidRightRef.current
      if (lidLeft && lidRight) {
        const heightPx = lidHeight.toFixed(2)
        lidLeft.setAttribute('height', heightPx)
        lidRight.setAttribute('height', heightPx)
      }
      const eyeScale = 1
      eyesRef.current?.setAttribute(
        'transform',
        `${eyeShift} translate(500 ${EYE_CY}) scale(${eyeScale.toFixed(3)}) translate(-500 ${-EYE_CY})`,
      )

      // Mouth: a closed-curve path whose corners, lip gap and curvature morph.
      const halfWidth = lerp(60, 120, mouthWide)
      const cx = MOUTH_CX + mouthShift * 46
      const left = cx - halfWidth
      const right = cx + halfWidth
      const cornerY = MOUTH_CY - mouthSmile * 10 + (mouthSmile < 0 ? 4 : 0)
      const gap = mouthOpen * 95
      const curve = mouthSmile * 14
      const topY = MOUTH_CY - gap / 2
      const botY = MOUTH_CY + gap / 2
      const mouth = mouthRef.current
      if (mouth) {
        if (gap < 4) {
          const thickness = 12
          mouth.setAttribute(
            'd',
            `M ${left} ${cornerY} Q ${cx} ${MOUTH_CY + curve * 1.9} ${right} ${cornerY} ` +
              `Q ${cx} ${MOUTH_CY + curve * 1.9 + thickness} ${left} ${cornerY} Z`,
          )
        } else {
          mouth.setAttribute(
            'd',
            `M ${left} ${cornerY} Q ${cx} ${topY - curve * 0.3 - 6} ${right} ${cornerY} ` +
              `Q ${cx + halfWidth * 0.1} ${botY + 34 + curve * 0.8} ${cx} ${botY + 26 + curve * 0.5} ` +
              `Q ${cx - halfWidth * 0.1} ${botY + 34 + curve * 0.8} ${left} ${cornerY} Z`,
          )
        }
      }

      const browY = 372 - browLift * 16
      const furrow = currentMode === 'thinking' ? 10 : 6
      browLeftRef.current?.setAttribute(
        'd',
        `M 225 ${browY + 6} L 465 ${browY + furrow + 14} L 465 ${browY + furrow + 40} L 225 ${browY + 30} Z`,
      )
      browRightRef.current?.setAttribute(
        'd',
        `M 775 ${browY + 6} L 535 ${browY + furrow + 14} L 535 ${browY + furrow + 40} L 775 ${browY + 30} Z`,
      )

      frame = requestAnimationFrame(tick)
    }

    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [levelRef])

  return (
    <svg
      ref={svgRef}
      className={`face mode-${mode}${isBlinking ? ' blinking' : ''}`}
      viewBox="0 0 1000 1000"
      role="img"
      aria-label={`Nova is ${mode}`}
    >
      <defs>
        <linearGradient id="skin" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#8d8d8d" />
          <stop offset="45%" stopColor="#e4e4e4" />
          <stop offset="100%" stopColor="#6e6e6e" />
        </linearGradient>
        <linearGradient id="jawShade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#000" stopOpacity="0" />
          <stop offset="100%" stopColor="#000" stopOpacity="0.45" />
        </linearGradient>
        <clipPath id="clipLeft">
          <path d="M 245 430 Q 350 372 455 430 L 455 470 Q 350 500 245 470 Z" />
        </clipPath>
        <clipPath id="clipRight">
          <path d="M 545 430 Q 650 372 755 430 L 755 470 Q 650 500 545 470 Z" />
        </clipPath>
      </defs>

      <g className="faceInner">
        {/* Neck */}
        <path className="neck" d="M 380 800 L 360 1000 L 640 1000 L 620 800 Z" />

        {/* Head: tall skull, wide cheekbones, huge square jaw */}
        <path
          className="head"
          d="M 500 90 C 700 90 770 200 775 360 C 778 470 790 560 800 650
             L 790 760 Q 780 835 700 850 L 300 850 Q 220 835 210 760
             L 200 650 C 210 560 222 470 225 360 C 230 200 300 90 500 90 Z"
        />
        <path className="headShade" d="M 200 640 L 210 760 Q 220 835 300 850 L 700 850 Q 780 835 790 760 L 800 640 Z" />

        {/* Hairline */}
        <path className="hair" d="M 225 330 C 215 190 300 80 500 80 C 700 80 785 190 775 330 C 760 250 700 200 500 195 C 300 200 240 250 225 330 Z" />

        {/* Cheekbone and jaw definition lines */}
        <path className="contour" d="M 235 560 C 260 700 300 790 380 830" />
        <path className="contour" d="M 765 560 C 740 700 700 790 620 830" />
        <path className="contour soft" d="M 300 600 Q 330 560 360 560" />
        <path className="contour soft" d="M 700 600 Q 670 560 640 560" />

        {/* Heavy brows */}
        <path ref={browLeftRef} className="brow" d="" />
        <path ref={browRightRef} className="brow" d="" />

        {/* Hooded eyes */}
        <g ref={eyesRef} className="eyes">
          <path className="eyeWhite" d="M 245 430 Q 350 372 455 430 Q 350 490 245 430 Z" />
          <path className="eyeWhite" d="M 545 430 Q 650 372 755 430 Q 650 490 545 430 Z" />
          <g clipPath="url(#clipLeft)">
            <rect ref={pupilLeftRef} className="pupil" x={324} y={404} width="52" height="52" rx="26" />
            <rect ref={lidLeftRef} className="lid" x={240} y={370} width={220} height="0" />
          </g>
          <g clipPath="url(#clipRight)">
            <rect ref={pupilRightRef} className="pupil" x={624} y={404} width="52" height="52" rx="26" />
            <rect ref={lidRightRef} className="lid" x={540} y={370} width={220} height="0" />
          </g>
          <path className="lidLine" d="M 238 432 Q 350 360 462 432" />
          <path className="lidLine" d="M 538 432 Q 650 360 762 432" />
        </g>

        {/* Nose */}
        <path className="contour" d="M 500 440 L 500 585" />
        <path className="nose" d="M 440 600 Q 500 635 560 600" />

        {/* Mouth: morphs with speech */}
        <path ref={mouthRef} className="mouth" d="" />
        {/* Chin cleft */}
        <path className="contour soft" d="M 500 790 L 500 830" />

        <g className="recDot">
          <circle className="recRing" cx="884" cy="116" r="26" />
          <circle className="recCore" cx="884" cy="116" r="14" />
        </g>
      </g>
    </svg>
  )
}
