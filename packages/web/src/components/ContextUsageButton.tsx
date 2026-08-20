import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { TokenUsage } from '@cortx/store';
import type { ContextUsageSummary } from '../context-usage';
import {
  contextRowPercent,
  formatContextPercent,
  formatContextTokenCount,
  sessionCacheHitRate,
} from '../context-usage';
import { surface } from '../design';

function progressBarWidth(percent: number): string {
  if (percent <= 0) return '0%';
  return `max(16px, ${Math.max(0, Math.min(100, percent))}%)`;
}

export function breakdownDotColor(percent: number): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const opacity = clamped <= 0 ? 0.14 : 0.2 + Math.sqrt(clamped / 100) * 0.78;
  return `rgba(24, 24, 27, ${opacity.toFixed(2)})`;
}

function MetricRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-zinc-500">{label}</span>
      <span className="font-mono text-[11px] font-semibold text-zinc-900">{value}</span>
    </div>
  );
}

function MetricGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-1.5">
      <div className="mb-2 text-xs font-semibold text-zinc-950">{title}</div>
      {children}
    </div>
  );
}

export function ContextUsagePanel({
  summary,
  sessionTokenUsage,
  embedded = false,
}: {
  summary: ContextUsageSummary;
  sessionTokenUsage?: TokenUsage;
  embedded?: boolean;
}) {
  const sessionHitRate = sessionCacheHitRate(sessionTokenUsage);
  const usedTokens = summary.usedTokens ?? 0;
  const windowTokens = summary.windowTokens ?? 0;
  const requestInputTokens = summary.requestInputTokens ?? 0;
  const requestOutputTokens = summary.requestOutputTokens ?? 0;
  const requestCacheReadTokens = summary.requestCacheReadTokens ?? 0;
  const requestCacheCreationTokens = summary.requestCacheCreationTokens ?? 0;
  const sessionInputTokens = sessionTokenUsage?.inputTokens ?? 0;
  const sessionOutputTokens = sessionTokenUsage?.outputTokens ?? 0;
  const sessionCacheReadTokens = sessionTokenUsage?.cacheReadTokens ?? 0;
  const sessionCacheCreationTokens = sessionTokenUsage?.cacheCreationTokens ?? 0;
  const contextPercent = summary.percentUsed ?? 0;
  const [showDetails, setShowDetails] = useState(false);

  return (
    <div className={`${embedded ? 'w-full border-0 bg-transparent shadow-none' : 'w-[380px] rounded-xl border border-zinc-200 bg-white shadow-2xl shadow-zinc-200/80'} p-4 text-zinc-950`}>
      <div className="flex items-center justify-between gap-4">
        <div className="text-sm font-medium text-zinc-950">Current Request Context</div>
        <div className="font-mono text-xs text-zinc-500">
          {formatContextTokenCount(usedTokens)}/{formatContextTokenCount(windowTokens)}
          <span className="ml-1">({formatContextPercent(contextPercent)})</span>
        </div>
      </div>
      <div className="mt-4 h-2 overflow-hidden rounded-full bg-zinc-200/90 shadow-inner shadow-zinc-300/60">
        <div
          className="h-full rounded-full bg-zinc-950"
          style={{ width: progressBarWidth(contextPercent) }}
        />
      </div>

      {!showDetails && (
        <div className="mt-3 flex items-center justify-end">
          <button
            type="button"
            aria-expanded={showDetails}
            onClick={() => setShowDetails(true)}
            className={`rounded-md px-2 py-1 text-xs font-medium text-zinc-500 hover:bg-zinc-50 hover:text-zinc-950 ${surface.focus}`}
          >
            Show more
          </button>
        </div>
      )}

      {showDetails && (
        <div className="mt-3 space-y-4">
          <div className="space-y-2">
            {summary.breakdown.map((row) => {
              const rowPercent = contextRowPercent(row, summary) ?? 0;
              return (
                <div key={row.key} className="flex items-center gap-3 text-sm">
                  <span
                    className="h-2.5 w-2.5 rounded-full"
                    style={{ backgroundColor: breakdownDotColor(rowPercent) }}
                  />
                  <span className="text-zinc-600">{row.label}</span>
                  {row.count !== undefined && <span className="text-[11px] text-zinc-400">{row.count}</span>}
                  <span className="ml-auto font-mono text-xs font-semibold text-zinc-950">
                    {formatContextPercent(rowPercent)}
                  </span>
                  <span className="w-14 text-right font-mono text-[11px] text-zinc-500">
                    {formatContextTokenCount(row.tokens)}
                  </span>
                </div>
              );
            })}
            {summary.breakdown.length === 0 && (
              <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-500">
                Waiting for usage data to show messages, tools, skills, and system prompt usage.
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3 rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-xs">
            <MetricGroup title="This Turn">
              <MetricRow label="Input" value={formatContextTokenCount(requestInputTokens)} />
              <MetricRow label="Output" value={formatContextTokenCount(requestOutputTokens)} />
              <MetricRow label="Cache Read" value={formatContextTokenCount(requestCacheReadTokens)} />
              <MetricRow label="Cache Write" value={formatContextTokenCount(requestCacheCreationTokens)} />
            </MetricGroup>
            <MetricGroup title="Session">
              <MetricRow label="Input" value={formatContextTokenCount(sessionInputTokens)} />
              <MetricRow label="Output" value={formatContextTokenCount(sessionOutputTokens)} />
              <MetricRow label="Cache Read" value={formatContextTokenCount(sessionCacheReadTokens)} />
              <MetricRow label="Cache Write" value={formatContextTokenCount(sessionCacheCreationTokens)} />
            </MetricGroup>
          </div>

          <div className="flex items-center justify-end">
            <button
              type="button"
              aria-expanded={showDetails}
              onClick={() => setShowDetails(false)}
              className={`rounded-md px-2 py-1 text-xs font-medium text-zinc-500 hover:bg-zinc-50 hover:text-zinc-950 ${surface.focus}`}
            >
              Collapse
            </button>
          </div>
        </div>
      )}

      <div className="mt-4 border-t border-zinc-200 pt-3 text-xs">
        <MetricRow label="Cache Hit Rate" value={formatContextPercent(sessionHitRate ?? 0)} />
      </div>
    </div>
  );
}

export function ContextUsageButton({
  summary,
  sessionTokenUsage,
}: {
  summary: ContextUsageSummary;
  sessionTokenUsage?: TokenUsage;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ bottom: number; right: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const percent = summary.percentUsed === undefined ? 0 : Math.max(0, Math.min(100, summary.percentUsed));
  const percentLabel = formatContextPercent(percent);
  const ringColor = percent >= 85 ? '#e11d48' : percent >= 65 ? '#f59e0b' : '#18181b';
  const ringRadius = 10;
  const ringCircumference = 2 * Math.PI * ringRadius;
  const ringOffset = ringCircumference * (1 - percent / 100);

  useLayoutEffect(() => {
    if (!open || typeof window === 'undefined') return undefined;

    function updatePosition() {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (!rect) return;
      const panelWidth = 380;
      const right = Math.max(12, Math.min(window.innerWidth - rect.right, window.innerWidth - panelWidth - 12));
      const bottom = Math.max(12, window.innerHeight - rect.top + 8);
      setPosition({ bottom, right });
    }

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label={`Context usage ${percentLabel}`}
        aria-expanded={open}
        title={`Context usage ${percentLabel}`}
        onClick={() => setOpen((value) => !value)}
        className={`grid h-8 w-8 place-items-center rounded-full bg-white shadow-sm shadow-zinc-200/50 hover:bg-zinc-50 ${surface.focus}`}
      >
        <span aria-hidden="true" className="relative grid h-6 w-6 place-items-center rounded-full">
          <svg className="absolute inset-0 h-6 w-6 -rotate-90" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r={ringRadius} fill="none" stroke="#e4e4e7" strokeWidth="3" />
            {percent > 0 && (
              <circle
                cx="12"
                cy="12"
                r={ringRadius}
                fill="none"
                stroke={ringColor}
                strokeWidth="3"
                strokeLinecap="round"
                strokeDasharray={ringCircumference}
                strokeDashoffset={ringOffset}
              />
            )}
          </svg>
          <span className="relative h-[10px] w-[10px] rounded-full bg-white" />
        </span>
      </button>
      {open &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className="fixed z-[100]"
            style={{
              bottom: position?.bottom ?? 56,
              right: position?.right ?? 12,
            }}
          >
            <ContextUsagePanel summary={summary} sessionTokenUsage={sessionTokenUsage} />
          </div>,
          document.body,
        )}
    </>
  );
}
