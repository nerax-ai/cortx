import { useState, useEffect, useRef } from 'react';
import { AgentStore } from '@cortx/store';
import { useStore } from './hooks/use-store';
import {
  EventBridge,
  type WebApprovalMode,
  type WebCreateSessionRequest,
  type WebRuntimeSessionInfo,
  type WebWorkspaceToolMode,
} from './bridge/event-bridge';
import { ConnectionOverlay } from './components/ConnectionOverlay';
import { DesktopWorkspace } from './components/DesktopWorkspace';
import { AskUserDialog } from './components/AskUserDialog';

export function App() {
  const [store] = useState(() => new AgentStore());
  const state = useStore(store);
  const bridgeRef = useRef<EventBridge | null>(null);
  const [connected, setConnected] = useState(false);
  const [session, setSession] = useState<WebRuntimeSessionInfo | null>(null);
  const [sessions, setSessions] = useState<WebRuntimeSessionInfo[]>([]);

  useEffect(() => {
    return () => {
      bridgeRef.current?.disconnect();
    };
  }, []);

  async function connect(request: WebCreateSessionRequest & { apiKey: string }) {
    const { apiKey, ...sessionRequest } = request;
    const bridge = new EventBridge(store, apiKey);
    bridgeRef.current = bridge;
    const created = await bridge.createSession(sessionRequest);
    await bridge.connect(created.id);
    const nextSessions = await bridge.listSessions();
    setSession(created);
    setSessions(nextSessions);
    setConnected(true);
  }

  async function createWorkspaceSession(request: {
    workingDirectory: string;
    toolMode: WebWorkspaceToolMode;
    approvalMode: WebApprovalMode;
  }) {
    if (!bridgeRef.current) return;
    const created = await bridgeRef.current.createSession(request);
    await bridgeRef.current.connect(created.id);
    const nextSessions = await bridgeRef.current.listSessions();
    setSession(created);
    setSessions(nextSessions);
  }

  async function switchSession(sessionId: string) {
    if (!bridgeRef.current) return;
    const next = await bridgeRef.current.getSession(sessionId);
    await bridgeRef.current.connect(sessionId);
    setSession(next);
  }

  async function sendPrompt(message: string) {
    if (!session || !bridgeRef.current) return;
    if (state.status === 'running') {
      await bridgeRef.current.followUp(session.id, message);
      return;
    }
    await bridgeRef.current.prompt(session.id, message);
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
    return <ConnectionOverlay onConnect={connect} />;
  }

  return (
    <>
      <DesktopWorkspace
        state={state}
        session={session}
        sessions={sessions}
        onSend={sendPrompt}
        onAbort={handleAbort}
        onResume={handleResume}
        onCreateSession={createWorkspaceSession}
        onSwitchSession={switchSession}
      />
      {state.status === 'awaiting_user' && state.pendingQuestion && (
        <AskUserDialog pendingQuestion={state.pendingQuestion} onSubmit={handleAnswer} />
      )}
    </>
  );
}
