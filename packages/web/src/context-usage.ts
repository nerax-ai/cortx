import type { ContextUsageBreakdownEntry, ContextUsageFacts, ContextUsageSource } from '@cortx/sdk';

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
  if (value === undefined) return '未知';
  if (value >= 10_000) {
    const units = value / 10_000;
    return `${Number.isInteger(units) ? units.toFixed(0) : units.toFixed(1)}万`;
  }
  if (value >= 1_000) {
    const units = value / 1_000;
    return `${Number.isInteger(units) ? units.toFixed(0) : units.toFixed(1)}千`;
  }
  return value.toLocaleString();
}

export function formatContextPercent(value: number | undefined): string {
  if (value === undefined) return '未知';
  if (value > 0 && value < 1) return '<1%';
  return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}%`;
}

export function formatContextSource(source: ContextUsageSource | undefined): string {
  switch (source) {
    case 'configured':
      return '配置';
    case 'model_metadata':
      return '模型配置';
    case 'provider':
      return 'Provider';
    case 'runtime_exact':
      return 'Runtime';
    case 'runtime_estimate':
      return 'Runtime 估算';
    case 'unknown':
    default:
      return '未知';
  }
}
