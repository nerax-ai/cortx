import { useState } from 'react';
import type { ContextUsageSummary } from '../context-usage';
import {
  contextRowPercent,
  formatContextPercent,
  formatContextSource,
  formatContextTokenCount,
} from '../context-usage';
import { surface } from '../design';

const ROW_COLORS: Record<ContextUsageSummary['breakdown'][number]['key'], string> = {
  messages: 'bg-blue-400',
  tools: 'bg-sky-400',
  skills: 'bg-blue-500',
  system_prompt: 'bg-sky-600',
  other: 'bg-zinc-500',
};

export function ContextUsagePanel({ summary }: { summary: ContextUsageSummary }) {
  return (
    <div className="w-[380px] rounded-xl border border-zinc-700 bg-zinc-900/95 p-4 text-zinc-100 shadow-2xl shadow-zinc-950/30 backdrop-blur">
      <div className="flex items-center justify-between gap-4">
        <div className="text-sm font-medium text-zinc-100">上下文容量</div>
        <div className="font-mono text-xs text-zinc-400">
          {formatContextTokenCount(summary.usedTokens)}/{formatContextTokenCount(summary.windowTokens)}
          <span className="ml-1">({formatContextPercent(summary.percentUsed)})</span>
        </div>
      </div>
      <div className="mt-1 flex items-center justify-between gap-3 text-[11px] text-zinc-500">
        <span className="truncate">{summary.model ?? 'unknown model'}</span>
        <span>{formatContextSource(summary.windowSource)}</span>
      </div>
      <div className="mt-4 h-2 overflow-hidden rounded-full bg-zinc-800">
        <div
          className="h-full rounded-full bg-blue-500"
          style={{ width: `${Math.max(2, Math.min(100, summary.percentUsed ?? 0))}%` }}
        />
      </div>

      <div className="mt-4 space-y-2">
        {summary.breakdown.map((row) => (
          <div key={row.key} className="flex items-center gap-3 text-sm">
            <span className={`h-2.5 w-2.5 rounded-full ${ROW_COLORS[row.key]}`} />
            <span className="text-zinc-400">{row.label}</span>
            {row.count !== undefined && <span className="text-[11px] text-zinc-600">{row.count}</span>}
            <span className="ml-auto font-mono text-xs font-semibold text-zinc-100">
              {formatContextPercent(contextRowPercent(row, summary))}
            </span>
            <span className="w-14 text-right font-mono text-[11px] text-zinc-500">
              {formatContextTokenCount(row.tokens)}
            </span>
          </div>
        ))}
        {summary.breakdown.length === 0 && (
          <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2 text-xs text-zinc-500">
            等待 provider usage 后显示消息、工具、技能和系统提示词占用。
          </div>
        )}
      </div>

      <div className="my-4 border-t border-zinc-700" />
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="text-zinc-400">缓存命中率</span>
        <span className="font-mono text-xs font-semibold text-zinc-100">
          {summary.cacheHitRate === undefined ? '暂无数据' : formatContextPercent(summary.cacheHitRate)}
        </span>
      </div>
    </div>
  );
}

export function ContextUsageButton({ summary }: { summary: ContextUsageSummary }) {
  const [open, setOpen] = useState(false);
  const compactLabel =
    summary.percentUsed === undefined ? formatContextTokenCount(summary.windowTokens) : formatContextPercent(summary.percentUsed);

  return (
    <div className="relative">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={`h-7 rounded-md border border-zinc-200 bg-white px-2 text-xs text-zinc-600 hover:bg-zinc-50 ${surface.focus}`}
      >
        Context <span className="font-mono text-[11px] text-zinc-400">{compactLabel}</span>
      </button>
      {open && (
        <div className="absolute bottom-9 right-0 z-30">
          <ContextUsagePanel summary={summary} />
        </div>
      )}
    </div>
  );
}
