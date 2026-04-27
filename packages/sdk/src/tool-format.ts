export interface FormatToolSummaryOptions {
  maxLength?: number;
}

function safeParse(input: unknown): Record<string, unknown> {
  if (typeof input === 'string') {
    try { return JSON.parse(input); } catch { return {}; }
  }
  return (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
}

export function formatToolSummary(
  toolName: string,
  input: unknown,
  options?: FormatToolSummaryOptions,
): string {
  const max = options?.maxLength ?? 100;
  const parsed = safeParse(input);

  if (toolName === 'agent') {
    const desc = String(parsed.description ?? '');
    const prompt = String(parsed.prompt ?? '').slice(0, max);
    return desc ? `${desc}: ${prompt}` : prompt;
  }
  if (toolName === 'bash') {
    return String(parsed.command ?? '').slice(0, max);
  }
  if (toolName === 'read' || toolName === 'write' || toolName === 'edit') {
    return String(parsed.file_path ?? parsed.path ?? '').slice(0, max);
  }
  if (toolName === 'grep') {
    return String(parsed.pattern ?? '').slice(0, max);
  }
  return '';
}
