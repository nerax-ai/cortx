import { Collapsible } from '@base-ui-components/react/collapsible';
import type { ToolCallEntry } from '@cortx/store';
import { surface, truncateMiddle } from '../design';

interface ToolCardProps {
  entry: ToolCallEntry;
}

function formatValue(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function truncate(str: string, max = 80): string {
  if (str.length <= max) return str;
  return str.slice(0, max) + '...';
}

export function ToolCard({ entry }: ToolCardProps) {
  const isPending = entry.status === 'pending';
  const isError = entry.isError === true;
  const statusLabel = isPending ? 'pending' : isError ? 'error' : 'done';
  const statusClass = isPending
    ? 'border-amber-300/20 bg-amber-950/20 text-amber-200'
    : isError
      ? 'border-rose-300/20 bg-rose-950/20 text-rose-200'
      : 'border-emerald-300/20 bg-emerald-950/20 text-emerald-200';

  const inputStr = formatValue(entry.input);
  const resultStr = entry.result != null ? formatValue(entry.result) : null;
  const summary = entry.progress || inputStr || resultStr || 'No details yet';

  return (
    <Collapsible.Root defaultOpen={isPending || isError} className={`overflow-hidden rounded-lg text-sm ${surface.panel}`}>
      <Collapsible.Trigger
        className={`flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-white/[0.035] ${surface.focus}`}
      >
        <span className={`rounded-full border px-2 py-0.5 text-[10px] ${statusClass}`}>{statusLabel}</span>
        <span className="min-w-0 shrink-0 font-mono text-xs font-medium text-zinc-200">{entry.toolName}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-600">{truncateMiddle(summary, 46)}</span>
        <span className="text-xs text-zinc-700">details</span>
      </Collapsible.Trigger>

      <Collapsible.Panel keepMounted className="border-t border-white/8 px-3 py-2">
        {inputStr && (
          <section className="mb-2">
            <div className="mb-1 text-[10px] uppercase tracking-[0.18em] text-zinc-700">Input</div>
            <pre className="max-h-44 overflow-y-auto rounded-md border border-white/7 bg-black/20 p-2 font-mono text-xs leading-5 text-zinc-500 whitespace-pre-wrap">
              {truncate(inputStr, 4000)}
            </pre>
          </section>
        )}
        {resultStr && (
          <section>
            <div className={`mb-1 text-[10px] uppercase tracking-[0.18em] ${isError ? 'text-rose-300/70' : 'text-zinc-700'}`}>
              Output {isError ? 'error' : ''}
            </div>
            <pre
              className={`max-h-64 overflow-y-auto rounded-md border bg-black/20 p-2 font-mono text-xs leading-5 whitespace-pre-wrap ${
                isError ? 'border-rose-300/15 text-rose-100/75' : 'border-white/7 text-zinc-500'
              }`}
            >
              {truncate(resultStr, 6000)}
            </pre>
          </section>
        )}
        {isPending && !resultStr && <div className="py-2 text-xs text-zinc-600">Waiting for result...</div>}
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
