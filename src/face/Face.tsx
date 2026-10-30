import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import type { FaceMode } from '../features/face/faceTypes'

interface FaceProps {
  mode: FaceMode
  /** Live speaking level 0..1, written by the socket at ~20Hz. */
  levelRef: RefObject<number>
}

const MOUTH_CX = 500
const MOUTH_CY = 742

/**
 * The eyes are two glowing blades with a positive canthal tilt (outer corner
 * higher than the inner one). Everything about them is defined for the left
 * eye; the right eye is the same shape mirrored across x = 500.
 */
const EYE_CX = 358
const EYE_CY = 486
const EYE_OUTER = { x: 262, y: 468 }
const EYE_INNER = { x: 452, y: 502 }
const EYE_PATH =
  `M ${EYE_OUTER.x} ${EYE_OUTER.y - 20} L ${EYE_INNER.x} ${EYE_INNER.y - 14} ` +
  `L ${EYE_INNER.x - 16} ${EYE_INNER.y + 17} L ${EYE_OUTER.x + 22} ${EYE_OUTER.y + 18} Z`

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
 * Nova's face: a flat, symbolic gigachad glyph rather than a drawn character.
 *
 * The head is a hard shield silhouette (square jaw, broad chin) lit with flat
 * facets. Eyes are glowing blades with a bright core that tracks the cursor,
 * under a heavy straight brow. One requestAnimationFrame loop drives gaze,
 * eyelid openness (blinks, squints, sleep), brows and an angular mouth that
 * follows the speech level with fast attack and slow release. The mode's
 * color and aura come from CSS.
 */
