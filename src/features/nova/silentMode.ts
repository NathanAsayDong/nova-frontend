/**
 * Silent mode: Nova keeps listening and replying as usual, but replies are
 * not spoken aloud -- text keeps showing up in the transcript normally.
 *
 * BACKEND CONTRACT (nova-backend branch `nova/silent-mode-backend`, plus the
 * `nova/silent-mode-ws-push` follow-up -- this is the only place these
 * names/shapes are pinned on the client; update here first if the contract
 * ever changes):
 *
 * Outgoing (client -> backend), a REST call rather than a socket command --
 * silent mode is per-conversation server state, not per-socket:
 *   POST /conversations/{conversationId}/silent-mode
 *   body: { "enabled": boolean }
 *   response: { "conversationId": string, "silentMode": boolean }
 *
 * The same conversation's GET /conversations/{conversationId} also reports
 * the current value as `"silentMode": boolean`, for a client that fetches
 * conversation state anyway and wants it without opening the socket.
 *
 * Incoming (backend -> client), pushed on the existing `/ws/transcribe`
 * socket once on connect and again whenever silent mode changes -- a voice
 * `set_silent_mode` tool call, or a REST POST from any client (this one or
 * another device on the same conversation):
 *   { "type": SILENT_MODE_STATE_EVENT, [SILENT_MODE_STATE_FIELD]: boolean }
 *
 * This push is authoritative: it is how the REST call's own effect is
 * reflected back (instead of trusting the POST response alone, which only
 * tells this client what it already knows) and how the `set_silent_mode`
 * voice tool's changes reach the client mid-conversation.
 *
 * When silent mode is turned off, the backend is expected to speak a short
 * confirmation through the ordinary `speech_text` / `assistant_audio_stream_*`
 * events -- nothing special on the client is needed for that to play, only
 * that silent mode's own `enabled: false` push is applied (synchronously, in
 * socket-message order) before that audio arrives.
 *
 * While silent mode is on, the backend agent is expected to skip TTS
 * synthesis entirely (no provider call), so `assistant_audio_stream_*`
 * should simply never arrive. The client does not rely on that, though:
 * `useNovaRuntime` refuses to buffer or play any `assistant_audio_stream_*`
 * data while `silentModeRef.current` is true, and proactively tears down
 * anything already playing or queued the instant the flag flips on (see
 * `stopAudioForSilentMode`) -- a safety net against audio arriving anyway,
 * not the primary mechanism.
 */

/** `type` value for the backend's authoritative state push. */
export const SILENT_MODE_STATE_EVENT = 'silent_mode_state'

/** Field name carrying the boolean on both the state push and the REST request body. */
export const SILENT_MODE_STATE_FIELD = 'enabled'

/** Field name carrying the boolean on the REST response body. */
export const SILENT_MODE_RESPONSE_FIELD = 'silentMode'

/** The REST endpoint the UI toggle posts to. */
export function silentModeEndpoint(conversationId: string): string {
  return `/conversations/${conversationId}/silent-mode`
}
