import { useCallback, useEffect, useRef, useState } from 'react'
import { acquireAudioStream, bestMimeType, resolveMeetingWsUrls } from '../../nova/utils'
import {
  fetchActiveMeeting,
  fetchMeeting,
  fetchMeetingSegments,
  startMeeting as startMeetingRequest,
  stopMeeting as stopMeetingRequest,
} from '../api'
import type {
  Meeting,
  MeetingDetail,
  MeetingPhase,
  MeetingSegment,
  MeetingSocketEvent,
} from '../types'

/**
 * Meeting mode's client half.
 *
 * Owns its own recorder and socket rather than borrowing the assistant's,
 * because the two capture shapes have nothing in common: this one runs for an
 * hour, streams to disk, and never plays anything back.
 *
 * Mode lives on the server — a meeting row with status 'recording' IS meeting
 * mode — so this polls for it rather than keeping its own flag. That is what
 * makes "Nova, start taking notes" work: the model calls the tool, the row
 * appears, and the client picks it up on the next poll without the two ever
 * disagreeing.
 */

// How often to ask the server whether a meeting is running. This is the path
// by which a meeting Nova started by voice reaches the UI.
const ACTIVE_POLL_MS = 4000

// Longer chunks than the assistant uses: nothing is waiting on them, and each
// one is an append to a file.
const CHUNK_MS = 1000

// While a meeting is finishing, poll until the notes land.
const NOTES_POLL_MS = 3000

type UseMeetingModeResult = {
  phase: MeetingPhase
  meeting: Meeting | null
  /** Durable transcript, oldest first. */
  segments: MeetingSegment[]
  /** The in-flight tail. Replace on each update; it is not yet committed. */
  partial: string
  error: string | null
  /** Notes, once the finished meeting has been written up. */
  finishedDetail: MeetingDetail | null
  isRecording: boolean
  /**
   * The meeting view should be on screen: recording, writing up, or showing
   * the finished notes. One view for the whole lifecycle, so stopping does
   * not bounce the user to chat and back.
   */
  isMeetingViewOpen: boolean
  startMeeting: (input?: { title?: string; projectId?: number | null }) => Promise<void>
  stopMeeting: () => Promise<void>
  dismissFinished: () => void
  clearError: () => void
}