export function Face({ mode, levelRef }: FaceProps) {
  const svgRef = useRef<SVGSVGElement>(null)
  const eyeLeftRef = useRef<SVGGElement>(null)
  const eyeRightRef = useRef<SVGGElement>(null)
  const coreLeftRef = useRef<SVGRectElement>(null)
  const coreRightRef = useRef<SVGRectElement>(null)
  const mouthRef = useRef<SVGPathElement>(null)
  const creaseRef = useRef<SVGPathElement>(null)
  const browLeftRef = useRef<SVGPathElement>(null)
  const browRightRef = useRef<SVGPathElement>(null)
  const modeRef = useRef<FaceMode>(mode)
  const blinkingRef = useRef(false)
  const cursorRef = useRef<[number, number] | null>(null)
  const cursorSeenAtRef = useRef(0)

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
    const timers: number[] = []
    const blink = (after: number, hold: number, then?: () => void) => {
      timers.push(
        window.setTimeout(() => {
          blinkingRef.current = true
          timers.push(
            window.setTimeout(() => {
              blinkingRef.current = false
              then?.()
            }, hold),
          )
        }, after),
      )
    }
    const schedule = () =>
      blink(2600 + Math.random() * 4400, 130, () => {
        if (Math.random() < 0.18) blink(170, 110, schedule)
        else schedule()
      })
    schedule()
    return () => {
      timers.forEach(clearTimeout)
      blinkingRef.current = false
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
    let openness = 1 // 0 closed .. 1 normal .. 1.15 wide
    let mouthOpen = 0
    let mouthWide = 1
    let mouthSmile = 0
    let mouthShift = 0
    let browLift = 0
    let browFurrow = 0
    let wobblePhase = 0

    const eyeCenterLineY = (x: number) =>
      EYE_OUTER.y + ((x - EYE_OUTER.x) / (EYE_INNER.x - EYE_OUTER.x)) * (EYE_INNER.y - EYE_OUTER.y)

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
      else if (currentMode === 'listening') targetOpen = 1.14
      else if (currentMode === 'talking') targetOpen = 1 - smoothed * 0.16
      if (blinkingRef.current) targetOpen = 0.04
      openness += (targetOpen - openness) * (1 - Math.exp(-dt * (blinkingRef.current ? 40 : 14)))

      // ----- Mouth targets -----
      let tOpen = 0
      let tWide = 1
      let tSmile = 0
      let tShift = 0
      switch (currentMode) {
        case 'idle':
          tSmile = 1
          break
        case 'listening':
          tOpen = 0.12
          tWide = 0.3
          tSmile = 0.1
          break
        case 'thinking':
          tWide = 0.5
          tSmile = -0.2
          tShift = 0.5
          break
        case 'talking': {
          const jitter = Math.sin(wobblePhase * 23) * 0.05 * smoothed
          tOpen = Math.min(1, smoothed * 1.55 + jitter)
          tWide = 1 - Math.min(0.5, smoothed * 0.65)
          tSmile = smoothed < 0.06 ? 0.6 : 0.1
          break
        }
        case 'meeting':
          tSmile = 0.5
          tWide = 0.75
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
      browFurrow += ((currentMode === 'thinking' ? 1 : 0) - browFurrow) * (1 - Math.exp(-dt * 8))

      // ----- Write to the DOM -----
      const shiftX = gazeX * 5
      const shiftY = gazeY * 3
      const sy = Math.max(0.05, openness)
      const eyeScale = `translate(${EYE_CX} ${EYE_CY}) scale(1 ${sy.toFixed(3)}) translate(${-EYE_CX} ${-EYE_CY})`
      eyeLeftRef.current?.setAttribute('transform', `translate(${shiftX.toFixed(2)} ${shiftY.toFixed(2)}) ${eyeScale}`)
      eyeRightRef.current?.setAttribute(
        'transform',
        `translate(${shiftX.toFixed(2)} ${shiftY.toFixed(2)}) translate(1000 0) scale(-1 1) ${eyeScale}`,
      )
      // The bright core slides along the slit. The right eye is drawn in a
      // mirrored frame, so its horizontal gaze offset is negated there.
      for (const [ref, dir] of [
        [coreLeftRef, 1],
        [coreRightRef, -1],
      ] as const) {
        const core = ref.current
        if (core) {
          const x = EYE_CX + dir * gazeX * 62
          core.setAttribute('x', (x - 14).toFixed(2))
          core.setAttribute('y', (eyeCenterLineY(x) + gazeY * 7 - 32).toFixed(2))
        }
      }

      // Brows: straight heavy bars; they lift for attention and drop when thinking.
      const lift = browLift * 20
      const drop = browFurrow * 9
      const outerY = 418 - lift
      const innerY = 448 - lift + drop
      browLeftRef.current?.setAttribute('d', `M 250 ${outerY.toFixed(1)} L 458 ${innerY.toFixed(1)}`)
      browRightRef.current?.setAttribute('d', `M 750 ${outerY.toFixed(1)} L 542 ${innerY.toFixed(1)}`)

      // Mouth: an angular polygon. Closed it collapses to a flat line with a
      // faint smirk (right corner higher); speaking opens it into a hexagon.
      const halfWidth = lerp(56, 96, mouthWide)
      const cx = MOUTH_CX + mouthShift * 40
      const left = cx - halfWidth
      const right = cx + halfWidth
      // A permanent slight smirk: the right corner sits higher than the left,
      // and rises further as the mouth relaxes into a smile.
      const smirk = 0.4 + 0.6 * Math.max(0, Math.min(1, mouthSmile))
      const cornerL = MOUTH_CY + 3 - smirk * 4
      const cornerR = MOUTH_CY - 2 - smirk * 24
      const gap = mouthOpen * 92
      const lineY = (x: number) => lerp(cornerL, cornerR, (x - left) / (right - left))
      const inL = left + halfWidth * 0.34
      const inR = right - halfWidth * 0.34
      const botL = left + halfWidth * 0.5
      const botR = right - halfWidth * 0.5
      // Dimple at the raised corner.
      const crease = creaseRef.current
      if (crease) {
        const dx = right + 20
        const dy = cornerR - 6
        crease.setAttribute('d', `M ${dx.toFixed(1)} ${dy.toFixed(1)} Q ${(dx + 12).toFixed(1)} ${(dy + 18).toFixed(1)} ${dx.toFixed(1)} ${(dy + 38).toFixed(1)}`)
        crease.style.opacity = (0.15 + smirk * 0.4).toFixed(2)
      }
      const mouth = mouthRef.current
      if (mouth) {
        mouth.setAttribute(
          'd',
          `M ${left.toFixed(1)} ${cornerL.toFixed(1)} ` +
            `L ${inL.toFixed(1)} ${(lineY(inL) - gap * 0.25).toFixed(1)} ` +
            `L ${inR.toFixed(1)} ${(lineY(inR) - gap * 0.25).toFixed(1)} ` +
            `L ${right.toFixed(1)} ${cornerR.toFixed(1)} ` +
            `L ${botR.toFixed(1)} ${(lineY(botR) + gap * 0.75).toFixed(1)} ` +
            `L ${botL.toFixed(1)} ${(lineY(botL) + gap * 0.75).toFixed(1)} Z`,
        )
      }

      frame = requestAnimationFrame(tick)
    }

    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [levelRef])

  const headPath =
    'M 330 105 L 670 105 L 752 160 L 786 330 L 800 540 L 792 690 L 738 830 L 650 884 ' +
    'L 350 884 L 262 830 L 208 690 L 200 540 L 214 330 L 248 160 Z'

  return (
    <svg
      ref={svgRef}
      className={`face mode-${mode}`}
      viewBox="0 0 1000 1000"
      role="img"
      aria-label={`Nova is ${mode}`}
    >
      <defs>
        <clipPath id="headClip">
          <path d={headPath} />
        </clipPath>
        <clipPath id="slitClip">
          <path d={EYE_PATH} />
        </clipPath>
        <linearGradient id="skin" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#383d45" />
          <stop offset="100%" stopColor="#23272d" />
        </linearGradient>
      </defs>

      <ellipse className="aura" cx="500" cy="480" rx="400" ry="430" />

      <g className="faceInner">
        {/* Neck: thick, running off the bottom edge */}
        <path className="neck" d="M 372 868 L 330 1000 L 670 1000 L 628 868 Z" />

        {/* Head */}
        <path className="head" d={headPath} />
        <g clipPath="url(#headClip)">
          {/* Flat facets: hair mass, lit cheek planes, shadowed jaw sides. */}
          <path className="hair" d="M 150 40 L 850 40 L 850 330 L 760 298 L 640 262 L 500 254 L 360 262 L 240 298 L 150 330 Z" />
          <path className="hairEdge" d="M 214 330 L 240 298 L 360 262 L 500 254 L 640 262 L 760 298 L 786 330" />
          <path className="shadow" d="M 190 560 L 262 604 L 332 784 L 392 900 L 190 900 Z" />
          <path className="shadow" d="M 810 560 L 738 604 L 668 784 L 608 900 L 810 900 Z" />
          <path className="plane" d="M 500 254 L 640 262 L 760 298 L 800 540 L 800 900 L 500 900 Z" />
          <path className="cheekline" d="M 262 604 L 332 784 L 392 884" />
          <path className="cheekline" d="M 738 604 L 668 784 L 608 884" />
          <path className="cheekbone" d="M 282 560 L 392 580" />
          <path className="cheekbone" d="M 718 560 L 608 580" />
        </g>
        <path className="rim" d={headPath} />

        {/* Heavy straight brows */}
        <path ref={browLeftRef} className="brow" d="" />
        <path ref={browRightRef} className="brow" d="" />

        {/* Blade eyes; the bright core is the gaze. */}
        <g ref={eyeLeftRef} className="eye">
          <path className="slit" d={EYE_PATH} />
          <g clipPath="url(#slitClip)">
            <rect ref={coreLeftRef} className="core" x={EYE_CX - 14} y={EYE_CY - 32} width="28" height="64" rx="14" />
          </g>
        </g>
        <g ref={eyeRightRef} className="eye">
          <path className="slit" d={EYE_PATH} />
          <g clipPath="url(#slitClip)">
            <rect ref={coreRightRef} className="core" x={EYE_CX - 14} y={EYE_CY - 32} width="28" height="64" rx="14" />
          </g>
        </g>

        {/* Nose: a bridge line and a flat base */}
        <path className="line" d="M 500 476 L 500 612" />
        <path className="line base" d="M 452 628 L 500 646 L 548 628" />

        {/* Mouth: morphs with speech */}
        <path ref={mouthRef} className="mouth" d="" />
        <path ref={creaseRef} className="line" d="" />

        {/* Chin cleft */}
        <path className="line soft" d="M 500 818 L 500 856" />

        <g className="recDot">
          <circle className="recRing" cx="884" cy="116" r="26" />
          <circle className="recCore" cx="884" cy="116" r="14" />
        </g>
      </g>
    </svg>
  )
}
