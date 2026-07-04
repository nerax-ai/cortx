import { useState, useRef, type KeyboardEvent } from 'react';
import { surface } from '../design';
import { ControlButton } from './ControlButton';

interface PromptInputProps {
  onSend: (message: string) => void;
  disabled?: boolean;
  mode?: 'prompt' | 'follow-up';
}

export function PromptInput({ onSend, disabled, mode = 'prompt' }: PromptInputProps) {
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
    <div className="border-t border-white/8 bg-[#151515] p-3">
      <div className={`mx-auto max-w-4xl rounded-xl p-2 ${surface.panel}`}>
        <div className="mb-2 flex items-center justify-between gap-3 px-2 text-[11px] uppercase tracking-[0.18em] text-zinc-600">
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
            className={`max-h-44 min-h-11 flex-1 resize-none rounded-lg border border-white/8 bg-black/20 px-3 py-2.5 text-sm leading-6 text-zinc-100 outline-none placeholder:text-zinc-700 disabled:opacity-40 ${surface.focus}`}
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
      </div>
    </div>
  );
}
