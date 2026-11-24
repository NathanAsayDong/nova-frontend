import { describe, expect, it } from 'vitest'
import {
  SILENT_MODE_COMMAND_EVENT,
  SILENT_MODE_STATE_EVENT,
  SILENT_MODE_STATE_FIELD,
} from './silentMode'

/**
 * These constants are the one place the assumed silent-mode wire contract is
 * named (nova-backend's silent-mode-backend branch had no commits yet at
 * the time this was written -- see the comment in silentMode.ts). Pinning
 * their literal values here means a future contract change shows up as a
 * failing test and a one-line fix, not a silent drift between this file and
 * the SocketEvent union / useNovaRuntime call sites that reference them.
 */
describe('silent mode wire contract constants', () => {
  it('names the outgoing command event distinctly from the incoming state push', () => {
    expect(SILENT_MODE_COMMAND_EVENT).toBe('set_silent_mode')
    expect(SILENT_MODE_STATE_EVENT).toBe('silent_mode_state')
    expect(SILENT_MODE_COMMAND_EVENT).not.toBe(SILENT_MODE_STATE_EVENT)
  })

  it('uses "enabled" as the shared boolean field name', () => {
    expect(SILENT_MODE_STATE_FIELD).toBe('enabled')
  })
})
