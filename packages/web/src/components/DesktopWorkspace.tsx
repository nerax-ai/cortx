import type { AgentState } from '@cortx/store';
import type { QueuedPrompt } from './PromptInput';
import type { ContextUsageSummary } from '../context-usage';
import type {
  WebAgentSpecInfo,
  WebApprovalMode,
  WebEventConnectionState,
  WebEventHistoryState,
  WebModelInfo,
  WebRuntimeSessionInfo,
  WebSkillInfo,
  WebSkillPackInfo,
  WebSkillPackInstallRequest,
  WebToolProfileInfo,
  WebWorkspaceDirectoryListing,
  WebWorkspaceToolMode,
} from '../bridge/event-bridge';
import { surface } from '../design';
import { ChatView } from './ChatView';
import { InspectorPanel } from './InspectorPanel';
import { SessionSidebar } from './SessionSidebar';
import { WorkspaceHeader } from './WorkspaceHeader';

interface DesktopWorkspaceProps {
  state: AgentState;
  session: WebRuntimeSessionInfo | null;
  sessions: WebRuntimeSessionInfo[];
  agentSpecs: WebAgentSpecInfo[];
  models: WebModelInfo[];
  sessionSkills: WebSkillInfo[];
  toolProfiles?: WebToolProfileInfo[];
  queuedPrompts: QueuedPrompt[];
  skillPacks: WebSkillPackInfo[];
  selectedSkillPackIds: string[];
  selectedWorkingDirectory: string | null;
  toolMode: WebWorkspaceToolMode;
  approvalMode: WebApprovalMode;
  eventConnection: WebEventConnectionState;
  eventHistory: WebEventHistoryState;
  onSend: (message: string) => void;
  onAbort: () => void;
  onResume: () => void;
  onSteerQueuedPrompt: (id: string) => void;
  onDeleteQueuedPrompt: (id: string) => void;
  onRecoverEventStream: () => void | Promise<void>;
  onLoadOlderHistory: () => void | Promise<void>;
  onCreateSession: (request: {
    workingDirectory: string;
    skillPacks?: string[];
  }) => void | Promise<void>;
  onBrowseWorkspaceDirectories: (path?: string) => Promise<WebWorkspaceDirectoryListing>;
  onLaunchAgentSpec: (path: string) => void | Promise<void>;
  onInstallSkillPack: (request: WebSkillPackInstallRequest) => void | Promise<void>;
  onSkillPackSelectionChange: (ids: string[]) => void;
  onSelectProject: (workingDirectory: string) => void | Promise<void>;
  onSwitchSession: (sessionId: string) => void | Promise<void>;
  onDeleteSession: (sessionId: string) => void | Promise<void>;
  onModelChange: (model: string) => void;
  onReasoningEffortChange: (effort: string | null) => void;
  onToolModeChange: (mode: WebWorkspaceToolMode) => void;
  onApprovalModeChange: (mode: WebApprovalMode) => void;
}

export function contextUsageForSession(
  state: AgentState,
  session: WebRuntimeSessionInfo | null,
): ContextUsageSummary | undefined {
  if (state.contextUsage) {
    const windowTokens = state.contextUsage.windowTokens ?? session?.contextWindowTokens;
    return {
      ...state.contextUsage,
      windowTokens,
      windowSource: state.contextUsage.windowSource ?? session?.contextWindowSource,
      model: state.contextUsage.model ?? session?.model,
      percentUsed:
        state.contextUsage.percentUsed ??
        (state.contextUsage.usedTokens !== undefined && windowTokens !== undefined && windowTokens > 0
          ? (state.contextUsage.usedTokens / windowTokens) * 100
          : undefined),
    };
  }
  if (!session) return undefined;
  if (session.usage?.context) {
    const windowTokens = session.usage.context.windowTokens ?? session.contextWindowTokens;
    return {
      ...session.usage.context,
      windowTokens,
      windowSource: session.usage.context.windowSource ?? session.contextWindowSource,
      model: session.usage.context.model ?? session.model,
      percentUsed:
        session.usage.context.percentUsed ??
        (session.usage.context.usedTokens !== undefined && windowTokens !== undefined && windowTokens > 0
          ? (session.usage.context.usedTokens / windowTokens) * 100
          : undefined),
    };
  }
  return {
    windowTokens: session.contextWindowTokens,
    windowSource: session.contextWindowSource,
    model: session.model,
    breakdown: [],
  };
}

