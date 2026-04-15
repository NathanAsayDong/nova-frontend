import type { ToolSummary } from '../types'

type ToolsDrawerProps = {
  isOpen: boolean
  isNovaEnabled: boolean
  tools: ToolSummary[]
  toolsError: string
  isToolsLoading: boolean
  savingMap: Record<string, boolean>
  onToggleOpen: () => void
  onSetNovaPower: (enabled: boolean) => void
  onToggleTool: (toolName: string, enabled: boolean) => Promise<void>
}

export function ToolsDrawer({
  isOpen,
  isNovaEnabled,
  tools,
  toolsError,
  isToolsLoading,
  savingMap,
  onToggleOpen,
  onSetNovaPower,
  onToggleTool,
}: ToolsDrawerProps) {
  return (
    <>
      <button
        type="button"
        className={`toolsEdgeToggle ${isOpen ? 'open' : 'closed'}`}
        onClick={onToggleOpen}
        aria-expanded={isOpen}
        aria-controls="nova-tools-drawer"
        aria-label={isOpen ? 'Hide tools panel' : 'Show tools panel'}
      >
        {isOpen ? '›' : '‹'}
      </button>

      <aside id="nova-tools-drawer" className={`toolsDrawer ${isOpen ? 'open' : 'closed'}`}>
        <section className="toolsPanel">
          <h2>Tools</h2>
          <div className={`powerRow ${isNovaEnabled ? 'powerOn' : 'powerOff'}`}>
            <div className="powerMeta">
              <p className="powerLabel">Nova Power</p>
              <p className="powerSubLabel">{isNovaEnabled ? 'Online' : 'Offline'}</p>
            </div>
            <label className="toggleWrap powerToggleWrap">
              <input
                type="checkbox"
                checked={isNovaEnabled}
                className="toggleInput"
                aria-label="Toggle Nova power"
                onChange={(event) => {
                  onSetNovaPower(event.target.checked)
                }}
              />
              <span className="toggleSlider powerToggleSlider" aria-hidden="true" />
            </label>
          </div>

          {isToolsLoading ? <p>Loading tools...</p> : null}
          {toolsError ? <p className="errorText">{toolsError}</p> : null}

          <ul className="toolList">
            {tools.map((tool) => {
              const isSaving = Boolean(savingMap[tool.name])
              return (
                <li key={tool.name} className="toolRow">
                  <div className="toolMeta">
                    <p className="toolName">{tool.name}</p>
                    <p className="toolDescription">{tool.description}</p>
                  </div>

                  <label className="toggleWrap">
                    <input
                      type="checkbox"
                      checked={tool.enabled}
                      disabled={isSaving}
                      className="toggleInput"
                      aria-label={`Toggle ${tool.name}`}
                      onChange={(event) => {
                        void onToggleTool(tool.name, event.target.checked)
                      }}
                    />
                    <span className="toggleSlider" aria-hidden="true" />
                  </label>
                </li>
              )
            })}
          </ul>
        </section>
      </aside>
    </>
  )
}
