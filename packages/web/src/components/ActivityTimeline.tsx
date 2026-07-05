import type { ActivityEntry } from '@cortx/store';
import { ToolCard } from './ToolCard';
import { SubAgentCard } from './ToolRegion';

interface ActivityCardProps {
  entry: ActivityEntry;
}

export function ActivityCard({ entry }: ActivityCardProps) {
  return (
    <div className="grid justify-items-start">
      <div className="mb-1 ml-4 text-[10px] uppercase tracking-[0.16em] text-zinc-400">
        {entry.kind === 'tool' ? 'Tool call' : 'Sub-agent'}
      </div>
      <div className="w-full max-w-[min(820px,100%)] pl-4">
        {entry.kind === 'tool' ? <ToolCard entry={entry.entry} /> : <SubAgentCard session={entry.session} />}
      </div>
    </div>
  );
}
