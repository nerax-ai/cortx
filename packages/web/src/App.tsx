import { useState, useEffect, useRef } from 'react';
import { AgentStore } from '@cortx/store';
import { useStore } from './hooks/use-store';
import {
  EventBridge,
  type WebApprovalMode,
  type WebRuntimeSessionInfo,
  type WebWorkspaceToolMode,
} from './bridge/event-bridge';
import { ConnectionStatus } from './components/ConnectionStatus';
import { DesktopWorkspace } from './components/DesktopWorkspace';
import { AskUserDialog } from './components/AskUserDialog';

const DEFAULT_API_KEY = import.meta.env.VITE_CORTX_API_KEY ?? 'cortx-dev-key';

export function App() {
  const [store] = useState(() => new AgentStore());
  const state = useStore(store);
  const bridgeRef = useRef<EventBridge | null>(null);
  const didAutoConnectRef = useRef(false);
  const [connected, setConnected] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [session, setSession] = useState<WebRuntimeSessionInfo | null>(null);
  const [sessions, setSessions] = useState<WebRuntimeSessionInfo[]>([]);
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
    const bridge = new EventBridge(store, DEFAULT_API_KEY);
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
  }

  async function refreshSessions() {
    if (!bridgeRef.current) return;
    setSessions(await bridgeRef.current.listSessions());
  }

  async function createWorkspaceSession(request: {
    workingDirectory: string;
  }) {
    if (!bridgeRef.current) return;
    const created = await bridgeRef.current.createSession({
      workingDirectory: request.workingDirectory.trim(),
      toolMode,
      approvalMode,
    });
    await bridgeRef.current.connect(created.id);
    const nextSessions = await bridgeRef.current.listSessions();
    activateSession(created);
    setSessions(nextSessions);
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
    });
    await bridgeRef.current.connect(created.id);
    activateSession(created);
    await refreshSessions();
    return created;
  }

  async function sendPrompt(message: string) {
    if (!session || !bridgeRef.current) return;
    if (state.status === 'running') {
      await bridgeRef.current.followUp(session.id, message);
      return;
    }
    let target = session;
    if (session.toolMode !== toolMode || session.approvalMode !== approvalMode) {
      const created = await createSessionForCurrentProject();
      if (!created) return;
      target = created;
    }
    await bridgeRef.current.prompt(target.id, message);
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

  if (!connected) {
    return <ConnectionStatus error={connectionError} onRetry={connect} />;
  }

  return (
    <>
      <DesktopWorkspace
        state={state}
        session={session}
        sessions={sessions}
        selectedWorkingDirectory={selectedWorkingDirectory}
        toolMode={toolMode}
        approvalMode={approvalMode}
        onSend={sendPrompt}
        onAbort={handleAbort}
        onResume={handleResume}
        onCreateSession={createWorkspaceSession}
        onCreateSessionForCurrentProject={createSessionForCurrentProject}
        onSelectProject={selectProject}
        onSwitchSession={switchSession}
        onToolModeChange={setToolMode}
        onApprovalModeChange={setApprovalMode}
      />
      {state.status === 'awaiting_user' && state.pendingQuestion && (
        <AskUserDialog pendingQuestion={state.pendingQuestion} onSubmit={handleAnswer} />
      )}
    </>
  );
}
