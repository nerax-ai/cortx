import { useState } from 'react';
import type { PendingQuestion } from '@cortx/store';

interface AskUserDialogProps {
  pendingQuestion: PendingQuestion;
  onSubmit: (toolCallId: string, response: string) => void;
}

export function AskUserDialog({ pendingQuestion, onSubmit }: AskUserDialogProps) {
  const [response, setResponse] = useState('');

  function handleSubmit() {
    if (!response.trim()) return;
    onSubmit(pendingQuestion.toolCallId, response);
    setResponse('');
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-gray-900 rounded-lg p-6 w-96 shadow-xl">
        <h3 className="text-lg font-medium text-white mb-2">Agent asks:</h3>
        <p className="text-gray-300 mb-4 whitespace-pre-wrap">{pendingQuestion.question}</p>
        <textarea
          value={response}
          onChange={(e) => setResponse(e.target.value)}
          placeholder="Type your response..."
          rows={3}
          className="w-full bg-gray-800 text-white rounded px-3 py-2 mb-4 outline-none focus:ring-2 focus:ring-blue-500 resize-none"
          autoFocus
        />
        <button
          onClick={handleSubmit}
          disabled={!response.trim()}
          className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded px-4 py-2 font-medium"
        >
          Submit
        </button>
      </div>
    </div>
  );
}
