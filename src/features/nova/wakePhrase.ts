/**
 * Wake phrase matching for the browser's speech recognizer. The backend has
 * the same rules (nova_controller.split_wake_phrase) for the Whisper side.
 */

function normalizeWakeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
}

// How recognizers mishear "Nova": "Noah" above all, a real name the model's
// prior favours over a rare word. Mirrors the backend's list.
const WAKE_NAME_VARIANTS = new Set(['nova', 'novah', 'nover', 'noah', 'noba', 'novaa'])
const WAKE_PREFIXES = new Set(['hey', 'hi', 'hello', 'ok', 'okay', 'yo', 'alright'])

function canonicalWakeTokens(value: string): string[] {
  const normalized = normalizeWakeText(value).replace(/\bno (?:va|vah|ver)\b/g, 'nova')
  if (!normalized) {
    return []
  }
  return normalized.split(' ').map((token) => (WAKE_NAME_VARIANTS.has(token) ? 'nova' : token))
}

/**
 * Whether `value` OPENS with the wake phrase: "Nova, …", "Hey Nova …",
 * "OK Nova …". Sentry mode uses this because it runs among other people,
 * and "I asked Nova yesterday" must not wake it.
 */
export function startsWithWakePhrase(value: string): boolean {
  const tokens = canonicalWakeTokens(value)
  if (tokens[0] === 'nova') {
    return true
  }
  return tokens.length >= 2 && WAKE_PREFIXES.has(tokens[0]) && tokens[1] === 'nova'
}

/** Conversation mode's wake check: also accepts "nova" in a short phrase. */
export function containsWakePhrase(value: string): boolean {
  const tokens = canonicalWakeTokens(value)
  if (tokens.length === 0) {
    return false
  }
  if (startsWithWakePhrase(value)) {
    return true
  }
  return tokens.length <= 3 && tokens.includes('nova')
}
