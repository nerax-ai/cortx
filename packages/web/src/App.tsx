import { useEffect, useState, useSyncExternalStore } from 'react';
import { SessionController } from './session/session-controller';
import type {
  WebApprovalMode,
  WebRuntimeSessionInfo,
  WebSkillInfo,
  WebWorkspaceDirectoryListing,
  WebWorkspaceToolMode,
} from './client/types';
import { ConnectionStatus } from './components/ConnectionStatus';
import { DesktopWorkspace } from './components/DesktopWorkspace';
import { AskUserDialog } from './components/AskUserDialog';
import type { QueuedPrompt } from './components/PromptInput';

const DEFAULT_API_KEY = import.meta.env.VITE_CORTX_API_KEY ?? 'cortx-dev-key';

function sameWorkspace(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  const normalize = (value: string) => value.replace(/\/+$/, '') || '/';
  return normalize(left) === normalize(right);
}

export function App() {
  const [controller] = useState(() => new SessionController({ apiKey: DEFAULT_API_KEY }));
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const session = snapshot.session;
  const [actionError, setActionError] = useState<string | null>(null);
  const [sessionSkills, setSessionSkills] = useState<WebSkillInfo[]>([]);
  const [selectedWorkingDirectory, setSelectedWorkingDirectory] = useState<string | null>(null);
  const [selectedSkillPackIds, setSelectedSkillPackIds] = useState<string[]>([]);
  const [toolMode, setToolMode] = useState<WebWorkspaceToolMode>('none');
  const [approvalMode, setApprovalMode] = useState<WebApprovalMode>('interactive');

  useEffect(() => {
    void controller.start().catch(() => undefined);
    return () => controller.close();
  }, [controller]);

  useEffect(() => {
    if (!session) return;
    setSelectedWorkingDirectory(session.workingDirectory);
    setSelectedSkillPackIds(session.skillPacks ?? []);
    setToolMode(session.toolProfile ?? session.toolMode);
    setApprovalMode(session.approvalMode);
    let current = true;
    setSessionSkills([]);
    void controller
      .listSessionSkills(session.id)
      .then((skills) => {
        if (current) setSessionSkills(skills);
      })
      .catch((error) => {
        if (current) setActionError(errorMessage(error));
      });
    return () => {
      current = false;
    };
  }, [controller, session?.id]);

  async function run<T>(operation: () => Promise<T>): Promise<T> {
    setActionError(null);
    try {
      return await operation();
    } catch (error) {
      setActionError(errorMessage(error));
      throw error;
    }
  }

  async function sendPrompt(message: string): Promise<void> {
    await run(() => controller.send(message));
  }

  async function createWorkspaceSession(request: { workingDirectory: string; skillPacks?: string[] }) {
    const workingDirectory = request.workingDirectory.trim();
    await run(() =>
      controller.createSession({
        workingDirectory,
        model: session?.model,
        reasoningEffort: session?.reasoningEffort,
        toolMode,
        approvalMode,
        skillPacks:
          request.skillPacks ??
          (sameWorkspace(workingDirectory, session?.workingDirectory)
            ? selectedSkillPackIds.length
              ? selectedSkillPackIds
              : undefined
            : undefined),
      }),
    );
  }

  async function selectProject(workingDirectory: string) {
    setSelectedWorkingDirectory(workingDirectory);
    const target = snapshot.sessions
      .filter((item) => item.workingDirectory === workingDirectory)
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0];
    if (target && target.id !== session?.id) await run(() => controller.activate(target.id));
  }

  async function launchAgentSpec(path: string) {
    await run(async () => {
      await controller.launchAgentSpec({ path });
      await controller.refreshAssets();
    });
  }

  async function updateActiveSession(request: {
    model?: string;
    reasoningEffort?: string | null;
    toolMode?: WebWorkspaceToolMode;
    approvalMode?: WebApprovalMode;
    skillPacks?: string[];
  }) {
    return run(() => controller.updateActiveSession(request));
  }

  async function handleToolModeChange(mode: WebWorkspaceToolMode) {
    const previous = toolMode;
    setToolMode(mode);
    try {
      await updateActiveSession({ toolMode: mode });
    } catch {
      setToolMode(previous);
    }
  }

  async function handleApprovalModeChange(mode: WebApprovalMode) {
    const previous = approvalMode;
    setApprovalMode(mode);
    try {
      await updateActiveSession({ approvalMode: mode });
    } catch {
      setApprovalMode(previous);
    }
  }

  async function handleModelChange(model: string) {
    if (!session) return;
    const selected = snapshot.models.find((item) => item.id === model);
    const reasoningEffort = selected?.reasoningEfforts?.some((option) => option.value === session.reasoningEffort)
      ? session.reasoningEffort
      : null;
    await updateActiveSession({ model, reasoningEffort }).catch(() => undefined);
  }

  async function handleReasoningEffortChange(reasoningEffort: string | null) {
    await updateActiveSession({ reasoningEffort }).catch(() => undefined);
  }

  async function handleSkillPackSelectionChange(ids: string[]) {
    const previous = selectedSkillPackIds;
    setSelectedSkillPackIds(ids);
    try {
      await updateActiveSession({ skillPacks: ids });
      if (session) setSessionSkills(await controller.listSessionSkills(session.id));
      await controller.refreshAssets();
    } catch {
      setSelectedSkillPackIds(previous);
    }
  }

  async function handleQueuedSteer(inputId: string) {
    const queued = session?.queuedInputs.find((input) => input.inputId === inputId);
    if (!queued) return;
    await run(async () => {
      await controller.cancelFollowUp(inputId);
      const current = controller.getSnapshot().session;
      if (current?.isRunning) await controller.steer(queued.message);
      else await controller.send(queued.message);
    }).catch(() => undefined);
  }

  const queuedPrompts: QueuedPrompt[] = (session?.queuedInputs ?? []).map((input) => ({
    id: input.inputId,
    text: input.message,
    createdAt: input.acceptedAt,
    state: input.state === 'interrupted' ? 'interrupted' : 'queued',
  }));

  if (snapshot.phase !== 'ready') {
    return (
      <ConnectionStatus
        error={snapshot.phase === 'failed' ? snapshot.error : null}
        onRetry={() => {
          void controller.start().catch(() => undefined);
        }}
      />
    );
  }

  return (
    <>
      <DesktopWorkspace
        state={snapshot.agent}
        session={session}
        sessions={snapshot.sessions}
        agentSpecs={snapshot.agentSpecs}
        models={snapshot.models}
        toolProfiles={snapshot.toolProfiles}
        sessionSkills={sessionSkills}
        queuedPrompts={queuedPrompts}
        skillPacks={snapshot.skillPacks}
        selectedSkillPackIds={selectedSkillPackIds}
        selectedWorkingDirectory={selectedWorkingDirectory}
        toolMode={toolMode}
        approvalMode={approvalMode}
        eventConnection={snapshot.connection}
        eventHistory={snapshot.history}
        errorNotice={actionError ?? snapshot.error}
        onDismissError={() => setActionError(null)}
        onSend={sendPrompt}
        onAbort={() => run(() => controller.abort()).catch(() => undefined)}
        onResume={() => run(() => controller.resume()).catch(() => undefined)}
        onSteerQueuedPrompt={handleQueuedSteer}
        onDeleteQueuedPrompt={(inputId) => {
          void run(() => controller.cancelFollowUp(inputId)).catch(() => undefined);
        }}
        onRecoverEventStream={() => run(() => controller.recover()).catch(() => undefined)}
        onLoadOlderHistory={() => run(() => controller.loadOlderHistory()).catch(() => undefined)}
        onCreateSession={createWorkspaceSession}
        onBrowseWorkspaceDirectories={(path): Promise<WebWorkspaceDirectoryListing> =>
          controller.listWorkspaceDirectories(path)
        }
        onLaunchAgentSpec={launchAgentSpec}
        onSkillPackSelectionChange={handleSkillPackSelectionChange}
        onSelectProject={selectProject}
        onSwitchSession={(sessionId) => run(() => controller.activate(sessionId)).catch(() => undefined)}
        onDeleteSession={(sessionId) => run(() => controller.deleteSession(sessionId)).catch(() => undefined)}
        onModelChange={handleModelChange}
        onReasoningEffortChange={handleReasoningEffortChange}
        onToolModeChange={handleToolModeChange}
        onApprovalModeChange={handleApprovalModeChange}
      />
      {snapshot.agent.status === 'awaiting_user' && snapshot.agent.pendingQuestion && (
        <AskUserDialog
          pendingQuestion={snapshot.agent.pendingQuestion}
          onSubmit={(toolCallId, response) => {
            void run(() => controller.answer(toolCallId, response)).catch(() => undefined);
          }}
        />
      )}
    </>
  );
}

export function latestSession(items: WebRuntimeSessionInfo[]): WebRuntimeSessionInfo | undefined {
  return [...items].sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
