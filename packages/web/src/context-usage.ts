import type { ContextUsageBreakdownEntry, ContextUsageFacts, ContextUsageSource } from '@cortx/sdk';
import type { TokenUsage } from '@cortx/store';

export type ContextUsageSummary = ContextUsageFacts;
export type ContextUsageRow = ContextUsageBreakdownEntry;

export function contextBreakdownTotal(summary: ContextUsageFacts): number {
  return summary.breakdown.reduce((total, row) => total + row.tokens, 0);
}

export function contextRowPercent(row: ContextUsageBreakdownEntry, summary: ContextUsageFacts): number | undefined {
  const denominator = Math.max(summary.usedTokens ?? 0, contextBreakdownTotal(summary));
  if (denominator <= 0) return undefined;
  return Math.max(0, Math.min(100, (row.tokens / denominator) * 100));
}

export function formatContextTokenCount(value: number | undefined): string {
  if (value === undefined) return 'Unknown';
  if (value >= 1_000_000) {
    const units = value / 1_000_000;
    return `${Number.isInteger(units) ? units.toFixed(0) : units.toFixed(1)}M`;
  }
  if (value >= 1_000) {
    const units = value / 1_000;
    return `${Number.isInteger(units) ? units.toFixed(0) : units.toFixed(1)}k`;
  }
  return value.toLocaleString();
}

export function formatContextPercent(value: number | undefined): string {
  if (value === undefined) return 'Unknown';
  if (value <= 0) return '0%';
  const displayValue = Math.max(0.1, value);
  return `${Number.isInteger(displayValue) ? displayValue.toFixed(0) : displayValue.toFixed(1)}%`;
}

function positiveToken(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function contextInputTokensForUsage(usage: TokenUsage): number | undefined {
  const inputTokens = positiveToken(usage.inputTokens);
  const cacheReadTokens = positiveToken(usage.cacheReadTokens);
  const cacheCreationTokens = positiveToken(usage.cacheCreationTokens);
  const noCacheInputTokens =
    usage.noCacheInputTokens === undefined ? undefined : positiveToken(usage.noCacheInputTokens);
  const total =
    noCacheInputTokens === undefined
      ? inputTokens + cacheReadTokens + cacheCreationTokens
      : Math.max(inputTokens, noCacheInputTokens + cacheReadTokens + cacheCreationTokens);
  return total > 0 ? total : undefined;
}

export function sessionCacheHitRate(usage: TokenUsage | undefined): number | undefined {
  if (!usage) return undefined;
  if (
    usage.noCacheInputTokens === undefined &&
    usage.cacheReadTokens === undefined &&
    usage.cacheCreationTokens === undefined
  ) {
    return undefined;
  }
  const denominator = contextInputTokensForUsage(usage);
  const cacheReadTokens = positiveToken(usage.cacheReadTokens);
  if (denominator === undefined || denominator <= 0) return undefined;
  return Math.max(0, Math.min(100, (cacheReadTokens / denominator) * 100));
}

export function formatContextSource(source: ContextUsageSource | undefined): string {
  switch (source) {
    case 'configured':
      return 'Configured';
    case 'model_metadata':
      return 'Model metadata';
    case 'provider':
      return 'Provider';
    case 'runtime_exact':
      return 'Runtime';
    case 'runtime_estimate':
      return 'Runtime estimate';
    case 'unknown':
    default:
      return 'Unknown';
  }
}
