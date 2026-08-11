import { useCallback, useEffect, useState } from 'react'

export type McpServerSummary = {
  id: number
  name: string
  url: string
  enabled: boolean
  auth_kind: 'none' | 'bearer' | 'oauth'
  has_token: boolean
  oauth_connected: boolean
  oauth_expires_at?: string | null
  created_at?: string
}

type AuthKind = 'none' | 'bearer' | 'oauth'

/**
 * Admin surface for Claude's MCP connector: register, toggle, connect, and
 * remove remote MCP servers. Changes take effect on Nova's next turn — the
 * backend reads the enabled set per request. Secrets are write-only: the
 * API never returns tokens, only connection status.
 */
export function McpServerPanel() {
  const [servers, setServers] = useState<McpServerSummary[]>([])
  const [expanded, setExpanded] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [authKind, setAuthKind] = useState<AuthKind>('none')
  const [token, setToken] = useState('')

  const loadServers = useCallback(async () => {
    try {
      const response = await fetch('/mcp-servers')
      if (response.ok) {
        setServers((await response.json()) as McpServerSummary[])
      }
    } catch {
      // Informational panel; a fetch failure shouldn't break the app shell.
    }
  }, [])

  useEffect(() => {
    void loadServers()
    // The OAuth consent flow finishes in another tab; refresh the panel when
    // the user comes back so "not connected" flips without a manual reload.
    const onFocus = () => void loadServers()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [loadServers])

  const addServer = async () => {
    setBusy(true)
    setError('')
    try {
      const response = await fetch('/mcp-servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          url: url.trim(),
          authKind,
          ...(authKind === 'bearer' && token.trim() ? { authToken: token.trim() } : {}),
        }),
      })
      const body = (await response.json().catch(() => null)) as
        | (McpServerSummary & { detail?: string })
        | null
      if (!response.ok) {
        throw new Error(body?.detail ?? `Failed to add server (${response.status})`)
      }
      setName('')
      setUrl('')
      setToken('')
      await loadServers()
      // OAuth servers aren't usable until connected — kick that off now.
      if (authKind === 'oauth' && body?.id) {
        await connectServer(body.id)
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to add server.')
    } finally {
      setBusy(false)
    }
  }

  const connectServer = async (serverId: number) => {
    setError('')
    try {
      const response = await fetch(`/mcp-servers/${serverId}/oauth/start`, {
        method: 'POST',
      })
      const body = (await response.json().catch(() => null)) as {
        authorization_url?: string
        detail?: string
      } | null
      if (!response.ok || !body?.authorization_url) {
        throw new Error(body?.detail ?? `Failed to start connection (${response.status})`)
      }
      window.open(body.authorization_url, '_blank', 'noopener')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to start connection.')
    }
  }

  const toggleServer = async (server: McpServerSummary) => {
    setError('')
    try {
      const response = await fetch(`/mcp-servers/${server.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !server.enabled }),
      })
      if (!response.ok) {
        throw new Error(`Failed to update server (${response.status})`)
      }
      await loadServers()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to update server.')
    }
  }

  const removeServer = async (server: McpServerSummary) => {
    if (!window.confirm(`Remove MCP server "${server.name}"?`)) {
      return
    }
    setError('')
    try {
      const response = await fetch(`/mcp-servers/${server.id}`, {
        method: 'DELETE',
      })
      if (!response.ok) {
        throw new Error(`Failed to remove server (${response.status})`)
      }
      await loadServers()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to remove server.')
    }
  }

  const authLabel = (server: McpServerSummary): string => {
    if (server.auth_kind === 'oauth') {
      return server.oauth_connected ? 'oauth ✓' : 'oauth — not connected'
    }
    return server.has_token ? 'token set' : 'no auth'
  }

  const enabledCount = servers.filter((server) => server.enabled).length

  return (
    <div className="mcpSection">
      <button
        type="button"
        className="metaToggle"
        onClick={() => setExpanded((current) => !current)}
        aria-expanded={expanded}
      >
        MCP servers ({enabledCount}/{servers.length} on) {expanded ? '▾' : '▸'}
      </button>

      {expanded ? (
        <div className="mcpPanel">
          <ul className="mcpList">
            {servers.length === 0 ? (
              <li className="projectEmpty">
                No MCP servers yet. Add one below to give Nova its tools.
              </li>
            ) : null}
            {servers.map((server) => (
              <li key={server.id} className="mcpItem">
                <label className="mcpEnable">
                  <input
                    type="checkbox"
                    checked={server.enabled}
                    onChange={() => void toggleServer(server)}
                  />
                  <span className="mcpName">{server.name}</span>
                </label>
                <span className="mcpUrl" title={server.url}>
                  {server.url}
                </span>
                <span
                  className={`mcpToken ${
                    server.auth_kind === 'oauth'
                      ? server.oauth_connected
                        ? 'set'
                        : 'warn'
                      : server.has_token
                        ? 'set'
                        : ''
                  }`}
                >
                  {authLabel(server)}
                </span>
                {server.auth_kind === 'oauth' ? (
                  <button
                    type="button"
                    className="mcpConnect"
                    onClick={() => void connectServer(server.id)}
                  >
                    {server.oauth_connected ? 'Reconnect' : 'Connect'}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="mcpRemove"
                  onClick={() => void removeServer(server)}
                  aria-label={`Remove ${server.name}`}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>

          <div className="mcpForm">
            <input
              className="mcpInput"
              placeholder="name (e.g. linear)"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <input
              className="mcpInput mcpInputUrl"
              placeholder="https://mcp.example.com/mcp"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
            <select
              className="mcpInput"
              value={authKind}
              onChange={(event) => setAuthKind(event.target.value as AuthKind)}
              aria-label="Authentication method"
            >
              <option value="none">no auth</option>
              <option value="bearer">bearer token</option>
              <option value="oauth">OAuth (connect account)</option>
            </select>
            {authKind === 'bearer' ? (
              <input
                className="mcpInput"
                placeholder="auth token"
                type="password"
                value={token}
                onChange={(event) => setToken(event.target.value)}
              />
            ) : null}
            <button
              type="button"
              className="headerButton"
              disabled={busy || !name.trim() || !url.trim()}
              onClick={() => void addServer()}
            >
              {busy ? 'Adding…' : authKind === 'oauth' ? 'Add & connect' : 'Add server'}
            </button>
          </div>

          {error ? <p className="mcpError">{error}</p> : null}
        </div>
      ) : null}
    </div>
  )
}
