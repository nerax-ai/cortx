import type { AgentState } from '@cortx/store';
import type {
  WebAgentSpecInfo,
  WebApprovalMode,
  WebEventConnectionState,
  WebRuntimeSessionInfo,
  WebSkillPackInfo,
  WebSkillPackInstallRequest,
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
  skillPacks: WebSkillPackInfo[];
  selectedSkillPackIds: string[];
  selectedWorkingDirectory: string | null;
  toolMode: WebWorkspaceToolMode;
  approvalMode: WebApprovalMode;
  eventConnection: WebEventConnectionState;
  onSend: (message: string) => void;
  onAbort: () => void;
  onResume: () => void;
  onRecoverEventStream: () => void | Promise<void>;
  onCreateSession: (request: {
    workingDirectory: string;
    skillPacks?: string[];
  }) => void | Promise<void>;
  onCreateSessionForCurrentProject: () => void | Promise<unknown>;
  onLaunchAgentSpec: (path: string) => void | Promise<void>;
  onInstallSkillPack: (request: WebSkillPackInstallRequest) => void | Promise<void>;
  onSkillPackSelectionChange: (ids: string[]) => void;
  onSelectProject: (workingDirectory: string) => void | Promise<void>;
  onSwitchSession: (sessionId: string) => void | Promise<void>;
  onToolModeChange: (mode: WebWorkspaceToolMode) => void;
  onApprovalModeChange: (mode: WebApprovalMode) => void;
}

export function DesktopWorkspace({
  state,
  session,
  sessions,
  agentSpecs,
  skillPacks,
  selectedSkillPackIds,
  selectedWorkingDirectory,
  toolMode,
  approvalMode,
  eventConnection,
  onSend,
  onAbort,
  onResume,
  onRecoverEventStream,
  onCreateSession,
  onCreateSessionForCurrentProject,
  onLaunchAgentSpec,
  onInstallSkillPack,
  onSkillPackSelectionChange,
  onSelectProject,
  onSwitchSession,
  onToolModeChange,
  onApprovalModeChange,
}: DesktopWorkspaceProps) {
  const willCreateSessionOnSend =
    Boolean(session) &&
    state.status !== 'running' &&
    (session?.toolMode !== toolMode ||
      session?.approvalMode !== approvalMode ||
      (session?.skillPacks ?? []).length !== selectedSkillPackIds.length ||
      (session?.skillPacks ?? []).some((id) => !selectedSkillPackIds.includes(id)));

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
          onLaunchAgentSpec={onLaunchAgentSpec}
          onInstallSkillPack={onInstallSkillPack}
          onSkillPackSelectionChange={onSkillPackSelectionChange}
          onSelectProject={onSelectProject}
          onSwitchSession={onSwitchSession}
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
            messages={state.messages}
            activity={state.activity}
            toolCalls={state.toolCalls}
            agentSessions={state.agentSessions}
            status={state.status}
            iteration={state.iteration}
            error={state.error}
            toolMode={toolMode}
            approvalMode={approvalMode}
            selectedWorkingDirectory={selectedWorkingDirectory}
            willCreateSessionOnSend={willCreateSessionOnSend}
            onSend={onSend}
            onAbort={onAbort}
            onResume={onResume}
            onCreateSessionForCurrentProject={onCreateSessionForCurrentProject}
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
