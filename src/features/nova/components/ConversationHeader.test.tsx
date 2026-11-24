import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ConversationHeader } from './ConversationHeader'

/**
 * The header is where the user flips silent mode by hand (ConversationHeader
 * renders the "Silent" switch next to the existing Sentry toggle). These
 * tests only cover that the switch reflects `isSilentMode` and calls
 * `onToggleSilentMode` -- the actual on/off behaviour (suppressing TTS audio,
 * syncing with a backend push) lives in useNovaRuntime and is out of scope
 * for a component test.
 */

const baseProps = {
  conversationId: null,
  project: null,
  projects: [],
  uiPhase: 'idle' as const,
  isStreaming: false,
  isNovaEnabled: true,
  voiceMode: 'conversation' as const,
  isConnected: true,
  isMeetingMode: false,
  isMeetingBusy: false,
  isMeetingsPanelOpen: false,
  isCodingPanelOpen: false,
  onNewConversation: () => {},
  onTogglePower: () => {},
  onToggleSentry: () => {},
  onToggleMeeting: () => {},
  onToggleMeetingsPanel: () => {},
  onToggleCodingPanel: () => {},
}

beforeEach(() => {
  // McpServerPanel fetches /mcp-servers on mount regardless of the test at
  // hand; stub fetch so that's a harmless rejection instead of a real
  // network call (it already swallows failures -- see its try/catch).
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no network in tests'))))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function renderHeader(overrides: { isSilentMode: boolean; onToggleSilentMode: () => void }) {
  return render(<ConversationHeader {...baseProps} {...overrides} />)
}

describe('ConversationHeader silent mode toggle', () => {
  it('renders off by default: unchecked, no dot, and the "turn silent on" tooltip', () => {
    renderHeader({ isSilentMode: false, onToggleSilentMode: () => {} })

    const toggle = screen.getByRole('switch', { name: 'Silent' })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(toggle).not.toHaveClass('active')
    expect(toggle).toHaveAttribute(
      'title',
      expect.stringContaining('does not speak replies out loud'),
    )
  })

  it('reflects isSilentMode=true (e.g. pushed by the backend) as checked, with a dot and the "on" tooltip', () => {
    renderHeader({ isSilentMode: true, onToggleSilentMode: () => {} })

    const toggle = screen.getByRole('switch', { name: 'Silent' })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect(toggle).toHaveClass('active')
    expect(toggle.querySelector('.silentDot')).not.toBeNull()
    expect(toggle).toHaveAttribute('title', expect.stringContaining('Silent mode is on'))
  })

  it('calls onToggleSilentMode on click, regardless of current state', async () => {
    const user = userEvent.setup()
    const onToggleSilentMode = vi.fn()
    renderHeader({ isSilentMode: false, onToggleSilentMode })

    await user.click(screen.getByRole('switch', { name: 'Silent' }))

    expect(onToggleSilentMode).toHaveBeenCalledTimes(1)
  })

  it('leaves the existing Sentry and power toggles alone', () => {
    renderHeader({ isSilentMode: false, onToggleSilentMode: () => {} })

    expect(screen.getByRole('switch', { name: /turn nova/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /sentry/i })).toBeInTheDocument()
  })
})
