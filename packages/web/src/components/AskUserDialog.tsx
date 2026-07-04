import { useState } from 'react';
import { Dialog } from '@base-ui-components/react/dialog';
import type { PendingQuestion } from '@cortx/store';
import { surface } from '../design';
import { ControlButton } from './ControlButton';

interface AskUserDialogProps {
  pendingQuestion: PendingQuestion;
  onSubmit: (toolCallId: string, response: string) => void;
}

interface AskUserDialogContentProps extends AskUserDialogProps {
  response: string;
  onResponseChange: (response: string) => void;
  onClear: () => void;
}

export function ApprovalDialogBody({
  pendingQuestion,
  response,
  onResponseChange,
  onClear,
  onSubmit,
}: AskUserDialogContentProps) {
  function handleSubmit() {
    if (!response.trim()) return;
    onSubmit(pendingQuestion.toolCallId, response);
  }

  return (
    <>
      <div className="mt-4 rounded-lg border border-white/8 bg-black/20 p-3 text-sm leading-6 text-zinc-300 whitespace-pre-wrap">
        {pendingQuestion.question}
      </div>

      <label className="mt-4 block text-xs font-medium uppercase tracking-[0.18em] text-zinc-600">
        Response
      </label>
      <textarea
        value={response}
        onChange={(e) => onResponseChange(e.target.value)}
        placeholder="Type your response..."
        rows={4}
        className={`mt-2 w-full resize-none rounded-lg border border-white/8 bg-black/25 px-3 py-2 text-sm leading-6 text-zinc-100 outline-none placeholder:text-zinc-700 ${surface.focus}`}
        autoFocus
      />

      <div className="mt-4 flex justify-end gap-2">
        <ControlButton onClick={onClear} disabled={!response}>
          Clear
        </ControlButton>
        <ControlButton tone="primary" onClick={handleSubmit} disabled={!response.trim()}>
          Submit answer
        </ControlButton>
      </div>
    </>
  );
}

export function AskUserDialogContent(props: AskUserDialogContentProps) {
  return (
    <>
      <Dialog.Title className="text-lg font-semibold text-zinc-100">Approval required</Dialog.Title>
      <Dialog.Description className="mt-1 text-sm text-zinc-500">
        Cortx is waiting for your answer before continuing this tool call.
      </Dialog.Description>
      <ApprovalDialogBody {...props} />
    </>
  );
}

export function AskUserDialog({ pendingQuestion, onSubmit }: AskUserDialogProps) {
  const [response, setResponse] = useState('');

  return (
    <Dialog.Root open modal disablePointerDismissal onOpenChange={() => undefined}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm" />
        <Dialog.Popup
          initialFocus
          className={`fixed left-1/2 top-1/2 z-50 w-[min(520px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-2xl p-5 shadow-2xl shadow-black/40 ${surface.panel}`}
        >
          <AskUserDialogContent
            pendingQuestion={pendingQuestion}
            response={response}
            onResponseChange={setResponse}
            onClear={() => setResponse('')}
            onSubmit={(toolCallId, answer) => {
              onSubmit(toolCallId, answer);
              setResponse('');
            }}
          />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
