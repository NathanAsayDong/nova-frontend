import { useEffect, useMemo, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import bootupSfx from '../../../assets/bootup.mp3'
import idleSfx from '../../../assets/idle.mp3'
import loadingSfx from '../../../assets/loading.mp3'
import messageSfx from '../../../assets/message.mp3'
import type {
  AudioQueueItem,
  CapturePurpose,
  SocketEvent,
  SpeechRecognitionLike,
  StreamAudioBuffer,
  ToolSummary,
  UiPhase,
} from '../types'
import {
  acquireAudioStream,
  base64ToArrayBuffer,
  bestMimeType,
  containsWakePhrase,
  describeMediaError,
  resolveWsUrls,
  silenceTimeoutMs,
  speechThreshold,
} from '../utils'

type UseNovaRuntimeResult = {
  isNovaEnabled: boolean
  showMicEnableButton: boolean
  isToolsPanelOpen: boolean
  tools: ToolSummary[]
  toolsError: string
  isToolsLoading: boolean
  savingMap: Record<string, boolean>
  uiPhase: UiPhase
  visualAudioLevel: number
  combinedVoiceLevel: number
  hasSpeechInput: boolean
  setIsToolsPanelOpen: Dispatch<SetStateAction<boolean>>
  retryRuntime: () => void
  setNovaPower: (enabled: boolean) => void
  toggleTool: (toolName: string, enabled: boolean) => Promise<void>
}

export function useNovaRuntime(): UseNovaRuntimeResult {
  const [, setStatusMessage] = useState('Requesting microphone permission...')
  const [isNovaEnabled, setIsNovaEnabled] = useState(true)
  const [showMicEnableButton, setShowMicEnableButton] = useState(true)
  const [isToolsPanelOpen, setIsToolsPanelOpen] = useState(true)
  const [tools, setTools] = useState<ToolSummary[]>([])
  const [toolsError, setToolsError] = useState('')
  const [isToolsLoading, setIsToolsLoading] = useState(false)
  const [savingMap, setSavingMap] = useState<Record<string, boolean>>({})
  const [audioLevel, setAudioLevel] = useState(0)
  const [agentAudioLevel, setAgentAudioLevel] = useState(0)
  const [uiPhase, setUiPhase] = useState<UiPhase>('idle')

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
  const analysisFrameRef = useRef<number | null>(null)
  const analysisDataRef = useRef<Uint8Array<ArrayBuffer> | null>(null)
  const agentAudioContextRef = useRef<AudioContext | null>(null)
  const agentAnalyserRef = useRef<AnalyserNode | null>(null)
  const agentSourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null)
  const agentAnalysisFrameRef = useRef<number | null>(null)
  const agentAnalysisDataRef = useRef<Uint8Array<ArrayBuffer> | null>(null)
  const activeAgentAudioRef = useRef<HTMLAudioElement | null>(null)
  const activePlaybackDoneRef = useRef<(() => void) | null>(null)
  const suppressAssistantAudioUntilNextTurnRef = useRef(false)

  const speechRecognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const wakeDetectModeRef = useRef<'browser' | 'disabled'>('disabled')
  const uiPhaseRef = useRef<UiPhase>('idle')
  const isInitInFlightRef = useRef(false)
  const awaitingMicrophoneRef = useRef(false)

  const capturePurposeRef = useRef<CapturePurpose>('none')
  const captureStartedRef = useRef(false)
  const pendingStopPurposeRef = useRef<Exclude<CapturePurpose, 'none'> | null>(null)
  const hasSpeechInCurrentTurnRef = useRef(false)
  const lastSpeechAtRef = useRef<number>(Date.now())

  const pendingWakeListeningRef = useRef(false)
  const pendingFollowUpListeningRef = useRef(false)
  const isNovaEnabledRef = useRef(true)
  const isShuttingDownRef = useRef(false)
  const bootupCueAudioRef = useRef<HTMLAudioElement | null>(null)
  const thinkingCueAudioRef = useRef<HTMLAudioElement | null>(null)
  const idleCueAudioRef = useRef<HTMLAudioElement | null>(null)
  const loadingCueAudioRef = useRef<HTMLAudioElement | null>(null)
  const loadingCueIntervalRef = useRef<number | null>(null)

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

  const hasSpeechInput = uiPhase === 'listening' && audioLevel > speechThreshold

  const clearRuntimeTimers = () => {
    hasSpeechInCurrentTurnRef.current = false
  }

  const setIdle = (message = 'Idle.') => {
    clearRuntimeTimers()
    uiPhaseRef.current = 'idle'
    setUiPhase('idle')
    setStatusMessage(message)
  }

  const setListening = (message: string) => {
    uiPhaseRef.current = 'listening'
    setUiPhase('listening')
    setStatusMessage(message)
    hasSpeechInCurrentTurnRef.current = false
    lastSpeechAtRef.current = Date.now()
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
    if (analysisFrameRef.current !== null) {
      cancelAnimationFrame(analysisFrameRef.current)
      analysisFrameRef.current = null
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
    setAudioLevel(0)
  }

  const cleanupAgentAudioAnalysis = () => {
    if (agentAnalysisFrameRef.current !== null) {
      cancelAnimationFrame(agentAnalysisFrameRef.current)
      agentAnalysisFrameRef.current = null
    }

    if (agentSourceNodeRef.current) {
      agentSourceNodeRef.current.disconnect()
      agentSourceNodeRef.current = null
    }

    if (agentAnalyserRef.current) {
      agentAnalyserRef.current.disconnect()
      agentAnalyserRef.current = null
    }

    if (agentAudioContextRef.current) {
      void agentAudioContextRef.current.close()
      agentAudioContextRef.current = null
    }

    agentAnalysisDataRef.current = null
    setAgentAudioLevel(0)
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

  const playThinkingCue = () => {
    if (!thinkingCueAudioRef.current) {
      thinkingCueAudioRef.current = new Audio(messageSfx)
      thinkingCueAudioRef.current.preload = 'auto'
    }

    const cue = thinkingCueAudioRef.current
    cue.currentTime = 0
    void cue.play().catch(() => {
      // Ignore playback errors from browser autoplay policies.
    })
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

  const playLoadingCue = () => {
    if (!loadingCueAudioRef.current) {
      loadingCueAudioRef.current = new Audio(loadingSfx)
      loadingCueAudioRef.current.preload = 'auto'
    }

    const cue = loadingCueAudioRef.current
    cue.currentTime = 0
    void cue.play().catch(() => {
      // Ignore playback errors from browser autoplay policies.
    })
  }

  const stopWakeRecognition = () => {
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
    clearRuntimeTimers()
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

    const mimeType = bestMimeType()
    const recorder = mimeType
      ? new MediaRecorder(mediaStreamRef.current, { mimeType })
      : new MediaRecorder(mediaStreamRef.current)
    recorderMimeTypeRef.current = recorder.mimeType || recorderMimeTypeRef.current

    const started = sendSocketEvent({
      event: 'start',
      mimeType: recorderMimeTypeRef.current,
      language: 'en',
      purpose,
    })
    if (!started) {
      return
    }

    captureStartedRef.current = true
    capturePurposeRef.current = purpose
    if (purpose === 'turn') {
      suppressAssistantAudioUntilNextTurnRef.current = false
    }
    pendingStopPurposeRef.current = null
    lastSpeechAtRef.current = Date.now()
    hasSpeechInCurrentTurnRef.current = false

    recorder.ondataavailable = async (event: BlobEvent) => {
      if (!event.data || event.data.size === 0) {
        return
      }

      if (!captureStartedRef.current) {
        return
      }

      const wsCurrent = wsRef.current
      if (!wsCurrent || wsCurrent.readyState !== WebSocket.OPEN) {
        return
      }

      const data = await event.data.arrayBuffer()
      wsCurrent.send(data)
    }

    recorder.onstop = () => {
      const stopPurpose = pendingStopPurposeRef.current
      pendingStopPurposeRef.current = null
      if (stopPurpose) {
        sendSocketEvent({ event: 'stop', purpose: stopPurpose })
      }
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
    sendSocketEvent({ event: 'stop', purpose })
  }

  const enqueueStreamAudio = (streamId: string) => {
    audioQueueRef.current.push({ kind: 'stream', streamId })
  }

  const startAgentAudioAnalysis = (audio: HTMLAudioElement) => {
    cleanupAgentAudioAnalysis()

    try {
      const audioContext = new window.AudioContext()
      const analyser = audioContext.createAnalyser()
      const source = audioContext.createMediaElementSource(audio)

      analyser.fftSize = 1024
      analyser.smoothingTimeConstant = 0.82

      source.connect(analyser)
      analyser.connect(audioContext.destination)

      agentAudioContextRef.current = audioContext
      agentAnalyserRef.current = analyser
      agentSourceNodeRef.current = source
      agentAnalysisDataRef.current = new Uint8Array<ArrayBuffer>(new ArrayBuffer(analyser.fftSize))

      let smoothed = 0
      const tick = () => {
        const activeAnalyser = agentAnalyserRef.current
        const activeData = agentAnalysisDataRef.current

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
        const amplified = Math.min(1, rms * 4.4)
        smoothed += (amplified - smoothed) * 0.2
        setAgentAudioLevel(smoothed)

        agentAnalysisFrameRef.current = requestAnimationFrame(tick)
      }

      agentAnalysisFrameRef.current = requestAnimationFrame(tick)
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
      startAgentAudioAnalysis(audio)
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
    startAgentAudioAnalysis(audio)

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

      mediaSource.addEventListener('sourceopen', onOpen, { once: true })
      mediaSource.addEventListener('error', () => reject(new Error('MediaSource error.')), {
        once: true,
      })
    })

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
      if (!speechRecognitionRef.current) {
        return
      }
      try {
        recognition.start()
      } catch {
        // noop
      }
    }

    recognition.onerror = () => {
      wakeDetectModeRef.current = 'disabled'
      stopWakeRecognition()
    }

    try {
      recognition.start()
      speechRecognitionRef.current = recognition
      wakeDetectModeRef.current = 'browser'
    } catch {
      wakeDetectModeRef.current = 'disabled'
    }
  }

  const fetchTools = async () => {
    setIsToolsLoading(true)
    setToolsError('')
    try {
      const response = await fetch('/tools')
      if (!response.ok) {
        throw new Error(`Failed to load tools (${response.status})`)
      }

      const payload = (await response.json()) as ToolSummary[]
      setTools(payload)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setToolsError(message)
    } finally {
      setIsToolsLoading(false)
    }
  }

  const toggleTool = async (toolName: string, enabled: boolean) => {
    const previousTools = tools
    setToolsError('')

    setTools((current) =>
      current.map((tool) => (tool.name === toolName ? { ...tool, enabled } : tool)),
    )
    setSavingMap((current) => ({ ...current, [toolName]: true }))

    try {
      const response = await fetch(`/tools/${toolName}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ enabled }),
      })

      if (!response.ok) {
        throw new Error(`Failed to update ${toolName} (${response.status})`)
      }

      const updatedTool = (await response.json()) as ToolSummary
      setTools((current) =>
        current.map((tool) => (tool.name === toolName ? updatedTool : tool)),
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setTools(previousTools)
      setToolsError(message)
    } finally {
      setSavingMap((current) => ({ ...current, [toolName]: false }))
    }
  }

  const handleSocketEvent = (payload: SocketEvent) => {
    if (payload.type === 'ready') {
      setIdle('Idle.')
      return
    }

    if (payload.type === 'assistant_progress') {
      if (suppressAssistantAudioUntilNextTurnRef.current) {
        return
      }
      setThinking(payload.text)
      return
    }

    if (payload.type === 'listening') {
      if (capturePurposeRef.current === 'turn') {
        setStatusMessage(payload.message)
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
      playIdleCue()
      setIdle(payload.message)
      return
    }

    if (payload.type === 'no_speech') {
      setListening('Still listening...')
      return
    }

    if (payload.type === 'done') {
      if (suppressAssistantAudioUntilNextTurnRef.current) {
        return
      }
      pendingFollowUpListeningRef.current = true
      setStatusMessage(payload.message)
      if (!isAudioQueueRunningRef.current && audioQueueRef.current.length === 0) {
        maybeFinalizeListeningTransitions()
      }
      return
    }

    if (payload.type === 'error') {
      streamBuffersRef.current.forEach((streamBuffer) => {
        streamBuffer.ended = true
        notifyStreamWaiters(streamBuffer)
      })
      setThinking(payload.message)
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

    let smoothed = 0

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
      smoothed += (amplified - smoothed) * 0.18
      setAudioLevel(smoothed)

      analysisFrameRef.current = requestAnimationFrame(tick)
    }

    analysisFrameRef.current = requestAnimationFrame(tick)
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

  const setNovaPower = (enabled: boolean) => {
    if (enabled === isNovaEnabledRef.current) {
      return
    }

    isNovaEnabledRef.current = enabled
    setIsNovaEnabled(enabled)
    if (!enabled) {
      shutdownRuntime('Nova is off. Turn Nova back on to resume.')
      return
    }

    setStatusMessage('Starting Nova...')
    playBootupCue()
    void initializeRuntime()
  }

  const retryRuntime = () => {
    setStatusMessage('Retrying microphone setup...')
    void initializeRuntime()
  }

  useEffect(() => {
    const speakingNow = audioLevel > speechThreshold

    if (uiPhase === 'idle') {
      return
    }

    if (uiPhase !== 'listening') {
      return
    }

    if (speakingNow) {
      lastSpeechAtRef.current = Date.now()
      if (!captureStartedRef.current) {
        startCapture('turn')
      }
      hasSpeechInCurrentTurnRef.current = true
      return
    }

    if (
      captureStartedRef.current &&
      capturePurposeRef.current === 'turn' &&
      hasSpeechInCurrentTurnRef.current &&
      Date.now() - lastSpeechAtRef.current > silenceTimeoutMs
    ) {
      stopCapture('turn')
      playThinkingCue()
      setThinking('Transcribing and generating response...')
    }
  }, [audioLevel, uiPhase]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (uiPhase !== 'thinking') {
      if (loadingCueIntervalRef.current !== null) {
        window.clearInterval(loadingCueIntervalRef.current)
        loadingCueIntervalRef.current = null
      }
      if (loadingCueAudioRef.current) {
        loadingCueAudioRef.current.pause()
        loadingCueAudioRef.current.currentTime = 0
      }
      return
    }

    loadingCueIntervalRef.current = window.setInterval(() => {
      playLoadingCue()
    }, 3000)

    return () => {
      if (loadingCueIntervalRef.current !== null) {
        window.clearInterval(loadingCueIntervalRef.current)
        loadingCueIntervalRef.current = null
      }
      if (loadingCueAudioRef.current) {
        loadingCueAudioRef.current.pause()
        loadingCueAudioRef.current.currentTime = 0
      }
    }
  }, [uiPhase])

  useEffect(() => {
    void fetchTools()
    void initializeRuntime()
    const streamBuffers = streamBuffersRef.current

    const handleDeviceChange = () => {
      if (!awaitingMicrophoneRef.current) {
        return
      }
      setStatusMessage('Microphone change detected. Click "Retry Nova" to retry.')
    }

    navigator.mediaDevices?.addEventListener?.('devicechange', handleDeviceChange)

    return () => {
      navigator.mediaDevices?.removeEventListener?.('devicechange', handleDeviceChange)
      streamBuffers.forEach((streamBuffer) => {
        streamBuffer.ended = true
        notifyStreamWaiters(streamBuffer)
      })
      streamBuffers.clear()
      stopActiveAgentAudioPlayback()
      cleanupMedia()
      cleanupAgentAudioAnalysis()
      closeSocket()
      cleanupAudioUrl()
      if (thinkingCueAudioRef.current) {
        thinkingCueAudioRef.current.pause()
        thinkingCueAudioRef.current.src = ''
        thinkingCueAudioRef.current = null
      }
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
      if (loadingCueIntervalRef.current !== null) {
        window.clearInterval(loadingCueIntervalRef.current)
        loadingCueIntervalRef.current = null
      }
      if (loadingCueAudioRef.current) {
        loadingCueAudioRef.current.pause()
        loadingCueAudioRef.current.src = ''
        loadingCueAudioRef.current = null
      }
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return {
    isNovaEnabled,
    showMicEnableButton,
    isToolsPanelOpen,
    tools,
    toolsError,
    isToolsLoading,
    savingMap,
    uiPhase,
    visualAudioLevel,
    combinedVoiceLevel,
    hasSpeechInput,
    setIsToolsPanelOpen,
    retryRuntime,
    setNovaPower,
    toggleTool,
  }
}
