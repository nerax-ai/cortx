import { Component, useState, type ReactNode } from 'react';
import { Tabs } from '@base-ui-components/react/tabs';
import type { ActivityEntry, TokenUsage } from '@cortx/store';
import { activityToInspectorMaps, latestIterationActivity } from '../activity';
import type { ContextUsageSummary } from '../context-usage';
import { summarizeInspector, surface } from '../design';
import type { WorkbenchContribution } from '../workbench/contribution-registry';
import { ContextUsagePanel } from './ContextUsageButton';
import { ToolRegion } from './ToolRegion';

const INSPECTOR_ACTIVITY_WINDOW = 80;
export type WorkspacePanelTab = string;

interface InspectorPanelProps {
  activity: ActivityEntry[];
  contextUsage?: ContextUsageSummary;
  tokenUsage?: TokenUsage;
  contributions?: WorkbenchContribution[];
  activeTab: WorkspacePanelTab;
  onTabChange: (tab: WorkspacePanelTab) => void;
  onClose: () => void;
}

const DEFAULT_CONTRIBUTIONS: WorkbenchContribution[] = [
  { id: 'activity', area: 'side-pane', label: 'Activity', order: 10, content: { kind: 'activity' } },
  { id: 'context', area: 'side-pane', label: 'Context', order: 20, content: { kind: 'context' } },
];

class ContributionBoundary extends Component<{ name: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <div role="status" className="m-3 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
          {this.props.name} failed to render. Other workbench contributions remain available.
        </div>
      );
    }
    return this.props.children;
  }
}

function InspectorTab({ active, contribution }: { active: boolean; contribution: WorkbenchContribution }) {
  return (
    <Tabs.Tab
      value={contribution.id}
      className={`min-h-9 flex-1 rounded-md px-3 py-1.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900/20 ${
        active ? 'bg-white text-zinc-950 shadow-sm' : 'text-zinc-500 hover:bg-white/60 hover:text-zinc-800'
      }`}
    >
      {contribution.label}
    </Tabs.Tab>
  );
}

function StatTile({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-3">
      <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-400">{label}</div>
      <div className="mt-1 truncate text-sm font-medium text-zinc-900">{value}</div>
    </div>
  );
}

function ActivityPanel({ activity }: { activity: ActivityEntry[] }) {
  const [tab, setTab] = useState('tools');
  const { toolCalls, agentSessions } = activityToInspectorMaps(activity);
  const latest = activityToInspectorMaps(latestIterationActivity(activity));
  const summary = summarizeInspector(latest.toolCalls, latest.agentSessions);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-zinc-200 p-3">
        <div className="grid grid-cols-2 gap-2">
          <StatTile label="Turn Tools" value={summary.totalTools} />
          <StatTile label="Turn Agents" value={summary.totalAgents} />
        </div>
      </div>
      <Tabs.Root value={tab} onValueChange={(value) => setTab(String(value))} className="flex min-h-0 flex-1 flex-col">
        <Tabs.List className="m-3 flex rounded-lg border border-zinc-200 bg-zinc-100 p-1">
          {['tools', 'agents'].map((value) => (
            <Tabs.Tab
              key={value}
              value={value}
              className={`min-h-9 flex-1 rounded-md px-3 py-1.5 text-xs capitalize ${
                tab === value ? 'bg-white text-zinc-950 shadow-sm' : 'text-zinc-500'
              } ${surface.focus}`}
            >
              {value}
            </Tabs.Tab>
          ))}
        </Tabs.List>
        <Tabs.Panel value="tools" className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
          <ToolRegion toolCalls={toolCalls} agentSessions={new Map()} maxItems={INSPECTOR_ACTIVITY_WINDOW} />
        </Tabs.Panel>
        <Tabs.Panel value="agents" className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
          <ToolRegion toolCalls={new Map()} agentSessions={agentSessions} maxItems={INSPECTOR_ACTIVITY_WINDOW} />
        </Tabs.Panel>
      </Tabs.Root>
    </div>
  );
}

export function InspectorPanel({
  activity,
  contextUsage,
  tokenUsage,
  contributions = DEFAULT_CONTRIBUTIONS,
  activeTab,
  onTabChange,
  onClose,
}: InspectorPanelProps) {
  const active = contributions.find((contribution) => contribution.id === activeTab) ?? contributions[0];

  return (
    <aside className="flex h-full min-h-0 flex-col bg-[#f3f3f1]">
      <div className="border-b border-zinc-200 p-3">
        <div className="mb-3 flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-zinc-950">{active?.label ?? 'Details'}</div>
            <div className="text-xs text-zinc-500">Runtime-owned workspace facts</div>
          </div>
          <button
            type="button"
            aria-label="Close panel"
            onClick={onClose}
            className={`grid h-10 w-10 place-items-center rounded-lg text-zinc-500 hover:bg-white hover:text-zinc-900 ${surface.focus}`}
          >
            ×
          </button>
        </div>
        <Tabs.Root value={active?.id} onValueChange={(value) => onTabChange(String(value))}>
          <Tabs.List aria-label="Workspace detail views" className="flex rounded-lg border border-zinc-200 bg-zinc-100 p-1">
            {contributions.map((contribution) => (
              <InspectorTab key={contribution.id} contribution={contribution} active={active?.id === contribution.id} />
            ))}
          </Tabs.List>
        </Tabs.Root>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {active && (
          <ContributionBoundary key={active.id} name={active.label}>
            {active.content.kind === 'activity' ? (
              <ActivityPanel activity={activity} />
            ) : (
              <ContextUsagePanel summary={contextUsage ?? { breakdown: [] }} sessionTokenUsage={tokenUsage} embedded />
            )}
          </ContributionBoundary>
        )}
      </div>
    </aside>
  );
}
