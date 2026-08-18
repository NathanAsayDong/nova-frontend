import { useCallback, useEffect, useState } from 'react'
import { ConversationHeader } from './features/nova/components/ConversationHeader'
import type { ProjectSummary } from './features/nova/components/ConversationHeader'
import { ConversationPanel } from './features/nova/components/ConversationPanel'
import { AuraBackdrop } from './features/nova/components/AuraBackdrop'
import { MicButton } from './features/nova/components/MicButton'
import { MeetingLive } from './features/meetings/components/MeetingLive'
import { MeetingNotesCard } from './features/meetings/components/MeetingNotesCard'
import { useMeetingMode } from './features/meetings/hooks/useMeetingMode'
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

  const {
    phase: meetingPhase,
    meeting,
    segments: meetingSegments,
    partial: meetingPartial,
    error: meetingError,
    finishedDetail,
    isRecording: isMeetingRecording,
    startMeeting,
    stopMeeting,
    dismissFinished,
  } = useMeetingMode()

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
    // The meeting recorder needs the microphone to itself, and Nova must not
    // answer the room while one is running.
    suspended: isMeetingRecording,
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

  const handleToggleMeeting = useCallback(() => {
    if (isMeetingRecording) {
      void stopMeeting()
      return
    }
    // Meetings inherit the conversation's project, matching what Nova does
    // when it starts one by voice.
    void startMeeting({ projectId: project?.id ?? null })
  }, [isMeetingRecording, project, startMeeting, stopMeeting])

  const isMeetingBusy =
    meetingPhase === 'starting' ||
    meetingPhase === 'stopping' ||
    meetingPhase === 'processing'

  return (
    <main className="shell">
      <AuraBackdrop
        uiPhase={uiPhase}
        isNovaEnabled={isNovaEnabled && !isMeetingRecording}
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
          isMeetingMode={isMeetingRecording}
          isMeetingBusy={isMeetingBusy}
          onNewConversation={handleNewConversation}
          onTogglePower={() => setNovaPower(!isNovaEnabled)}
          onToggleMeeting={handleToggleMeeting}
        />

        {isMeetingRecording || meetingPhase === 'stopping' ? (
          // A meeting replaces the conversation rather than sitting beside it:
          // Nova is not going to answer, and leaving the chat composer in
          // reach would invite typing into a conversation that is not
          // listening.
          <MeetingLive
            phase={meetingPhase}
            title={meeting?.title ?? null}
            projectName={meeting?.project?.name ?? null}
            segments={meetingSegments}
            partial={meetingPartial}
            error={meetingError}
            onStop={() => void stopMeeting()}
          />
        ) : (
          <ConversationPanel
            messages={messages}
            isStreaming={isStreaming}
            isLoadingHistory={isLoadingHistory}
            error={chatError}
            onSend={sendMessage}
            onStop={stopStreaming}
            banner={
              finishedDetail ? (
                <MeetingNotesCard detail={finishedDetail} onDismiss={dismissFinished} />
              ) : meetingPhase === 'processing' ? (
                <p className="meetingProcessingBanner">
                  Meeting ended. Nova is writing it up…
                </p>
              ) : null
            }
            voiceSlot={
              <MicButton
                isNovaEnabled={isNovaEnabled}
                showMicEnableButton={showMicEnableButton}
                onRetry={retryRuntime}
              />
            }
          />
        )}
      </div>
    </main>
  )
}

export default App
