import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentState } from '@cortx/store';
import { DesktopWorkspace } from '../src/components/DesktopWorkspace';
import { MessageBubble } from '../src/components/MessageBubble';
import { PromptInput } from '../src/components/PromptInput';
import { ApprovalDialogBody } from '../src/components/AskUserDialog';
import { ConnectionOverlay } from '../src/components/ConnectionOverlay';

function makeState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    sessionId: 'sess_web',
    messages: {
      turns: [
        {
          role: 'user',
          content: 'Review this workspace',
          timestamp: 1,
        },
      ],
      currentText: 'I will inspect the changed files.',
      currentThinking: 'Need to inspect the repo first.',
    },
    iteration: 2,
    toolCalls: new Map([
      [
        'tool_1',
        {
          toolName: 'read',
          input: { path: 'packages/web/src/App.tsx' },
          status: 'pending',
          progress: 'Reading App.tsx',
        },
      ],
    ]),
    tokenUsage: { inputTokens: 1530, outputTokens: 220 },
    totalElapsed: 65,
    elapsed: 5,
    status: 'running',
    error: undefined,
    agentSessions: new Map([
      [
        'agent_1',
        {
          toolCallId: 'agent_1',
          description: 'Review UI states',
          status: 'running',
          isBackground: true,
          iterations: 1,
          toolCallCount: 1,
          progress: 'Checking layout',
        },
      ],
    ]),
    pendingQuestion: null,
    ...overrides,
  };
}

describe('web desktop UI', () => {
  test('ConnectionOverlay renders the remote-only connect surface', () => {
    const html = renderToStaticMarkup(<ConnectionOverlay onConnect={async () => undefined} />);

    expect(html).toContain('Cortx Web');
    expect(html).toContain('API Key');
    expect(html).toContain('Connect to workspace');
    expect(html).toContain('remote-only');
  });

  test('DesktopWorkspace renders shell, conversation and inspector facts', () => {
    const html = renderToStaticMarkup(
      <DesktopWorkspace
        state={makeState()}
        session={{
          id: 'sess_1234567890',
          createdAt: 1,
          lastActivityAt: 2,
          workingDirectory: '/Users/dev/work/cortx',
          model: 'default',
          toolMode: 'all',
          approvalMode: 'interactive',
          isRunning: true,
          eventCount: 7,
        }}
        onSend={() => undefined}
        onAbort={() => undefined}
        onResume={() => undefined}
      />,
    );

    expect(html).toContain('Cortx');
    expect(html).toContain('Remote agent workspace');
    expect(html).toContain('Working');
    expect(html).toContain('work/cortx');
    expect(html).toContain('Inspector');
    expect(html).toContain('Tools');
    expect(html).toContain('Agents');
    expect(html).toContain('I will inspect the changed files.');
  });

  test('MessageBubble distinguishes user and assistant output', () => {
    const user = renderToStaticMarkup(<MessageBubble role="user" content="Hello" />);
    const assistant = renderToStaticMarkup(<MessageBubble role="assistant" content="Hi" duration={1.2} />);

    expect(user).toContain('You');
    expect(assistant).toContain('Cortx');
    expect(assistant).toContain('1.2s');
  });

  test('PromptInput reflects prompt, follow-up and awaiting-user modes', () => {
    const prompt = renderToStaticMarkup(<PromptInput onSend={() => undefined} />);
    const followUp = renderToStaticMarkup(<PromptInput onSend={() => undefined} mode="follow-up" />);
    const disabled = renderToStaticMarkup(<PromptInput onSend={() => undefined} disabled />);

    expect(prompt).toContain('Prompt');
    expect(followUp).toContain('Follow-up');
    expect(disabled).toContain('Awaiting answer');
  });

  test('ApprovalDialogBody renders the pending question and disabled submit state', () => {
    const html = renderToStaticMarkup(
      <ApprovalDialogBody
        pendingQuestion={{ toolCallId: 'tool_approval', question: 'Allow write to package.json?' }}
        response=""
        onResponseChange={() => undefined}
        onClear={() => undefined}
        onSubmit={() => undefined}
      />,
    );

    expect(html).toContain('Allow write to package.json?');
    expect(html).toContain('Submit answer');
  });
});
