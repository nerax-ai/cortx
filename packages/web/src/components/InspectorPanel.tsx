import { useState, type ReactNode } from 'react';
import { Tabs } from '@base-ui-components/react/tabs';
import type { ActivityEntry } from '@cortx/store';
import { activityToInspectorMaps, latestIterationActivity } from '../activity';
import { summarizeInspector, surface } from '../design';
import { ToolRegion } from './ToolRegion';

const INSPECTOR_ACTIVITY_WINDOW = 80;
export type WorkspacePanelTab = 'activity' | 'review' | 'browser';

interface InspectorPanelProps {
  activity: ActivityEntry[];
  activeTab: WorkspacePanelTab;
  onTabChange: (tab: WorkspacePanelTab) => void;
  onClose: () => void;
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

const PANEL_LABELS: Record<WorkspacePanelTab, string> = {
  activity: 'Activity',
  review: 'Review',
  browser: 'Browser',
};

function EmptyPanel({ title }: { title: string }) {
  return (
    <div className="grid min-h-full place-items-center p-4">
      <div className={`w-full rounded-xl p-4 text-center text-sm ${surface.panel}`}>
        <div className="font-medium text-zinc-900">{title}</div>
        <div className="mt-1 text-xs text-zinc-500">Nothing open</div>
      </div>
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
          No activity
        </div>
      )}
    </div>
  );
}

export function InspectorPanel({
  activity,
  activeTab,
  onTabChange,
  onClose,
}: InspectorPanelProps) {
  return (
    <aside className="flex h-full min-h-0 flex-col bg-[#f3f3f1]">
      <div className="border-b border-zinc-200 p-3">
        <div className="mb-3 flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-zinc-950">{PANEL_LABELS[activeTab]}</div>
            <div className="text-xs text-zinc-500">Workspace panel</div>
          </div>
          <button
            type="button"
            aria-label="Close panel"
            onClick={onClose}
            className={`grid h-7 w-7 place-items-center rounded-md text-zinc-400 hover:bg-white hover:text-zinc-900 ${surface.focus}`}
          >
            ×
          </button>
        </div>

        <Tabs.Root
          value={activeTab}
          onValueChange={(value) => onTabChange(String(value) as WorkspacePanelTab)}
          className="flex min-h-0 flex-col"
        >
          <Tabs.List className="flex rounded-lg border border-zinc-200 bg-zinc-100 p-1">
            <InspectorTab value="activity" active={activeTab === 'activity'}>
              Activity
            </InspectorTab>
            <InspectorTab value="review" active={activeTab === 'review'}>
              Review
            </InspectorTab>
            <InspectorTab value="browser" active={activeTab === 'browser'}>
              Browser
            </InspectorTab>
          </Tabs.List>
        </Tabs.Root>
      </div>

      {activeTab === 'activity' && <ActivityPanel activity={activity} />}
      {activeTab === 'review' && <EmptyPanel title="Review" />}
      {activeTab === 'browser' && <EmptyPanel title="Browser" />}
    </aside>
  );
}
