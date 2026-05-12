import { useState } from 'react';
import type { AgentEvent } from '@cortx/sdk';
import { useStore } from '../hooks/use-store';
import { EventBridge } from '../bridge/event-bridge';

interface AskUserDialogProps {
  onSubmit: (toolCallId: string, response: string) => void;
}

export function AskUserDialog({ onSubmit }: AskUserDialogProps) {
  // This component should only render when status is 'awaiting_user'
  // For now, it's a placeholder that receives the toolCallId from the parent
  const [response, setResponse] = useState('');
  const [toolCallId, setToolCallId] = useState('');

  function handleSubmit() {
    if (!response.trim() || !toolCallId.trim()) return;
    onSubmit(toolCallId, response);
    setResponse('');
    setToolCallId('');
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-gray-900 rounded-lg p-6 w-96 shadow-xl">
        <h3 className="text-lg font-medium text-white mb-4">Agent asks:</h3>
        <label className="block text-sm text-gray-400 mb-1">Tool Call ID</label>
        <input
          value={toolCallId}
          onChange={(e) => setToolCallId(e.target.value)}
          placeholder="tc_xxx"
          className="w-full bg-gray-800 text-white rounded px-3 py-2 mb-3 outline-none focus:ring-2 focus:ring-blue-500"
        />
        <label className="block text-sm text-gray-400 mb-1">Your response</label>
        <textarea
          value={response}
          onChange={(e) => setResponse(e.target.value)}
          placeholder="Type your response..."
          rows={3}
          className="w-full bg-gray-800 text-white rounded px-3 py-2 mb-4 outline-none focus:ring-2 focus:ring-blue-500 resize-none"
        />
        <button
          onClick={handleSubmit}
          disabled={!response.trim() || !toolCallId.trim()}
          className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded px-4 py-2 font-medium"
        >
          Submit
        </button>
      </div>
    </div>
  );
}
