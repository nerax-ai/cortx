import { useState, useEffect, useRef } from 'react';
import { AgentStore } from '@cortx/store';
import { useStore } from './hooks/use-store';
import {
  EventBridge,
  type WebAgentSpecInfo,
  type WebApprovalMode,
  type WebEventConnectionState,
  type WebEventHistoryState,
  type WebModelInfo,
  type WebRuntimeSessionInfo,
  type WebWorkspaceDirectoryListing,
  type WebSkillPackInfo,
  type WebSkillPackInstallRequest,
  type WebSkillInfo,
  type WebWorkspaceToolMode,
} from './bridge/event-bridge';
import { ConnectionStatus } from './components/ConnectionStatus';
import { DesktopWorkspace } from './components/DesktopWorkspace';
import { AskUserDialog } from './components/AskUserDialog';
import type { QueuedPrompt } from './components/PromptInput';

const DEFAULT_API_KEY = import.meta.env.VITE_CORTX_API_KEY ?? 'cortx-dev-key';
const INITIAL_EVENT_CONNECTION: WebEventConnectionState = {
  phase: 'closed',
  message: 'No active event stream',
  updatedAt: 0,
};
const INITIAL_EVENT_HISTORY: WebEventHistoryState = {
  hasMoreBefore: false,
  loadedEvents: 0,
  loadingOlder: false,
};
const EMPTY_QUEUED_PROMPTS: QueuedPrompt[] = [];

