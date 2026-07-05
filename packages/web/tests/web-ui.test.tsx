import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentState } from '@cortx/store';
import { activityToInspectorMaps, latestIterationActivity } from '../src/activity';
import { DesktopWorkspace } from '../src/components/DesktopWorkspace';
import { ChatView } from '../src/components/ChatView';
import { MessageBubble } from '../src/components/MessageBubble';
import { PromptInput } from '../src/components/PromptInput';
import { ApprovalDialogBody } from '../src/components/AskUserDialog';
import { ConnectionStatus } from '../src/components/ConnectionStatus';
import { MarkdownContent } from '../src/components/MarkdownContent';
import { WorkspaceHeader } from '../src/components/WorkspaceHeader';

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
    activity: [
      {
        kind: 'tool',
        id: 'tool_1',
        timestamp: 3,
        entry: {
          toolName: 'read',
          input: { path: 'packages/web/src/App.tsx' },
          status: 'pending',
          progress: 'Reading App.tsx',
        },
      },
      {
        kind: 'agent',
        id: 'agent_1',
        timestamp: 4,
        session: {
          toolCallId: 'agent_1',
          description: 'Review UI states',
          status: 'running',
          isBackground: true,
          iterations: 1,
          toolCallCount: 1,
          progress: 'Checking layout',
        },
      },
    ],
    pendingQuestion: null,
    ...overrides,
  };
}

