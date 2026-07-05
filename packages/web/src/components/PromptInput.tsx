import { useState, useRef, type KeyboardEvent } from 'react';
import type { WebApprovalMode, WebWorkspaceToolMode } from '../bridge/event-bridge';
import { compactPath, surface } from '../design';
import { ControlButton } from './ControlButton';

interface PromptInputProps {
  onSend: (message: string) => void;
  disabled?: boolean;
  mode?: 'prompt' | 'follow-up';
  toolMode: WebWorkspaceToolMode;
  approvalMode: WebApprovalMode;
  selectedWorkingDirectory: string | null;
  canChangeModes: boolean;
  willCreateSessionOnSend: boolean;
  onCreateSession: () => void | Promise<unknown>;
  onToolModeChange: (mode: WebWorkspaceToolMode) => void;
  onApprovalModeChange: (mode: WebApprovalMode) => void;
}

export function PromptInput({
  onSend,
  disabled,
  mode = 'prompt',
  toolMode,
  approvalMode,
  selectedWorkingDirectory,
  canChangeModes,
  willCreateSessionOnSend,
  onCreateSession,
  onToolModeChange,
  onApprovalModeChange,
}: PromptInputProps) {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const label = disabled ? 'Awaiting answer' : mode === 'follow-up' ? 'Follow-up' : 'Prompt';
  const placeholder = disabled
    ? 'Answer the pending request in the dialog...'
    : mode === 'follow-up'
      ? 'Add context while Cortx is working...'
      : 'Ask Cortx to inspect, change, or explain this workspace...';

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  function submit() {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setValue('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  }

  return (
    <div className="border-t border-zinc-200 bg-white p-3">
      <div className={`mx-auto max-w-4xl rounded-xl p-2 ${surface.panel}`}>
        <div className="mb-2 flex items-center justify-between gap-3 px-2 text-[11px] uppercase tracking-[0.18em] text-zinc-400">
          <span>{label}</span>
          <span className="hidden sm:inline">Enter to send · Shift Enter for newline</span>
        </div>
        <div className="flex gap-2">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = e.target.scrollHeight + 'px';
            }}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            disabled={disabled}
            rows={1}
            className={`max-h-44 min-h-11 flex-1 resize-none rounded-lg border border-zinc-200 bg-white px-3 py-2.5 text-sm leading-6 text-zinc-950 outline-none placeholder:text-zinc-400 disabled:opacity-40 ${surface.focus}`}
          />
          <ControlButton
            tone="primary"
            onClick={submit}
            disabled={disabled || !value.trim()}
            className="self-end px-4 py-2.5"
          >
            {mode === 'follow-up' ? 'Follow up' : 'Send'}
          </ControlButton>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 px-1 text-xs text-zinc-500">
          <span className="min-w-0 truncate rounded-md border border-zinc-200 bg-zinc-50 px-2 py-1 font-mono text-[11px] text-zinc-600">
            {selectedWorkingDirectory ? compactPath(selectedWorkingDirectory) : 'no project'}
          </span>
          <label className="flex items-center gap-1">
            <span className="text-[11px] text-zinc-400">Tools</span>
            <select
              value={toolMode}
              disabled={!canChangeModes}
              onChange={(e) => onToolModeChange(e.target.value as WebWorkspaceToolMode)}
              className={`h-7 rounded-md border border-zinc-200 bg-white px-2 text-xs text-zinc-800 disabled:bg-zinc-50 disabled:text-zinc-400 ${surface.focus}`}
            >
              <option value="all">All</option>
              <option value="coding">Coding</option>
              <option value="read-only">Read only</option>
              <option value="none">None</option>
            </select>
          </label>
          <label className="flex items-center gap-1">
            <span className="text-[11px] text-zinc-400">Control</span>
            <select
              value={approvalMode}
              disabled={!canChangeModes}
              onChange={(e) => onApprovalModeChange(e.target.value as WebApprovalMode)}
              className={`h-7 rounded-md border border-zinc-200 bg-white px-2 text-xs text-zinc-800 disabled:bg-zinc-50 disabled:text-zinc-400 ${surface.focus}`}
            >
              <option value="interactive">Ask first</option>
              <option value="full-access">Full access</option>
              <option value="deny">Deny writes</option>
            </select>
          </label>
          <button
            type="button"
            disabled={!selectedWorkingDirectory || !canChangeModes}
            onClick={() => void onCreateSession()}
            className={`ml-auto h-7 rounded-md border border-zinc-200 px-2 text-xs text-zinc-600 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:text-zinc-300 ${surface.focus}`}
          >
            New session
          </button>
          {willCreateSessionOnSend && (
            <span className="basis-full px-1 text-[11px] text-amber-700">
              Sending will start a new session for this project with the selected controls.
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
