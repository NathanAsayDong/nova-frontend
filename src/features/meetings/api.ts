import type { Meeting, MeetingDetail } from './types'

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let detail = `Request failed (${response.status})`
    try {
      const body = (await response.json()) as { detail?: string }
      if (body?.detail) {
        detail = body.detail
      }
    } catch {
      // Non-JSON error body; the status line is all we have.
    }
    throw new Error(detail)
  }
  return (await response.json()) as T
}

export async function fetchActiveMeeting(): Promise<Meeting | null> {
  const response = await fetch('/meetings/active')
  const body = await readJson<{ meeting: Meeting | null }>(response)
  return body.meeting
}

export async function startMeeting(input: {
  title?: string
  projectId?: number | null
}): Promise<Meeting> {
  const response = await fetch('/meetings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: input.title?.trim() || undefined,
      projectId: input.projectId ?? undefined,
    }),
  })
  const body = await readJson<{ meeting: Meeting }>(response)
  return body.meeting
}

export async function stopMeeting(uuid: string): Promise<void> {
  await readJson(
    await fetch(`/meetings/${uuid}/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ generateNotes: true }),
    }),
  )
}

export async function fetchMeeting(uuid: string): Promise<MeetingDetail> {
  return readJson<MeetingDetail>(await fetch(`/meetings/${uuid}`))
}

export async function fetchMeetings(limit = 20): Promise<Meeting[]> {
  const response = await fetch(`/meetings?limit=${limit}`)
  const body = await readJson<{ meetings: Meeting[] }>(response)
  return body.meetings
}

export async function fetchMeetingSegments(
  uuid: string,
): Promise<{ startMs: number; endMs: number; text: string }[]> {
  const response = await fetch(`/meetings/${uuid}/segments`)
  const body = await readJson<{
    segments: { startMs: number; endMs: number; text: string }[]
  }>(response)
  return body.segments
}
