import { useState } from 'react';
import type { WebApprovalMode, WebWorkspaceToolMode } from '../bridge/event-bridge';
import { surface } from '../design';

interface ConnectionOverlayProps {
  onConnect: (request: {
    apiKey: string;
    workingDirectory?: string;
    toolMode?: WebWorkspaceToolMode;
    approvalMode?: WebApprovalMode;
  }) => Promise<void> | void;
}

export function ConnectionOverlay({ onConnect }: ConnectionOverlayProps) {
  const [apiKey, setApiKey] = useState('');
  const [workingDirectory, setWorkingDirectory] = useState('');
  const [toolMode, setToolMode] = useState<WebWorkspaceToolMode>('all');
  const [approvalMode, setApprovalMode] = useState<WebApprovalMode>('interactive');
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConnect() {
    const trimmed = apiKey.trim();
    if (!trimmed || connecting) return;

    setConnecting(true);
    setError(null);
    try {
      await onConnect({
        apiKey: trimmed,
        workingDirectory: workingDirectory.trim() || undefined,
        toolMode,
        approvalMode,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setConnecting(false);
    }
  }

  return (
    <div className={`${surface.page} grid min-h-screen place-items-center px-4`}>
      <div className="w-full max-w-5xl overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-xl shadow-zinc-200/70">
        <div className="grid min-h-[590px] grid-cols-1 lg:grid-cols-[1fr_430px]">
          <section className="flex flex-col justify-between border-b border-zinc-200 bg-zinc-50 p-8 lg:border-b-0 lg:border-r">
            <div>
              <div className="mb-8 flex items-center gap-3">
                <div className="grid h-9 w-9 place-items-center rounded-md border border-zinc-300 bg-white text-sm font-semibold text-zinc-900">
                  Cx
                </div>
                <div>
                  <div className="text-sm font-semibold text-zinc-950">Cortx Web</div>
                  <div className="text-xs text-zinc-500">Remote agent workspace</div>
                </div>
              </div>
              <div className="max-w-2xl">
                <p className="mb-3 text-xs uppercase tracking-[0.22em] text-zinc-500">Agent control plane</p>
                <h1 className="text-3xl font-semibold tracking-tight text-zinc-950">
                  Control workspace agents with a Codex-style desktop layout.
                </h1>
                <p className="mt-4 text-sm leading-6 text-zinc-600">
                  Pick a workspace directory, choose how much control the agent has, then inspect conversations, tools and sub-agents from one surface.
                </p>
              </div>
            </div>
            <div className="mt-10 grid gap-3 text-xs text-zinc-600 sm:grid-cols-3">
              <div className="rounded-lg border border-zinc-200 bg-white p-3">
                <div className="mb-1 text-zinc-900">Runtime</div>
                Server-backed sessions
              </div>
              <div className="rounded-lg border border-zinc-200 bg-white p-3">
                <div className="mb-1 text-zinc-900">Stream</div>
                SSE events and replay
              </div>
              <div className="rounded-lg border border-zinc-200 bg-white p-3">
                <div className="mb-1 text-zinc-900">Control</div>
                Tools and sub-agents
              </div>
            </div>
          </section>

          <section className="flex flex-col justify-center p-8">
            <div className="mb-6">
              <h2 className="text-lg font-semibold text-zinc-950">Connect</h2>
              <p className="mt-1 text-sm text-zinc-500">Use the API key configured on your Cortx server.</p>
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void handleConnect();
              }}
            >
              <label className="mb-2 block text-xs font-medium uppercase tracking-[0.18em] text-zinc-500">
                API Key
              </label>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value);
                  if (error) setError(null);
                }}
                placeholder="cortx-dev-key"
                disabled={connecting}
                className={`mb-4 h-11 w-full rounded-lg border border-zinc-200 bg-white px-3 text-sm text-zinc-950 outline-none placeholder:text-zinc-400 disabled:opacity-50 ${surface.focus}`}
              />
              <label className="mb-2 block text-xs font-medium uppercase tracking-[0.18em] text-zinc-500">
                Workspace Directory
              </label>
              <input
                value={workingDirectory}
                onChange={(e) => setWorkingDirectory(e.target.value)}
                placeholder="Use server default workspace"
                disabled={connecting}
                className={`mb-4 h-11 w-full rounded-lg border border-zinc-200 bg-white px-3 font-mono text-xs text-zinc-950 outline-none placeholder:text-zinc-400 disabled:opacity-50 ${surface.focus}`}
              />
              <div className="mb-4 grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="mb-2 block text-xs font-medium uppercase tracking-[0.18em] text-zinc-500">Tools</span>
                  <select
                    value={toolMode}
                    onChange={(e) => setToolMode(e.target.value as WebWorkspaceToolMode)}
                    className={`h-10 w-full rounded-lg border border-zinc-200 bg-white px-3 text-sm text-zinc-900 ${surface.focus}`}
                  >
                    <option value="all">All tools</option>
                    <option value="coding">Coding</option>
                    <option value="read-only">Read only</option>
                    <option value="none">None</option>
                  </select>
                </label>
                <label className="block">
                  <span className="mb-2 block text-xs font-medium uppercase tracking-[0.18em] text-zinc-500">Control</span>
                  <select
                    value={approvalMode}
                    onChange={(e) => setApprovalMode(e.target.value as WebApprovalMode)}
                    className={`h-10 w-full rounded-lg border border-zinc-200 bg-white px-3 text-sm text-zinc-900 ${surface.focus}`}
                  >
                    <option value="interactive">Ask first</option>
                    <option value="full-access">Full access</option>
                    <option value="deny">Read-only safety</option>
                  </select>
                </label>
              </div>
              {error && (
                <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs leading-5 text-rose-700">
                  {error}
                </div>
              )}
              <button
                type="submit"
                disabled={!apiKey.trim() || connecting}
                className={`h-11 w-full rounded-lg border border-zinc-900 bg-zinc-950 px-4 text-sm font-medium text-white transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:border-zinc-200 disabled:bg-zinc-100 disabled:text-zinc-400 ${surface.focus}`}
              >
                {connecting ? 'Connecting...' : 'Connect to workspace'}
              </button>
            </form>
            <p className="mt-4 text-xs leading-5 text-zinc-600">
              The Web app stays remote-only. Agent execution, workspace tools and approvals are hosted by the server runtime.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