export function DesktopWorkspace({
  state,
  session,
  sessions,
  agentSpecs,
  models,
  sessionSkills,
  toolProfiles = [],
  queuedPrompts,
  skillPacks,
  selectedSkillPackIds,
  selectedWorkingDirectory,
  toolMode,
  approvalMode,
  eventConnection,
  eventHistory,
  onSend,
  onAbort,
  onResume,
  onSteerQueuedPrompt,
  onDeleteQueuedPrompt,
  onRecoverEventStream,
  onLoadOlderHistory,
  onCreateSession,
  onBrowseWorkspaceDirectories,
  onLaunchAgentSpec,
  onInstallSkillPack,
  onSkillPackSelectionChange,
  onSelectProject,
  onSwitchSession,
  onDeleteSession,
  onModelChange,
  onReasoningEffortChange,
  onToolModeChange,
  onApprovalModeChange,
}: DesktopWorkspaceProps) {
  const contextUsage = contextUsageForSession(state, session);

  return (
    <div className={`${surface.page} flex h-screen overflow-hidden`}>
      <div className="hidden w-[252px] shrink-0 md:block">
        <SessionSidebar
          status={state.status}
          session={session}
          sessions={sessions}
          agentSpecs={agentSpecs}
          skillPacks={skillPacks}
          selectedSkillPackIds={selectedSkillPackIds}
          selectedWorkingDirectory={selectedWorkingDirectory}
          tokenUsage={state.tokenUsage}
          elapsed={state.totalElapsed}
          onCreateSession={onCreateSession}
          onBrowseWorkspaceDirectories={onBrowseWorkspaceDirectories}
          onLaunchAgentSpec={onLaunchAgentSpec}
          onInstallSkillPack={onInstallSkillPack}
          onSkillPackSelectionChange={onSkillPackSelectionChange}
          onSelectProject={onSelectProject}
          onSwitchSession={onSwitchSession}
          onDeleteSession={onDeleteSession}
        />
      </div>

      <main className="flex min-w-0 flex-1 flex-col">
        <WorkspaceHeader
          status={state.status}
          session={session}
          tokenUsage={state.tokenUsage}
          elapsed={state.totalElapsed}
          iteration={state.iteration}
          eventConnection={eventConnection}
          onRecoverEventStream={onRecoverEventStream}
        />
        <div className="grid min-h-0 flex-1 grid-cols-1 xl:grid-cols-[minmax(0,1fr)_344px]">
          <ChatView
            sessionId={session?.id ?? state.sessionId}
            messages={state.messages}
            activity={state.activity}
            toolCalls={state.toolCalls}
            agentSessions={state.agentSessions}
            contextUsage={contextUsage}
            tokenUsage={state.tokenUsage}
            status={state.status}
            error={state.error}
            skills={sessionSkills}
            toolProfiles={toolProfiles}
            models={models}
            model={session?.model}
            reasoningEffort={session?.reasoningEffort}
            promptHistory={session?.promptHistory}
            queuedPrompts={queuedPrompts}
            hasOlderHistory={eventHistory.sessionId === session?.id && eventHistory.hasMoreBefore}
            isLoadingOlderHistory={eventHistory.sessionId === session?.id && eventHistory.loadingOlder}
            toolMode={toolMode}
            approvalMode={approvalMode}
            onSend={onSend}
            onAbort={onAbort}
            onResume={onResume}
            onSteerQueuedPrompt={onSteerQueuedPrompt}
            onDeleteQueuedPrompt={onDeleteQueuedPrompt}
            onLoadOlderHistory={onLoadOlderHistory}
            onModelChange={onModelChange}
            onReasoningEffortChange={onReasoningEffortChange}
            onToolModeChange={onToolModeChange}
            onApprovalModeChange={onApprovalModeChange}
          />
          <div className="hidden min-h-0 border-l border-zinc-200 xl:block">
            <InspectorPanel
              session={session}
              status={state.status}
              tokenUsage={state.tokenUsage}
              elapsed={state.totalElapsed}
              activity={state.activity}
            />
          </div>
        </div>
      </main>
    </div>
  );
}
