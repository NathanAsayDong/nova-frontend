/**
 * Silent mode: Nova keeps listening and replying as usual, but replies are
 * not spoken aloud -- text keeps showing up in the transcript normally.
 *
 * ASSUMED BACKEND CONTRACT (nova-backend branch `silent-mode-backend` had no
 * commits yet as of this writing -- confirm these names against whatever
 * lands there and update this file; it is the only place they're named).
 *
 * Silent mode is a per-session toggle on the same `/ws/transcribe` socket
 * `useNovaRuntime` already holds open, not a REST resource: it needs to be
 * flippable mid-conversation by the `set_silent_mode` tool the backend agent
 * loop can call, and "per session, default off on reconnect" falls out for
 * free from being socket state rather than something persisted server-side.
 *
 * Outgoing (client -> backend), sent the same way as the existing
 * `{ event: 'speech_pause' }` / `{ event: 'abort' }` commands:
 *   { event: SILENT_MODE_COMMAND_EVENT, [SILENT_MODE_STATE_FIELD]: boolean }
 *
 * Incoming (backend -> client), pushed both as the ack of the command above
 * and whenever the `set_silent_mode` tool changes it mid-call:
 *   { type: SILENT_MODE_STATE_EVENT, [SILENT_MODE_STATE_FIELD]: boolean }
 *
 * When silent mode is turned off, the backend is expected to speak a short
 * confirmation through the ordinary `speech_text` / `assistant_audio_stream_*`
 * events -- nothing special on the client is needed for that to play, only
 * that silent mode's own `enabled: false` push is applied (synchronously, in
 * socket-message order) before that audio arrives.
 */

/** `event` value for the client's outgoing toggle command. */
export const SILENT_MODE_COMMAND_EVENT = 'set_silent_mode'

/** `type` value for the backend's authoritative state push. */
export const SILENT_MODE_STATE_EVENT = 'silent_mode_state'

/** Field name carrying the boolean on both the command and the state push. */
export const SILENT_MODE_STATE_FIELD = 'enabled'
