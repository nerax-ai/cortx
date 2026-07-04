import { useState, type ReactNode } from 'react';
import { Tabs } from '@base-ui-components/react/tabs';
import type { AgentSessionSummary, AgentStatus, TokenUsage, ToolCallEntry } from '@cortx/store';
import type { WebRuntimeSessionInfo } from '../bridge/event-bridge';
import {
  compactPath,
  compactSessionId,
  formatElapsed,
  formatTokenUsage,
  statusTone,
  summarizeInspector,
  surface,
} from '../design';
import { ToolRegion } from './ToolRegion';

interface InspectorPanelProps {
  session: WebRuntimeSessionInfo | null;
  status: AgentStatus;
  tokenUsage: TokenUsage;
  elapsed: number;
  toolCalls: Map<string, ToolCallEntry>;
  agentSessions: Map<string, AgentSessionSummary>;
}

const EMPTY_TOOL_CALLS = new Map<string, ToolCallEntry>();
const EMPTY_AGENT_SESSIONS = new Map<string, AgentSessionSummary>();

function StatTile({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-white/7 bg-black/15 p-3">
      <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-600">{label}</div>
      <div className="mt-1 truncate text-sm font-medium text-zinc-200">{value}</div>
    </div>
  );
}

function InspectorTab({
  active,
  value,
  children,
}: {
  active: boolean;
  value: string;
  children: ReactNode;
}) {
  return (
    <Tabs.Tab
      value={value}
      className={`flex-1 rounded-md px-3 py-1.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/35 ${
        active ? 'bg-white/8 text-zinc-100' : 'text-zinc-500 hover:bg-white/5 hover:text-zinc-300'
      }`}
    >
      {children}
    </Tabs.Tab>
  );
}

export function InspectorPanel({
  session,
  status,
  tokenUsage,
  elapsed,
  toolCalls,
  agentSessions,
}: InspectorPanelProps) {
  const [tab, setTab] = useState('tools');
  const tone = statusTone(status);
  const summary = summarizeInspector(toolCalls, agentSessions);

  return (
    <aside className="flex h-full min-h-0 flex-col bg-[#151515]">
      <div className="border-b border-white/8 p-4">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-zinc-100">Inspector</div>
            <div className="text-xs text-zinc-600">Runtime facts and tool activity</div>
          </div>
          <span className={`rounded-full border px-2 py-0.5 text-[10px] ${tone.badgeClass}`}>{tone.label}</span>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <StatTile label="Tools" value={summary.totalTools} />
          <StatTile label="Agents" value={summary.totalAgents} />
          <StatTile label="Tokens" value={formatTokenUsage(tokenUsage)} />
          <StatTile label="Elapsed" value={formatElapsed(elapsed)} />
        </div>
      </div>

      <div className="border-b border-white/8 p-4">
        <div className="space-y-2 text-xs">
          <div className="flex justify-between gap-3">
            <span className="text-zinc-600">Workspace</span>
            <span className="truncate text-zinc-300">{session ? compactPath(session.workingDirectory) : '-'}</span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-zinc-600">Session</span>
            <span className="truncate font-mono text-zinc-400">{compactSessionId(session?.id, 16)}</span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-zinc-600">Events</span>
            <span className="text-zinc-300">{session?.eventCount ?? 0}</span>
          </div>
        </div>
      </div>

      <Tabs.Root value={tab} onValueChange={(value) => setTab(String(value))} className="flex min-h-0 flex-1 flex-col">
        <Tabs.List className="m-3 flex rounded-lg border border-white/7 bg-black/20 p-1">
          <InspectorTab value="tools" active={tab === 'tools'}>
            Tools
          </InspectorTab>
          <InspectorTab value="agents" active={tab === 'agents'}>
            Agents
          </InspectorTab>
        </Tabs.List>
        <Tabs.Panel value="tools" className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
          <ToolRegion toolCalls={toolCalls} agentSessions={EMPTY_AGENT_SESSIONS} />
        </Tabs.Panel>
        <Tabs.Panel value="agents" className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
          <ToolRegion toolCalls={EMPTY_TOOL_CALLS} agentSessions={agentSessions} />
        </Tabs.Panel>
      </Tabs.Root>

      {summary.totalTools === 0 && summary.totalAgents === 0 && (
        <div className={`mx-3 mb-3 rounded-lg p-3 text-xs leading-relaxed ${surface.panel} text-zinc-600`}>
          Tool calls and sub-agent runs will appear here as the session works.
        </div>
      )}
    </aside>
  );
}
