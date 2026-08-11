import { useCallback, useEffect, useState } from 'react'
import { ConversationHeader } from './features/nova/components/ConversationHeader'
import type { ProjectSummary } from './features/nova/components/ConversationHeader'
import { ConversationPanel } from './features/nova/components/ConversationPanel'
import { AuraBackdrop } from './features/nova/components/AuraBackdrop'
import { MicButton } from './features/nova/components/MicButton'
import { useNovaChat } from './features/nova/hooks/useNovaChat'
import { useNovaRuntime } from './features/nova/hooks/useNovaRuntime'
import './features/nova/styles/index.css'

function App() {
  const {
    messages,
    isStreaming,
    isLoadingHistory,
    error: chatError,
    conversationId,
    project,
    sendMessage,
    stopStreaming,
    startNewConversation,
    refreshConversation,
    addVoiceUserMessage,
    updateVoiceDraft,
    applyVoiceEvent,
    endVoiceAssistantTurn,
  } = useNovaChat()

  // Speech feeds the same transcript as chat: the websocket now emits the
  // same structured turn events the chat stream does.
  const handleTurnComplete = useCallback(
    (id: string) => {
      endVoiceAssistantTurn(id)
    },
    [endVoiceAssistantTurn],
  )

  const {
    isNovaEnabled,
    showMicEnableButton,
    uiPhase,
    combinedVoiceLevel,
    retryRuntime,
    setNovaPower,
  } = useNovaRuntime({
    onUserTranscript: addVoiceUserMessage,
    onPartialUserTranscript: updateVoiceDraft,
    onAgentEvent: applyVoiceEvent,
    onTurnComplete: handleTurnComplete,
  })

  const [projects, setProjects] = useState<ProjectSummary[]>([])

  const loadProjects = useCallback(async () => {
    try {
      const response = await fetch('/projects')
      if (response.ok) {
        setProjects((await response.json()) as ProjectSummary[])
      }
    } catch {
      // The project list is informational; a failure shouldn't break chat.
    }
  }, [])

  useEffect(() => {
    void loadProjects()
  }, [loadProjects])

  // Nova can create, attach, or switch projects mid-turn, so reconcile the
  // header and project list once a turn settles. uiPhase covers spoken turns.
  useEffect(() => {
    if (!isStreaming && uiPhase === 'idle') {
      void loadProjects()
      void refreshConversation()
    }
  }, [isStreaming, uiPhase, loadProjects, refreshConversation])

  const handleNewConversation = useCallback(async () => {
    await startNewConversation()
    void loadProjects()
  }, [loadProjects, startNewConversation])

  return (
    <main className="shell">
      <AuraBackdrop
        uiPhase={uiPhase}
        isNovaEnabled={isNovaEnabled}
        voiceLevel={combinedVoiceLevel}
        isStreaming={isStreaming}
      />

      <div className="novaWorkspace">
        <ConversationHeader
          conversationId={conversationId}
          project={project}
          projects={projects}
          uiPhase={uiPhase}
          isStreaming={isStreaming}
          isNovaEnabled={isNovaEnabled}
          onNewConversation={handleNewConversation}
          onTogglePower={() => setNovaPower(!isNovaEnabled)}
        />

        <ConversationPanel
          messages={messages}
          isStreaming={isStreaming}
          isLoadingHistory={isLoadingHistory}
          error={chatError}
          onSend={sendMessage}
          onStop={stopStreaming}
          voiceSlot={
            <MicButton
              isNovaEnabled={isNovaEnabled}
              showMicEnableButton={showMicEnableButton}
              onRetry={retryRuntime}
            />
          }
        />
      </div>
    </main>
  )
}

export default App
