import { useState, useEffect, useRef } from 'react';
import { AgentStore } from '@cortx/store';
import { useStore } from './hooks/use-store';
import { EventBridge, type WebRuntimeSessionInfo } from './bridge/event-bridge';
import { ConnectionOverlay } from './components/ConnectionOverlay';
import { StatusBar } from './components/StatusBar';
import { ChatView } from './components/ChatView';
import { AskUserDialog } from './components/AskUserDialog';

export function App() {
  const [store] = useState(() => new AgentStore());
  const state = useStore(store);
  const bridgeRef = useRef<EventBridge | null>(null);
  const [connected, setConnected] = useState(false);
  const [session, setSession] = useState<WebRuntimeSessionInfo | null>(null);

  useEffect(() => {
    return () => {
      bridgeRef.current?.disconnect();
    };
  }, []);

  async function connect(apiKey: string) {
    const bridge = new EventBridge(store, apiKey);
    bridgeRef.current = bridge;
    const created = await bridge.createSession();
    await bridge.connect(created.id);
    setSession(created);
    setConnected(true);
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
    <div className="h-screen flex flex-col bg-gray-950 text-gray-100">
      <StatusBar
        status={state.status}
        session={session}
        tokenUsage={state.tokenUsage}
        elapsed={state.totalElapsed}
        iteration={state.iteration}
      />
      <ChatView
        messages={state.messages}
        toolCalls={state.toolCalls}
        agentSessions={state.agentSessions}
        status={state.status}
        iteration={state.iteration}
        error={state.error}
        onSend={sendPrompt}
        onAbort={handleAbort}
        onResume={handleResume}
      />
      {state.status === 'awaiting_user' && state.pendingQuestion && (
        <AskUserDialog pendingQuestion={state.pendingQuestion} onSubmit={handleAnswer} />
      )}
    </div>
  );
}
