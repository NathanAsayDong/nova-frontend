import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChatStreamEvent } from '../chatTypes'
import bootupSfx from '../../../assets/bootup.mp3'
import idleSfx from '../../../assets/idle.mp3'
import type {
  AudioQueueItem,
  CapturePurpose,
  SocketEvent,
  SpeechRecognitionLike,
  StreamAudioBuffer,
  UiPhase,
} from '../types'
import {
  acquireAudioStream,
  base64ToArrayBuffer,
  bestMimeType,
  clearConversationId,
  containsWakePhrase,
  describeMediaError,
  loadConversationId,
  resolveWsUrls,
  saveConversationId,
} from '../utils'
import { createTurnDetector, type TurnDetector } from '../turnDetector'
import { publishFaceLevel } from '../../face/publisher'

type UseNovaRuntimeResult = {
  isNovaEnabled: boolean
  showMicEnableButton: boolean
  uiPhase: UiPhase
  visualAudioLevel: number
  combinedVoiceLevel: number
  hasSpeechInput: boolean
  assistantText: string
  retryRuntime: () => void
  setNovaPower: (enabled: boolean) => void
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
  /** Structured turn events (delta / text_final / tool_call / artifact). */
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
  const agentAudioContextRef = useRef<AudioContext | null>(null)
  const agentMeterNodeRef = useRef<AudioWorkletNode | null>(null)
  const agentSourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null)
  // Resolves true once the worklet graph is loaded; false if it failed and
  // playback should fall back to a plain element->destination connection.
  const agentGraphReadyRef = useRef<Promise<boolean> | null>(null)
  const agentLevelSmoothedRef = useRef(0)
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
  const idleCueAudioRef = useRef<HTMLAudioElement | null>(null)
  const conversationIdRef = useRef<string | null>(loadConversationId())
  const nextTextSeqRef = useRef(1)
  const pendingTextChunksRef = useRef(new Map<number, string>())

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
    // Only detach the finished clip; the context and meter node live for the
    // whole session so the worklet never reloads between clips.
    if (agentSourceNodeRef.current) {
      agentSourceNodeRef.current.disconnect()
      agentSourceNodeRef.current = null
    }

    agentLevelSmoothedRef.current = 0
    setAgentAudioLevel(0)
    publishFaceLevel(0)
  }

  const closeAgentAudioGraph = () => {
    cleanupAgentAudioAnalysis()
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
      activeAudio.src = ''
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

  const playIdleCue = () => {
    if (!idleCueAudioRef.current) {
      idleCueAudioRef.current = new Audio(idleSfx)
      idleCueAudioRef.current.preload = 'auto'
    }

    const cue = idleCueAudioRef.current
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
    nextTextSeqRef.current = 1
    pendingTextChunksRef.current.clear()
  }

  const appendOrderedChunk = (
    pending: Map<number, string>,
    nextSeqRef: { current: number },
    seq: number,
    value: string,
    onAppend: (chunk: string) => void,
  ) => {
    pending.set(seq, value)
    let assembled = ''
    while (pending.has(nextSeqRef.current)) {
      assembled += pending.get(nextSeqRef.current)!
      pending.delete(nextSeqRef.current)
      nextSeqRef.current += 1
    }
    if (assembled) {
      onAppend(assembled)
    }
  }

  const appendAssistantTextChunk = (seq: number, text: string) => {
    appendOrderedChunk(
      pendingTextChunksRef.current,
      nextTextSeqRef,
      seq,
      text,
      (chunk) => setAssistantText((current) => current + chunk),
    )
  }

  const sendSocketEvent = (payload: Record<string, unknown>): boolean => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return false
    }
    ws.send(JSON.stringify(payload))
    return true
  }

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

    const mimeType = bestMimeType()
    const recorder = mimeType
      ? new MediaRecorder(mediaStreamRef.current, { mimeType })
      : new MediaRecorder(mediaStreamRef.current)
    recorderMimeTypeRef.current = recorder.mimeType || recorderMimeTypeRef.current

    const started = sendSocketEvent({
      event: 'start',
      mimeType: recorderMimeTypeRef.current,
      language: 'en',
      // Lets the backend skip live-caption passes for wake checks.
      purpose,
      ...(conversationIdRef.current ? { conversationId: conversationIdRef.current } : {}),
    })
    if (!started) {
      return
    }

    captureStartedRef.current = true
    capturePurposeRef.current = purpose
    if (purpose === 'turn') {
      suppressAssistantAudioUntilNextTurnRef.current = false
      resetAssistantTurnContent()
    }
    pendingStopPurposeRef.current = null

    // Chunk delivery is chained through this promise so the stop message can
    // wait its turn. Two subtleties, both of which lose the END of the user's
    // last word if ignored:
    //  - ondataavailable has to await the Blob before it can send, so a stop
    //    message sent synchronously from onstop OVERTAKES the recorder's
    //    final flush — the backend transcribes a buffer missing the tail.
    //  - the old "is capture still on?" guard here dropped that same final
    //    flush outright, because stopCapture clears the flag before the
    //    recorder emits it. The backend already ignores chunks outside a
    //    recording, so no client-side gate is needed at all.
    let lastChunkDelivery: Promise<void> = Promise.resolve()

    recorder.ondataavailable = (event: BlobEvent) => {
      if (!event.data || event.data.size === 0) {
        return
      }

      const delivery = (async () => {
        const wsCurrent = wsRef.current
        if (!wsCurrent || wsCurrent.readyState !== WebSocket.OPEN) {
          return
        }
        const data = await event.data.arrayBuffer()
        if (wsCurrent.readyState === WebSocket.OPEN) {
          wsCurrent.send(data)
        }
      })()
      lastChunkDelivery = delivery.catch(() => {
        // A failed chunk send must not also swallow the stop message.
      })
    }

    recorder.onstop = () => {
      const stopPurpose = pendingStopPurposeRef.current
      pendingStopPurposeRef.current = null
      if (!stopPurpose) {
        return
      }
      void lastChunkDelivery.then(() => {
        sendSocketEvent({
          event: 'stop',
          purpose: stopPurpose,
          ...(conversationIdRef.current ? { conversationId: conversationIdRef.current } : {}),
        })
      })
    }

    recorder.start(450)
    mediaRecorderRef.current = recorder
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
    if (!captureStartedRef.current || capturePurposeRef.current !== 'turn') {
      return
    }

    captureStartedRef.current = false
    capturePurposeRef.current = 'none'
    pendingStopPurposeRef.current = null

    const recorder = mediaRecorderRef.current
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop()
    }
    sendSocketEvent({ event: 'abort' })
  }

  const enqueueStreamAudio = (streamId: string) => {
    audioQueueRef.current.push({ kind: 'stream', streamId })
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

    try {
      if (audioContext.state === 'suspended') {
        void audioContext.resume()
      }
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
      const audio = new Audio(streamUrl)
      activeAgentAudioRef.current = audio
      await startAgentAudioAnalysis(audio)
      await audio.play()
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

    const audio = new Audio(audioUrl)
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
          void audio.play().catch(() => {
            setStatusMessage('Tap anywhere if browser blocks autoplay.')
          })
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

  const triggerWakeGreeting = () => {
    if (uiPhaseRef.current !== 'idle') {
      return
    }

    setThinking('Wake phrase detected. Saying hello...')
    pendingWakeListeningRef.current = true
    sendSocketEvent({ event: 'wake_greeting' })
  }

  const triggerWakeBargeIn = () => {
    if (uiPhaseRef.current !== 'responding') {
      return
    }

    suppressAssistantAudioUntilNextTurnRef.current = true
    pendingWakeListeningRef.current = false
    pendingFollowUpListeningRef.current = false
    audioQueueRef.current = []
    streamBuffersRef.current.forEach((streamBuffer) => {
      streamBuffer.ended = true
      notifyStreamWaiters(streamBuffer)
    })
    streamBuffersRef.current.clear()
    stopActiveAgentAudioPlayback()
    setListening("I'm listening.")
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
      let transcript = ''
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        transcript += ` ${event.results[i][0].transcript}`
      }

      if (!containsWakePhrase(transcript)) {
        return
      }

      if (uiPhaseRef.current === 'responding') {
        triggerWakeBargeIn()
        return
      }

      if (uiPhaseRef.current === 'idle') {
        triggerWakeGreeting()
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
        return
      }
      setIdle('Idle.')
      return
    }

    if (payload.type === 'listening') {
      if (capturePurposeRef.current === 'turn') {
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

    if (payload.type === 'follow_up_stopped') {
      // Stop phrase spoken — no user_transcript follows, drop the caption.
      optionsRef.current.onPartialUserTranscript?.('')
      playIdleCue()
      setIdle(payload.message)
      return
    }

    if (payload.type === 'no_speech') {
      optionsRef.current.onPartialUserTranscript?.('')
      setListening('Still listening...')
      return
    }

    if (payload.type === 'partial_transcript') {
      // Live caption of an in-progress recording; only meaningful mid-turn.
      if (capturePurposeRef.current === 'turn') {
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
      optionsRef.current.onAgentEvent?.({
        type: 'delta',
        text: payload.text,
        seq: payload.seq,
        format: 'markdown',
      })
      appendAssistantTextChunk(payload.seq, payload.text)
      return
    }

    if (payload.type === 'done') {
      if (suppressAssistantAudioUntilNextTurnRef.current) {
        return
      }
      persistConversationId(payload.conversationId)
      optionsRef.current.onTurnComplete?.(payload.conversationId)
      setAssistantText(payload.assistantText)
      pendingFollowUpListeningRef.current = true
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

    // A timer, deliberately NOT requestAnimationFrame. rAF stops completely
    // while the tab or window is hidden — and the user watches the face page
    // or the server logs while talking, so a rAF-driven detector froze
    // mid-turn and the recorder ran until they clicked back. rAF also runs at
    // whatever the monitor refreshes at (60Hz laptop, 144Hz gaming tower),
    // which made every per-frame constant machine-dependent. A 25ms interval
    // is steady on a visible tab and degrades to ~1s ticks on a hidden one —
    // coarse, but the turn still ends. All smoothing is dt-aware so the
    // cadence change alters resolution, not behavior.
    const tick = () => {
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

      const rms = Math.sqrt(sumSquares / activeData.length)
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

    analysisTimerRef.current = window.setInterval(tick, 25)
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
      let ws: WebSocket | null = null
      let lastConnectError = 'Unknown connection error.'

      for (const url of wsUrls) {
        try {
          ws = await new Promise<WebSocket>((resolve, reject) => {
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
          break
        } catch (error) {
          lastConnectError = error instanceof Error ? error.message : String(error)
        }
      }

      if (!ws) {
        throw new Error(`Unable to connect to backend websocket. ${lastConnectError}`)
      }
      if (!isNovaEnabledRef.current) {
        ws.close()
        return
      }

      wsRef.current = ws
      setIdle('Idle.')
      maybeStartWakeRecognition()

      ws.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data) as SocketEvent
          handleSocketEvent(payload)
        } catch {
          setStatusMessage('Received non-JSON message from backend.')
        }
      }

      ws.onerror = () => {
        if (!isNovaEnabledRef.current || isShuttingDownRef.current) {
          return
        }
        setThinking('WebSocket connection error.')
      }

      ws.onclose = () => {
        streamBuffersRef.current.forEach((streamBuffer) => {
          streamBuffer.ended = true
          notifyStreamWaiters(streamBuffer)
        })
        wsRef.current = null
        captureStartedRef.current = false
        capturePurposeRef.current = 'none'
        if (!isNovaEnabledRef.current || isShuttingDownRef.current) {
          return
        }
        setIdle('Connection closed. Waiting to reconnect on refresh.')
      }

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
    void fetch('/nova/power', {
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
    playBootupCue()
    pendingPowerOnListenRef.current = true
    void initializeRuntime()
  }

  const retryRuntime = () => {
    setStatusMessage('Retrying microphone setup...')
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
  turnHandlersRef.current = {
    onSpeechOnset: () => {
      if (uiPhaseRef.current !== 'listening') {
        return
      }
      // Start the recorder at the first sign of speech rather than after the
      // onset hold confirms it — confirmation costs 120ms, and a recorder
      // started then has already missed the first syllable. If the onset
      // turns out to be a click, onSpeechAbort unwinds this.
      if (!captureStartedRef.current) {
        startCapture('turn')
      }
    },
    onSpeechStart: () => {
      if (uiPhaseRef.current !== 'listening') {
        return
      }
      // Capture normally began at onset; this is the backstop for the edge
      // where onset fired outside 'listening' and the phase changed since.
      if (!captureStartedRef.current) {
        startCapture('turn')
      }
    },
    onSpeechAbort: () => {
      abortCapture()
    },
    onSpeechPause: () => {
      if (uiPhaseRef.current !== 'listening') {
        return
      }
      if (captureStartedRef.current && capturePurposeRef.current === 'turn') {
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
    },
    onSpeechResume: () => {
      if (uiPhaseRef.current !== 'listening') {
        return
      }
      if (captureStartedRef.current && capturePurposeRef.current === 'turn') {
        sendSocketEvent({ event: 'speech_resume' })
      }
    },
    onTurnEnd: () => {
      if (uiPhaseRef.current !== 'listening') {
        return
      }
      if (!captureStartedRef.current || capturePurposeRef.current !== 'turn') {
        return
      }
      stopCapture('turn')
      setThinking('Transcribing and generating response...')
    },
  }

  useEffect(() => {
    let cancelled = false

    // Restore the persisted power state so a page refresh doesn't turn a
    // deliberately-off Nova back on.
    const boot = async () => {
      try {
        const response = await fetch('/nova/power')
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

    return () => {
      cancelled = true
      navigator.mediaDevices?.removeEventListener?.('devicechange', handleDeviceChange)
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
      if (idleCueAudioRef.current) {
        idleCueAudioRef.current.pause()
        idleCueAudioRef.current.src = ''
        idleCueAudioRef.current = null
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
  }
}
