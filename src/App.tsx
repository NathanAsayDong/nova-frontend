import { HudBackground } from './features/nova/components/HudBackground'
import { MarkdownPanel } from './features/nova/components/MarkdownPanel'
import { ToolsDrawer } from './features/nova/components/ToolsDrawer'
import { VoiceStage } from './features/nova/components/VoiceStage'
import { useNovaRuntime } from './features/nova/hooks/useNovaRuntime'
import './features/nova/styles/index.css'

function App() {
  const {
    isNovaEnabled,
    showMicEnableButton,
    isToolsPanelOpen,
    tools,
    toolsError,
    isToolsLoading,
    savingMap,
    uiPhase,
    visualAudioLevel,
    combinedVoiceLevel,
    hasSpeechInput,
    assistantText,
    assistantMarkdown,
    isMarkdownPanelOpen,
    setIsToolsPanelOpen,
    setIsMarkdownPanelOpen,
    retryRuntime,
    setNovaPower,
    toggleTool,
  } = useNovaRuntime()

  return (
    <main className="shell">
      <HudBackground />

      <VoiceStage
        uiPhase={uiPhase}
        visualAudioLevel={visualAudioLevel}
        combinedVoiceLevel={combinedVoiceLevel}
        hasSpeechInput={hasSpeechInput}
        assistantText={assistantText}
        showMicEnableButton={showMicEnableButton}
        isNovaEnabled={isNovaEnabled}
        onRetry={retryRuntime}
      />

      <ToolsDrawer
        isOpen={isToolsPanelOpen}
        isNovaEnabled={isNovaEnabled}
        tools={tools}
        toolsError={toolsError}
        isToolsLoading={isToolsLoading}
        savingMap={savingMap}
        onToggleOpen={() => setIsToolsPanelOpen((current) => !current)}
        onSetNovaPower={setNovaPower}
        onToggleTool={toggleTool}
      />

      <MarkdownPanel
        isOpen={isMarkdownPanelOpen}
        isToolsPanelOpen={isToolsPanelOpen}
        markdown={assistantMarkdown}
        onToggleOpen={() => setIsMarkdownPanelOpen((current) => !current)}
      />
    </main>
  )
}

export default App
