import { useState, useEffect, useRef } from 'react';
import { AgentStore } from '@cortx/store';
import { useStore } from './hooks/use-store';
import { EventBridge } from './bridge/event-bridge';
import { ConnectionOverlay } from './components/ConnectionOverlay';
import { StatusBar } from './components/StatusBar';
import { ChatView } from './components/ChatView';
import { AskUserDialog } from './components/AskUserDialog';

export function App() {
  const [store] = useState(() => new AgentStore());
  const state = useStore(store);
  const bridgeRef = useRef<EventBridge | null>(null);
  const [connected, setConnected] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);

  useEffect(() => {
    return () => { bridgeRef.current?.disconnect(); };
  }, []);

  async function connect(apiKey: string) {
    const bridge = new EventBridge(store, apiKey);
    bridgeRef.current = bridge;
    const id = await bridge.createSession();
    await bridge.connect(id);
    setSessionId(id);
    setConnected(true);
  }

  async function sendPrompt(message: string) {
    if (!sessionId || !bridgeRef.current) return;
    await bridgeRef.current.prompt(sessionId, message);
  }

  function handleAnswer(toolCallId: string, response: string) {
    if (!sessionId || !bridgeRef.current) return;
    bridgeRef.current.answer(sessionId, toolCallId, response);
  }

  if (!connected) {
    return <ConnectionOverlay onConnect={connect} />;
  }

  return (
    <div className="h-screen flex flex-col bg-gray-950 text-gray-100">
      <StatusBar
        status={state.status}
        sessionId={sessionId}
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
      />
      {state.status === 'awaiting_user' && state.pendingQuestion && (
        <AskUserDialog pendingQuestion={state.pendingQuestion} onSubmit={handleAnswer} />
      )}
    </div>
  );
}
