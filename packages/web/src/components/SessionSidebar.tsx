import { useEffect, useState } from 'react';
import type { AgentStatus, TokenUsage } from '@cortx/store';
import type { WebApprovalMode, WebRuntimeSessionInfo, WebWorkspaceToolMode } from '../bridge/event-bridge';
import { compactPath, compactSessionId, formatElapsed, formatTokenUsage, statusTone, surface } from '../design';

interface SessionSidebarProps {
  status: AgentStatus;
  session: WebRuntimeSessionInfo | null;
  sessions: WebRuntimeSessionInfo[];
  tokenUsage: TokenUsage;
  elapsed: number;
  onCreateSession: (request: {
    workingDirectory: string;
    toolMode: WebWorkspaceToolMode;
    approvalMode: WebApprovalMode;
  }) => void | Promise<void>;
  onSwitchSession: (sessionId: string) => void | Promise<void>;
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <span className="text-zinc-500">{label}</span>
      <span className="min-w-0 truncate text-right text-zinc-800">{value}</span>
    </div>
  );
}

export function SessionSidebar({
  status,
  session,
  sessions,
  tokenUsage,
  elapsed,
  onCreateSession,
  onSwitchSession,
}: SessionSidebarProps) {
  const tone = statusTone(status);
  const [workingDirectory, setWorkingDirectory] = useState(session?.workingDirectory ?? '');
  const [toolMode, setToolMode] = useState<WebWorkspaceToolMode>(session?.toolMode ?? 'all');
  const [approvalMode, setApprovalMode] = useState<WebApprovalMode>(session?.approvalMode ?? 'interactive');

  useEffect(() => {
    setWorkingDirectory(session?.workingDirectory ?? '');
    setToolMode(session?.toolMode ?? 'all');
    setApprovalMode(session?.approvalMode ?? 'interactive');
  }, [session?.approvalMode, session?.toolMode, session?.workingDirectory]);

  return (
    <aside className="flex h-full min-h-0 flex-col border-r border-zinc-200 bg-[#f3f3f1]">
      <div className="border-b border-zinc-200 p-3">
        <div className="mb-3 flex items-center gap-2">
          <div className="grid h-8 w-8 place-items-center rounded-md border border-zinc-300 bg-white text-sm font-semibold text-zinc-950">
            Cx
          </div>
          <div>
            <div className="text-sm font-semibold text-zinc-950">Cortx</div>
            <div className="text-xs text-zinc-500">Agent workspace</div>
          </div>
        </div>

        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void onCreateSession({ workingDirectory, toolMode, approvalMode });
          }}
        >
          <input
            value={workingDirectory}
            onChange={(e) => setWorkingDirectory(e.target.value)}
            placeholder="Use server default workspace"
            className={`h-9 w-full rounded-md border border-zinc-200 bg-white px-2 font-mono text-[11px] text-zinc-900 ${surface.focus}`}
          />
          <div className="grid grid-cols-2 gap-2">
            <select
              value={toolMode}
              onChange={(e) => setToolMode(e.target.value as WebWorkspaceToolMode)}
              className={`h-8 rounded-md border border-zinc-200 bg-white px-2 text-xs text-zinc-800 ${surface.focus}`}
            >
              <option value="all">All tools</option>
              <option value="coding">Coding</option>
              <option value="read-only">Read only</option>
              <option value="none">No tools</option>
            </select>
            <select
              value={approvalMode}
              onChange={(e) => setApprovalMode(e.target.value as WebApprovalMode)}
              className={`h-8 rounded-md border border-zinc-200 bg-white px-2 text-xs text-zinc-800 ${surface.focus}`}
            >
              <option value="interactive">Ask first</option>
              <option value="full-access">Full access</option>
              <option value="deny">Deny writes</option>
            </select>
          </div>
          <button
            type="submit"
            className={`h-8 w-full rounded-md bg-zinc-950 px-3 text-xs font-medium text-white hover:bg-zinc-800 ${surface.focus}`}
          >
            New workspace session
          </button>
        </form>
      </div>

      <div className="border-b border-zinc-200 p-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-zinc-900">Active Session</span>
          <span className={`rounded-full border px-2 py-0.5 text-[10px] ${tone.badgeClass}`}>{tone.label}</span>
        </div>
        <div className="space-y-2">
          <DetailRow label="Model" value={session?.model ?? 'not connected'} />
          <DetailRow label="Workspace" value={session ? compactPath(session.workingDirectory) : '-'} />
          <DetailRow label="Session" value={compactSessionId(session?.id, 13)} />
          <DetailRow label="Tools" value={session?.toolMode ?? '-'} />
          <DetailRow label="Control" value={session?.approvalMode ?? '-'} />
          <DetailRow label="Tokens" value={formatTokenUsage(tokenUsage)} />
          <DetailRow label="Elapsed" value={formatElapsed(elapsed)} />
        </div>
      </div>

      <section className="min-h-0 flex-1 overflow-y-auto p-2">
        <div className="mb-2 px-1 text-xs font-medium text-zinc-500">Sessions</div>
        <div className="space-y-1">
          {sessions.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => void onSwitchSession(item.id)}
              className={`w-full rounded-md px-2 py-2 text-left text-xs transition-colors ${item.id === session?.id ? 'bg-white text-zinc-950 shadow-sm' : 'text-zinc-600 hover:bg-white/70 hover:text-zinc-950'} ${surface.focus}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-medium">{compactPath(item.workingDirectory)}</span>
                <span className="shrink-0 text-[10px] text-zinc-400">{item.isRunning ? 'running' : 'ready'}</span>
              </div>
              <div className="mt-1 truncate font-mono text-[10px] text-zinc-400">{compactSessionId(item.id, 16)}</div>
            </button>
          ))}
        </div>
      </section>
    </aside>
  );
}
