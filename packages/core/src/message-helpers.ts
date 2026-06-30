import type { LanguageMessage, LanguageToolCallContent } from '@cortx/sdk';

export function createUserMessage(text: string): LanguageMessage {
  return { role: 'user', content: [{ type: 'text', text }] } as LanguageMessage;
}

export function replaceMessageContent(
  msg: LanguageMessage,
  content: LanguageMessage['content'],
): LanguageMessage {
  return { role: msg.role, content } as LanguageMessage;
}

export function messageText(message: LanguageMessage): string {
  const { content } = message;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => typeof part === 'object' && part !== null && 'type' in part && part.type === 'text' && typeof part.text === 'string'
      ? part.text
      : '')
    .join('');
}

export function isToolCallContent(item: unknown): item is LanguageToolCallContent {
  return typeof item === 'object' && item !== null && 'type' in item && (item as { type: string }).type === 'tool-call';
}
