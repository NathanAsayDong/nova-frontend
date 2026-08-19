/**
 * Publisher side of the face feed.
 *
 * The main app tab is the only place that knows the true conversation state:
 * it owns the transcribe socket, plays the TTS audio, and computes the live
 * amplitude. This module pushes that state to the backend's tiny /ws/face
 * relay so a face tab (possibly on another device) can render it.
 *
 * Single-user deployment, so this is deliberately simple: one module-level
 * socket, reconnect on a timer, and re-send the last known mode whenever the
 * connection comes back.
 */

import { resolveWsUrlsForPath } from '../nova/utils'
import type { FaceMode } from './faceTypes'

let socket: WebSocket | null = null
let started = false
let urlIndex = 0
let reconnectTimer: number | null = null

let lastMode: FaceMode = 'idle'
let lastSentLevel = 0
let lastLevelSentAt = 0

const RECONNECT_DELAY_MS = 2000
const LEVEL_MIN_INTERVAL_MS = 33
const LEVEL_MIN_DELTA = 0.015

function connect() {
  const urls = resolveWsUrlsForPath('/ws/face')
  const url = urls[urlIndex % urls.length]

  let candidate: WebSocket
  try {
    candidate = new WebSocket(`${url}?role=pub`)
  } catch {
    scheduleReconnect()
    return
  }

  candidate.onopen = () => {
    socket = candidate
    // A viewer that connected while we were away is showing "off"; catch it up.
    sendJson({ type: 'face_state', mode: lastMode })
  }

  candidate.onclose = () => {
    if (socket === candidate) {
      socket = null
    }
    // Rotate through candidate URLs (dev proxy first, backend direct after).
    urlIndex += 1
    scheduleReconnect()
  }

  candidate.onerror = () => {
    candidate.close()
  }
}

function scheduleReconnect() {
  if (!started || reconnectTimer !== null) {
    return
  }
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null
    connect()
  }, RECONNECT_DELAY_MS)
}

function sendJson(payload: Record<string, unknown>) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload))
  }
}

/** Idempotent; the app calls this once on mount. */
export function connectFacePublisher() {
  if (started) {
    return
  }
  started = true
  connect()
}

export function publishFaceMode(mode: FaceMode) {
  lastMode = mode
  sendJson({ type: 'face_state', mode })
}

/**
 * Called from the audio worklet's message port at ~20Hz while Nova speaks.
 * Throttled and deduped so silence doesn't stream a wall of zeros.
 */
export function publishFaceLevel(level: number) {
  const now = performance.now()
  const delta = Math.abs(level - lastSentLevel)
  if (now - lastLevelSentAt < LEVEL_MIN_INTERVAL_MS) {
    return
  }
  if (delta < LEVEL_MIN_DELTA && !(level === 0 && lastSentLevel !== 0)) {
    return
  }
  lastSentLevel = level
  lastLevelSentAt = now
  sendJson({ type: 'face_level', level: Number(level.toFixed(3)) })
}