describe('web desktop UI', () => {
  test('ConnectionStatus renders auto-connect state without API key inputs', () => {
    const html = renderToStaticMarkup(<ConnectionStatus error={null} onRetry={() => undefined} />);

    expect(html).toContain('Cortx');
    expect(html).toContain('Connecting to runtime');
    expect(html).not.toContain('API Key');
    expect(html).not.toContain('Workspace Directory');
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
        sessions={[
          {
            id: 'sess_1234567890',
            createdAt: 1,
            lastActivityAt: 2,
            workingDirectory: '/Users/dev/work/cortx',
            model: 'default',
            toolMode: 'all',
            approvalMode: 'interactive',
            isRunning: true,
            eventCount: 7,
          },
          {
            id: 'sess_same_project',
            createdAt: 1,
            lastActivityAt: 3,
            workingDirectory: '/Users/dev/work/cortx',
            model: 'default',
            toolMode: 'read-only',
            approvalMode: 'full-access',
            isRunning: false,
            eventCount: 3,
          },
          {
            id: 'sess_other_project',
            createdAt: 1,
            lastActivityAt: 2,
            workingDirectory: '/Users/dev/work/cortx/packages/web',
            model: 'default',
            toolMode: 'read-only',
            approvalMode: 'full-access',
            isRunning: false,
            eventCount: 3,
          },
        ]}
        agentSpecs={[
          {
            name: 'basic-reviewer',
            path: '/Users/dev/work/cortx/examples/skill-packs/basic/agents/reviewer.json',
            relativePath: 'examples/skill-packs/basic/agents/reviewer.json',
            sourceRoot: '/Users/dev/work/cortx',
            promptPreview: '/review current changes',
            toolMode: 'read-only',
            approvalMode: 'deny',
          },
        ]}
        skillPacks={[
          {
            id: 'review-pack',
            name: 'Review Pack',
            version: '0.1.0',
            sourcePath: '/Users/dev/work/cortx/examples/skill-packs/review',
            installedAt: 42,
            path: '/Users/dev/work/cortx/examples/skill-packs/review',
            skillPaths: ['/Users/dev/work/cortx/examples/skill-packs/review/skills'],
            agentSpecPaths: ['/Users/dev/work/cortx/examples/skill-packs/review/agents'],
          },
        ]}
        selectedSkillPackIds={['review-pack']}
        selectedWorkingDirectory="/Users/dev/work/cortx"
        toolMode="all"
        approvalMode="interactive"
        eventConnection={{ phase: 'live', sessionId: 'sess_1234567890', lastSequence: 7, updatedAt: 3 }}
        onSend={() => undefined}
        onAbort={() => undefined}
        onResume={() => undefined}
        onRecoverEventStream={() => undefined}
        onCreateSession={() => undefined}
        onCreateSessionForCurrentProject={() => undefined}
        onLaunchAgentSpec={() => undefined}
        onInstallSkillPack={() => undefined}
        onSkillPackSelectionChange={() => undefined}
        onSelectProject={() => undefined}
        onSwitchSession={() => undefined}
        onToolModeChange={() => undefined}
        onApprovalModeChange={() => undefined}
      />,
    );

    expect(html).toContain('Cortx');
    expect(html).toContain('Agent workspace');
    expect(html).toContain('Projects');
    expect(html).toContain('Agents');
    expect(html).toContain('basic-reviewer');
    expect(html).toContain('/review current changes');
    expect(html).toContain('Skill Packs');
    expect(html).toContain('Review Pack');
    expect(html).toContain('Install Skill Pack');
    expect(html).toContain('Install pack');
    expect(html).toContain('Add Project');
    expect(html).toContain('Add project');
    expect(html).toContain('Working');
    expect(html).toContain('Live');
    expect(html).toContain('event 7');
    expect(html).toContain('work/cortx');
    expect(html).toContain('2 sessions');
    expect(html).toContain('read-only');
    expect(html).toContain('full-access');
    expect(html).toContain('Inspector');
    expect(html).toContain('Tools');
    expect(html).toContain('Agents');
    expect(html).toContain('Tool call');
    expect(html).toContain('Sub-agent');
    expect(html).toContain('I will inspect the changed files.');
  });

  test('WorkspaceHeader renders recover action for degraded event streams', () => {
    const reconnecting = renderToStaticMarkup(
      <WorkspaceHeader
        status="idle"
        session={{
          id: 'sess_1234567890',
          createdAt: 1,
          lastActivityAt: 2,
          workingDirectory: '/Users/dev/work/cortx',
          model: 'default',
          toolMode: 'all',
          approvalMode: 'interactive',
          isRunning: false,
          eventCount: 7,
        }}
        tokenUsage={{ inputTokens: 100, outputTokens: 20 }}
        elapsed={12}
        iteration={0}
        eventConnection={{
          phase: 'reconnecting',
          sessionId: 'sess_1234567890',
          lastSequence: 12,
          message: 'Event stream interrupted',
          updatedAt: 4,
        }}
        onRecoverEventStream={() => undefined}
      />,
    );
    const live = renderToStaticMarkup(
      <WorkspaceHeader
        status="idle"
        session={{
          id: 'sess_1234567890',
          createdAt: 1,
          lastActivityAt: 2,
          workingDirectory: '/Users/dev/work/cortx',
          model: 'default',
          toolMode: 'all',
          approvalMode: 'interactive',
          isRunning: false,
          eventCount: 7,
        }}
        tokenUsage={{ inputTokens: 100, outputTokens: 20 }}
        elapsed={12}
        iteration={0}
        eventConnection={{
          phase: 'live',
          sessionId: 'sess_1234567890',
          lastSequence: 12,
          updatedAt: 4,
        }}
        onRecoverEventStream={() => undefined}
      />,
    );

    expect(reconnecting).toContain('Reconnecting');
    expect(reconnecting).toContain('event 12');
    expect(reconnecting).toContain('Recover stream');
    expect(live).toContain('Live');
    expect(live).not.toContain('Recover stream');
  });

  test('ChatView deduplicates sub-agent tool activity in the conversation', () => {
    const html = renderToStaticMarkup(
      <ChatView
        messages={{ turns: [], currentText: '', currentThinking: '' }}
        activity={[
          {
            kind: 'tool',
            id: 'agent_dup',
            timestamp: 1,
            entry: {
              toolName: 'agent',
              input: { description: 'Review the project' },
              status: 'complete',
              result: 'done',
            },
          },
          {
            kind: 'agent',
            id: 'agent_dup',
            timestamp: 2,
            session: {
              toolCallId: 'agent_dup',
              description: 'Review the project',
              status: 'completed',
              isBackground: false,
              iterations: 2,
              toolCallCount: 1,
            },
          },
        ]}
        toolCalls={new Map()}
        agentSessions={new Map()}
        status="idle"
        iteration={0}
        error={undefined}
        toolMode="all"
        approvalMode="interactive"
        selectedWorkingDirectory="/Users/dev/work/cortx"
        willCreateSessionOnSend={false}
        onSend={() => undefined}
        onAbort={() => undefined}
        onResume={() => undefined}
        onCreateSessionForCurrentProject={() => undefined}
        onToolModeChange={() => undefined}
        onApprovalModeChange={() => undefined}
      />,
    );

    expect(html).toContain('Sub-agent');
    expect(html).toContain('Review the project');
    expect(html).not.toContain('Tool call');
  });

  test('activity inspector summary counts visible tools and sub-agents once', () => {
    const activity = [
      {
        kind: 'tool',
        id: 'read_1',
        timestamp: 1,
        iteration: 2,
        entry: { toolName: 'read', input: { path: 'README.md' }, status: 'complete', result: 'ok' },
      },
      {
        kind: 'tool',
        id: 'agent_1',
        timestamp: 2,
        iteration: 2,
        entry: { toolName: 'agent', input: { description: 'Review' }, status: 'complete', result: 'done' },
      },
      {
        kind: 'agent',
        id: 'agent_1',
        timestamp: 3,
        iteration: 2,
        session: {
          toolCallId: 'agent_1',
          description: 'Review',
          status: 'completed',
          isBackground: false,
          iterations: 1,
          toolCallCount: 1,
        },
      },
      {
        kind: 'agent',
        id: 'old_agent',
        timestamp: 0,
        iteration: 1,
        session: {
          toolCallId: 'old_agent',
          description: 'Old review',
          status: 'completed',
          isBackground: false,
          iterations: 1,
          toolCallCount: 1,
        },
      },
    ] as const;

    const { toolCalls, agentSessions } = activityToInspectorMaps([...activity]);
    const latest = activityToInspectorMaps(latestIterationActivity([...activity]));

    expect(toolCalls.size).toBe(1);
    expect(toolCalls.get('read_1')?.toolName).toBe('read');
    expect(agentSessions.size).toBe(2);
    expect(agentSessions.get('agent_1')?.description).toBe('Review');
    expect(latest.toolCalls.size).toBe(1);
    expect(latest.agentSessions.size).toBe(1);
    expect(latest.agentSessions.has('old_agent')).toBe(false);
  });

  test('MessageBubble distinguishes user and assistant output', () => {
    const user = renderToStaticMarkup(<MessageBubble role="user" content="Hello" />);
    const assistant = renderToStaticMarkup(<MessageBubble role="assistant" content="Hi" duration={1.2} />);

    expect(user).toContain('You');
    expect(assistant).toContain('Cortx');
    expect(assistant).toContain('1.2s');
  });

  test('PromptInput reflects prompt, follow-up and awaiting-user modes', () => {
    const props = {
      onSend: () => undefined,
      toolMode: 'all' as const,
      approvalMode: 'interactive' as const,
      selectedWorkingDirectory: '/Users/dev/work/cortx',
      canChangeModes: true,
      willCreateSessionOnSend: false,
      onCreateSession: () => undefined,
      onToolModeChange: () => undefined,
      onApprovalModeChange: () => undefined,
    };
    const prompt = renderToStaticMarkup(<PromptInput {...props} />);
    const followUp = renderToStaticMarkup(<PromptInput {...props} mode="follow-up" canChangeModes={false} />);
    const disabled = renderToStaticMarkup(<PromptInput {...props} disabled canChangeModes={false} />);

    expect(prompt).toContain('Prompt');
    expect(prompt).toContain('Tools');
    expect(prompt).toContain('Control');
    expect(prompt).toContain('New session');
    expect(followUp).toContain('Follow-up');
    expect(disabled).toContain('Awaiting answer');
  });

  test('PromptInput warns when selected controls will create a new session', () => {
    const html = renderToStaticMarkup(
      <PromptInput
        onSend={() => undefined}
        toolMode="read-only"
        approvalMode="full-access"
        selectedWorkingDirectory="/Users/dev/work/cortx"
        canChangeModes
        willCreateSessionOnSend
        onCreateSession={() => undefined}
        onToolModeChange={() => undefined}
        onApprovalModeChange={() => undefined}
      />,
    );

    expect(html).toContain('Sending will start a new session');
  });

  test('MarkdownContent renders common markdown blocks', () => {
    const html = renderToStaticMarkup(
      <MarkdownContent
        text={
          '## Plan\n\n- inspect\n- fix\n\n| Name | Value |\n| --- | ---: |\n| Status | **ok** |\n\n```ts\nconst ok = true;\n```\n\nUse **bold** and [link](https://example.com).'
        }
      />,
    );

    expect(html).toContain('<h2');
    expect(html).toContain('<ul');
    expect(html).toContain('<table');
    expect(html).toContain('<td');
    expect(html).toContain('<code>const ok = true;</code>');
    expect(html).toContain('<strong');
    expect(html).toContain('href="https://example.com"');
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

  test('ApprovalDialogBody renders selectable approval choices', () => {
    const html = renderToStaticMarkup(
      <ApprovalDialogBody
        pendingQuestion={{
          toolCallId: 'tool_approval',
          question: 'Allow write to package.json?',
          kind: 'tool_approval',
          allowedResponses: ['yes', 'no'],
          context: { workingDirectory: '/Users/dev/work/cortx' },
        }}
        response=""
        onResponseChange={() => undefined}
        onClear={() => undefined}
        onSubmit={() => undefined}
      />,
    );

    expect(html).toContain('Allow write to package.json?');
    expect(html).toContain('Allow');
    expect(html).toContain('Deny');
    expect(html).not.toContain('Submit answer');
    expect(html).not.toContain('Type your response');
  });
});
