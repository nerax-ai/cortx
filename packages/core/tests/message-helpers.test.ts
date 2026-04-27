import { describe, test, expect } from 'bun:test';
import { createUserMessage, replaceMessageContent } from '../src/message-helpers';
import type { LanguageMessage } from '@cortx/sdk';

describe('message-helpers', () => {
  test('createUserMessage creates a user message with text content', () => {
    const msg = createUserMessage('hello');
    expect(msg.role).toBe('user');
    expect(Array.isArray(msg.content)).toBe(true);
    expect(msg.content).toHaveLength(1);
    const part = msg.content[0] as { type: string; text: string };
    expect(part.type).toBe('text');
    expect(part.text).toBe('hello');
  });

  test('createUserMessage with empty string produces valid structure', () => {
    const msg = createUserMessage('');
    expect(msg.role).toBe('user');
    const part = msg.content[0] as { type: string; text: string };
    expect(part.text).toBe('');
  });

  test('replaceMessageContent preserves role and replaces content', () => {
    const original: LanguageMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'old content' }],
    } as LanguageMessage;
    const result = replaceMessageContent(original, [{ type: 'text', text: 'new content' }]);
    expect(result.role).toBe('assistant');
    const part = result.content[0] as { type: string; text: string };
    expect(part.text).toBe('new content');
  });
});
