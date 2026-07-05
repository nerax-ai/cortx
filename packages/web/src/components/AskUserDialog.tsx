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
  const choices = pendingQuestion.allowedResponses ?? [];
  const isChoiceRequest = choices.length > 0;

  function choiceLabel(choice: string): string {
    if (choice === 'yes') return 'Allow';
    if (choice === 'no') return 'Deny';
    return choice;
  }

  return (
    <>
      <div className="mt-4 rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-sm leading-6 text-zinc-700 whitespace-pre-wrap">
        {pendingQuestion.question}
      </div>

      {pendingQuestion.context?.workingDirectory && (
        <div className="mt-3 truncate rounded-md bg-white px-2 py-1 font-mono text-[11px] text-zinc-500">
          {String(pendingQuestion.context.workingDirectory)}
        </div>
      )}

      {!isChoiceRequest && (
        <>
          <label className="mt-4 block text-xs font-medium uppercase tracking-[0.18em] text-zinc-500">
            Response
          </label>
          <textarea
            value={response}
            onChange={(e) => onResponseChange(e.target.value)}
            placeholder="Type your response..."
            rows={4}
            className={`mt-2 w-full resize-none rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm leading-6 text-zinc-950 outline-none placeholder:text-zinc-400 ${surface.focus}`}
            autoFocus
          />
        </>
      )}

      <div className="mt-4 flex justify-end gap-2">
        {isChoiceRequest ? (
          choices.map((choice) => (
            <ControlButton
              key={choice}
              tone={choice === 'no' ? 'danger' : 'primary'}
              onClick={() => onSubmit(pendingQuestion.toolCallId, choice)}
            >
              {choiceLabel(choice)}
            </ControlButton>
          ))
        ) : (
          <>
            <ControlButton onClick={onClear} disabled={!response}>
              Clear
            </ControlButton>
            <ControlButton tone="primary" onClick={handleSubmit} disabled={!response.trim()}>
              Submit answer
            </ControlButton>
          </>
        )}
      </div>
    </>
  );
}

export function AskUserDialogContent(props: AskUserDialogContentProps) {
  return (
    <>
      <Dialog.Title className="text-lg font-semibold text-zinc-950">Approval required</Dialog.Title>
      <Dialog.Description className="mt-1 text-sm text-zinc-500">
        Cortx is waiting for your choice before continuing this tool call.
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
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-zinc-950/20 backdrop-blur-sm" />
        <Dialog.Popup
          initialFocus
          className={`fixed left-1/2 top-1/2 z-50 w-[min(560px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-2xl p-5 shadow-2xl shadow-zinc-300/60 ${surface.panel}`}
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
