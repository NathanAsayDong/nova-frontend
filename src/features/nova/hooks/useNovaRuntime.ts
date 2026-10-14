import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChatStreamEvent } from '../chatTypes'
import bootupSfx from '../../../assets/bootup.mp3'
import type {
  AudioQueueItem,
  CapturePurpose,
  SocketEvent,
  SpeechRecognitionLike,
  StreamAudioBuffer,
  UiPhase,
  VoiceMode,
} from '../types'
import {
  acquireAudioStream,
  base64ToArrayBuffer,
  bestMimeType,
  clearConversationId,
  describeMediaError,
  loadConversationId,
  resolveWsUrls,
  saveConversationId,
} from '../utils'
import { containsWakePhrase, startsWithWakePhrase } from '../wakePhrase'
import { playEarcon, primeEarcons } from '../earcons'
import { createTurnDetector, type TurnDetector } from '../turnDetector'
import { SILENT_CLIP_DATA_URI } from '../silentClip'
import { publishFaceLevel } from '../../face/publisher'
import { authFetch } from '../../../lib/api'

const voiceModeStorageKey = 'nova.voiceMode'

function loadVoiceMode(): VoiceMode {
  try {
    return window.localStorage.getItem(voiceModeStorageKey) === 'sentry' ? 'sentry' : 'conversation'
  } catch {
    return 'conversation'
  }
}

// Sentry: an utterance that ended before the recognizer reported whether it
// opened with the wake phrase waits this long for a late result.
const SENTRY_WAKE_GRACE_MS = 900
// Sentry: woken with nothing asked. Back to waiting after this much quiet.
const SENTRY_LISTEN_TIMEOUT_MS = 8000
const SENTRY_WAITING_MESSAGE = 'Sentry: say "Hey Nova" to ask something.'

// How much audio from BEFORE the voice detector fires each recording keeps.
// The detector only fires once the level crosses its threshold, by which
// point a soft opening ("Say…", "Add…") is already gone — "Say hi to Brad"
// arrived as "Hi to Brad." So the recorder listens through a delay line of
// this length while the detector reads the live mic: starting the recorder
// at onset captures from half a second earlier.
const PREROLL_MS = 500
// Slack on top of the pre-roll for the recorder's own buffering.
const PREROLL_SLACK_MS = 60

// Reconnect backoff after the socket to the tower drops (laptop sleep, Wi-Fi
// change, or the API restarting — which it does on every `git pull` on the
// tower). Before, a dropped socket stayed dropped until a page refresh, and
// Sentry kept chiming on "Hey Nova" with nowhere to send the request.
const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000, 30000]
// A woken request waits this long for the socket to come back before giving up.
const SOCKET_WAIT_MS = 8000

/**
 * One recording, from recorder start to its final flush.
 *
 * A sentry capture starts `held`: its chunks stay on this machine until the
 * wake phrase is heard, because in sentry mode most speech in the room is
 * not meant for Nova and never leaves the browser. When the wake phrase
 * arrives the capture is `promoted` -- the start message and the held chunks
 * go out in order, ahead of anything recorded after.
 */
type ActiveCapture = {
  purpose: Exclude<CapturePurpose, 'none'>
  recorder: MediaRecorder
  held: boolean
  heldChunks: Blob[]
  promoted: boolean
  discarded: boolean
  utteranceEnded: boolean
  // Every send for this capture is chained here, so chunks keep their order
  // and the stop message waits for the final flush.
  delivery: Promise<void>
  // This recording's lag behind the live mic: PREROLL_MS when it records
  // through the delay line, 0 when it fell back to the raw stream.
  lagMs: number
}

type UseNovaRuntimeResult = {
  isNovaEnabled: boolean
  showMicEnableButton: boolean
  uiPhase: UiPhase
  visualAudioLevel: number
  combinedVoiceLevel: number
  hasSpeechInput: boolean
  /**
   * What Nova is SAYING this turn -- the short spoken line, not the
   * written answer. The full markdown reply reaches the transcript
   * through `onAgentEvent`; this is the caption for the audio.
   */
  assistantText: string
  retryRuntime: () => void
  setNovaPower: (enabled: boolean) => void
  /**
   * The browser refused to play Nova's voice because no tap has unlocked
   * audio yet (iOS Safari). The composer shows an "Enable sound" button
   * that calls `enableSound` from inside the tap.
   */
  needsSoundUnlock: boolean
  enableSound: () => void
  /** 'conversation' keeps listening after a reply; 'sentry' needs the wake phrase every time. */
  voiceMode: VoiceMode
  setVoiceMode: (mode: VoiceMode) => void
  /** The socket to the tower is open. False while (re)connecting. */
  isConnected: boolean
}

type NovaRuntimeOptions = {
  /** What the user said, once transcribed. */
  onUserTranscript?: (text: string) => void
  /**
   * Live caption while the user is still speaking. Each call carries the
   * full text so far (replace, don't append); an empty string means the
   * caption should be discarded (no final transcript is coming).
   */
  onPartialUserTranscript?: (text: string) => void
  /**
   * Structured turn events (delta / text_final / status_text / tool_call /
   * artifact) -- everything that belongs on screen. The spoken line is
   * deliberately NOT among them: it is a summary of the same answer, and
   * printing it above the answer would say everything twice.
   */
  onAgentEvent?: (event: ChatStreamEvent) => void
  /** Turn finished; carries the conversation it belongs to. */
  onTurnComplete?: (conversationId: string) => void
  /**
   * Stand the whole voice pipeline down without touching Nova's power state.
   *
   * Meeting mode uses this: the meeting recorder needs the microphone to
   * itself, and Nova must not answer the room while one is running. Distinct
   * from power off, which is a decision the user made and is persisted.
   */
  suspended?: boolean
}

