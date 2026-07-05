import type { AgentState } from '@cortx/store';
import type { WebApprovalMode, WebRuntimeSessionInfo, WebWorkspaceToolMode } from '../bridge/event-bridge';
import { surface } from '../design';
import { ChatView } from './ChatView';
import { InspectorPanel } from './InspectorPanel';
import { SessionSidebar } from './SessionSidebar';
import { WorkspaceHeader } from './WorkspaceHeader';

interface DesktopWorkspaceProps {
  state: AgentState;
  session: WebRuntimeSessionInfo | null;
  sessions: WebRuntimeSessionInfo[];
  onSend: (message: string) => void;
  onAbort: () => void;
  onResume: () => void;
  onCreateSession: (request: {
    workingDirectory: string;
    toolMode: WebWorkspaceToolMode;
    approvalMode: WebApprovalMode;
  }) => void | Promise<void>;
  onSwitchSession: (sessionId: string) => void | Promise<void>;
}

export function DesktopWorkspace({
  state,
  session,
  sessions,
  onSend,
  onAbort,
  onResume,
  onCreateSession,
  onSwitchSession,
}: DesktopWorkspaceProps) {
  return (
    <div className={`${surface.page} flex h-screen overflow-hidden`}>
      <div className="hidden w-[252px] shrink-0 md:block">
        <SessionSidebar
          status={state.status}
          session={session}
          sessions={sessions}
          tokenUsage={state.tokenUsage}
          elapsed={state.totalElapsed}
          onCreateSession={onCreateSession}
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
        />
        <div className="grid min-h-0 flex-1 grid-cols-1 xl:grid-cols-[minmax(0,1fr)_344px]">
          <ChatView
            messages={state.messages}
            toolCalls={state.toolCalls}
            agentSessions={state.agentSessions}
            status={state.status}
            iteration={state.iteration}
            error={state.error}
            onSend={onSend}
            onAbort={onAbort}
            onResume={onResume}
          />
          <div className="hidden min-h-0 border-l border-zinc-200 xl:block">
            <InspectorPanel
              session={session}
              status={state.status}
              tokenUsage={state.tokenUsage}
              elapsed={state.totalElapsed}
              toolCalls={state.toolCalls}
              agentSessions={state.agentSessions}
            />
          </div>
        </div>
      </main>
    </div>
  );
}
