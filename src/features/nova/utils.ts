export const speechThreshold = 0.018
export const silenceTimeoutMs = 1000

const conversationIdStorageKey = 'nova.conversationId'

export function loadConversationId(): string | null {
  try {
    return sessionStorage.getItem(conversationIdStorageKey)
  } catch {
    return null
  }
}

export function saveConversationId(id: string): void {
  try {
    sessionStorage.setItem(conversationIdStorageKey, id)
  } catch {
    // ignore private-browsing / storage restrictions
  }
}

export function clearConversationId(): void {
  try {
    sessionStorage.removeItem(conversationIdStorageKey)
  } catch {
    // ignore private-browsing / storage restrictions
  }
}

const preferredMimeTypes = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'] as const

export function resolveWsUrls(): string[] {
  const fromEnv = import.meta.env.VITE_TRANSCRIBE_WS_URL
  if (fromEnv) {
    return [fromEnv as string]
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const urls = [`${protocol}//${window.location.host}/ws/transcribe`]

  if (window.location.port === '5173' || window.location.port === '4173') {
    urls.push(`${protocol}//127.0.0.1:8000/ws/transcribe`)
    urls.push(`${protocol}//localhost:8000/ws/transcribe`)
  }

  return Array.from(new Set(urls))
}

export function bestMimeType() {
  return preferredMimeTypes.find((type) => MediaRecorder.isTypeSupported(type))
}

export function base64ToArrayBuffer(base64Data: string): ArrayBuffer {
  const byteChars = atob(base64Data)
  const bytes = new Uint8Array(byteChars.length)
  for (let index = 0; index < byteChars.length; index += 1) {
    bytes[index] = byteChars.charCodeAt(index)
  }
  return bytes.buffer
}

function normalizeWakeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
}

export function containsWakePhrase(value: string): boolean {
  const normalized = normalizeWakeText(value)
  if (!normalized) {
    return false
  }

  const tokens = normalized.split(' ')
  if (tokens.length === 0) {
    return false
  }

  const wakePrefixes = new Set(['hey', 'hi', 'hello', 'ok', 'okay', 'yo'])

  if (tokens[0] === 'nova') {
    return true
  }

  if (tokens.length >= 2 && wakePrefixes.has(tokens[0]) && tokens[1] === 'nova') {
    return true
  }

  return tokens.length <= 3 && tokens.includes('nova')
}

export function describeMediaError(error: unknown): string {
  if (error && typeof error === 'object' && 'name' in error) {
    const name = String((error as { name?: unknown }).name || '')
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      return 'No microphone was found by browser APIs. Check macOS Input + Chrome permissions, then click "Retry Nova".'
    }
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
      return 'Microphone permission was denied. Allow mic access and reload the page.'
    }
    if (name === 'NotReadableError' || name === 'TrackStartError') {
      return 'Microphone is busy in another app. Close other recording apps and try again.'
    }
  }

  const rawMessage = error instanceof Error ? error.message : String(error)
  return `Microphone access failed: ${rawMessage}`
}

export async function acquireAudioStream(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Browser does not support mediaDevices.getUserMedia.')
  }

  const constraintsToTry: MediaStreamConstraints[] = [
    { audio: true },
    { audio: { deviceId: { ideal: 'default' } } },
    { audio: { deviceId: { ideal: 'communications' } } },
  ]

  let lastError: unknown = null

  for (const constraints of constraintsToTry) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints)
    } catch (error) {
      lastError = error
      const name =
        error && typeof error === 'object' && 'name' in error
          ? String((error as { name?: unknown }).name || '')
          : ''
      if (
        name !== 'NotFoundError' &&
        name !== 'DevicesNotFoundError' &&
        name !== 'OverconstrainedError' &&
        name !== 'AbortError'
      ) {
        throw error
      }
    }
  }

  const devices = await navigator.mediaDevices.enumerateDevices()
  const audioInputs = devices.filter((device) => device.kind === 'audioinput')

  for (const device of audioInputs) {
    if (!device.deviceId) {
      continue
    }
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: device.deviceId },
        },
      })
    } catch (error) {
      lastError = error
    }
  }

  const legacyGetUserMedia = (
    navigator as Navigator & {
      webkitGetUserMedia?: (
        constraints: MediaStreamConstraints,
        successCallback: (stream: MediaStream) => void,
        errorCallback: (error: Error) => void,
      ) => void
    }
  ).webkitGetUserMedia

  if (legacyGetUserMedia) {
    try {
      return await new Promise<MediaStream>((resolve, reject) => {
        legacyGetUserMedia.call(
          navigator,
          { audio: true },
          (stream) => resolve(stream),
          (error) => reject(error),
        )
      })
    } catch (error) {
      lastError = error
    }
  }

  throw lastError ?? new Error('Failed to acquire microphone stream.')
}
