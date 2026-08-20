import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentState } from '@cortx/store';
import { activityToInspectorMaps, latestIterationActivity } from '../src/activity';
import { contextRowPercent, formatContextPercent } from '../src/context-usage';
import { DesktopWorkspace, contextUsageForSession } from '../src/components/DesktopWorkspace';
import { ChatView } from '../src/components/ChatView';
import { MessageBubble } from '../src/components/MessageBubble';
import { PromptInput, buildPromptHistory, shouldSubmitPromptInput } from '../src/components/PromptInput';
import { ApprovalDialogBody } from '../src/components/AskUserDialog';
import { ConnectionStatus } from '../src/components/ConnectionStatus';
import { ContextUsageButton, ContextUsagePanel, breakdownDotColor } from '../src/components/ContextUsageButton';
import { InspectorPanel } from '../src/components/InspectorPanel';
import { MarkdownContent } from '../src/components/MarkdownContent';
import { DeleteSessionDialogContent } from '../src/components/SessionSidebar';
import { ToolCard } from '../src/components/ToolCard';
import { WorkspaceHeader } from '../src/components/WorkspaceHeader';

const TEST_MODELS = [
  {
    id: 'default',
    name: 'GPT-5.5',
    contextWindowTokens: 200000,
    reasoningEfforts: [
      { value: 'low', label: 'Light' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
      { value: 'xhigh', label: 'Extra High' },
    ],
  },
];

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
    tokenUsage: { inputTokens: 1530, outputTokens: 220, cacheReadTokens: 470 },
    contextUsage: {
      usedTokens: 1530,
      requestInputTokens: 1330,
      requestOutputTokens: 220,
      requestCacheReadTokens: 200,
      windowTokens: 200000,
      windowSource: 'model_metadata',
      model: 'default',
      percentUsed: 0.765,
      cacheHitRate: 20,
      breakdown: [
        { key: 'messages', label: 'Messages', tokens: 700, source: 'runtime_estimate', count: 2 },
        { key: 'tools', label: 'Tools', tokens: 500, source: 'runtime_estimate', count: 4 },
        { key: 'skills', label: 'Skills', tokens: 200, source: 'runtime_estimate', count: 1 },
        { key: 'system_prompt', label: 'System Prompt', tokens: 100, source: 'runtime_estimate' },
        { key: 'other', label: 'Other', tokens: 30, source: 'provider' },
      ],
    },
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
          promptHistory: ['Review current changes and summarize the main risks before editing anything'],
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
            promptHistory: ['Review current changes and summarize the main risks before editing anything'],
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
            promptHistory: ['Fix the markdown rendering in tool cards'],
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
        models={TEST_MODELS}
        sessionSkills={[
          {
            name: 'review',
            description: 'Review code changes',
            dirPath: '/Users/dev/work/cortx/examples/skill-packs/review/skills/review',
          },
        ]}
        queuedPrompts={[{ id: 'queued_1', text: 'Check the pending UI state after this turn', createdAt: 5 }]}
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
        eventHistory={{ sessionId: 'sess_1234567890', hasMoreBefore: false, loadedEvents: 7, loadingOlder: false }}
        onSend={() => undefined}
        onAbort={() => undefined}
        onResume={() => undefined}
        onSteerQueuedPrompt={() => undefined}
        onDeleteQueuedPrompt={() => undefined}
        onRecoverEventStream={() => undefined}
        onLoadOlderHistory={() => undefined}
        onCreateSession={() => undefined}
        onBrowseWorkspaceDirectories={async () => ({
          roots: ['/Users/dev/work/cortx'],
          current: '/Users/dev/work/cortx',
          entries: [],
        })}
        onLaunchAgentSpec={() => undefined}
        onInstallSkillPack={() => undefined}
        onSkillPackSelectionChange={() => undefined}
        onSelectProject={() => undefined}
        onSwitchSession={() => undefined}
        onDeleteSession={() => undefined}
        onModelChange={() => undefined}
        onReasoningEffortChange={() => undefined}
        onToolModeChange={() => undefined}
        onApprovalModeChange={() => undefined}
      />,
    );

    expect(html).toContain('Cortx');
    expect(html).toContain('Agent workspace');
    expect(html).not.toContain('Active Project');
    expect(html).toContain('Projects');
    expect(html).not.toContain('basic-reviewer');
    expect(html).not.toContain('/review current changes');
    expect(html).not.toContain('Skill Packs');
    expect(html).not.toContain('Review Pack');
    expect(html).not.toContain('Install Skill Pack');
    expect(html).not.toContain('Install pack');
    expect(html).toContain('Add project');
    expect(html).not.toContain('Browse');
    expect(html).toContain('Working');
    expect(html).toContain('Live');
    expect(html).toContain('event 7');
    expect(html).toContain('work/cortx');
    expect(html).toContain('2 sessions');
    expect(html).toContain('Review current changes and summar…');
    expect(html).toContain('Fix the markdown rendering in too…');
    expect(html).toContain('Delete Review current changes and summar…');
    expect(html).toContain('read-only');
    expect(html).toContain('full-access');
    expect(html).toContain('Activity');
    expect(html).not.toContain('Inspector');
    expect(html).toContain('Tools');
    expect(html).toContain('Turn Agents');
    expect(html).not.toContain('Runtime facts and tool activity');
    expect(html).not.toContain('Session Tokens');
    expect(html).not.toContain('Elapsed');
    expect(html).toContain('Tool call');
    expect(html).toContain('Sub-agent');
    expect(html).toContain('I will inspect the changed files.');
    expect(html).toContain('Context');
    expect(html).toContain('Templates');
    expect(html).toContain('GPT-5.5');
    expect(html).toContain('Runtime queued inputs');
    expect(html).toContain('Check the pending UI state after this turn');
    expect(html).toContain('Steer');
    expect(html).toContain('Edit');
    expect(html).toContain('Delete');
    expect(html).toContain('Stop');
  });

  test('InspectorPanel renders as a tabbed workspace panel', () => {
    const html = renderToStaticMarkup(
      <InspectorPanel activity={makeState().activity} activeTab="activity" onTabChange={() => undefined} onClose={() => undefined} />,
    );

    expect(html).toContain('Activity');
    expect(html).toContain('Context');
    expect(html).not.toContain('Browser');
    expect(html).toContain('Turn Tools');
    expect(html).toContain('Turn Agents');
    expect(html).toContain('Close panel');
  });

  test('DeleteSessionDialogContent renders the in-app confirmation content', () => {
    const html = renderToStaticMarkup(
      <DeleteSessionDialogContent
        sessionTitle="Review current changes"
        isDeleting={false}
        onCancel={() => undefined}
        onConfirm={() => undefined}
      />,
    );

    expect(html).toContain('Delete session');
    expect(html).toContain('Review current changes');
    expect(html).toContain('saved history');
    expect(html).toContain('Cancel');
    expect(html).toContain('Delete');
  });

  test('ContextUsagePanel renders runtime context facts without local estimation', () => {
    const summary = makeState().contextUsage;
    const html = renderToStaticMarkup(
      <ContextUsagePanel summary={summary!} sessionTokenUsage={{ inputTokens: 1530, outputTokens: 220, cacheReadTokens: 470 }} />,
    );

    expect(html).toContain('Current Request Context');
    expect(html).not.toContain('default');
    expect(html).not.toContain('Model metadata');
    expect(html).toContain('Show more');
    expect(html).toContain('0.8%');
    expect(html).toContain('Cache Hit Rate');
    expect(html).toContain('23.5%');
    expect(html.match(/Hit Rate/g)?.length).toBe(1);
    expect(html.indexOf('Show more')).toBeLessThan(html.indexOf('Cache Hit Rate'));
    expect(html).not.toContain('This Turn');
    expect(html).not.toContain('Session');
    expect(html).not.toContain('Input');
    expect(html).not.toContain('Output');
    expect(html).not.toContain('Cache Read');
    expect(html).not.toContain('Cache Write');
    expect(html).not.toContain('Messages');
    expect(html).not.toContain('Tools');
    expect(html).not.toContain('Skills');
    expect(html).not.toContain('System Prompt');
    expect(html).not.toContain('Provider');
  });

  test('contextUsageForSession falls back to session usage after restored replay', () => {
    const summary = contextUsageForSession(
      makeState({ contextUsage: undefined }),
      {
        id: 'sess_restored',
        createdAt: 1,
        lastActivityAt: 2,
        workingDirectory: '/repo/cortx',
        model: 'default',
        contextWindowTokens: 128000,
        contextWindowSource: 'model_metadata',
        toolMode: 'read-only',
        approvalMode: 'deny',
        usage: {
          inputTokens: 462,
          outputTokens: 4846,
          cacheReadTokens: 177216,
          context: {
            usedTokens: 94521,
            requestInputTokens: 19,
            requestOutputTokens: 2527,
            requestCacheReadTokens: 89984,
            windowTokens: 128000,
            windowSource: 'model_metadata',
            model: 'default',
            percentUsed: 73.84453125,
            cacheHitRate: 99.97888959256913,
            breakdown: [
              { key: 'messages', label: 'Messages', tokens: 93604, source: 'runtime_estimate', count: 145 },
              { key: 'tools', label: 'Tools', tokens: 393, source: 'runtime_estimate', count: 5 },
              { key: 'skills', label: 'Skills', tokens: 500, source: 'runtime_estimate', count: 43 },
              { key: 'system_prompt', label: 'System Prompt', tokens: 24, source: 'runtime_estimate' },
              { key: 'other', label: 'Other', tokens: 0, source: 'provider' },
            ],
          },
        },
        isRunning: false,
        eventCount: 2000,
      },
    );

    expect(summary).toMatchObject({
      usedTokens: 94521,
      percentUsed: 73.84453125,
      cacheHitRate: 99.97888959256913,
      windowTokens: 128000,
      model: 'default',
    });
    expect(summary?.breakdown[0]).toMatchObject({ key: 'messages', tokens: 93604 });
  });

  test('ToolCard renders read tools as file content instead of raw JSON first', () => {
    const html = renderToStaticMarkup(
      <ToolCard
        entry={{
          toolName: 'read',
          input: { path: 'src/example.ts', offset: 3, limit: 2 },
          result: 'const answer = 42;\nexport default answer;',
          status: 'complete',
        }}
      />,
    );

    expect(html).toContain('Read src/example.ts');
    expect(html).toContain('Read content');
    expect(html).toContain('const answer = 42;');
    expect(html).toContain('offset 3');
    expect(html).toContain('limit 2');
    expect(html).toContain('Raw details');
  });

  test('ToolCard renders write tools as added file content', () => {
    const html = renderToStaticMarkup(
      <ToolCard
        entry={{
          toolName: 'write',
          input: { path: 'src/new-file.ts', content: 'export const name = "cortx";\n' },
          result: 'Wrote 29 bytes to src/new-file.ts',
          status: 'complete',
        }}
      />,
    );

    expect(html).toContain('Write src/new-file.ts');
    expect(html).toContain('Written content');
    expect(html).toContain('+1 lines');
    expect(html).toContain('export const name = &quot;cortx&quot;;');
    expect(html).toContain('Wrote 29 bytes to src/new-file.ts');
  });

  test('ToolCard renders edit tools with before and after comparison', () => {
    const html = renderToStaticMarkup(
      <ToolCard
        entry={{
          toolName: 'edit',
          input: {
            path: 'src/example.ts',
            oldText: 'const status = "draft";',
            newText: 'const status = "ready";',
          },
          result: 'Edited src/example.ts',
          status: 'complete',
          details: {
            kind: 'file_edit',
            path: 'src/example.ts',
            removedLines: 0,
            addedLines: 1,
            lines: [
              { kind: 'context', oldLine: 8, newLine: 8, text: 'const name = "cortx";' },
              { kind: 'context', oldLine: 9, newLine: 9, text: 'const status = "draft";' },
              { kind: 'add', newLine: 10, text: 'const ready = true;' },
              { kind: 'context', oldLine: 10, newLine: 11, text: 'export { name };' },
            ],
          },
        }}
      />,
    );

    expect(html).toContain('Edit src/example.ts');
    expect(html).toContain('Edit diff');
    expect(html).toContain('Line 10');
    expect(html).toContain('Changed at Line 10');
    expect(html).toContain('@@ -8,3 +8,4 @@');
    expect(html).toContain('old');
    expect(html).toContain('new');
    expect(html).toContain('-0 +1 lines');
    expect(html).not.toContain('Old content');
    expect(html).not.toContain('New content');
    expect(html).toContain('const name = &quot;cortx&quot;;');
    expect(html).toContain('const status = &quot;draft&quot;;');
    expect(html).toContain('const ready = true;');
    expect(html).toContain('export { name };');
  });

  test('ToolCard renders edit fallback as a unified multi-line diff when details are missing', () => {
    const html = renderToStaticMarkup(
      <ToolCard
        entry={{
          toolName: 'edit',
          input: {
            path: 'hello.txt',
            oldText: 'Edited again, adding one more line!',
            newText: 'Edited again, adding one more line!\nThe file is becoming richer.',
          },
          result: 'Edited hello.txt',
          status: 'complete',
        }}
      />,
    );

    expect(html).toContain('Edit hello.txt');
    expect(html).toContain('Edit diff');
    expect(html).toContain('Input fragment Line 2');
    expect(html).toContain('@@ -1,1 +1,2 @@');
    expect(html).toContain('-0 +1 lines');
    expect(html).toContain('Edited again, adding one more line!');
    expect(html).toContain('The file is becoming richer.');
    expect(html).not.toContain('Old content');
    expect(html).not.toContain('New content');
    expect(html).not.toContain('md:grid-cols-2');
  });

  test('ToolCard shows exact line and inline changed text for middle-line edits', () => {
    const html = renderToStaticMarkup(
      <ToolCard
        entry={{
          toolName: 'edit',
          input: {
            path: 'src/config.ts',
            oldText: 'const status = "draft";',
            newText: 'const status = "ready";',
          },
          result: 'Edited src/config.ts',
          status: 'complete',
          details: {
            kind: 'file_edit',
            path: 'src/config.ts',
            contextLines: 3,
            oldStartLine: 42,
            newStartLine: 42,
            removedLines: 1,
            addedLines: 1,
            lines: [
              { kind: 'context', oldLine: 40, newLine: 40, text: 'export const name = "cortx";' },
              { kind: 'context', oldLine: 41, newLine: 41, text: 'export const mode = "local";' },
              { kind: 'remove', oldLine: 42, text: 'const status = "draft";' },
              { kind: 'add', newLine: 42, text: 'const status = "ready";' },
              { kind: 'context', oldLine: 43, newLine: 43, text: 'export { status };' },
            ],
          },
        }}
      />,
    );

    expect(html).toContain('Line 42');
    expect(html).toContain('Changed at Line 42');
    expect(html).toContain('@@ -40,4 +40,4 @@');
    expect(html).toContain('draft');
    expect(html).toContain('ready');
    expect(html).toContain('-1 +1 lines');
  });

  test('breakdownDotColor uses one neutral theme with percent-based depth', () => {
    expect(breakdownDotColor(0)).toBe('rgba(24, 24, 27, 0.14)');
    expect(breakdownDotColor(100)).toBe('rgba(24, 24, 27, 0.98)');
    expect(breakdownDotColor(1)).not.toBe(breakdownDotColor(50));
  });

  test('formatContextPercent keeps small positive values visible', () => {
    expect(formatContextPercent(0)).toBe('0%');
    expect(formatContextPercent(0.01)).toBe('0.1%');
    expect(formatContextPercent(0.765)).toBe('0.8%');
    expect(formatContextPercent(1)).toBe('1%');
  });

  test('ContextUsagePanel bases row percentages on explainable context totals', () => {
    const summary = {
      usedTokens: 398,
      requestInputTokens: 398,
      requestOutputTokens: 133,
      requestCacheReadTokens: 1472,
      windowTokens: 128_000,
      windowSource: 'model_metadata' as const,
      model: 'default',
      percentUsed: 0.3109375,
      cacheHitRate: 78.7,
      breakdown: [
        { key: 'messages' as const, label: 'Messages', tokens: 259, source: 'runtime_estimate' as const, count: 6 },
        { key: 'tools' as const, label: 'Tools', tokens: 876, source: 'runtime_estimate' as const, count: 9 },
        { key: 'skills' as const, label: 'Skills', tokens: 500, source: 'runtime_estimate' as const, count: 42 },
        { key: 'system_prompt' as const, label: 'System Prompt', tokens: 24, source: 'runtime_estimate' as const },
        { key: 'other' as const, label: 'Other', tokens: 0, source: 'provider' as const },
      ],
    };

    expect(formatContextPercent(contextRowPercent(summary.breakdown[0], summary))).toBe('15.6%');
    expect(formatContextPercent(contextRowPercent(summary.breakdown[1], summary))).toBe('52.8%');
    expect(formatContextPercent(contextRowPercent(summary.breakdown[2], summary))).toBe('30.1%');
    expect(formatContextPercent(contextRowPercent(summary.breakdown[4], summary))).not.toBe('100%');
  });

  test('ContextUsageButton renders empty usage as a track-only ring', () => {
    const html = renderToStaticMarkup(
      <ContextUsageButton
        summary={{
          windowTokens: 200000,
          windowSource: 'model_metadata',
          model: 'default',
          breakdown: [],
        }}
      />,
    );

    expect(html).toContain('Context usage 0%');
    expect(html).toContain('stroke="#e4e4e7"');
    expect(html).not.toContain('border border-zinc-200');
    expect(html).not.toContain('No context usage data yet');
    expect(html).not.toContain('>0</span>');
    expect(html).not.toContain('>–</span>');
  });

  test('ContextUsagePanel renders empty numeric facts as zero with a visible progress track', () => {
    const html = renderToStaticMarkup(
      <ContextUsagePanel
        summary={{
          windowTokens: 200000,
          windowSource: 'model_metadata',
          model: 'default',
          breakdown: [],
        }}
      />,
    );

    expect(html).toContain('0/200k');
    expect(html).toContain('(0%)');
    expect(html).toContain('Show more');
    expect(html).toContain('Cache Hit Rate');
    expect(html.match(/Hit Rate/g)?.length).toBe(1);
    expect(html.indexOf('Show more')).toBeLessThan(html.indexOf('Cache Hit Rate'));
    expect(html).toContain('bg-white');
    expect(html).toContain('bg-zinc-200/90');
    expect(html).not.toContain('This Turn');
    expect(html).not.toContain('Session');
    expect(html).not.toContain('Input');
    expect(html).not.toContain('Cache Write');
    expect(html).not.toContain('No data');
    expect(html).not.toContain('Unknown/200k');
    expect(html).not.toContain('Provider');
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
        error={undefined}
        skills={[]}
        models={TEST_MODELS}
        model="default"
        queuedPrompts={[]}
        toolMode="all"
        approvalMode="interactive"
        onSend={() => undefined}
        onAbort={() => undefined}
        onResume={() => undefined}
        onSteerQueuedPrompt={() => undefined}
        onDeleteQueuedPrompt={() => undefined}
        onLoadOlderHistory={() => undefined}
        onModelChange={() => undefined}
        onReasoningEffortChange={() => undefined}
        onToolModeChange={() => undefined}
        onApprovalModeChange={() => undefined}
      />,
    );

    expect(html).toContain('Sub-agent');
    expect(html).toContain('Review the project');
    expect(html).not.toContain('Tool call');
  });

  test('ChatView windows large restored histories on initial render', () => {
    const turns = Array.from({ length: 130 }, (_, index) => ({
      role: 'assistant' as const,
      content: `history-message-${index}`,
      timestamp: index + 1,
    }));
    const html = renderToStaticMarkup(
      <ChatView
        sessionId="sess_large"
        messages={{ turns, currentText: '', currentThinking: '' }}
        activity={[]}
        toolCalls={new Map()}
        agentSessions={new Map()}
        status="idle"
        error={undefined}
        skills={[]}
        models={TEST_MODELS}
        model="default"
        queuedPrompts={[]}
        toolMode="all"
        approvalMode="interactive"
        onSend={() => undefined}
        onAbort={() => undefined}
        onResume={() => undefined}
        onSteerQueuedPrompt={() => undefined}
        onDeleteQueuedPrompt={() => undefined}
        onLoadOlderHistory={() => undefined}
        onModelChange={() => undefined}
        onReasoningEffortChange={() => undefined}
        onToolModeChange={() => undefined}
        onApprovalModeChange={() => undefined}
      />,
    );

    expect(html).toContain('Load older 10 items');
    expect(html).not.toContain('history-message-0');
    expect(html).toContain('history-message-129');
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
      skills: [
        {
          name: 'review',
          description: 'Review code changes',
          dirPath: '/Users/dev/work/cortx/.cortx/skills/review',
        },
      ],
      models: TEST_MODELS,
      model: 'default',
      reasoningEffort: 'xhigh',
      status: 'idle' as const,
      toolMode: 'all' as const,
      approvalMode: 'interactive' as const,
      canChangeModes: true,
      onAbort: () => undefined,
      onResume: () => undefined,
      onSteerQueuedPrompt: () => undefined,
      onDeleteQueuedPrompt: () => undefined,
      onModelChange: () => undefined,
      onReasoningEffortChange: () => undefined,
      onToolModeChange: () => undefined,
      onApprovalModeChange: () => undefined,
    };
    const prompt = renderToStaticMarkup(<PromptInput {...props} />);
    const running = renderToStaticMarkup(
      <PromptInput
        {...props}
        status="running"
        canChangeModes
        queuedPrompts={[{ id: 'queued_1', text: 'Use this after the current turn', createdAt: 1 }]}
      />,
    );
    const disabled = renderToStaticMarkup(<PromptInput {...props} disabled canChangeModes={false} />);

    expect(prompt).toContain('Ask Cortx to inspect');
    expect(prompt).toContain('Tools');
    expect(prompt).toContain('Control');
    expect(prompt).toContain('Templates');
    expect(prompt).toContain('GPT-5.5');
    expect(prompt).toContain('Extra High');
    expect(prompt).not.toContain('New session');
    expect(prompt).not.toContain('Enter to send');
    expect(prompt).not.toContain('work/cortx');
    expect(running).toContain('Type a follow-up');
    expect(running).not.toContain('turn 3');
    expect(running).toContain('Runtime queued inputs');
    expect(running).toContain('Use this after the current turn');
    expect(running).toContain('Stop current turn');
    expect(disabled).toContain('Answer the pending request');
  });

  test('PromptInput treats mode controls as current-session settings', () => {
    const html = renderToStaticMarkup(
      <PromptInput
        onSend={() => undefined}
        skills={[]}
        models={TEST_MODELS}
        model="default"
        status="idle"
        toolMode="read-only"
        approvalMode="full-access"
        canChangeModes
        onAbort={() => undefined}
        onResume={() => undefined}
        onSteerQueuedPrompt={() => undefined}
        onDeleteQueuedPrompt={() => undefined}
        onModelChange={() => undefined}
        onReasoningEffortChange={() => undefined}
        onToolModeChange={() => undefined}
        onApprovalModeChange={() => undefined}
      />,
    );

    expect(html).toContain('Read only');
    expect(html).toContain('Full access');
    expect(html).not.toContain('Sending will start a new session');
  });

  test('PromptInput submit shortcut ignores in-progress IME composition', () => {
    expect(shouldSubmitPromptInput({ key: 'Enter' })).toBe(true);
    expect(shouldSubmitPromptInput({ key: 'Enter', shiftKey: true })).toBe(false);
    expect(shouldSubmitPromptInput({ key: 'Enter', nativeEvent: { isComposing: true } })).toBe(false);
    expect(shouldSubmitPromptInput({ key: 'Enter', nativeEvent: { keyCode: 229 } })).toBe(false);
  });

  test('buildPromptHistory merges restored session turns with local prompt history', () => {
    expect(
      buildPromptHistory(
        ['first request', 'duplicate request', 'second request'],
        ['duplicate request', 'local follow-up'],
      ),
    ).toEqual(['first request', 'second request', 'duplicate request', 'local follow-up']);
    expect(buildPromptHistory(Array.from({ length: 105 }, (_, index) => `prompt-${index}`))).toHaveLength(100);
    expect(buildPromptHistory(Array.from({ length: 105 }, (_, index) => `prompt-${index}`))[0]).toBe('prompt-5');
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

  test('MarkdownContent renders all markdown heading levels', () => {
    const html = renderToStaticMarkup(
      <MarkdownContent
        text={'# One\n## Two\n### Three\n#### Four\n##### Five\n###### Six\n\n#### Screenshot case'}
      />,
    );

    expect(html).toContain('<h1');
    expect(html).toContain('<h2');
    expect(html).toContain('<h3');
    expect(html).toContain('<h4');
    expect(html).toContain('<h5');
    expect(html).toContain('<h6');
    expect(html).toContain('Screenshot case');
    expect(html).not.toContain('#### Screenshot case');
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
