import { useState, type ReactNode } from 'react';
import { Tabs } from '@base-ui-components/react/tabs';
import type { ActivityEntry, AgentStatus, TokenUsage } from '@cortx/store';
import type { WebRuntimeSessionInfo } from '../bridge/event-bridge';
import { activityToInspectorMaps, latestIterationActivity } from '../activity';
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

const INSPECTOR_ACTIVITY_WINDOW = 80;

interface InspectorPanelProps {
  session: WebRuntimeSessionInfo | null;
  status: AgentStatus;
  tokenUsage: TokenUsage;
  elapsed: number;
  activity: ActivityEntry[];
}

function StatTile({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-3">
      <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-400">{label}</div>
      <div className="mt-1 truncate text-sm font-medium text-zinc-900">{value}</div>
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
      className={`flex-1 rounded-md px-3 py-1.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900/20 ${
        active ? 'bg-white text-zinc-950 shadow-sm' : 'text-zinc-500 hover:bg-white/60 hover:text-zinc-800'
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
  activity,
}: InspectorPanelProps) {
  const [tab, setTab] = useState('tools');
  const tone = statusTone(status);
  const { toolCalls, agentSessions } = activityToInspectorMaps(activity);
  const latest = activityToInspectorMaps(latestIterationActivity(activity));
  const summary = summarizeInspector(latest.toolCalls, latest.agentSessions);

  return (
    <aside className="flex h-full min-h-0 flex-col bg-[#f3f3f1]">
      <div className="border-b border-zinc-200 p-4">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-zinc-950">Inspector</div>
            <div className="text-xs text-zinc-500">Runtime facts and tool activity</div>
          </div>
          <span className={`rounded-full border px-2 py-0.5 text-[10px] ${tone.badgeClass}`}>{tone.label}</span>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <StatTile label="Turn Tools" value={summary.totalTools} />
          <StatTile label="Turn Agents" value={summary.totalAgents} />
          <StatTile label="Session Tokens" value={formatTokenUsage(tokenUsage)} />
          <StatTile label="Elapsed" value={formatElapsed(elapsed)} />
        </div>
      </div>

      <div className="border-b border-zinc-200 p-4">
        <div className="space-y-2 text-xs">
          <div className="flex justify-between gap-3">
            <span className="text-zinc-500">Workspace</span>
            <span className="truncate text-zinc-800">{session ? compactPath(session.workingDirectory) : '-'}</span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-zinc-500">Session</span>
            <span className="truncate font-mono text-zinc-600">{compactSessionId(session?.id, 16)}</span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-zinc-500">Events</span>
            <span className="text-zinc-800">{session?.eventCount ?? 0}</span>
          </div>
        </div>
      </div>

      <Tabs.Root value={tab} onValueChange={(value) => setTab(String(value))} className="flex min-h-0 flex-1 flex-col">
        <Tabs.List className="m-3 flex rounded-lg border border-zinc-200 bg-zinc-100 p-1">
          <InspectorTab value="tools" active={tab === 'tools'}>
            Tools
          </InspectorTab>
          <InspectorTab value="agents" active={tab === 'agents'}>
            Agents
          </InspectorTab>
        </Tabs.List>
        <Tabs.Panel value="tools" className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
          <ToolRegion toolCalls={toolCalls} agentSessions={new Map()} maxItems={INSPECTOR_ACTIVITY_WINDOW} />
        </Tabs.Panel>
        <Tabs.Panel value="agents" className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
          <ToolRegion toolCalls={new Map()} agentSessions={agentSessions} maxItems={INSPECTOR_ACTIVITY_WINDOW} />
        </Tabs.Panel>
      </Tabs.Root>

      {summary.totalTools === 0 && summary.totalAgents === 0 && (
        <div className={`mx-3 mb-3 rounded-lg p-3 text-xs leading-relaxed ${surface.panel} text-zinc-500`}>
          Tool calls and sub-agent runs will appear here as the session works.
        </div>
      )}
    </aside>
  );
}
