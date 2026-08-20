import type { AgentState } from '@cortx/store';
import { useState, useSyncExternalStore } from 'react';
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
  WebToolProfileInfo,
  WebWorkspaceDirectoryListing,
  WebWorkspaceToolMode,
} from '../client/types';
import { surface } from '../design';
import { ChatView } from './ChatView';
import { InspectorPanel, type WorkspacePanelTab } from './InspectorPanel';
import { SessionSidebar } from './SessionSidebar';
import { WorkspaceHeader } from './WorkspaceHeader';
import { createDefaultWorkbenchRegistry } from '../workbench/contribution-registry';
import { WorkbenchFrame } from '../workbench/WorkbenchFrame';

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
  errorNotice?: string | null;
  onDismissError?: () => void;
  onSend: (message: string) => void | Promise<void>;
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

function normalizePathForCompare(path: string | undefined): string | undefined {
  if (!path) return undefined;
  return path.replace(/\/+$/, '') || '/';
}

function pathWithin(path: string | undefined, root: string | undefined): boolean {
  const normalizedPath = normalizePathForCompare(path);
  const normalizedRoot = normalizePathForCompare(root);
  if (!normalizedPath || !normalizedRoot) return false;
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}

function filterAgentSpecsForWorkspace(
  specs: WebAgentSpecInfo[],
  workingDirectory: string | null,
): WebAgentSpecInfo[] {
  if (!workingDirectory) return specs;
  return specs.filter((spec) => {
    if (spec.workingDirectory) return normalizePathForCompare(spec.workingDirectory) === normalizePathForCompare(workingDirectory);
    return pathWithin(spec.path, workingDirectory) || pathWithin(spec.sourceRoot, workingDirectory);
  });
}

function filterSkillPacksForWorkspace(
  packs: WebSkillPackInfo[],
  workingDirectory: string | null,
): WebSkillPackInfo[] {
  if (!workingDirectory) return packs;
  return packs.filter((pack) => pathWithin(pack.sourcePath || pack.path, workingDirectory));
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
  errorNotice,
  onDismissError,
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
  const workspaceAgentSpecs = filterAgentSpecsForWorkspace(agentSpecs, selectedWorkingDirectory);
  const workspaceSkillPacks = filterSkillPacksForWorkspace(skillPacks, selectedWorkingDirectory);
  const [registry] = useState(createDefaultWorkbenchRegistry);
  const contributions = useSyncExternalStore(registry.subscribe, registry.getSnapshot, registry.getSnapshot);
  const [railOpen, setRailOpen] = useState(false);
  const [workspacePanelOpen, setWorkspacePanelOpen] = useState(true);
  const [workspacePanelTab, setWorkspacePanelTab] = useState<WorkspacePanelTab>('activity');

  function openWorkspacePanel(tab: WorkspacePanelTab) {
    setWorkspacePanelTab(tab);
    setWorkspacePanelOpen(true);
  }

  const rail = (
    <SessionSidebar
      session={session}
      sessions={sessions}
      selectedWorkingDirectory={selectedWorkingDirectory}
      onCreateSession={onCreateSession}
      onBrowseWorkspaceDirectories={onBrowseWorkspaceDirectories}
      onSelectProject={async (workingDirectory) => {
        setRailOpen(false);
        await onSelectProject(workingDirectory);
      }}
      onSwitchSession={async (sessionId) => {
        setRailOpen(false);
        await onSwitchSession(sessionId);
      }}
      onDeleteSession={onDeleteSession}
    />
  );

  const header = (
    <WorkspaceHeader
      status={state.status}
      session={session}
      iteration={state.iteration}
      eventConnection={eventConnection}
      onRecoverEventStream={onRecoverEventStream}
      panelOpen={workspacePanelOpen}
      activePanel={workspacePanelTab}
      panelItems={contributions.map((contribution) => ({ value: contribution.id, label: contribution.label }))}
      onOpenPanel={openWorkspacePanel}
      onClosePanel={() => setWorkspacePanelOpen(false)}
    />
  );

  const conversation = (
    <div className="flex min-h-0 flex-1 flex-col">
      {session?.sessionHealth === 'durability_failed' && (
        <div role="alert" className="border-b border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-800">
          Runtime persistence failed. New mutations are disabled until storage is repaired; the visible history remains available for diagnosis.
        </div>
      )}
      {eventHistory.truncated && (
        <div role="status" className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
          Earlier events were truncated by retention. The conversation starts at the oldest recoverable Runtime fact.
        </div>
      )}
      {errorNotice && (
        <div
          role="status"
          aria-live="polite"
          className="flex items-center justify-between gap-3 border-b border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-800"
        >
          <span>{errorNotice}</span>
          {onDismissError && (
            <button type="button" onClick={onDismissError} className={`min-h-9 rounded px-2 py-1 text-xs hover:bg-rose-100 ${surface.focus}`}>
              Dismiss
            </button>
          )}
        </div>
      )}
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
        agentSpecs={workspaceAgentSpecs}
        skillPacks={workspaceSkillPacks}
        selectedSkillPackIds={selectedSkillPackIds}
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
        canChangeModes={session ? session.runPhase === 'idle' && session.sessionHealth !== 'durability_failed' : state.status === 'idle'}
        onSend={onSend}
        onAbort={onAbort}
        onResume={onResume}
        onSteerQueuedPrompt={onSteerQueuedPrompt}
        onDeleteQueuedPrompt={onDeleteQueuedPrompt}
        onLoadOlderHistory={onLoadOlderHistory}
        onLaunchAgentSpec={onLaunchAgentSpec}
        onSkillPackSelectionChange={onSkillPackSelectionChange}
        onModelChange={onModelChange}
        onReasoningEffortChange={onReasoningEffortChange}
        onToolModeChange={onToolModeChange}
        onApprovalModeChange={onApprovalModeChange}
      />
    </div>
  );

  const sidePane = (
    <InspectorPanel
      activity={state.activity}
      contextUsage={contextUsage}
      tokenUsage={state.tokenUsage}
      contributions={contributions}
      activeTab={workspacePanelTab}
      onTabChange={setWorkspacePanelTab}
      onClose={() => setWorkspacePanelOpen(false)}
    />
  );

  return (
    <WorkbenchFrame
      rail={rail}
      header={header}
      conversation={conversation}
      sidePane={sidePane}
      railOpen={railOpen}
      sidePaneOpen={workspacePanelOpen}
      onRailOpenChange={setRailOpen}
      onSidePaneOpenChange={setWorkspacePanelOpen}
    />
  );
}
