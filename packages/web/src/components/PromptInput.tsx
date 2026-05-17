import { useState, useRef, type KeyboardEvent } from 'react';

interface PromptInputProps {
  onSend: (message: string) => void;
  disabled?: boolean;
}

export function PromptInput({ onSend, disabled }: PromptInputProps) {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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
    <div className="border-t border-gray-800/60 p-3 bg-gray-900/80">
      <div className="flex gap-2 max-w-3xl mx-auto">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            e.target.style.height = 'auto';
            e.target.style.height = e.target.scrollHeight + 'px';
          }}
          onKeyDown={handleKeyDown}
          placeholder={disabled ? 'Agent is working...' : 'Send a message...'}
          disabled={disabled}
          rows={1}
          className="flex-1 bg-gray-800/80 text-white rounded-lg px-3 py-2 resize-none outline-none focus:ring-2 focus:ring-blue-500/50 disabled:opacity-40 max-h-40 text-sm placeholder-gray-600"
        />
        <button
          onClick={submit}
          disabled={disabled || !value.trim()}
          className="bg-blue-600 hover:bg-blue-700 disabled:opacity-30 disabled:cursor-not-allowed text-white rounded-lg px-4 py-2 font-medium self-end text-sm transition-colors"
        >
          Send
        </button>
      </div>
    </div>
  );
}
