import { describe, expect, it } from 'vitest'
import {
  SILENT_MODE_RESPONSE_FIELD,
  SILENT_MODE_STATE_EVENT,
  SILENT_MODE_STATE_FIELD,
  silentModeEndpoint,
} from './silentMode'

/**
 * These are the one place the silent-mode wire contract is named -- the real
 * one, confirmed against nova-backend's `nova/silent-mode-backend` and
 * `nova/silent-mode-ws-push` branches (REST + a websocket push, not a socket
 * command). Pinning them here means a future contract change shows up as a
 * failing test and a one-line fix, not a silent drift between this file and
 * the SocketEvent union / useNovaRuntime call sites that reference them.
 */
describe('silent mode wire contract', () => {
  it('builds the REST endpoint the UI toggle posts to', () => {
    expect(silentModeEndpoint('conv-123')).toBe('/conversations/conv-123/silent-mode')
    expect(silentModeEndpoint('abc-def-456')).toBe('/conversations/abc-def-456/silent-mode')
  })

  it('names the incoming push event distinctly from the two field names', () => {
    expect(SILENT_MODE_STATE_EVENT).toBe('silent_mode_state')
    expect(SILENT_MODE_STATE_FIELD).toBe('enabled')
    expect(SILENT_MODE_RESPONSE_FIELD).toBe('silentMode')
  })

  it('uses "enabled" for both the push and the REST request body, and "silentMode" only for the REST response', () => {
    // The REST request body and the push share a field name; only the POST
    // response calls it something else (`silentMode`) -- easy to conflate,
    // so pinned explicitly here.
    expect(SILENT_MODE_STATE_FIELD).not.toBe(SILENT_MODE_RESPONSE_FIELD)
  })
})
