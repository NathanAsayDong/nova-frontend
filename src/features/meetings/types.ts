/**
 * Meeting mode: Nova stops answering and only transcribes.
 *
 * A meeting is a pure transcript — every voice in the room lands in one
 * stream of timed text. Nothing here records who said what.
 */

export type MeetingStatus = 'recording' | 'processing' | 'complete' | 'failed'

export type MeetingProject = {
  id: number
  name?: string | null
}

export type Meeting = {
  uuid: string
  title: string | null
  status: MeetingStatus
  started_at: string
  ended_at: string | null
  project: MeetingProject | null
}

export type MeetingSegment = {
  startMs: number
  endMs: number
  text: string
}

export type ActionItem = {
  task?: string
  owner?: string | null
  due?: string | null
}

export type MeetingNotes = {
  summary_md: string
  decisions: string[]
  action_items: ActionItem[]
  created_at: string
}

export type MeetingDetail = {
  meeting: Meeting
  notes: MeetingNotes | null
  note?: string
}

/** Where the client is in the meeting lifecycle, independent of the row's status. */
export type MeetingPhase =
  | 'off'
  | 'starting'
  | 'recording'
  | 'stopping'
  | 'processing'
  | 'error'

export type MeetingSocketEvent =
  | { type: 'ready'; message: string }
  | { type: 'recording'; meeting: Meeting; resumedAtMs: number; message: string }
  /** The live draft. Carries the whole tail each time — replace, never append. */
  | { type: 'partial_transcript'; text: string; fromMs: number }
  /** Durable transcript. Append these. */
  | { type: 'segments_committed'; segments: MeetingSegment[] }
  | { type: 'processing'; status: string; meeting_uuid: string; note: string }
  | { type: 'error'; message: string }