function createQueuedPrompt(message: string): QueuedPrompt {
  return {
    id: `queued_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    text: message,
    createdAt: Date.now(),
  };
}

function latestSession(items: WebRuntimeSessionInfo[]): WebRuntimeSessionInfo | undefined {
  return [...items].sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0];
}

export function App() {
  const [store] = useState(() => new AgentStore());
  const state = useStore(store);
  const bridgeRef = useRef<EventBridge | null>(null);
  const didAutoConnectRef = useRef(false);
  const activeSessionIdRef = useRef<string | null>(null);
  const queuedSendInFlightRef = useRef(false);
  const [connected, setConnected] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [eventConnection, setEventConnection] = useState<WebEventConnectionState>(INITIAL_EVENT_CONNECTION);
  const [eventHistory, setEventHistory] = useState<WebEventHistoryState>(INITIAL_EVENT_HISTORY);
  const [session, setSession] = useState<WebRuntimeSessionInfo | null>(null);
  const [sessions, setSessions] = useState<WebRuntimeSessionInfo[]>([]);
  const [agentSpecs, setAgentSpecs] = useState<WebAgentSpecInfo[]>([]);
  const [models, setModels] = useState<WebModelInfo[]>([]);
  const [sessionSkills, setSessionSkills] = useState<WebSkillInfo[]>([]);
  const [skillPacks, setSkillPacks] = useState<WebSkillPackInfo[]>([]);
  const [selectedSkillPackIds, setSelectedSkillPackIds] = useState<string[]>([]);
  const [selectedWorkingDirectory, setSelectedWorkingDirectory] = useState<string | null>(null);
  const [toolMode, setToolMode] = useState<WebWorkspaceToolMode>('all');
  const [approvalMode, setApprovalMode] = useState<WebApprovalMode>('interactive');
  const [queuedPromptsBySession, setQueuedPromptsBySession] = useState<Record<string, QueuedPrompt[]>>({});
  const activeQueuedPrompts = session ? queuedPromptsBySession[session.id] ?? EMPTY_QUEUED_PROMPTS : EMPTY_QUEUED_PROMPTS;

  useEffect(() => {
    if (didAutoConnectRef.current) return;
    didAutoConnectRef.current = true;
    void connect();

    return () => {
      bridgeRef.current?.disconnect();
    };
  }, []);

  useEffect(() => {
    queuedSendInFlightRef.current = false;
  }, [session?.id]);

  useEffect(() => {
    if (state.status === 'running') {
      queuedSendInFlightRef.current = false;
      return;
    }
    if (state.status !== 'idle' || !session || !bridgeRef.current || activeQueuedPrompts.length === 0) return;
    if (queuedSendInFlightRef.current) return;

    const next = activeQueuedPrompts[0];
    queuedSendInFlightRef.current = true;
    removeQueuedPrompt(session.id, next.id);
    void bridgeRef.current
      .prompt(session.id, next.text)
      .then(() => refreshSessions())
      .catch((err) => {
        prependQueuedPrompt(session.id, next);
        setConnectionError(err instanceof Error ? err.message : String(err));
        queuedSendInFlightRef.current = false;
      });
  }, [activeQueuedPrompts, session, state.status]);

  async function connect() {
    setConnectionError(null);
    setEventConnection(INITIAL_EVENT_CONNECTION);
    setEventHistory(INITIAL_EVENT_HISTORY);
    const bridge = new EventBridge(store, DEFAULT_API_KEY, '', {
      onConnectionState: setEventConnection,
      onHistoryState: setEventHistory,
    });
    bridgeRef.current = bridge;
    try {
      const [existing, availableModels] = await Promise.all([
        bridge.listSessions(),
        bridge.listModels().catch(() => [] as WebModelInfo[]),
      ]);
      setModels(availableModels);
      const target =
        [...existing].sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0] ??
        await bridge.createSession({ toolMode: 'all', approvalMode: 'interactive' });
      await bridge.connect(target.id);
      const nextSessions = await bridge.listSessions();
      activateSession(target);
      setSessions(nextSessions);
      setConnected(true);
      void refreshSessionSkills(target.id, bridge);
      void bridge
        .listAgentSpecs()
        .then((discoveredAgentSpecs) => {
          if (bridgeRef.current === bridge) setAgentSpecs(discoveredAgentSpecs);
        })
        .catch((err) => {
          if (bridgeRef.current === bridge) setConnectionError(err instanceof Error ? err.message : String(err));
        });
      void bridge
        .listSkillPacks()
        .then((installedSkillPacks) => {
          if (bridgeRef.current !== bridge) return;
          setSkillPacks(installedSkillPacks);
          setSelectedSkillPackIds((current) => current.filter((id) => installedSkillPacks.some((pack) => pack.id === id)));
        })
        .catch((err) => {
          if (bridgeRef.current === bridge) setConnectionError(err instanceof Error ? err.message : String(err));
        });
    } catch (err) {
      bridge.disconnect();
      bridgeRef.current = null;
      setConnected(false);
      setConnectionError(err instanceof Error ? err.message : String(err));
    }
  }

  function activateSession(next: WebRuntimeSessionInfo) {
    activeSessionIdRef.current = next.id;
    store.syncRuntimeSession({
      sessionId: next.id,
      isRunning: next.isRunning,
      tokenUsage: next.usage,
      contextUsage: next.usage?.context,
    });
    setSession(next);
    setSelectedWorkingDirectory(next.workingDirectory);
    setToolMode(next.toolMode);
    setApprovalMode(next.approvalMode);
    setSelectedSkillPackIds(next.skillPacks ?? []);
    setSessionSkills([]);
  }

  function rememberSession(next: WebRuntimeSessionInfo) {
    setSession((current) => (current?.id === next.id ? next : current));
    setSessions((current) =>
      current.some((item) => item.id === next.id)
        ? current.map((item) => (item.id === next.id ? next : item))
        : [next, ...current],
    );
  }

  function updateQueuedPrompts(sessionId: string, updater: (items: QueuedPrompt[]) => QueuedPrompt[]) {
    setQueuedPromptsBySession((current) => {
      const nextItems = updater(current[sessionId] ?? []);
      const next = { ...current };
      if (nextItems.length) next[sessionId] = nextItems;
      else delete next[sessionId];
      return next;
    });
  }

  function appendQueuedPrompt(sessionId: string, message: string) {
    const prompt = createQueuedPrompt(message);
    updateQueuedPrompts(sessionId, (items) => [...items, prompt].slice(-20));
  }

  function prependQueuedPrompt(sessionId: string, prompt: QueuedPrompt) {
    updateQueuedPrompts(sessionId, (items) => [prompt, ...items].slice(0, 20));
  }

  function removeQueuedPrompt(sessionId: string, id: string) {
    updateQueuedPrompts(sessionId, (items) => items.filter((item) => item.id !== id));
  }

  async function refreshSessions() {
    if (!bridgeRef.current) return;
    setSessions(await bridgeRef.current.listSessions());
  }

  async function refreshAgentSpecs() {
    if (!bridgeRef.current) return;
    setAgentSpecs(await bridgeRef.current.listAgentSpecs());
  }

  async function refreshSkillPacks() {
    if (!bridgeRef.current) return;
    const installed = await bridgeRef.current.listSkillPacks();
    setSkillPacks(installed);
    setSelectedSkillPackIds((current) => current.filter((id) => installed.some((pack) => pack.id === id)));
  }

  async function refreshSessionSkills(sessionId = session?.id, bridge = bridgeRef.current) {
    if (!sessionId || !bridge) {
      setSessionSkills([]);
      return;
    }
    try {
      const skills = await bridge.listSessionSkills(sessionId);
      if (bridgeRef.current === bridge && activeSessionIdRef.current === sessionId) {
        setSessionSkills(skills);
      }
    } catch (err) {
      if (bridgeRef.current === bridge && activeSessionIdRef.current === sessionId) {
        setSessionSkills([]);
        setConnectionError(err instanceof Error ? err.message : String(err));
      }
    }
  }

  async function listWorkspaceDirectories(path?: string): Promise<WebWorkspaceDirectoryListing> {
    if (!bridgeRef.current) throw new Error('Not connected');
    return bridgeRef.current.listWorkspaceDirectories(path);
  }

  function selectedSkillPacksForRequest(): string[] | undefined {
    return selectedSkillPackIds.length ? selectedSkillPackIds : undefined;
  }

  async function createWorkspaceSession(request: {
    workingDirectory: string;
    skillPacks?: string[];
  }) {
    if (!bridgeRef.current) return;
    const created = await bridgeRef.current.createSession({
      workingDirectory: request.workingDirectory.trim(),
      model: session?.model,
      reasoningEffort: session?.reasoningEffort,
      toolMode,
      approvalMode,
      skillPacks: request.skillPacks ?? selectedSkillPacksForRequest(),
    });
    await bridgeRef.current.connect(created.id);
    const nextSessions = await bridgeRef.current.listSessions();
    activateSession(created);
    setSessions(nextSessions);
    await refreshSessionSkills(created.id);
    await refreshAgentSpecs();
  }

  async function switchSession(sessionId: string) {
    if (!bridgeRef.current) return;
    const next = await bridgeRef.current.getSession(sessionId);
    await bridgeRef.current.connect(sessionId);
    activateSession(next);
    await refreshSessionSkills(next.id);
  }

  async function deleteSession(sessionId: string) {
    if (!bridgeRef.current) return;
    const bridge = bridgeRef.current;
    const deleted = sessions.find((item) => item.id === sessionId) ?? (session?.id === sessionId ? session : undefined);
    const deletingActiveSession = session?.id === sessionId;

    await bridge.deleteSession(sessionId);
    setQueuedPromptsBySession((current) => {
      if (!(sessionId in current)) return current;
      const next = { ...current };
      delete next[sessionId];
      return next;
    });

    let nextSessions = await bridge.listSessions();
    setSessions(nextSessions);
    if (!deletingActiveSession) return;

    const fallbackWorkingDirectory = deleted?.workingDirectory ?? selectedWorkingDirectory ?? undefined;
    let target =
      latestSession(nextSessions.filter((item) => item.workingDirectory === fallbackWorkingDirectory)) ??
      latestSession(nextSessions);

    if (!target) {
      target = await bridge.createSession({
        workingDirectory: fallbackWorkingDirectory,
        model: session?.model,
        reasoningEffort: session?.reasoningEffort,
        toolMode,
        approvalMode,
        skillPacks: selectedSkillPacksForRequest(),
      });
      nextSessions = await bridge.listSessions();
      setSessions(nextSessions);
    }

    await bridge.connect(target.id);
    activateSession(target);
    await refreshSessionSkills(target.id, bridge);
    await refreshAgentSpecs();
  }

  async function selectProject(workingDirectory: string) {
    setSelectedWorkingDirectory(workingDirectory);
    const target = [...sessions]
      .filter((item) => item.workingDirectory === workingDirectory)
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0];
    if (target && target.id !== session?.id) {
      await switchSession(target.id);
    }
  }

  async function launchAgentSpec(path: string) {
    if (!bridgeRef.current) return;
    const launched = await bridgeRef.current.launchAgentSpec({ path });
    await bridgeRef.current.connect(launched.id);
    activateSession(launched);
    await refreshSessionSkills(launched.id);
    await refreshSessions();
    await refreshAgentSpecs();
  }

  async function installSkillPack(request: WebSkillPackInstallRequest) {
    if (!bridgeRef.current) return;
    await bridgeRef.current.installSkillPack(request);
    await Promise.all([refreshSkillPacks(), refreshAgentSpecs()]);
  }

  async function updateActiveSession(request: {
    model?: string;
    reasoningEffort?: string | null;
    toolMode?: WebWorkspaceToolMode;
    approvalMode?: WebApprovalMode;
    skillPacks?: string[];
  }) {
    if (!session || !bridgeRef.current) return null;
    const updated = await bridgeRef.current.updateSession(session.id, request);
    activateSession(updated);
    rememberSession(updated);
    return updated;
  }

  async function handleToolModeChange(mode: WebWorkspaceToolMode) {
    const previous = session?.toolMode ?? toolMode;
    setToolMode(mode);
    try {
      await updateActiveSession({ toolMode: mode });
    } catch (err) {
      setToolMode(previous);
      setConnectionError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleApprovalModeChange(mode: WebApprovalMode) {
    const previous = session?.approvalMode ?? approvalMode;
    setApprovalMode(mode);
    try {
      await updateActiveSession({ approvalMode: mode });
    } catch (err) {
      setApprovalMode(previous);
      setConnectionError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleModelChange(model: string) {
    if (!session) return;
    const previous = { model: session.model, reasoningEffort: session.reasoningEffort };
    const nextModel = models.find((item) => item.id === model);
    const nextReasoningEffort = nextModel?.reasoningEfforts?.some((option) => option.value === session.reasoningEffort)
      ? session.reasoningEffort
      : null;
    try {
      await updateActiveSession({ model, reasoningEffort: nextReasoningEffort });
    } catch (err) {
      await updateActiveSession(previous).catch(() => undefined);
      setConnectionError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleReasoningEffortChange(reasoningEffort: string | null) {
    if (!session) return;
    const previous = session.reasoningEffort;
    try {
      await updateActiveSession({ reasoningEffort });
    } catch (err) {
      await updateActiveSession({ reasoningEffort: previous ?? null }).catch(() => undefined);
      setConnectionError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleSkillPackSelectionChange(ids: string[]) {
    const previous = session?.skillPacks ?? selectedSkillPackIds;
    setSelectedSkillPackIds(ids);
    try {
      await updateActiveSession({ skillPacks: ids });
      await refreshSessionSkills();
      await refreshAgentSpecs();
    } catch (err) {
      setSelectedSkillPackIds(previous);
      setConnectionError(err instanceof Error ? err.message : String(err));
    }
  }

  async function sendPrompt(message: string) {
    if (!session || !bridgeRef.current) return;
    if (state.status === 'running') {
      appendQueuedPrompt(session.id, message);
      return;
    }
    await bridgeRef.current.prompt(session.id, message);
    await refreshSessions();
  }

  async function handleSteerQueuedPrompt(id: string) {
    if (!session || !bridgeRef.current) return;
    const prompt = (queuedPromptsBySession[session.id] ?? []).find((item) => item.id === id);
    if (!prompt) return;
    removeQueuedPrompt(session.id, id);
    try {
      if (state.status === 'running') {
        await bridgeRef.current.steer(session.id, prompt.text);
      } else {
        await bridgeRef.current.prompt(session.id, prompt.text);
        await refreshSessions();
      }
    } catch (err) {
      prependQueuedPrompt(session.id, prompt);
      setConnectionError(err instanceof Error ? err.message : String(err));
    }
  }

  function handleDeleteQueuedPrompt(id: string) {
    if (!session) return;
    removeQueuedPrompt(session.id, id);
  }

  async function handleAnswer(toolCallId: string, response: string) {
    if (!session || !bridgeRef.current) return;
    await bridgeRef.current.answer(session.id, toolCallId, response);
  }

  async function handleAbort() {
    if (!session || !bridgeRef.current) return;
    await bridgeRef.current.abort(session.id);
    const next = await bridgeRef.current.getSession(session.id);
    setSession(next);
  }

  async function handleResume() {
    if (!session || !bridgeRef.current) return;
    await bridgeRef.current.resume(session.id);
    const next = await bridgeRef.current.getSession(session.id);
    setSession(next);
  }

  async function handleRecoverEventStream() {
    if (!session || !bridgeRef.current) {
      await connect();
      return;
    }
    try {
      setConnectionError(null);
      await bridgeRef.current.connect(session.id);
      const [next, nextSessions] = await Promise.all([
        bridgeRef.current.getSession(session.id),
        bridgeRef.current.listSessions(),
      ]);
      activateSession(next);
      setSessions(nextSessions);
      await refreshSessionSkills(next.id);
    } catch (err) {
      setEventConnection({
        phase: 'disconnected',
        sessionId: session.id,
        message: err instanceof Error ? err.message : String(err),
        updatedAt: Date.now(),
      });
    }
  }

  async function handleLoadOlderHistory() {
    if (!session || !bridgeRef.current) return;
    try {
      setConnectionError(null);
      await bridgeRef.current.loadOlderHistory(session.id);
      const next = await bridgeRef.current.getSession(session.id);
      store.syncRuntimeSession({
        sessionId: next.id,
        isRunning: next.isRunning,
        tokenUsage: next.usage,
        contextUsage: next.usage?.context,
      });
      rememberSession(next);
    } catch (err) {
      setConnectionError(err instanceof Error ? err.message : String(err));
    }
  }

  if (!connected) {
    return <ConnectionStatus error={connectionError} onRetry={connect} />;
  }

  return (
    <>
      <DesktopWorkspace
        state={state}
        session={session}
        sessions={sessions}
        agentSpecs={agentSpecs}
        models={models}
        sessionSkills={sessionSkills}
        queuedPrompts={activeQueuedPrompts}
        skillPacks={skillPacks}
        selectedSkillPackIds={selectedSkillPackIds}
        selectedWorkingDirectory={selectedWorkingDirectory}
        toolMode={toolMode}
        approvalMode={approvalMode}
        eventConnection={eventConnection}
        eventHistory={eventHistory}
        onSend={sendPrompt}
        onAbort={handleAbort}
        onResume={handleResume}
        onSteerQueuedPrompt={handleSteerQueuedPrompt}
        onDeleteQueuedPrompt={handleDeleteQueuedPrompt}
        onRecoverEventStream={handleRecoverEventStream}
        onLoadOlderHistory={handleLoadOlderHistory}
        onCreateSession={createWorkspaceSession}
        onBrowseWorkspaceDirectories={listWorkspaceDirectories}
        onLaunchAgentSpec={launchAgentSpec}
        onInstallSkillPack={installSkillPack}
        onSkillPackSelectionChange={handleSkillPackSelectionChange}
        onSelectProject={selectProject}
        onSwitchSession={switchSession}
        onDeleteSession={deleteSession}
        onModelChange={handleModelChange}
        onReasoningEffortChange={handleReasoningEffortChange}
        onToolModeChange={handleToolModeChange}
        onApprovalModeChange={handleApprovalModeChange}
      />
      {state.status === 'awaiting_user' && state.pendingQuestion && (
        <AskUserDialog pendingQuestion={state.pendingQuestion} onSubmit={handleAnswer} />
      )}
    </>
  );
}
