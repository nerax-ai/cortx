import type { LanguageMessage } from '@cortx/sdk';
import type {
  LanguageAssistantMessage,
  LanguageFileContent,
  LanguageSystemMessage,
  LanguageToolMessage,
  LanguageUserMessage,
} from '@synax-ai/sdk';
import type { TurnEntry } from './types/tui-state.js';

type MessageRole = LanguageMessage['role'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRole(value: unknown): value is MessageRole {
  return value === 'system' || value === 'user' || value === 'assistant' || value === 'tool';
}

function isJsonValue(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!isRecord(value)) return false;
  return Object.values(value).every(isJsonValue);
}

function isToolOutput(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  if ((value.type === 'text' || value.type === 'error-text') && typeof value.value === 'string') return true;
  if ((value.type === 'json' || value.type === 'error-json') && isJsonValue(value.value)) return true;
  if (value.type === 'execution-denied') return value.reason === undefined || typeof value.reason === 'string';
  if (value.type === 'content') return Array.isArray(value.value) && value.value.every(isContentPart);
  return false;
}

function isContentPart(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  if (value.type === 'text') return typeof value.text === 'string';
  if (value.type === 'file') return typeof value.mediaType === 'string' && (typeof value.data === 'string' || value.data instanceof URL);
  if (value.type === 'reasoning') return typeof value.reasoning === 'string';
  if (value.type === 'tool-call') return typeof value.toolCallId === 'string' && typeof value.toolName === 'string';
  if (value.type === 'tool-result') {
    return typeof value.toolCallId === 'string' && typeof value.toolName === 'string' && isToolOutput(value.output);
  }
  if (value.type === 'tool-approval-request') {
    return typeof value.approvalId === 'string' && typeof value.toolCallId === 'string';
  }
  if (value.type === 'tool-approval-response') {
    return typeof value.approvalId === 'string' && typeof value.approved === 'boolean';
  }
  return false;
}

function isTextPart(value: unknown): value is { type: 'text'; text: string } {
  return isRecord(value) && value.type === 'text' && typeof value.text === 'string';
}

function isFilePart(value: unknown): value is LanguageFileContent {
  return isRecord(value) &&
    value.type === 'file' &&
    typeof value.mediaType === 'string' &&
    (typeof value.data === 'string' || value.data instanceof URL);
}

function parseMessage(item: unknown): LanguageMessage | null {
  if (!isRecord(item) || !isRole(item.role)) return null;
  const content = typeof item.content === 'string'
    ? [{ type: 'text' as const, text: item.content }]
    : item.content;
  if (!Array.isArray(content)) return null;

  if (item.role === 'system' && content.every(isTextPart)) {
    return { role: 'system', content } satisfies LanguageSystemMessage;
  }
  if (item.role === 'user' && content.every((part) => isTextPart(part) || isFilePart(part))) {
    return { role: 'user', content } satisfies LanguageUserMessage;
  }
  if (item.role === 'tool' && content.every((part) => isRecord(part) && part.type === 'tool-result' && isContentPart(part))) {
    return { role: 'tool', content } satisfies LanguageToolMessage;
  }
  if (item.role === 'assistant' && content.every(isContentPart)) {
    return { role: 'assistant', content } satisfies LanguageAssistantMessage;
  }
  return null;
}

function turnToMessage(turn: TurnEntry): LanguageMessage | null {
  if (turn.role === 'user') {
    return { role: 'user', content: [{ type: 'text', text: turn.content }] } satisfies LanguageUserMessage;
  }
  if (turn.role === 'assistant') {
    return { role: 'assistant', content: [{ type: 'text', text: turn.content }] } satisfies LanguageAssistantMessage;
  }
  if (turn.role === 'system') {
    return { role: 'system', content: [{ type: 'text', text: turn.content }] } satisfies LanguageSystemMessage;
  }
  if (turn.role === 'tool') return null;
  return null;
}

/**
 * Parse runtime data into LanguageMessage[].
 *
 * Session data is loaded from JSON — types don't exist at runtime.
 * This function is the single trusted boundary where untyped data
 * enters the typed system.
 */
export function parseAgentMessages(data: unknown): LanguageMessage[] {
  if (!Array.isArray(data)) return [];
  return data.map(parseMessage).filter((message): message is LanguageMessage => message !== null);
}

/** Map TurnEntry records to message-shaped objects. */
export function turnsToMessages(turns: TurnEntry[]): LanguageMessage[] {
  return turns.map(turnToMessage).filter((message): message is LanguageMessage => message !== null);
}
