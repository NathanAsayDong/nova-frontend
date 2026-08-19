import { useCallback, useEffect, useState } from 'react'
import { ConversationHeader } from './features/nova/components/ConversationHeader'
import type { ProjectSummary } from './features/nova/components/ConversationHeader'
import { ConversationPanel } from './features/nova/components/ConversationPanel'
import { AuraBackdrop } from './features/nova/components/AuraBackdrop'
import { MicButton } from './features/nova/components/MicButton'
import { MeetingView } from './features/meetings/components/MeetingView'
import { MeetingStartForm } from './features/meetings/components/MeetingStartForm'
import { MeetingsPanel } from './features/meetings/components/MeetingsPanel'
import { useMeetingMode } from './features/meetings/hooks/useMeetingMode'
import { connectFacePublisher, publishFaceMode } from './features/face/publisher'
import type { FaceMode } from './features/face/faceTypes'
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
    isMeetingViewOpen,
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

  // The /face tab renders whatever the app tab is doing; this tab is the
  // only source of truth for mode, so publish every change to the relay.
  useEffect(() => {
    connectFacePublisher()
  }, [])

  const faceMode: FaceMode = isMeetingRecording
    ? 'meeting'
    : !isNovaEnabled
      ? 'off'
      : uiPhase === 'responding'
        ? 'talking'
        : uiPhase === 'thinking' || (isStreaming && uiPhase === 'idle')
          ? 'thinking'
          : uiPhase === 'listening'
            ? 'listening'
            : 'idle'

  useEffect(() => {
    publishFaceMode(faceMode)
  }, [faceMode])

  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [isStartFormOpen, setIsStartFormOpen] = useState(false)
  const [isMeetingsPanelOpen, setIsMeetingsPanelOpen] = useState(false)

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
    setIsMeetingsPanelOpen(false)
    setIsStartFormOpen((current) => !current)
  }, [isMeetingRecording, stopMeeting])

  const isMeetingBusy = meetingPhase === 'starting' || meetingPhase === 'stopping'

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
          isMeetingsPanelOpen={isMeetingsPanelOpen}
          onNewConversation={handleNewConversation}
          onTogglePower={() => setNovaPower(!isNovaEnabled)}
          onToggleMeeting={handleToggleMeeting}
          onToggleMeetingsPanel={() => {
            setIsStartFormOpen(false)
            setIsMeetingsPanelOpen((current) => !current)
          }}
        />

        {isStartFormOpen && !isMeetingViewOpen ? (
          <MeetingStartForm
            projects={projects}
            defaultProjectId={project?.id ?? null}
            onCancel={() => setIsStartFormOpen(false)}
            onStart={(input) => {
              setIsStartFormOpen(false)
              void startMeeting(input)
            }}
          />
        ) : null}

        {isMeetingViewOpen ? (
          // One view for the whole meeting — recording, writing up, and the
          // finished notes — so stopping is a single transition rather than a
          // bounce back to chat and out again.
          <MeetingView
            phase={meetingPhase}
            title={meeting?.title ?? null}
            projectName={meeting?.project?.name ?? null}
            segments={meetingSegments}
            partial={meetingPartial}
            error={meetingError}
            notes={finishedDetail?.notes ?? null}
            finishedWithoutNotes={
              finishedDetail !== null && finishedDetail.notes === null
            }
            onStop={() => void stopMeeting()}
            onDone={() => {
              // A meeting can begin while the form or the list is open (Nova
              // starts one by voice); clear both on the way out so finishing
              // lands in the conversation rather than back where you were.
              setIsStartFormOpen(false)
              setIsMeetingsPanelOpen(false)
              dismissFinished()
            }}
          />
        ) : isMeetingsPanelOpen ? (
          <MeetingsPanel
            projects={projects}
            onClose={() => setIsMeetingsPanelOpen(false)}
          />
        ) : (
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
        )}
      </div>
    </main>
  )
}

export default App
