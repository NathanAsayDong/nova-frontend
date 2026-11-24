import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Silent mode's REST contract, exercised through the real hook rather than a
 * reimplementation of its internals: `setSilentMode` POSTs
 * /conversations/{id}/silent-mode (success, failure-rollback) and the
 * `silent_mode_state` websocket push still reconciles over whatever a REST
 * call in flight was doing. See silentMode.ts for the wire contract these
 * assert against.
 *
 * Getting to a connected hook means standing in for every browser API
 * `useNovaRuntime` touches before it ever gets to attach a socket -- a mic
 * stream, the Web Audio graph, and the websocket itself. Those are faked
 * below; none of it is what this file is testing, it is just what has to
 * exist for the real `setSilentMode` / `silent_mode_state` code paths to run.
 */

vi.mock('../utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils')>()
  return {
    ...actual,
    acquireAudioStream: vi.fn(async () => fakeMediaStream()),
    bestMimeType: vi.fn(() => undefined),
    resolveWsUrls: vi.fn(() => ['ws://backend.test/ws/transcribe']),
  }
})

const mockAuthFetch = vi.fn()

vi.mock('../../../lib/api', () => ({
  authFetch: (...args: Parameters<typeof mockAuthFetch>) => mockAuthFetch(...args),
  apiUrl: (path: string) => path,
  wsUrl: () => 'ws://backend.test/ws/transcribe',
  getToken: () => null,
  setToken: () => {},
  clearToken: () => {},
  announceUnauthorized: () => {},
  API_BASE: '',
  UNAUTHORIZED_EVENT: 'nova:unauthorized',
}))

function fakeMediaStream() {
  return {
    getTracks: () => [],
    getAudioTracks: () => [],
  } as unknown as MediaStream
}

class FakeAudioNode {
  connect() {
    return this
  }
  disconnect() {}
}

class FakeAnalyserNode extends FakeAudioNode {
  fftSize = 1024
  smoothingTimeConstant = 0
  getByteTimeDomainData(target: Uint8Array) {
    target.fill(128)
  }
}

class FakeDelayNode extends FakeAudioNode {
  delayTime = { value: 0 }
}

class FakeGainNode extends FakeAudioNode {
  gain = { value: 0 }
}

class FakeAudioContext {
  state = 'running'
  destination = {}
  audioWorklet = { addModule: async () => {} }
  createAnalyser() {
    return new FakeAnalyserNode()
  }
  createMediaStreamSource() {
    return new FakeAudioNode()
  }
  createMediaElementSource() {
    return new FakeAudioNode()
  }
  createDelay() {
    return new FakeDelayNode()
  }
  createGain() {
    return new FakeGainNode()
  }
  createMediaStreamDestination() {
    return { channelCount: 1, stream: fakeMediaStream(), connect: () => {}, disconnect: () => {} }
  }
  resume() {
    return Promise.resolve()
  }
  close() {
    return Promise.resolve()
  }
}

class FakeAudioWorkletNode extends FakeAudioNode {
  port: { onmessage: ((event: MessageEvent) => void) | null } = { onmessage: null }
}

/** A controllable stand-in for the one /ws/transcribe socket the hook opens. */
class FakeWebSocket {
  static OPEN = 1
  static CLOSED = 3
  static instances: FakeWebSocket[] = []

  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  sent: unknown[] = []

  constructor(public url: string) {
    FakeWebSocket.instances.push(this)
  }

  send(data: unknown) {
    this.sent.push(data)
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.()
  }

  /** Test helper: finish the connect handshake `openSocket` is waiting on. */
  triggerOpen() {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.()
  }

  /** Test helper: deliver a backend push, same shape as the real socket. */
  triggerMessage(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) })
  }
}

let useNovaRuntime: typeof import('./useNovaRuntime').useNovaRuntime

beforeEach(async () => {
  vi.resetModules()
  mockAuthFetch.mockReset()
  FakeWebSocket.instances = []
  sessionStorage.clear()

  // A conversation id must already exist for setSilentMode to have anything
  // to POST against -- same as a page reload mid-conversation.
  sessionStorage.setItem('nova.conversationId', 'conv-123')

  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode)
  vi.stubGlobal('WebSocket', FakeWebSocket)

  // Default: no persisted power-off state, no SpeechRecognition in jsdom.
  mockAuthFetch.mockImplementation(async (path: string) => {
    if (path === '/nova/power') {
      return { ok: false, status: 404, json: async () => ({}) } as Response
    }
    throw new Error(`unexpected authFetch call in test: ${path}`)
  })

  ;({ useNovaRuntime } = await import('./useNovaRuntime'))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** Render the hook and wait for it to reach a connected socket. */
async function renderConnectedRuntime() {
  const view = renderHook(() => useNovaRuntime())

  await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1))
  const socket = FakeWebSocket.instances[0]
  act(() => socket.triggerOpen())
  await waitFor(() => expect(view.result.current.isConnected).toBe(true))

  return { ...view, socket }
}

