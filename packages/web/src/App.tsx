import { useState } from 'react';
import { useStore } from './hooks/use-store';
import { EventBridge } from './bridge/event-bridge';
import { ConnectionOverlay } from './components/ConnectionOverlay';
import { StatusBar } from './components/StatusBar';
import { ChatView } from './components/ChatView';
import { AskUserDialog } from './components/AskUserDialog';

export function App() {
  const [bridge] = useState(() => new EventBridge());
  const state = useStore(bridge.store);
  const [connected, setConnected] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);

  async function connect() {
    const id = await bridge.createSession();
    setSessionId(id);
    setConnected(true);
  }

  async function sendPrompt(message: string) {
    if (!sessionId) return;
    await bridge.prompt(sessionId, message);
  }

  function handleAnswer(toolCallId: string, response: string) {
    if (!sessionId) return;
    bridge.answer(sessionId, toolCallId, response);
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
      />
      <ChatView
        messages={state.messages}
        toolCalls={state.toolCalls}
        agentSessions={state.agentSessions}
        status={state.status}
        onSend={sendPrompt}
      />
      {state.status === 'awaiting_user' && (
        <AskUserDialog onSubmit={handleAnswer} />
      )}
    </div>
  );
}