export function useMeetingMode(): UseMeetingModeResult {
  const [phase, setPhase] = useState<MeetingPhase>('off')
  const [meeting, setMeeting] = useState<Meeting | null>(null)
  const [segments, setSegments] = useState<MeetingSegment[]>([])
  const [partial, setPartial] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [finishedDetail, setFinishedDetail] = useState<MeetingDetail | null>(null)

  const socketRef = useRef<WebSocket | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const phaseRef = useRef<MeetingPhase>('off')
  const meetingRef = useRef<Meeting | null>(null)
  // Guards the poll from re-attaching to a meeting we are deliberately
  // tearing down, and from racing a start already in flight.
  const attachingRef = useRef(false)

  useEffect(() => {
    phaseRef.current = phase
  }, [phase])
  useEffect(() => {
    meetingRef.current = meeting
  }, [meeting])

  const teardownCapture = useCallback(() => {
    const recorder = recorderRef.current
    recorderRef.current = null
    if (recorder && recorder.state !== 'inactive') {
      try {
        recorder.stop()
      } catch {
        // Already stopping; the tracks below are what actually free the mic.
      }
    }
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null

    const socket = socketRef.current
    socketRef.current = null
    if (socket && socket.readyState <= WebSocket.OPEN) {
      socket.close()
    }
  }, [])

  const handleSocketEvent = useCallback((event: MeetingSocketEvent) => {
    switch (event.type) {
      case 'recording':
        setMeeting(event.meeting)
        setPhase('recording')
        break
      case 'partial_transcript':
        setPartial(event.text)
        break
      case 'segments_committed':
        // Committed text supersedes whatever the draft was showing.
        setSegments((current) => [...current, ...event.segments])
        setPartial('')
        break
      case 'processing':
        setPhase('processing')
        break
      case 'error':
        setError(event.message)
        break
      default:
        break
    }
  }, [])

  /**
   * Open the socket and start streaming audio into an already-created meeting.
   * Returns false if capture could not be established.
   */
  const attachToMeeting = useCallback(
    async (target: Meeting): Promise<boolean> => {
      if (attachingRef.current || socketRef.current) {
        return false
      }
      attachingRef.current = true
      setError(null)
      setPhase('starting')
      setMeeting(target)

      try {
        // A reload mid-meeting should show what was already captured, not an
        // empty pane that fills in from wherever the cursor happens to be.
        try {
          const existing = await fetchMeetingSegments(target.uuid)
          setSegments(existing)
        } catch {
          setSegments([])
        }

        const stream = await acquireAudioStream()
        streamRef.current = stream

        const socket = await openSocket()
        socketRef.current = socket

        const mimeType = bestMimeType()
        socket.send(
          JSON.stringify({
            event: 'start',
            meetingId: target.uuid,
            mimeType: mimeType ?? 'audio/webm',
          }),
        )

        const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
        recorderRef.current = recorder
        recorder.ondataavailable = (blobEvent: BlobEvent) => {
          if (!blobEvent.data.size || socket.readyState !== WebSocket.OPEN) {
            return
          }
          void blobEvent.data.arrayBuffer().then((buffer) => {
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(buffer)
            }
          })
        }
        recorder.start(CHUNK_MS)

        socket.onmessage = (message) => {
          try {
            handleSocketEvent(JSON.parse(message.data as string) as MeetingSocketEvent)
          } catch {
            // A malformed frame is not worth ending a meeting over.
          }
        }
        socket.onclose = () => {
          // Dropping the socket does not end the meeting — the row stays
          // recording and the poll below reattaches. Only an explicit stop
          // ends it.
          if (socketRef.current === socket) {
            socketRef.current = null
          }
        }

        setPhase('recording')
        return true
      } catch (caught) {
        teardownCapture()
        setPhase('error')
        setError(caught instanceof Error ? caught.message : String(caught))
        return false
      } finally {
        attachingRef.current = false
      }
    },
    [handleSocketEvent, teardownCapture],
  )

  const startMeeting = useCallback(
    async (input: { title?: string; projectId?: number | null } = {}) => {
      if (phaseRef.current === 'recording' || attachingRef.current) {
        return
      }
      setPhase('starting')
      setSegments([])
      setPartial('')
      setFinishedDetail(null)
      let created: Meeting | null = null
      try {
        created = await startMeetingRequest(input)
        const attached = await attachToMeeting(created)
        if (!attached) {
          // The row exists but nothing is capturing into it. Leaving it would
          // hold the single active-meeting slot and block every later start,
          // so roll it back rather than stranding the user in a meeting that
          // is not recording anything. Denied microphone permission is the
          // normal way to get here.
          await stopMeetingRequest(created.uuid).catch(() => {})
          setMeeting(null)
        }
      } catch (caught) {
        if (created) {
          await stopMeetingRequest(created.uuid).catch(() => {})
          setMeeting(null)
        }
        setPhase('error')
        setError(caught instanceof Error ? caught.message : String(caught))
      }
    },
    [attachToMeeting],
  )

  const stopMeeting = useCallback(async () => {
    const target = meetingRef.current
    if (!target) {
      return
    }
    setPhase('stopping')
    attachingRef.current = true // keep the poll from re-attaching mid-teardown

    const socket = socketRef.current
    if (socket?.readyState === WebSocket.OPEN) {
      // Ask the socket to stop: it flushes the last partial window before
      // ending the meeting, so the tail is not lost.
      socket.send(JSON.stringify({ event: 'stop', generateNotes: true }))
      await new Promise((resolve) => setTimeout(resolve, 250))
    } else {
      try {
        await stopMeetingRequest(target.uuid)
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught))
      }
    }

    teardownCapture()
    setPhase('processing')
    setPartial('')
    attachingRef.current = false
  }, [teardownCapture])

  // Mode is server-side, so poll for it. This is how a meeting Nova started
  // by voice, or one left running across a page reload, reaches the UI.
  useEffect(() => {
    let cancelled = false

    const poll = async () => {
      if (cancelled || attachingRef.current) {
        return
      }
      const phaseNow = phaseRef.current
      if (phaseNow === 'starting' || phaseNow === 'stopping') {
        return
      }

      try {
        const active = await fetchActiveMeeting()
        if (cancelled) {
          return
        }

        if (active && !socketRef.current) {
          await attachToMeeting(active)
          return
        }
        if (!active && phaseNow === 'recording') {
          // Stopped from somewhere else — Nova calling the tool, or another
          // tab. Tear the capture down to match.
          teardownCapture()
          setPhase('processing')
        }
      } catch {
        // A failed poll is not worth surfacing; the next one will retry.
      }
    }

    void poll()
    const timer = window.setInterval(() => void poll(), ACTIVE_POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [attachToMeeting, teardownCapture])

  // While a stopped meeting is being written up, wait for the notes.
  useEffect(() => {
    if (phase !== 'processing' || !meeting) {
      return
    }
    let cancelled = false

    const poll = async () => {
      try {
        const detail = await fetchMeeting(meeting.uuid)
        if (cancelled) {
          return
        }
        if (detail.notes || detail.meeting.status === 'failed') {
          // Keep `meeting` set: the view still shows its title and project
          // alongside the notes until the user is done reading.
          setFinishedDetail(detail)
          setMeeting(detail.meeting)
          setPhase('off')
        }
      } catch {
        // Keep waiting; a transient failure here should not strand the UI.
      }
    }

    void poll()
    const timer = window.setInterval(() => void poll(), NOTES_POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [phase, meeting])

  useEffect(() => teardownCapture, [teardownCapture])

  return {
    phase,
    meeting,
    segments,
    partial,
    error,
    finishedDetail,
    isRecording: phase === 'recording' || phase === 'starting',
    isMeetingViewOpen: phase !== 'off' || finishedDetail !== null,
    startMeeting,
    stopMeeting,
    dismissFinished: () => {
      setFinishedDetail(null)
      setMeeting(null)
      setSegments([])
      setPartial('')
    },
    clearError: () => setError(null),
  }
}

/** Try each candidate URL in turn; dev and prod resolve differently. */
async function openSocket(): Promise<WebSocket> {
  const urls = resolveMeetingWsUrls()
  let lastError: unknown = null

  for (const url of urls) {
    try {
      return await new Promise<WebSocket>((resolve, reject) => {
        const socket = new WebSocket(url)
        socket.binaryType = 'arraybuffer'
        const timer = window.setTimeout(() => {
          socket.close()
          reject(new Error(`Timed out connecting to ${url}`))
        }, 5000)
        socket.onopen = () => {
          window.clearTimeout(timer)
          resolve(socket)
        }
        socket.onerror = () => {
          window.clearTimeout(timer)
          reject(new Error(`Could not connect to ${url}`))
        }
      })
    } catch (caught) {
      lastError = caught
    }
  }

  throw lastError ?? new Error('Could not open the meeting socket.')
}