export function useNovaRuntime(options: NovaRuntimeOptions = {}): UseNovaRuntimeResult {
  const optionsRef = useRef(options)
  optionsRef.current = options

  const [, setStatusMessage] = useState('Requesting microphone permission...')
  const [isNovaEnabled, setIsNovaEnabled] = useState(true)
  const [showMicEnableButton, setShowMicEnableButton] = useState(true)
  const [audioLevel, setAudioLevel] = useState(0)
  const [agentAudioLevel, setAgentAudioLevel] = useState(0)
  const [uiPhase, setUiPhase] = useState<UiPhase>('idle')
  const [assistantText, setAssistantText] = useState('')
  const [needsSoundUnlock, setNeedsSoundUnlock] = useState(false)
  const [voiceMode, setVoiceModeState] = useState<VoiceMode>(loadVoiceMode)
  const voiceModeRef = useRef<VoiceMode>(voiceMode)
  const activeCaptureRef = useRef<ActiveCapture | null>(null)
  const sentryGraceTimerRef = useRef<number | null>(null)
  const sentryListenTimerRef = useRef<number | null>(null)
  // Set by `done` in sentry mode: once the reply has finished playing, go
  // back to waiting for the wake phrase instead of listening for a follow-up.
  const pendingSentryReturnRef = useRef(false)
  const [isConnected, setIsConnected] = useState(false)
  const reconnectTimerRef = useRef<number | null>(null)
  const reconnectAttemptRef = useRef(0)
  const isConnectingRef = useRef(false)
  // Captures waiting for the socket to come back, resolved when it opens.
  const socketWaitersRef = useRef<Array<() => void>>([])
  // The recognizer keeps revising a phrase after it first matches (interim,
  // then final). Each phrase may wake Nova once: a late final for "Hey Nova,
  // …" arriving as the reply starts would otherwise barge in on the answer.
  const handledWakeResultRef = useRef<{ recognition: SpeechRecognitionLike | null; index: number }>({
    recognition: null,
    index: -1,
  })

  const wsRef = useRef<WebSocket | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const mediaStreamRef = useRef<MediaStream | null>(null)
  const recorderMimeTypeRef = useRef('audio/webm')

  const audioQueueRef = useRef<AudioQueueItem[]>([])
  const streamBuffersRef = useRef<Map<string, StreamAudioBuffer>>(new Map())
  const isAudioQueueRunningRef = useRef(false)
  const currentAudioUrlRef = useRef<string | null>(null)

  const audioContextRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const analysisTimerRef = useRef<number | null>(null)
  const analysisDataRef = useRef<Uint8Array<ArrayBuffer> | null>(null)
  const prerollNodeRef = useRef<DelayNode | null>(null)
  // The audio-thread level meter that drives the turn detector, and the
  // silent sink that keeps the graph pulling it.
  const micMeterNodeRef = useRef<AudioWorkletNode | null>(null)
  const micMeterSinkRef = useRef<GainNode | null>(null)
  // The mic, PREROLL_MS late. What recordings are made from.
  const recordStreamRef = useRef<MediaStream | null>(null)
  // The detector saw silence begin here; the speech_pause flush waits for the
  // delayed recording to catch up to this point.
  const speechPausedAtRef = useRef<number | null>(null)
  const pauseFlushTimerRef = useRef<number | null>(null)
  const agentAudioContextRef = useRef<AudioContext | null>(null)
  const agentMeterNodeRef = useRef<AudioWorkletNode | null>(null)
  const agentSourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null)
  // Resolves true once the worklet graph is loaded; false if it failed and
  // playback should fall back to a plain element->destination connection.
  const agentGraphReadyRef = useRef<Promise<boolean> | null>(null)
  const agentLevelSmoothedRef = useRef(0)
  // ONE element for every reply, for iOS: Safari grants "may play with sound"
  // per element, inside a user gesture, and a `new Audio()` built when the
  // reply arrives over the socket has never seen a gesture. This element is
  // unlocked once (see unlockAudio) and every clip is played through it by
  // swapping its src.
  const agentAudioElementRef = useRef<HTMLAudioElement | null>(null)
  const audioUnlockedRef = useRef(false)
  // The element while a clip is actually playing through it; null between.
  const activeAgentAudioRef = useRef<HTMLAudioElement | null>(null)
  const activePlaybackDoneRef = useRef<(() => void) | null>(null)
  const suppressAssistantAudioUntilNextTurnRef = useRef(false)

  const speechRecognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const wakeRestartTimerRef = useRef<number | null>(null)
  const wakeDetectModeRef = useRef<'browser' | 'disabled'>('disabled')
  const uiPhaseRef = useRef<UiPhase>('idle')
  const isInitInFlightRef = useRef(false)
  const awaitingMicrophoneRef = useRef(false)

  const capturePurposeRef = useRef<CapturePurpose>('none')
  const captureStartedRef = useRef(false)
  const pendingStopPurposeRef = useRef<Exclude<CapturePurpose, 'none'> | null>(null)

  // Turn detection. The detector is fed by the analysis timer and calls back
  // on transitions only, so it never re-renders this hook while the user is
  // mid-sentence. Its handlers are reached through a ref because the detector
  // outlives the render that created it.
  const turnDetectorRef = useRef<TurnDetector | null>(null)
  const turnHandlersRef = useRef<{
    onSpeechOnset: () => void
    onSpeechStart: () => void
    onSpeechPause: () => void
    onSpeechResume: () => void
    onSpeechAbort: () => void
    onTurnEnd: () => void
  } | null>(null)
  const [isSpeaking, setIsSpeaking] = useState(false)

  const pendingWakeListeningRef = useRef(false)
  const pendingFollowUpListeningRef = useRef(false)
  // Set when the user flips the power toggle on: an explicit "I want to talk"
  // signal, so the next ready connection goes straight to listening instead
  // of idling until a wake phrase.
  const pendingPowerOnListenRef = useRef(false)
  const isNovaEnabledRef = useRef(true)
  const isShuttingDownRef = useRef(false)
  const bootupCueAudioRef = useRef<HTMLAudioElement | null>(null)
  const conversationIdRef = useRef<string | null>(loadConversationId())

  const wsUrls = useMemo(() => resolveWsUrls(), [])

  useEffect(() => {
    uiPhaseRef.current = uiPhase
  }, [uiPhase])

  useEffect(() => {
    isNovaEnabledRef.current = isNovaEnabled
  }, [isNovaEnabled])

  const visualAudioLevel = useMemo(() => {
    if (uiPhase === 'listening') {
      return audioLevel
    }
    if (uiPhase === 'thinking' || uiPhase === 'responding') {
      return 0.4
    }
    return 0
  }, [audioLevel, uiPhase])

  const combinedVoiceLevel = useMemo(
    () => Math.max(audioLevel, agentAudioLevel),
    [audioLevel, agentAudioLevel],
  )

  const hasSpeechInput = uiPhase === 'listening' && isSpeaking

  const resetTurnDetection = () => {
    turnDetectorRef.current?.reset()
    setIsSpeaking(false)
  }

  const setIdle = (message = 'Idle.') => {
    resetTurnDetection()
    uiPhaseRef.current = 'idle'
    setUiPhase('idle')
    setStatusMessage(message)
    resetAssistantTurnContent()
  }

  const setListening = (message: string) => {
    uiPhaseRef.current = 'listening'
    setUiPhase('listening')
    setStatusMessage(message)
    resetTurnDetection()
  }

  // Listening, entered mid-utterance: a sentry wake usually lands while the
  // user is still talking ("Hey Nova, what's…"), and resetting the detector
  // there would lose track of the very turn being woken for.
  const markListening = (message: string) => {
    uiPhaseRef.current = 'listening'
    setUiPhase('listening')
    setStatusMessage(message)
  }

  const setThinking = (message: string) => {
    uiPhaseRef.current = 'thinking'
    setUiPhase('thinking')
    setStatusMessage(message)
  }

  const setResponding = (message: string) => {
    uiPhaseRef.current = 'responding'
    setUiPhase('responding')
    setStatusMessage(message)
  }

  const cleanupAudioAnalysis = () => {
    if (analysisTimerRef.current !== null) {
      window.clearInterval(analysisTimerRef.current)
      analysisTimerRef.current = null
    }

    if (sourceNodeRef.current) {
      sourceNodeRef.current.disconnect()
      sourceNodeRef.current = null
    }

    if (prerollNodeRef.current) {
      prerollNodeRef.current.disconnect()
      prerollNodeRef.current = null
    }
    if (micMeterNodeRef.current) {
      micMeterNodeRef.current.port.onmessage = null
      micMeterNodeRef.current.disconnect()
      micMeterNodeRef.current = null
    }
    if (micMeterSinkRef.current) {
      micMeterSinkRef.current.disconnect()
      micMeterSinkRef.current = null
    }
    recordStreamRef.current = null
    if (pauseFlushTimerRef.current !== null) {
      window.clearTimeout(pauseFlushTimerRef.current)
      pauseFlushTimerRef.current = null
    }
    speechPausedAtRef.current = null

    if (analyserRef.current) {
      analyserRef.current.disconnect()
      analyserRef.current = null
    }

    if (audioContextRef.current) {
      void audioContextRef.current.close()
      audioContextRef.current = null
    }

    analysisDataRef.current = null
    turnDetectorRef.current = null
    setAudioLevel(0)
    setIsSpeaking(false)
  }

  const cleanupAgentAudioAnalysis = () => {
    // Levels only. The element, its source node, the context and the meter
    // all live for the whole session: createMediaElementSource may be called
    // once per element, and once called the element's sound only ever comes
    // out through the context, so the wiring is permanent by nature.
    agentLevelSmoothedRef.current = 0
    setAgentAudioLevel(0)
    publishFaceLevel(0)
  }

  const closeAgentAudioGraph = () => {
    cleanupAgentAudioAnalysis()
    if (agentSourceNodeRef.current) {
      agentSourceNodeRef.current.disconnect()
      agentSourceNodeRef.current = null
    }
    if (agentAudioElementRef.current) {
      agentAudioElementRef.current.pause()
      agentAudioElementRef.current.src = ''
      agentAudioElementRef.current = null
    }
    audioUnlockedRef.current = false
    if (agentMeterNodeRef.current) {
      agentMeterNodeRef.current.port.onmessage = null
      agentMeterNodeRef.current.disconnect()
      agentMeterNodeRef.current = null
    }
    if (agentAudioContextRef.current) {
      void agentAudioContextRef.current.close()
      agentAudioContextRef.current = null
    }
    agentGraphReadyRef.current = null
  }

  const cleanupAudioUrl = () => {
    if (currentAudioUrlRef.current) {
      URL.revokeObjectURL(currentAudioUrlRef.current)
      currentAudioUrlRef.current = null
    }
  }

  const stopActiveAgentAudioPlayback = () => {
    const activeAudio = activeAgentAudioRef.current
    if (activeAudio) {
      activeAudio.pause()
      activeAudio.onended = null
      activeAudio.onerror = null
      activeAudio.removeAttribute('src')
      activeAudio.load()
      activeAgentAudioRef.current = null
    }

    if (activePlaybackDoneRef.current) {
      activePlaybackDoneRef.current()
      activePlaybackDoneRef.current = null
    }

    cleanupAgentAudioAnalysis()
    cleanupAudioUrl()
  }

  const playBootupCue = () => {
    if (!bootupCueAudioRef.current) {
      bootupCueAudioRef.current = new Audio(bootupSfx)
      bootupCueAudioRef.current.preload = 'auto'
    }

    const cue = bootupCueAudioRef.current
    cue.currentTime = 0
    void cue.play().catch(() => {
      // Ignore playback errors from browser autoplay policies.
    })
  }

  const stopWakeRecognition = () => {
    if (wakeRestartTimerRef.current !== null) {
      window.clearTimeout(wakeRestartTimerRef.current)
      wakeRestartTimerRef.current = null
    }

    const recognition = speechRecognitionRef.current
    if (!recognition) {
      return
    }

    recognition.onresult = null
    recognition.onend = null
    recognition.onerror = null
    recognition.stop()
    speechRecognitionRef.current = null
  }

  const cleanupMedia = () => {
    if (mediaRecorderRef.current) {
      if (mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop()
      }
      mediaRecorderRef.current.ondataavailable = null
      mediaRecorderRef.current.onstop = null
      mediaRecorderRef.current = null
    }

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop())
      mediaStreamRef.current = null
    }

    cleanupAudioAnalysis()
    stopWakeRecognition()
  }

  const closeSocket = () => {
    if (wsRef.current) {
      wsRef.current.onmessage = null
      wsRef.current.onerror = null
      wsRef.current.onclose = null
      wsRef.current.close()
      wsRef.current = null
    }
  }

  const waitForNextStreamSignal = async (streamBuffer: StreamAudioBuffer) =>
    new Promise<void>((resolve) => {
      streamBuffer.waiters.push(resolve)
    })

  const notifyStreamWaiters = (streamBuffer: StreamAudioBuffer) => {
    const waiters = streamBuffer.waiters.splice(0, streamBuffer.waiters.length)
    waiters.forEach((resolve) => resolve())
  }

  const shutdownRuntime = (message = 'Nova is off. Turn Nova back on to resume.') => {
    isShuttingDownRef.current = true
    awaitingMicrophoneRef.current = false
    pendingWakeListeningRef.current = false
    pendingFollowUpListeningRef.current = false
    pendingPowerOnListenRef.current = false
    pendingSentryReturnRef.current = false
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    reconnectAttemptRef.current = 0
    setIsConnected(false)
    clearSentryGrace()
    clearSentryListenTimeout()
    discardSentryCapture()
    activeCaptureRef.current = null
    resetTurnDetection()
    audioQueueRef.current = []
    streamBuffersRef.current.forEach((streamBuffer) => {
      streamBuffer.ended = true
      notifyStreamWaiters(streamBuffer)
    })
    streamBuffersRef.current.clear()
    stopActiveAgentAudioPlayback()
    cleanupMedia()
    closeSocket()
    cleanupAudioUrl()
    captureStartedRef.current = false
    capturePurposeRef.current = 'none'
    setShowMicEnableButton(false)
    setIdle(message)
  }

  const persistConversationId = (id: string) => {
    conversationIdRef.current = id
    saveConversationId(id)
  }

  const resetAssistantTurnContent = () => {
    setAssistantText('')
  }

  /**
   * Accumulate what Nova says out loud over one turn.
   *
   * A turn speaks at most twice -- the pre-tool acknowledgment, then the
   * reply -- and both arrive in order down the one socket, so this needs no
   * sequencing. The written answer used to feed this state and did need it,
   * back when the two were the same text.
   */
  const appendSpokenLine = (text: string) => {
    setAssistantText((current) => (current ? `${current} ${text}` : text))
  }

  const sendSocketEvent = (payload: Record<string, unknown>): boolean => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return false
    }
    ws.send(JSON.stringify(payload))
    return true
  }

  const sendBlob = async (blob: Blob) => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return
    }
    const data = await blob.arrayBuffer()
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data)
    }
  }

  const startMessage = (purpose: Exclude<CapturePurpose, 'none'>) => ({
    event: 'start',
    mimeType: recorderMimeTypeRef.current,
    language: 'en',
    // Lets the backend skip live-caption passes for wake checks, and strip
    // the wake phrase from a sentry turn.
    purpose,
    ...(conversationIdRef.current ? { conversationId: conversationIdRef.current } : {}),
  })

  const startCapture = (purpose: Exclude<CapturePurpose, 'none'>) => {
    if (captureStartedRef.current) {
      return
    }
    if (!mediaStreamRef.current) {
      return
    }

    // Re-sync from storage: the chat hook owns "New conversation" and clears
    // the stored id there. Without this, the voice path keeps speaking into
    // the old (now closed) conversation.
    conversationIdRef.current = loadConversationId() || null

    // Through the delay line when the audio graph is running; a suspended
    // context would hand the recorder silence, so fall back to the raw mic
    // (no pre-roll) rather than risk an empty turn.
    const delayed =
      audioContextRef.current?.state === 'running' ? recordStreamRef.current : null
    const recordStream = delayed ?? mediaStreamRef.current
    const mimeType = bestMimeType()
    const recorder = mimeType
      ? new MediaRecorder(recordStream, { mimeType })
      : new MediaRecorder(recordStream)
    recorderMimeTypeRef.current = recorder.mimeType || recorderMimeTypeRef.current

    // A sentry capture tells the backend nothing until it is promoted. Any
    // other capture is held too while the socket is down, and goes out as
    // soon as it is back, rather than the turn failing silently.
    const held = purpose === 'sentry' || !sendSocketEvent(startMessage(purpose))

    const capture: ActiveCapture = {
      purpose,
      recorder,
      held,
      heldChunks: [],
      promoted: false,
      discarded: false,
      utteranceEnded: false,
      delivery: Promise.resolve(),
      lagMs: delayed ? PREROLL_MS : 0,
    }
    activeCaptureRef.current = capture

    captureStartedRef.current = true
    capturePurposeRef.current = purpose
    if (purpose === 'turn') {
      suppressAssistantAudioUntilNextTurnRef.current = false
      resetAssistantTurnContent()
    }
    pendingStopPurposeRef.current = null

    // Chunk delivery is chained so the stop message can wait its turn. Two
    // subtleties, both of which lose the END of the user's last word if
    // ignored:
    //  - ondataavailable has to await the Blob before it can send, so a stop
    //    message sent synchronously from onstop OVERTAKES the recorder's
    //    final flush — the backend transcribes a buffer missing the tail.
    //  - an "is capture still on?" guard here would drop that same final
    //    flush, because stopCapture clears the flag before the recorder
    //    emits it. The backend already ignores chunks outside a recording,
    //    so no client-side gate is needed.
    // Whether a chunk is held is decided when its turn in the chain comes,
    // not when it arrives, so held chunks always go out before later ones.
    recorder.ondataavailable = (event: BlobEvent) => {
      if (!event.data || event.data.size === 0) {
        return
      }
      const blob = event.data
      capture.delivery = capture.delivery
        .then(async () => {
          if (capture.discarded) {
            return
          }
          if (capture.held) {
            capture.heldChunks.push(blob)
            return
          }
          await sendBlob(blob)
        })
        .catch(() => {
          // A failed chunk send must not also swallow the stop message.
        })
    }

    recorder.onstop = () => {
      const stopPurpose = pendingStopPurposeRef.current
      pendingStopPurposeRef.current = null
      if (activeCaptureRef.current === capture) {
        activeCaptureRef.current = null
      }
      if (!stopPurpose || capture.discarded) {
        return
      }
      void capture.delivery.then(() => {
        // Gave up waiting for the socket after this stop was queued.
        if (capture.discarded) {
          return
        }
        sendSocketEvent({
          event: 'stop',
          purpose: stopPurpose,
          ...(conversationIdRef.current ? { conversationId: conversationIdRef.current } : {}),
        })
      })
    }

    recorder.start(450)
    mediaRecorderRef.current = recorder

    if (held && purpose !== 'sentry') {
      promoteCapture(capture)
    }
  }

  /**
   * Send a held capture: the start message, then everything recorded so far.
   *
   * Waits for the socket first. A request spoken while it was down (the
   * laptop just woke, the tower's API just restarted) goes out once it
   * reconnects instead of being dropped; if it does not come back in time,
   * say so with the cancel tone rather than listening into nothing.
   */
  const promoteCapture = (capture: ActiveCapture) => {
    if (!capture.held || capture.promoted || capture.discarded) {
      return
    }
    capture.promoted = true
    suppressAssistantAudioUntilNextTurnRef.current = false
    resetAssistantTurnContent()
    capture.delivery = capture.delivery
      .then(async () => {
        const open = await waitForOpenSocket(SOCKET_WAIT_MS)
        if (capture.discarded) {
          return
        }
        if (!open) {
          abandonCapture(capture)
          return
        }
        sendSocketEvent(startMessage(capture.purpose))
        for (const blob of capture.heldChunks) {
          await sendBlob(blob)
        }
        capture.heldChunks = []
        capture.held = false
      })
      .catch(() => {})
  }

  /** The socket never came back for this capture: drop it and stand down audibly. */
  const abandonCapture = (capture: ActiveCapture) => {
    capture.discarded = true
    capture.heldChunks = []
    if (activeCaptureRef.current === capture) {
      activeCaptureRef.current = null
      captureStartedRef.current = false
      capturePurposeRef.current = 'none'
      pendingStopPurposeRef.current = null
    }
    if (capture.recorder.state !== 'inactive') {
      capture.recorder.stop()
    }
    optionsRef.current.onPartialUserTranscript?.('')
    playEarcon('cancel')
    setIdle(
      voiceModeRef.current === 'sentry'
        ? SENTRY_WAITING_MESSAGE
        : "Couldn't reach Nova. Reconnecting...",
    )
  }

  const clearSentryGrace = () => {
    if (sentryGraceTimerRef.current !== null) {
      window.clearTimeout(sentryGraceTimerRef.current)
      sentryGraceTimerRef.current = null
    }
  }

  const clearSentryListenTimeout = () => {
    if (sentryListenTimerRef.current !== null) {
      window.clearTimeout(sentryListenTimerRef.current)
      sentryListenTimerRef.current = null
    }
  }

  /** Drop a sentry capture that was never woken. Nothing was sent, so nothing to tell the backend. */
  const discardSentryCapture = () => {
    clearSentryGrace()
    const capture = activeCaptureRef.current
    if (!capture || capture.purpose !== 'sentry' || capture.promoted) {
      return
    }
    capture.discarded = true
    capture.heldChunks = []
    activeCaptureRef.current = null
    captureStartedRef.current = false
    capturePurposeRef.current = 'none'
    pendingStopPurposeRef.current = null
    if (capture.recorder.state !== 'inactive') {
      capture.recorder.stop()
    }
  }

  const stopCapture = (purpose: Exclude<CapturePurpose, 'none'>) => {
    if (!captureStartedRef.current) {
      return
    }

    captureStartedRef.current = false
    capturePurposeRef.current = 'none'
    pendingStopPurposeRef.current = purpose

    const recorder = mediaRecorderRef.current
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop()
      return
    }

    pendingStopPurposeRef.current = null
    sendSocketEvent({
      event: 'stop',
      purpose,
      ...(conversationIdRef.current ? { conversationId: conversationIdRef.current } : {}),
    })
  }

  // Capture opened on what turned out to be a click, not speech: tear it down
  // without transcribing anything. `pendingStopPurposeRef` stays null so the
  // recorder's onstop sends nothing; the explicit abort tells the backend to
  // drop the buffered noise instead of merging it into the next real turn.
  const abortCapture = () => {
    const purpose = capturePurposeRef.current
    if (!captureStartedRef.current || (purpose !== 'turn' && purpose !== 'sentry')) {
      return
    }

    captureStartedRef.current = false
    capturePurposeRef.current = 'none'
    pendingStopPurposeRef.current = null
    const capture = activeCaptureRef.current
    if (capture) {
      // Still waiting on the socket: make sure it is never sent.
      capture.discarded = capture.held
      activeCaptureRef.current = null
    }

    const recorder = mediaRecorderRef.current
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop()
    }
    sendSocketEvent({ event: 'abort' })
  }

  const enqueueStreamAudio = (streamId: string) => {
    audioQueueRef.current.push({ kind: 'stream', streamId })
  }

  const getAgentAudioElement = (): HTMLAudioElement => {
    if (!agentAudioElementRef.current) {
      const audio = new Audio()
      audio.preload = 'auto'
      // iOS: without this an <audio> with a video-capable container can try
      // to go fullscreen. Harmless elsewhere.
      audio.setAttribute('playsinline', '')
      agentAudioElementRef.current = audio
    }
    return agentAudioElementRef.current
  }

  /**
   * Make Nova audible on iOS. Must run synchronously inside a user gesture.
   *
   * Plays a silent clip through the shared element so Safari marks it as
   * user-activated, and creates/resumes the agent AudioContext while the
   * gesture is live. Both are one-time; afterwards replies that arrive over
   * the socket may start on their own. Wired to the power tap, the retry
   * tap, the "Enable sound" button, and the first tap anywhere on the page.
   */
  const unlockAudio = () => {
    primeEarcons()
    if (audioUnlockedRef.current) {
      return
    }

    // Create the context inside the gesture (the async body runs to its
    // first await synchronously) and resume it if it started suspended.
    void ensureAgentAudioGraph()
    const audioContext = agentAudioContextRef.current
    if (audioContext && audioContext.state === 'suspended') {
      void audioContext.resume().catch(() => {})
    }

    // A clip is already playing, so the browser has evidently allowed it; do
    // not interrupt it with the silent clip.
    if (activeAgentAudioRef.current) {
      audioUnlockedRef.current = true
      setNeedsSoundUnlock(false)
      return
    }

    const audio = getAgentAudioElement()
    audio.src = SILENT_CLIP_DATA_URI
    const attempt = audio.play()
    if (attempt) {
      attempt
        .then(() => {
          audioUnlockedRef.current = true
          setNeedsSoundUnlock(false)
        })
        .catch(() => {
          // Still locked; the "Enable sound" button stays until a tap works.
        })
    }
  }

  const ensureAgentAudioGraph = (): Promise<boolean> => {
    if (!agentGraphReadyRef.current) {
      agentGraphReadyRef.current = (async () => {
        // One long-lived context for all agent playback. The level meter runs
        // as an AudioWorklet on the audio thread, so the face tab (and the
        // aura) keep getting levels even while this tab is hidden — a rAF
        // loop would freeze the mouth the moment the tab loses visibility.
        const audioContext = new window.AudioContext()
        agentAudioContextRef.current = audioContext
        try {
          await audioContext.audioWorklet.addModule('/level-meter-worklet.js')
          const meter = new AudioWorkletNode(audioContext, 'level-meter')
          meter.connect(audioContext.destination)
          meter.port.onmessage = (event: MessageEvent<number>) => {
            const raw = event.data
            const current = agentLevelSmoothedRef.current
            // Fast attack, slow release: consonants pop, decays feel natural.
            const rate = raw > current ? 0.55 : 0.25
            const smoothed = current + (raw - current) * rate
            agentLevelSmoothedRef.current = smoothed
            setAgentAudioLevel(smoothed)
            publishFaceLevel(smoothed)
          }
          agentMeterNodeRef.current = meter
          return true
        } catch {
          // No metering, but audio still must play: clips connect straight
          // to the destination instead.
          return false
        }
      })()
    }
    return agentGraphReadyRef.current
  }

  const startAgentAudioAnalysis = async (audio: HTMLAudioElement) => {
    cleanupAgentAudioAnalysis()

    const hasMeter = await ensureAgentAudioGraph()
    const audioContext = agentAudioContextRef.current
    if (!audioContext) {
      return
    }

    if (audioContext.state === 'suspended') {
      // resume() can hang on iOS when no gesture has happened yet, so it is
      // raced rather than awaited outright.
      await Promise.race([
        audioContext.resume().catch(() => undefined),
        new Promise<void>((resolve) => window.setTimeout(resolve, 400)),
      ])
    }

    // Already wired: the same element plays every clip, and a media element
    // may only be turned into a source once.
    if (agentSourceNodeRef.current) {
      return
    }

    // Wiring an element into a context that is not running would mute it,
    // permanently, since the element's sound then only exists inside the
    // context. Better an unmetered clip than a silent one: skip the meter
    // for now and try again on the next clip.
    if (audioContext.state !== 'running') {
      return
    }

    try {
      const source = audioContext.createMediaElementSource(audio)
      if (hasMeter && agentMeterNodeRef.current) {
        source.connect(agentMeterNodeRef.current)
      } else {
        source.connect(audioContext.destination)
      }
      agentSourceNodeRef.current = source
    } catch {
      setAgentAudioLevel(0)
    }
  }

  /** What to do when play() is refused: name it, and offer the tap that fixes it. */
  const handlePlaybackRefused = (error: unknown) => {
    const name = error instanceof Error ? error.name : ''
    if (name === 'NotAllowedError') {
      audioUnlockedRef.current = false
      setNeedsSoundUnlock(true)
      setStatusMessage('Tap "Enable sound" to hear Nova.')
    } else {
      setStatusMessage('Tap anywhere if browser blocks autoplay.')
    }
  }

  const playStreamClip = async (streamBuffer: StreamAudioBuffer) => {
    const supportsMse =
      typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(streamBuffer.mimeType)

    if (!supportsMse) {
      while (!streamBuffer.ended) {
        await waitForNextStreamSignal(streamBuffer)
      }
      cleanupAudioUrl()
      const streamBlob = new Blob(streamBuffer.chunks, { type: streamBuffer.mimeType })
      const streamUrl = URL.createObjectURL(streamBlob)
      currentAudioUrlRef.current = streamUrl
      const audio = getAgentAudioElement()
      audio.src = streamUrl
      activeAgentAudioRef.current = audio
      await startAgentAudioAnalysis(audio)
      try {
        await audio.play()
        audioUnlockedRef.current = true
        setNeedsSoundUnlock(false)
      } catch (error) {
        handlePlaybackRefused(error)
        if (activeAgentAudioRef.current === audio) {
          activeAgentAudioRef.current = null
        }
        throw error
      }
      await new Promise<void>((resolve) => {
        const finish = () => {
          if (activePlaybackDoneRef.current === finish) {
            activePlaybackDoneRef.current = null
          }
          resolve()
        }
        activePlaybackDoneRef.current = finish
        audio.onended = finish
        audio.onerror = finish
      })
      if (activeAgentAudioRef.current === audio) {
        activeAgentAudioRef.current = null
      }
      cleanupAgentAudioAnalysis()
      return
    }

    cleanupAudioUrl()

    const mediaSource = new MediaSource()
    const audioUrl = URL.createObjectURL(mediaSource)
    currentAudioUrlRef.current = audioUrl

    const audio = getAgentAudioElement()
    audio.src = audioUrl
    activeAgentAudioRef.current = audio
    // Kick off the meter hookup but do NOT await it yet: 'sourceopen' can
    // fire while the worklet module is still loading, and a listener attached
    // after the fact would leave this promise — and the whole speaking
    // phase — hanging forever.
    const analysisReady = startAgentAudioAnalysis(audio)

    const sourceBuffer = await new Promise<SourceBuffer>((resolve, reject) => {
      const onOpen = () => {
        try {
          const buffer = mediaSource.addSourceBuffer(streamBuffer.mimeType)
          buffer.mode = 'sequence'
          resolve(buffer)
        } catch {
          reject(new Error('Could not create streaming source buffer.'))
        }
      }

      if (mediaSource.readyState === 'open') {
        onOpen()
        return
      }
      mediaSource.addEventListener('sourceopen', onOpen, { once: true })
      mediaSource.addEventListener('error', () => reject(new Error('MediaSource error.')), {
        once: true,
      })
    })

    await analysisReady

    let playTriggered = false
    const appendChunk = async (chunk: ArrayBuffer) =>
      new Promise<void>((resolve, reject) => {
        const onUpdateEnd = () => resolve()
        const onError = () => reject(new Error('SourceBuffer append error.'))

        sourceBuffer.addEventListener('updateend', onUpdateEnd, { once: true })
        sourceBuffer.addEventListener('error', onError, { once: true })
        sourceBuffer.appendBuffer(chunk)
      })

    const playbackFinished = new Promise<void>((resolve) => {
      const finish = () => {
        if (activePlaybackDoneRef.current === finish) {
          activePlaybackDoneRef.current = null
        }
        resolve()
      }
      activePlaybackDoneRef.current = finish
      audio.onended = finish
      audio.onerror = finish
    })

    while (true) {
      if (suppressAssistantAudioUntilNextTurnRef.current) {
        break
      }
      const nextChunk = streamBuffer.chunks.shift()
      if (nextChunk) {
        await appendChunk(nextChunk)
        if (!playTriggered) {
          playTriggered = true
          void audio
            .play()
            .then(() => {
              audioUnlockedRef.current = true
              setNeedsSoundUnlock(false)
            })
            .catch(handlePlaybackRefused)
        }
        continue
      }

      if (streamBuffer.ended) {
        if (mediaSource.readyState === 'open') {
          mediaSource.endOfStream()
        }
        break
      }

      await waitForNextStreamSignal(streamBuffer)
    }

    if (!playTriggered) {
      if (activeAgentAudioRef.current === audio) {
        activeAgentAudioRef.current = null
      }
      cleanupAgentAudioAnalysis()
      return
    }

    await playbackFinished
    if (activeAgentAudioRef.current === audio) {
      activeAgentAudioRef.current = null
    }
    cleanupAgentAudioAnalysis()
  }

  const maybeFinalizeListeningTransitions = () => {
    if (pendingSentryReturnRef.current) {
      pendingSentryReturnRef.current = false
      pendingFollowUpListeningRef.current = false
      returnToSentryWaiting('done')
      return
    }

    if (pendingWakeListeningRef.current) {
      pendingWakeListeningRef.current = false
      setListening('Hi, I\'m listening.')
      return
    }

    if (pendingFollowUpListeningRef.current) {
      pendingFollowUpListeningRef.current = false
      setListening('Nova is ready for a follow-up.')
    }
  }

  const drainAudioQueue = async () => {
    if (isAudioQueueRunningRef.current) {
      return
    }

    isAudioQueueRunningRef.current = true
    try {
      while (audioQueueRef.current.length > 0) {
        if (suppressAssistantAudioUntilNextTurnRef.current) {
          audioQueueRef.current = []
          break
        }
        const next = audioQueueRef.current.shift()
        if (!next) {
          continue
        }

        try {
          const streamBuffer = streamBuffersRef.current.get(next.streamId)
          if (streamBuffer) {
            setResponding('Nova is speaking...')
            await playStreamClip(streamBuffer)
          }
        } catch {
          setStatusMessage('Skipped one audio clip due to playback error.')
        } finally {
          streamBuffersRef.current.delete(next.streamId)
        }
      }
    } finally {
      isAudioQueueRunningRef.current = false
      maybeFinalizeListeningTransitions()
    }
  }

  const returnToSentryWaiting = (cue: 'done' | 'cancel') => {
    clearSentryListenTimeout()
    playEarcon(cue)
    setIdle(SENTRY_WAITING_MESSAGE)
  }

  /** Woken in sentry mode with nothing asked yet: wait a while, then stand down. */
  const armSentryListenTimeout = () => {
    clearSentryListenTimeout()
    if (voiceModeRef.current !== 'sentry') {
      return
    }
    sentryListenTimerRef.current = window.setTimeout(() => {
      sentryListenTimerRef.current = null
      if (
        voiceModeRef.current === 'sentry' &&
        uiPhaseRef.current === 'listening' &&
        !captureStartedRef.current
      ) {
        returnToSentryWaiting('cancel')
      }
    }, SENTRY_LISTEN_TIMEOUT_MS)
  }

  // Conversation mode's wake: a chime and straight to listening. It used to
  // speak "Hello sir" first, which cost a TTS round trip before the user
  // could say anything.
  const triggerWakeGreeting = () => {
    if (uiPhaseRef.current !== 'idle') {
      return
    }
    playEarcon('wake')
    setListening("I'm listening.")
  }

  const handleSentryWake = () => {
    const capture = activeCaptureRef.current
    playEarcon('wake')
    if (capture && capture.purpose === 'sentry' && !capture.promoted && !capture.discarded) {
      clearSentryGrace()
      promoteCapture(capture)
      markListening("I'm listening.")
      // The utterance already ended ("Hey Nova." and a pause) before the
      // recognizer caught up: send it now rather than waiting on silence.
      if (capture.utteranceEnded) {
        stopCapture('sentry')
        setThinking('Transcribing and generating response...')
      }
      return
    }
    // The recognizer heard it but no recording was running (the voice
    // detector missed the start): treat it as a bare wake and listen.
    setListening("I'm listening.")
    armSentryListenTimeout()
    if (!wsRef.current) {
      void reconnectSocket()
    }
  }

  const triggerWakeBargeIn = () => {
    if (uiPhaseRef.current !== 'responding') {
      return
    }

    playEarcon('wake')
    suppressAssistantAudioUntilNextTurnRef.current = true
    pendingWakeListeningRef.current = false
    pendingFollowUpListeningRef.current = false
    pendingSentryReturnRef.current = false
    audioQueueRef.current = []
    streamBuffersRef.current.forEach((streamBuffer) => {
      streamBuffer.ended = true
      notifyStreamWaiters(streamBuffer)
    })
    streamBuffersRef.current.clear()
    stopActiveAgentAudioPlayback()
    setListening("I'm listening.")
    armSentryListenTimeout()
  }

  const maybeStartWakeRecognition = () => {
    const SpeechRecognitionCtor = (
      window as unknown as {
        SpeechRecognition?: new () => SpeechRecognitionLike
        webkitSpeechRecognition?: new () => SpeechRecognitionLike
      }
    ).SpeechRecognition
      ?? (
        window as unknown as {
          SpeechRecognition?: new () => SpeechRecognitionLike
          webkitSpeechRecognition?: new () => SpeechRecognitionLike
        }
      ).webkitSpeechRecognition

    if (!SpeechRecognitionCtor) {
      wakeDetectModeRef.current = 'disabled'
      return
    }

    const recognition = new SpeechRecognitionCtor()
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = 'en-US'

    recognition.onresult = (event) => {
      const sentry = voiceModeRef.current === 'sentry'
      let woke = false
      if (sentry) {
        // Each result is one phrase; the wake phrase has to open one.
        const handled = handledWakeResultRef.current
        const lastHandled = handled.recognition === recognition ? handled.index : -1
        for (let i = Math.max(event.resultIndex, lastHandled + 1); i < event.results.length; i += 1) {
          if (startsWithWakePhrase(event.results[i][0].transcript)) {
            handledWakeResultRef.current = { recognition, index: i }
            woke = true
            break
          }
        }
      } else {
        let transcript = ''
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          transcript += ` ${event.results[i][0].transcript}`
        }
        woke = containsWakePhrase(transcript)
      }

      if (!woke) {
        return
      }

      if (uiPhaseRef.current === 'responding') {
        triggerWakeBargeIn()
        return
      }

      if (uiPhaseRef.current === 'idle') {
        if (sentry) {
          handleSentryWake()
        } else {
          triggerWakeGreeting()
        }
      }
    }

    recognition.onend = () => {
      // Deliberately stopped (power off, meeting mode) — stay stopped.
      if (speechRecognitionRef.current !== recognition) {
        return
      }
      speechRecognitionRef.current = null
      recognition.onresult = null
      recognition.onend = null
      recognition.onerror = null

      // Chrome ends continuous sessions on its own after silence or a
      // recognizer recycle. Restart with a fresh instance — reusing the
      // ended one can throw "already started" on some platforms — after a
      // short delay so an error/end loop can't spin hot.
      wakeRestartTimerRef.current = window.setTimeout(() => {
        wakeRestartTimerRef.current = null
        if (
          !isNovaEnabledRef.current ||
          isShuttingDownRef.current ||
          speechRecognitionRef.current
        ) {
          return
        }
        maybeStartWakeRecognition()
      }, 300)
    }

    recognition.onerror = (event) => {
      // Only mic-permission failures are terminal. Everything else Chrome
      // throws routinely (no-speech after silence, network, aborted) is
      // recoverable: leave the ref in place so onend restarts a fresh
      // session. Disabling here is what used to kill "nova" after a long
      // idle stretch.
      if (event?.error === 'not-allowed' || event?.error === 'service-not-allowed') {
        wakeDetectModeRef.current = 'disabled'
        stopWakeRecognition()
      }
    }

    try {
      recognition.start()
      speechRecognitionRef.current = recognition
      wakeDetectModeRef.current = 'browser'
    } catch {
      wakeDetectModeRef.current = 'disabled'
    }
  }

  const handleSocketEvent = (payload: SocketEvent) => {
    if (payload.type === 'ready') {
      if (pendingPowerOnListenRef.current) {
        pendingPowerOnListenRef.current = false
        setListening("I'm listening.")
        armSentryListenTimeout()
        return
      }
      // On a reconnect a request may be waiting on this socket; leave it be.
      if (uiPhaseRef.current === 'idle') {
        setIdle(voiceModeRef.current === 'sentry' ? SENTRY_WAITING_MESSAGE : 'Idle.')
      }
      return
    }

    if (payload.type === 'listening') {
      if (capturePurposeRef.current === 'turn' || capturePurposeRef.current === 'sentry') {
        setStatusMessage(payload.message)
        // Starting window, until the first caption gives the backend's scorer
        // something to read.
        if (payload.endpointMs) {
          turnDetectorRef.current?.setSilenceWindow(payload.endpointMs)
        }
      }
      return
    }

    if (payload.type === 'chunk_received') {
      if (capturePurposeRef.current === 'turn') {
        setStatusMessage('Listening...')
      }
      return
    }

    if (payload.type === 'assistant_audio_stream_start') {
      if (suppressAssistantAudioUntilNextTurnRef.current) {
        return
      }
      const streamBuffer: StreamAudioBuffer = {
        streamId: payload.streamId,
        mimeType: payload.mimeType,
        role: payload.role,
        chunks: [],
        ended: false,
        waiters: [],
      }
      streamBuffersRef.current.set(payload.streamId, streamBuffer)
      enqueueStreamAudio(payload.streamId)
      void drainAudioQueue()
      return
    }

    if (payload.type === 'assistant_audio_stream_chunk') {
      if (suppressAssistantAudioUntilNextTurnRef.current) {
        return
      }
      const streamBuffer = streamBuffersRef.current.get(payload.streamId)
      if (!streamBuffer) {
        return
      }
      streamBuffer.chunks.push(base64ToArrayBuffer(payload.chunkBase64))
      notifyStreamWaiters(streamBuffer)
      return
    }

    if (payload.type === 'assistant_audio_stream_end') {
      if (suppressAssistantAudioUntilNextTurnRef.current) {
        return
      }
      const streamBuffer = streamBuffersRef.current.get(payload.streamId)
      if (!streamBuffer) {
        return
      }
      streamBuffer.ended = true
      notifyStreamWaiters(streamBuffer)
      return
    }

    if (payload.type === 'wake_greeting_done') {
      pendingWakeListeningRef.current = true
      if (!isAudioQueueRunningRef.current && audioQueueRef.current.length === 0) {
        maybeFinalizeListeningTransitions()
      }
      return
    }

    if (payload.type === 'wake_not_detected') {
      setIdle(payload.message)
      return
    }

    if (payload.type === 'wake_only') {
      // "Hey Nova" on its own: the chime already played, now take the request.
      optionsRef.current.onPartialUserTranscript?.('')
      setListening("I'm listening.")
      armSentryListenTimeout()
      return
    }

    if (payload.type === 'follow_up_stopped') {
      // Stop phrase spoken — no user_transcript follows, drop the caption.
      optionsRef.current.onPartialUserTranscript?.('')
      clearSentryListenTimeout()
      playEarcon('done')
      setIdle(voiceModeRef.current === 'sentry' ? SENTRY_WAITING_MESSAGE : payload.message)
      return
    }

    if (payload.type === 'no_speech') {
      optionsRef.current.onPartialUserTranscript?.('')
      if (voiceModeRef.current === 'sentry') {
        returnToSentryWaiting('cancel')
        return
      }
      setListening('Still listening...')
      return
    }

    if (payload.type === 'partial_transcript') {
      // Live caption of an in-progress recording; only meaningful mid-turn.
      if (capturePurposeRef.current === 'turn' || capturePurposeRef.current === 'sentry') {
        optionsRef.current.onPartialUserTranscript?.(payload.text)
        // The caption also carries how long silence should now have to last
        // before the turn is called over: short once the sentence resolves,
        // long while it trails off mid-thought. This is the semantic half of
        // turn detection -- the detector only measures the silence.
        if (payload.endpointMs) {
          turnDetectorRef.current?.setSilenceWindow(payload.endpointMs)
        }
      }
      return
    }

    if (payload.type === 'user_transcript') {
      persistConversationId(payload.conversationId)
      optionsRef.current.onUserTranscript?.(payload.text)
      return
    }

    if (payload.type === 'tool_call' || payload.type === 'artifact') {
      optionsRef.current.onAgentEvent?.(payload as unknown as ChatStreamEvent)
      return
    }

    if (payload.type === 'text_final') {
      optionsRef.current.onAgentEvent?.({
        type: 'text_final',
        text: payload.text,
        format: 'markdown',
      })
      return
    }

    if (payload.type === 'status_text') {
      // Pre-tool acknowledgment; its audio arrives via the usual TTS stream
      // events, this only places the line in the transcript.
      if (suppressAssistantAudioUntilNextTurnRef.current) {
        return
      }
      persistConversationId(payload.conversationId)
      optionsRef.current.onAgentEvent?.({
        type: 'status_text',
        text: payload.text,
      })
      return
    }

    if (payload.type === 'assistant_text') {
      if (suppressAssistantAudioUntilNextTurnRef.current) {
        return
      }
      persistConversationId(payload.conversationId)
      // Screen only. This is the full written answer, which is now allowed to
      // be as long as the question deserves precisely because nobody has to
      // listen to it.
      optionsRef.current.onAgentEvent?.({
        type: 'delta',
        text: payload.text,
        seq: payload.seq,
        format: 'markdown',
      })
      return
    }

    if (payload.type === 'speech_text') {
      // The spoken half of the turn. Its audio follows immediately as the
      // usual TTS stream events; this is the text of that audio, kept out of
      // the transcript because the written answer already says it at length.
      if (suppressAssistantAudioUntilNextTurnRef.current) {
        return
      }
      persistConversationId(payload.conversationId)
      appendSpokenLine(payload.text)
      return
    }

    if (payload.type === 'done') {
      if (suppressAssistantAudioUntilNextTurnRef.current) {
        return
      }
      persistConversationId(payload.conversationId)
      optionsRef.current.onTurnComplete?.(payload.conversationId)
      // Deliberately not setAssistantText: `assistantText` on the done event
      // is the written answer, and this state tracks what was spoken. The
      // speech_text events already filled it in.
      // Conversation mode listens for a follow-up; sentry goes back to
      // waiting for the wake phrase. Either way, after the reply has played.
      if (voiceModeRef.current === 'sentry') {
        pendingSentryReturnRef.current = true
      } else {
        pendingFollowUpListeningRef.current = true
      }
      setStatusMessage(payload.message)
      if (!isAudioQueueRunningRef.current && audioQueueRef.current.length === 0) {
        maybeFinalizeListeningTransitions()
      }
      return
    }

    if (payload.type === 'error') {
      optionsRef.current.onPartialUserTranscript?.('')
      streamBuffersRef.current.forEach((streamBuffer) => {
        streamBuffer.ended = true
        notifyStreamWaiters(streamBuffer)
      })
      if (
        payload.message.includes('Invalid conversationId') ||
        payload.code === 'conversation_closed'
      ) {
        conversationIdRef.current = null
        clearConversationId()
      }
      // Idle, not thinking: an error ends the turn, and nothing else will
      // transition the phase afterwards — thinking would be stuck forever.
      setIdle(payload.message)
      captureStartedRef.current = false
      capturePurposeRef.current = 'none'
    }
  }

  const startAudioAnalysis = (stream: MediaStream) => {
    cleanupAudioAnalysis()

    const audioContext = new window.AudioContext()
    const analyser = audioContext.createAnalyser()
    const source = audioContext.createMediaStreamSource(stream)

    analyser.fftSize = 1024
    analyser.smoothingTimeConstant = 0.82

    source.connect(analyser)

    // The pre-roll tap: the same mic through a delay line, for the recorder.
    const preroll = audioContext.createDelay(1)
    preroll.delayTime.value = PREROLL_MS / 1000
    const recordTap = audioContext.createMediaStreamDestination()
    recordTap.channelCount = 1
    source.connect(preroll)
    preroll.connect(recordTap)
    prerollNodeRef.current = preroll
    recordStreamRef.current = recordTap.stream

    audioContextRef.current = audioContext
    analyserRef.current = analyser
    sourceNodeRef.current = source
    analysisDataRef.current = new Uint8Array<ArrayBuffer>(new ArrayBuffer(analyser.fftSize))

    turnDetectorRef.current = createTurnDetector({
      onSpeechOnset: () => turnHandlersRef.current?.onSpeechOnset(),
      onSpeechStart: () => turnHandlersRef.current?.onSpeechStart(),
      onSpeechPause: () => turnHandlersRef.current?.onSpeechPause(),
      onSpeechResume: () => turnHandlersRef.current?.onSpeechResume(),
      onSpeechAbort: () => turnHandlersRef.current?.onSpeechAbort(),
      onTurnEnd: () => turnHandlersRef.current?.onTurnEnd(),
      onSpeakingChange: setIsSpeaking,
    })

    let smoothed = 0
    let lastPublishedAt = 0
    let lastTickAt = performance.now()

    // Fed one RMS reading at a time, from whichever source is running.
    // Deliberately NOT requestAnimationFrame: rAF stops completely while the
    // tab is hidden — and the user watches the face page or the server logs
    // while talking, so a rAF-driven detector froze mid-turn. All smoothing
    // is dt-aware, so the cadence of the source alters resolution, not
    // behavior.
    const applyLevel = (rms: number) => {
      const amplified = Math.min(1, rms * 2.8)

      const now = performance.now()
      const dt = Math.max(1, now - lastTickAt)
      lastTickAt = now
      // ~90ms time constant, matching the old 0.18-per-frame feel at 60Hz.
      smoothed += (amplified - smoothed) * (1 - Math.exp(-dt / 90))

      turnDetectorRef.current?.push(smoothed, now)

      // React sees far fewer updates than the detector: the aura is a
      // visual, and re-rendering the runtime at tick rate while someone
      // talks was pure overhead. ~20Hz is past the point the eye can tell.
      if (now - lastPublishedAt >= 50) {
        lastPublishedAt = now
        setAudioLevel(smoothed)
      }
    }

    // Until the audio-thread meter is up (and if it never comes up), read
    // the analyser on a 25ms timer. Chrome throttles timers in hidden tabs —
    // to about once a minute after five minutes hidden — which starved the
    // detector of a Sentry tab left in the background: it chimed on "Hey
    // Nova" and then never heard the request. Hence the worklet below.
    const readAnalyser = () => {
      const activeAnalyser = analyserRef.current
      const activeData = analysisDataRef.current
      if (!activeAnalyser || !activeData) {
        return
      }
      activeAnalyser.getByteTimeDomainData(activeData)
      let sumSquares = 0
      for (let i = 0; i < activeData.length; i += 1) {
        const normalized = (activeData[i] - 128) / 128
        sumSquares += normalized * normalized
      }
      applyLevel(Math.sqrt(sumSquares / activeData.length))
    }
    analysisTimerRef.current = window.setInterval(readAnalyser, 25)

    // The audio thread is never throttled, and the messages it posts are
    // not timers, so this keeps the detector at full cadence in a hidden tab.
    void audioContext.audioWorklet
      .addModule('/mic-level-worklet.js')
      .then(() => {
        // Torn down (or rebuilt) while the module loaded.
        if (audioContextRef.current !== audioContext) {
          return
        }
        const meter = new AudioWorkletNode(audioContext, 'mic-level', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          channelCount: 1,
        })
        // A node only renders while something downstream pulls it; a muted
        // gain into the destination does that without making a sound.
        const sink = audioContext.createGain()
        sink.gain.value = 0
        meter.port.onmessage = (event: MessageEvent<number>) => applyLevel(event.data)
        source.connect(meter)
        meter.connect(sink)
        sink.connect(audioContext.destination)
        micMeterNodeRef.current = meter
        micMeterSinkRef.current = sink
        if (analysisTimerRef.current !== null) {
          window.clearInterval(analysisTimerRef.current)
          analysisTimerRef.current = null
        }
      })
      .catch(() => {
        // No worklet support: the timer above stays the source.
      })
  }

  const openSocket = async (): Promise<WebSocket> => {
    let lastConnectError = 'Unknown connection error.'
    for (const url of wsUrls) {
      try {
        return await new Promise<WebSocket>((resolve, reject) => {
          const candidate = new WebSocket(url)
          const timeout = window.setTimeout(() => {
            candidate.close()
            reject(new Error(`Timed out connecting to ${url}`))
          }, 6000)

          candidate.onopen = () => {
            window.clearTimeout(timeout)
            resolve(candidate)
          }
          candidate.onerror = () => {
            window.clearTimeout(timeout)
            reject(new Error(`WebSocket error for ${url}`))
          }
        })
      } catch (error) {
        lastConnectError = error instanceof Error ? error.message : String(error)
      }
    }
    throw new Error(`Unable to connect to backend websocket. ${lastConnectError}`)
  }

  const attachSocket = (ws: WebSocket) => {
    wsRef.current = ws
    reconnectAttemptRef.current = 0
    setIsConnected(true)

    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as SocketEvent
        handleSocketEvent(payload)
      } catch {
        setStatusMessage('Received non-JSON message from backend.')
      }
    }

    ws.onerror = () => {
      // onclose always follows; reconnecting is handled there.
    }

    ws.onclose = () => handleSocketClosed(ws)

    // Anything that was waiting for a socket (a request spoken while it was
    // down) can go now.
    const waiters = socketWaitersRef.current.splice(0)
    waiters.forEach((resolve) => resolve())
  }

  const handleSocketClosed = (ws: WebSocket) => {
    if (wsRef.current !== ws) {
      return
    }
    streamBuffersRef.current.forEach((streamBuffer) => {
      streamBuffer.ended = true
      notifyStreamWaiters(streamBuffer)
    })
    wsRef.current = null
    setIsConnected(false)

    // A turn the backend was receiving is gone with its connection. A held
    // capture (a sentry utterance still on this machine) is unaffected.
    const capture = activeCaptureRef.current
    if (capture && !capture.held) {
      capture.discarded = true
      activeCaptureRef.current = null
      captureStartedRef.current = false
      capturePurposeRef.current = 'none'
      pendingStopPurposeRef.current = null
      if (capture.recorder.state !== 'inactive') {
        capture.recorder.stop()
      }
    }

    if (!isNovaEnabledRef.current || isShuttingDownRef.current) {
      return
    }
    if (uiPhaseRef.current === 'thinking' || uiPhaseRef.current === 'responding') {
      playEarcon('cancel')
      setIdle(voiceModeRef.current === 'sentry' ? SENTRY_WAITING_MESSAGE : 'Reconnecting...')
    }
    scheduleReconnect()
  }

  const scheduleReconnect = () => {
    if (reconnectTimerRef.current !== null) {
      return
    }
    const attempt = reconnectAttemptRef.current
    const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)]
    reconnectAttemptRef.current = attempt + 1
    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = null
      void reconnectSocket()
    }, delay)
  }

  /** Re-open the socket now (not after the backoff), keeping the microphone as it is. */
  const reconnectSocket = async () => {
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    if (
      !isNovaEnabledRef.current ||
      isShuttingDownRef.current ||
      isConnectingRef.current ||
      wsRef.current
    ) {
      return
    }
    if (!mediaStreamRef.current) {
      // Never got as far as the microphone: start from the top.
      void initializeRuntime()
      return
    }
    isConnectingRef.current = true
    try {
      const ws = await openSocket()
      if (!isNovaEnabledRef.current || isShuttingDownRef.current) {
        ws.close()
        return
      }
      attachSocket(ws)
    } catch {
      scheduleReconnect()
    } finally {
      isConnectingRef.current = false
    }
  }

  /** Resolve true once the socket is open (reconnecting now if needed), false after `timeoutMs`. */
  const waitForOpenSocket = (timeoutMs: number) =>
    new Promise<boolean>((resolve) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        resolve(true)
        return
      }
      const waiter = () => {
        window.clearTimeout(timer)
        resolve(true)
      }
      const timer = window.setTimeout(() => {
        socketWaitersRef.current = socketWaitersRef.current.filter((w) => w !== waiter)
        resolve(false)
      }, timeoutMs)
      socketWaitersRef.current.push(waiter)
      void reconnectSocket()
    })

  // The microphone's track ends when the Mac sleeps or the input device
  // changes. Chrome's speech recognizer reopens the mic on its own, so the
  // wake chime would keep working while the recorder and detector listened
  // to a dead stream. Reopen it the same way.
  const watchMicTrack = (stream: MediaStream) => {
    stream.getAudioTracks().forEach((track) => {
      track.addEventListener('ended', () => {
        if (mediaStreamRef.current !== stream) {
          return
        }
        void restartMicrophone()
      })
    })
  }

  const restartMicrophone = async () => {
    if (!isNovaEnabledRef.current || isShuttingDownRef.current) {
      return
    }
    discardSentryCapture()
    try {
      const stream = await acquireAudioStream()
      if (!isNovaEnabledRef.current || isShuttingDownRef.current) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop())
      mediaStreamRef.current = stream
      startAudioAnalysis(stream)
      watchMicTrack(stream)
    } catch {
      window.setTimeout(() => void restartMicrophone(), 5000)
    }
  }

  const initializeRuntime = async () => {
    if (!isNovaEnabledRef.current) {
      return
    }
    if (isInitInFlightRef.current) {
      return
    }
    isInitInFlightRef.current = true
    isShuttingDownRef.current = false

    try {
      setStatusMessage('Requesting microphone permission...')
      const stream = await acquireAudioStream()
      if (!isNovaEnabledRef.current) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      awaitingMicrophoneRef.current = false
      setShowMicEnableButton(false)
      mediaStreamRef.current = stream
      startAudioAnalysis(stream)

      const mimeType = bestMimeType()
      recorderMimeTypeRef.current = mimeType ?? 'audio/webm'

      setStatusMessage('Connecting to Nova backend...')
      const ws = await openSocket()
      if (!isNovaEnabledRef.current) {
        ws.close()
        return
      }

      attachSocket(ws)
      setIdle(voiceModeRef.current === 'sentry' ? SENTRY_WAITING_MESSAGE : 'Idle.')
      maybeStartWakeRecognition()
      watchMicTrack(stream)

      mediaRecorderRef.current = null
    } catch (error) {
      if (!isNovaEnabledRef.current || isShuttingDownRef.current) {
        return
      }
      awaitingMicrophoneRef.current = true
      let extra = ''
      try {
        const devices = await navigator.mediaDevices.enumerateDevices()
        const micCount = devices.filter((device) => device.kind === 'audioinput').length
        extra = ` Chrome currently reports ${micCount} microphone input(s).`
      } catch {
        // ignore diagnostics failure
      }
      setIdle(`${describeMediaError(error)}${extra}`)
      shutdownRuntime(`${describeMediaError(error)}${extra}`)
    } finally {
      isInitInFlightRef.current = false
    }
  }

  const persistNovaPower = (enabled: boolean) => {
    void authFetch('/nova/power', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    }).catch(() => {
      // Backend power state is advisory; the local teardown is authoritative.
    })
  }

  const setNovaPower = (enabled: boolean) => {
    if (enabled === isNovaEnabledRef.current) {
      return
    }

    isNovaEnabledRef.current = enabled
    setIsNovaEnabled(enabled)
    persistNovaPower(enabled)
    if (!enabled) {
      shutdownRuntime('Nova is off. Turn Nova back on to resume.')
      return
    }

    setStatusMessage('Starting Nova...')
    // This is a tap: the one moment iOS lets us make the reply audible.
    unlockAudio()
    playBootupCue()
    pendingPowerOnListenRef.current = true
    void initializeRuntime()
  }

  const retryRuntime = () => {
    setStatusMessage('Retrying microphone setup...')
    unlockAudio()
    void initializeRuntime()
  }

  // Suspend/resume for meeting mode. Deliberately reuses the same teardown and
  // startup as the power toggle, so there is one way the runtime stops and one
  // way it starts, rather than a second half-parallel path.
  const suspended = options.suspended ?? false
  const wasSuspendedRef = useRef(false)

  useEffect(() => {
    if (suspended === wasSuspendedRef.current) {
      return
    }
    wasSuspendedRef.current = suspended

    if (suspended) {
      shutdownRuntime('Meeting in progress. Nova is transcribing, not listening for you.')
      return
    }
    if (isNovaEnabledRef.current) {
      setStatusMessage('Meeting ended. Nova is listening again.')
      void initializeRuntime()
    }
  }, [suspended]) // eslint-disable-line react-hooks/exhaustive-deps

  // What the detector does when it sees a transition. Kept in a ref because
  // the detector is created once, inside the analyser graph, and would
  // otherwise close over the first render's copies of these functions. Every
  // handler is guarded on the phase: the detector keeps running whenever the
  // microphone is open, but only a listening runtime should act on it.
  // Sentry is waiting for the wake phrase: every utterance is recorded
  // locally, just in case it opens with "Hey Nova".
  // Does not need the socket: the utterance is only recorded locally, and if
  // it turns out to be a wake the promotion waits for the socket to return.
  const isSentryWaiting = () =>
    voiceModeRef.current === 'sentry' &&
    uiPhaseRef.current === 'idle' &&
    isNovaEnabledRef.current &&
    Boolean(mediaStreamRef.current)

  // A capture the backend is receiving: a turn, or a sentry capture that has
  // been woken. A held sentry capture has not told the backend anything.
  const isLiveTurnCapture = () => {
    if (!captureStartedRef.current) {
      return false
    }
    if (capturePurposeRef.current === 'turn') {
      return true
    }
    return capturePurposeRef.current === 'sentry' && Boolean(activeCaptureRef.current?.promoted)
  }

  turnHandlersRef.current = {
    onSpeechOnset: () => {
      if (isSentryWaiting()) {
        if (!captureStartedRef.current) {
          startCapture('sentry')
        }
        return
      }
      if (uiPhaseRef.current !== 'listening') {
        return
      }
      clearSentryListenTimeout()
      // Start the recorder at the first sign of speech rather than after the
      // onset hold confirms it — confirmation costs 120ms, and a recorder
      // started then has already missed the first syllable. If the onset
      // turns out to be a click, onSpeechAbort unwinds this.
      if (!captureStartedRef.current) {
        startCapture('turn')
      }
    },
    onSpeechStart: () => {
      if (isSentryWaiting()) {
        if (!captureStartedRef.current) {
          startCapture('sentry')
        }
        return
      }
      if (uiPhaseRef.current !== 'listening') {
        return
      }
      clearSentryListenTimeout()
      // Capture normally began at onset; this is the backstop for the edge
      // where onset fired outside 'listening' and the phase changed since.
      if (!captureStartedRef.current) {
        startCapture('turn')
      }
    },
    onSpeechAbort: () => {
      const capture = activeCaptureRef.current
      if (capture?.purpose === 'sentry' && !capture.promoted) {
        discardSentryCapture()
        return
      }
      abortCapture()
      // A click while woken: keep waiting for the request, but not forever.
      if (uiPhaseRef.current === 'listening') {
        armSentryListenTimeout()
      }
    },
    onSpeechPause: () => {
      speechPausedAtRef.current = performance.now()
      if (uiPhaseRef.current !== 'listening') {
        return
      }
      const flush = () => {
        pauseFlushTimerRef.current = null
        if (uiPhaseRef.current !== 'listening' || !isLiveTurnCapture()) {
          return
        }
        // Flush the recorder first: the audio holding the last words is
        // still in its internal buffer, and the backend is about to
        // transcribe. The flushed chunk is what tells it the buffer is
        // complete through the pause.
        try {
          mediaRecorderRef.current?.requestData()
        } catch {
          // Some recorders (Safari mp4) can throw here; the next cadence
          // flush covers the tail, just later.
        }
        // The backend starts transcribing on this, so the work happens during
        // the silence window instead of after it.
        sendSocketEvent({ event: 'speech_pause' })
      }
      // The recording runs behind the live mic by the pre-roll, so the last
      // words have not reached it yet: flush once they have.
      const lag = activeCaptureRef.current?.lagMs ?? 0
      if (pauseFlushTimerRef.current !== null) {
        window.clearTimeout(pauseFlushTimerRef.current)
      }
      if (lag > 0) {
        pauseFlushTimerRef.current = window.setTimeout(flush, lag + PREROLL_SLACK_MS)
      } else {
        flush()
      }
    },
    onSpeechResume: () => {
      speechPausedAtRef.current = null
      if (pauseFlushTimerRef.current !== null) {
        // Talking again before the flush went out: there was no pause to report.
        window.clearTimeout(pauseFlushTimerRef.current)
        pauseFlushTimerRef.current = null
      }
      if (uiPhaseRef.current !== 'listening') {
        return
      }
      if (isLiveTurnCapture()) {
        sendSocketEvent({ event: 'speech_resume' })
      }
    },
    onTurnEnd: () => {
      const capture = activeCaptureRef.current
      if (capture?.purpose === 'sentry' && !capture.promoted) {
        // Over before the recognizer said whether it opened with "Nova":
        // give a late result a moment, then forget the utterance.
        capture.utteranceEnded = true
        clearSentryGrace()
        sentryGraceTimerRef.current = window.setTimeout(() => {
          sentryGraceTimerRef.current = null
          discardSentryCapture()
        }, SENTRY_WAKE_GRACE_MS)
        return
      }
      if (uiPhaseRef.current !== 'listening') {
        return
      }
      if (!isLiveTurnCapture()) {
        return
      }
      const purpose = capturePurposeRef.current === 'sentry' ? 'sentry' : 'turn'
      setThinking('Transcribing and generating response...')
      // The recording lags the mic by the pre-roll. The silence window is
      // normally longer than that, so the last words are already in; only a
      // window shorter than the lag (a low NOVA_ENDPOINT_SCALE) waits out
      // the difference, so the tail of the turn is never cut.
      const lag = activeCaptureRef.current?.lagMs ?? 0
      const silentFor =
        speechPausedAtRef.current === null ? 0 : performance.now() - speechPausedAtRef.current
      const wait = lag > 0 ? Math.max(0, lag + PREROLL_SLACK_MS - silentFor) : 0
      if (wait > 0) {
        window.setTimeout(() => stopCapture(purpose), wait)
      } else {
        stopCapture(purpose)
      }
    },
  }

  const setVoiceMode = (mode: VoiceMode) => {
    if (mode === voiceModeRef.current) {
      return
    }
    voiceModeRef.current = mode
    setVoiceModeState(mode)
    try {
      window.localStorage.setItem(voiceModeStorageKey, mode)
    } catch {
      // Not persisted; the mode still applies until reload.
    }
    // A tap: unlock audio so the first chime is not blocked.
    unlockAudio()

    if (mode === 'sentry') {
      // Waiting for follow-ups is exactly what sentry does not do. Mid-turn,
      // `done` will route back to waiting once the reply ends.
      if (uiPhaseRef.current === 'listening' && !captureStartedRef.current) {
        returnToSentryWaiting('done')
      } else if (uiPhaseRef.current === 'idle') {
        setStatusMessage(SENTRY_WAITING_MESSAGE)
      }
      return
    }

    clearSentryListenTimeout()
    discardSentryCapture()
    if (pendingSentryReturnRef.current) {
      pendingSentryReturnRef.current = false
      pendingFollowUpListeningRef.current = true
    }
  }

  useEffect(() => {
    let cancelled = false

    // Restore the persisted power state so a page refresh doesn't turn a
    // deliberately-off Nova back on.
    const boot = async () => {
      try {
        const response = await authFetch('/nova/power')
        if (response.ok) {
          const data = (await response.json()) as { enabled?: boolean }
          if (data.enabled === false) {
            if (cancelled) {
              return
            }
            isNovaEnabledRef.current = false
            setIsNovaEnabled(false)
            setShowMicEnableButton(false)
            setIdle('Nova is off. Turn Nova back on to resume.')
            return
          }
        }
      } catch {
        // Power state is a nicety; default to booting normally.
      }
      if (!cancelled) {
        void initializeRuntime()
      }
    }
    void boot()

    const streamBuffers = streamBuffersRef.current

    const handleDeviceChange = () => {
      if (!awaitingMicrophoneRef.current) {
        return
      }
      setStatusMessage('Microphone change detected. Click "Retry Nova" to retry.')
    }

    navigator.mediaDevices?.addEventListener?.('devicechange', handleDeviceChange)

    // Back from sleep or a network change: reconnect now rather than at the
    // next backoff step, so the first "Hey Nova" after it finds a socket.
    const reconnectIfDown = () => {
      if (document.visibilityState === 'visible' || navigator.onLine) {
        if (!wsRef.current) {
          void reconnectSocket()
        }
      }
    }
    window.addEventListener('online', reconnectIfDown)
    document.addEventListener('visibilitychange', reconnectIfDown)

    // Nova boots without a tap on page load, so the power button is not
    // guaranteed to be pressed before the first reply. Any first tap or key
    // on the page unlocks audio instead. Cheap: a no-op once unlocked.
    const gestureEvents = ['touchend', 'mousedown', 'keydown'] as const
    const handleFirstGesture = () => unlockAudio()
    gestureEvents.forEach((name) =>
      document.addEventListener(name, handleFirstGesture, { passive: true }),
    )

    return () => {
      cancelled = true
      gestureEvents.forEach((name) => document.removeEventListener(name, handleFirstGesture))
      navigator.mediaDevices?.removeEventListener?.('devicechange', handleDeviceChange)
      window.removeEventListener('online', reconnectIfDown)
      document.removeEventListener('visibilitychange', reconnectIfDown)
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
      streamBuffers.forEach((streamBuffer) => {
        streamBuffer.ended = true
        notifyStreamWaiters(streamBuffer)
      })
      streamBuffers.clear()
      stopActiveAgentAudioPlayback()
      cleanupMedia()
      closeAgentAudioGraph()
      closeSocket()
      cleanupAudioUrl()
      if (bootupCueAudioRef.current) {
        bootupCueAudioRef.current.pause()
        bootupCueAudioRef.current.src = ''
        bootupCueAudioRef.current = null
      }
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return {
    isNovaEnabled,
    showMicEnableButton,
    uiPhase,
    visualAudioLevel,
    combinedVoiceLevel,
    hasSpeechInput,
    assistantText,
    retryRuntime,
    setNovaPower,
    needsSoundUnlock,
    enableSound: unlockAudio,
    voiceMode,
    setVoiceMode,
    isConnected,
  }
}
