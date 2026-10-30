import { useEffect, useRef, useState } from 'react'
import { resolveWsUrlsForPath } from '../features/nova/utils'
import type { FaceEvent, FaceMode } from '../features/face/faceTypes'
import { Face } from './Face'

const RECONNECT_DELAY_MS = 2000
const PING_INTERVAL_MS = 25_000

/**
 * The /face tab: a dumb renderer for the app tab's state.
 *
 * It owns no audio and no conversation — it connects to the backend's
 * /ws/face relay as a viewer, keeps the latest mode in state, and feeds the
 * latest speaking level to the Face through a ref (60fps animation reads it
 * directly; a React re-render per level packet would be wasteful).
 */
export function FacePage() {
  // `?mode=talking` previews an expression without a backend: it pins the
  // mode and, for talking, feeds a synthetic speech level.
  const previewMode = new URLSearchParams(window.location.search).get('mode') as FaceMode | null
  const [mode, setMode] = useState<FaceMode>(previewMode ?? 'off')
  const [connected, setConnected] = useState(previewMode !== null)
  const levelRef = useRef(0)

  useEffect(() => {
    if (previewMode !== 'talking') return
    const timer = window.setInterval(() => {
      const t = performance.now() / 1000
      const syllable = Math.max(0, Math.sin(t * 9)) * (0.55 + 0.45 * Math.sin(t * 2.3))
      levelRef.current = Math.max(0, Math.min(1, syllable))
    }, 50)
    return () => clearInterval(timer)
  }, [previewMode])

  useEffect(() => {
    if (previewMode) return
    let cancelled = false
    let socket: WebSocket | null = null
    let reconnectTimer: number | null = null
    let pingTimer: number | null = null
    let urlIndex = 0

    // `?ws=` lets a face tab bypass the same-origin default — handy when the
    // face runs on another device that reaches the backend directly.
    const override = new URLSearchParams(window.location.search).get('ws')
    const urls = override ? [override] : resolveWsUrlsForPath('/ws/face', { auth: false })

    const scheduleReconnect = () => {
      if (cancelled || reconnectTimer !== null) {
        return
      }
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null
        connect()
      }, RECONNECT_DELAY_MS)
    }

    const connect = () => {
      if (cancelled) {
        return
      }

      let candidate: WebSocket
      try {
        candidate = new WebSocket(urls[urlIndex % urls.length])
      } catch {
        urlIndex += 1
        scheduleReconnect()
        return
      }
      socket = candidate

      candidate.onopen = () => {
        setConnected(true)
        pingTimer = window.setInterval(() => {
          if (candidate.readyState === WebSocket.OPEN) {
            candidate.send(JSON.stringify({ type: 'ping' }))
          }
        }, PING_INTERVAL_MS)
      }

      candidate.onmessage = (event) => {
        let payload: FaceEvent
        try {
          payload = JSON.parse(event.data as string) as FaceEvent
        } catch {
          return
        }
        if (payload.type === 'face_state') {
          setMode(payload.mode)
          if (payload.mode !== 'talking') {
            levelRef.current = 0
          }
        } else if (payload.type === 'face_level') {
          levelRef.current = Math.max(0, Math.min(1, payload.level))
        }
      }

      candidate.onclose = () => {
        if (pingTimer !== null) {
          clearInterval(pingTimer)
          pingTimer = null
        }
        setConnected(false)
        setMode('off')
        levelRef.current = 0
        urlIndex += 1
        scheduleReconnect()
      }

      candidate.onerror = () => {
        candidate.close()
      }
    }

    connect()

    return () => {
      cancelled = true
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer)
      }
      if (pingTimer !== null) {
        clearInterval(pingTimer)
      }
      if (socket) {
        socket.onclose = null
        socket.close()
      }
    }
  }, [previewMode])

  return (
    <div className="faceScreen">
      <Face mode={mode} levelRef={levelRef} />
      {!connected ? <div className="connectionNote">connecting…</div> : null}
    </div>
  )
}
