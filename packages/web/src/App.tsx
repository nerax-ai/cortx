import { useState, useEffect, useRef } from 'react';
import { AgentStore } from '@cortx/store';
import { useStore } from './hooks/use-store';
import {
  EventBridge,
  type WebAgentSpecInfo,
  type WebApprovalMode,
  type WebEventConnectionState,
  type WebRuntimeSessionInfo,
  type WebWorkspaceDirectoryListing,
  type WebSkillPackInfo,
  type WebSkillPackInstallRequest,
  type WebWorkspaceToolMode,
} from './bridge/event-bridge';
import { ConnectionStatus } from './components/ConnectionStatus';
import { DesktopWorkspace } from './components/DesktopWorkspace';
import { AskUserDialog } from './components/AskUserDialog';

const DEFAULT_API_KEY = import.meta.env.VITE_CORTX_API_KEY ?? 'cortx-dev-key';
const INITIAL_EVENT_CONNECTION: WebEventConnectionState = {
  phase: 'closed',
  message: 'No active event stream',
  updatedAt: 0,
};

export function App() {
  const [store] = useState(() => new AgentStore());
  const state = useStore(store);
  const bridgeRef = useRef<EventBridge | null>(null);
  const didAutoConnectRef = useRef(false);
  const [connected, setConnected] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [eventConnection, setEventConnection] = useState<WebEventConnectionState>(INITIAL_EVENT_CONNECTION);
  const [session, setSession] = useState<WebRuntimeSessionInfo | null>(null);
  const [sessions, setSessions] = useState<WebRuntimeSessionInfo[]>([]);
  const [agentSpecs, setAgentSpecs] = useState<WebAgentSpecInfo[]>([]);
  const [skillPacks, setSkillPacks] = useState<WebSkillPackInfo[]>([]);
  const [selectedSkillPackIds, setSelectedSkillPackIds] = useState<string[]>([]);
  const [selectedWorkingDirectory, setSelectedWorkingDirectory] = useState<string | null>(null);
  const [toolMode, setToolMode] = useState<WebWorkspaceToolMode>('all');
  const [approvalMode, setApprovalMode] = useState<WebApprovalMode>('interactive');

  useEffect(() => {
    if (didAutoConnectRef.current) return;
    didAutoConnectRef.current = true;
    void connect();

    return () => {
      bridgeRef.current?.disconnect();
    };
  }, []);

  async function connect() {
    setConnectionError(null);
    setEventConnection(INITIAL_EVENT_CONNECTION);
    const bridge = new EventBridge(store, DEFAULT_API_KEY, '', { onConnectionState: setEventConnection });
    bridgeRef.current = bridge;
    try {
      const existing = await bridge.listSessions();
      const target =
        [...existing].sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0] ??
        await bridge.createSession({ toolMode: 'all', approvalMode: 'interactive' });
      await bridge.connect(target.id);
      const nextSessions = await bridge.listSessions();
      activateSession(target);
      setSessions(nextSessions);
      setConnected(true);
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
    setSession(next);
    setSelectedWorkingDirectory(next.workingDirectory);
    setToolMode(next.toolMode);
    setApprovalMode(next.approvalMode);
    setSelectedSkillPackIds(next.skillPacks ?? []);
  }

  function rememberSession(next: WebRuntimeSessionInfo) {
    setSession((current) => (current?.id === next.id ? next : current));
    setSessions((current) =>
      current.some((item) => item.id === next.id)
        ? current.map((item) => (item.id === next.id ? next : item))
        : [next, ...current],
    );
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
      toolMode,
      approvalMode,
      skillPacks: request.skillPacks ?? selectedSkillPacksForRequest(),
    });
    await bridgeRef.current.connect(created.id);
    const nextSessions = await bridgeRef.current.listSessions();
    activateSession(created);
    setSessions(nextSessions);
    await refreshAgentSpecs();
  }

  async function switchSession(sessionId: string) {
    if (!bridgeRef.current) return;
    const next = await bridgeRef.current.getSession(sessionId);
    await bridgeRef.current.connect(sessionId);
    activateSession(next);
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

  async function createSessionForCurrentProject() {
    if (!bridgeRef.current) return null;
    const workingDirectory = selectedWorkingDirectory ?? session?.workingDirectory;
    if (!workingDirectory) return null;
    const created = await bridgeRef.current.createSession({
      workingDirectory,
      toolMode,
      approvalMode,
      skillPacks: selectedSkillPacksForRequest(),
    });
    await bridgeRef.current.connect(created.id);
    activateSession(created);
    await refreshSessions();
    return created;
  }

  async function launchAgentSpec(path: string) {
    if (!bridgeRef.current) return;
    const launched = await bridgeRef.current.launchAgentSpec({ path });
    await bridgeRef.current.connect(launched.id);
    activateSession(launched);
    await refreshSessions();
    await refreshAgentSpecs();
  }

  async function installSkillPack(request: WebSkillPackInstallRequest) {
    if (!bridgeRef.current) return;
    await bridgeRef.current.installSkillPack(request);
    await Promise.all([refreshSkillPacks(), refreshAgentSpecs()]);
  }

  async function updateActiveSession(request: {
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

  async function handleSkillPackSelectionChange(ids: string[]) {
    const previous = session?.skillPacks ?? selectedSkillPackIds;
    setSelectedSkillPackIds(ids);
    try {
      await updateActiveSession({ skillPacks: ids });
      await refreshAgentSpecs();
    } catch (err) {
      setSelectedSkillPackIds(previous);
      setConnectionError(err instanceof Error ? err.message : String(err));
    }
  }

  async function sendPrompt(message: string) {
    if (!session || !bridgeRef.current) return;
    if (state.status === 'running') {
      await bridgeRef.current.followUp(session.id, message);
      return;
    }
    await bridgeRef.current.prompt(session.id, message);
    await refreshSessions();
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
    } catch (err) {
      setEventConnection({
        phase: 'disconnected',
        sessionId: session.id,
        message: err instanceof Error ? err.message : String(err),
        updatedAt: Date.now(),
      });
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
        skillPacks={skillPacks}
        selectedSkillPackIds={selectedSkillPackIds}
        selectedWorkingDirectory={selectedWorkingDirectory}
        toolMode={toolMode}
        approvalMode={approvalMode}
        eventConnection={eventConnection}
        onSend={sendPrompt}
        onAbort={handleAbort}
        onResume={handleResume}
        onRecoverEventStream={handleRecoverEventStream}
        onCreateSession={createWorkspaceSession}
        onCreateSessionForCurrentProject={createSessionForCurrentProject}
        onBrowseWorkspaceDirectories={listWorkspaceDirectories}
        onLaunchAgentSpec={launchAgentSpec}
        onInstallSkillPack={installSkillPack}
        onSkillPackSelectionChange={handleSkillPackSelectionChange}
        onSelectProject={selectProject}
        onSwitchSession={switchSession}
        onToolModeChange={handleToolModeChange}
        onApprovalModeChange={handleApprovalModeChange}
      />
      {state.status === 'awaiting_user' && state.pendingQuestion && (
        <AskUserDialog pendingQuestion={state.pendingQuestion} onSubmit={handleAnswer} />
      )}
    </>
  );
}