describe('silent mode: REST toggle (POST /conversations/{id}/silent-mode)', () => {
  it('applies the toggle optimistically, POSTs the real contract, and keeps the confirmed value', async () => {
    mockAuthFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/nova/power') {
        return { ok: false, status: 404, json: async () => ({}) } as Response
      }
      if (path === '/conversations/conv-123/silent-mode') {
        expect(init?.method).toBe('POST')
        expect(JSON.parse(String(init?.body))).toEqual({ enabled: true })
        return {
          ok: true,
          status: 200,
          json: async () => ({ conversationId: 'conv-123', silentMode: true }),
        } as Response
      }
      throw new Error(`unexpected authFetch call: ${path}`)
    })

    const { result } = await renderConnectedRuntime()
    expect(result.current.isSilentMode).toBe(false)

    act(() => {
      result.current.setSilentMode(true)
    })

    // Optimistic: the button-facing state flips before the network settles.
    expect(result.current.isSilentMode).toBe(true)

    await waitFor(() => {
      expect(mockAuthFetch).toHaveBeenCalledWith(
        '/conversations/conv-123/silent-mode',
        expect.objectContaining({ method: 'POST' }),
      )
    })

    // Reconciled with the response, which agrees -- stays on.
    await waitFor(() => expect(result.current.isSilentMode).toBe(true))
  })

  it('reverts the optimistic flip and leaves the previous state in place when the request fails', async () => {
    mockAuthFetch.mockImplementation(async (path: string) => {
      if (path === '/nova/power') {
        return { ok: false, status: 404, json: async () => ({}) } as Response
      }
      if (path === '/conversations/conv-123/silent-mode') {
        return { ok: false, status: 500, json: async () => ({}) } as Response
      }
      throw new Error(`unexpected authFetch call: ${path}`)
    })

    const { result } = await renderConnectedRuntime()
    expect(result.current.isSilentMode).toBe(false)

    act(() => {
      result.current.setSilentMode(true)
    })
    expect(result.current.isSilentMode).toBe(true)

    // The backend never confirmed it: the optimistic flip rolls back.
    await waitFor(() => expect(result.current.isSilentMode).toBe(false))
  })

  it('rolls back a failed turn-off the same way, back to on', async () => {
    mockAuthFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/nova/power') {
        return { ok: false, status: 404, json: async () => ({}) } as Response
      }
      if (path === '/conversations/conv-123/silent-mode') {
        const body = JSON.parse(String(init?.body)) as { enabled: boolean }
        if (body.enabled) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ conversationId: 'conv-123', silentMode: true }),
          } as Response
        }
        return { ok: false, status: 500, json: async () => ({}) } as Response
      }
      throw new Error(`unexpected authFetch call: ${path}`)
    })

    const { result } = await renderConnectedRuntime()

    act(() => {
      result.current.setSilentMode(true)
    })
    await waitFor(() => expect(result.current.isSilentMode).toBe(true))

    act(() => {
      result.current.setSilentMode(false)
    })
    expect(result.current.isSilentMode).toBe(false)

    await waitFor(() => expect(result.current.isSilentMode).toBe(true))
  })
})

describe('silent mode: incoming silent_mode_state push', () => {
  it('is authoritative over a local click: a push after the toggle wins', async () => {
    mockAuthFetch.mockImplementation(async (path: string) => {
      if (path === '/nova/power') {
        return { ok: false, status: 404, json: async () => ({}) } as Response
      }
      if (path === '/conversations/conv-123/silent-mode') {
        // Never resolves within the test: the push should win regardless.
        return new Promise<Response>(() => {})
      }
      throw new Error(`unexpected authFetch call: ${path}`)
    })

    const { result, socket } = await renderConnectedRuntime()

    act(() => {
      result.current.setSilentMode(true)
    })
    expect(result.current.isSilentMode).toBe(true)

    // The `set_silent_mode` voice tool (or another client's REST call)
    // flipped it back off while our POST is still in flight.
    act(() => {
      socket.triggerMessage({ type: 'silent_mode_state', enabled: false })
    })

    expect(result.current.isSilentMode).toBe(false)
  })

  it('reflects a push with no local toggle involved, e.g. on connect or from the set_silent_mode tool', async () => {
    const { result, socket } = await renderConnectedRuntime()
    expect(result.current.isSilentMode).toBe(false)

    act(() => {
      socket.triggerMessage({ type: 'silent_mode_state', enabled: true })
    })

    expect(result.current.isSilentMode).toBe(true)
  })
})
