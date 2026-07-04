import { useState } from 'react';
import { surface } from '../design';

interface ConnectionOverlayProps {
  onConnect: (apiKey: string) => Promise<void> | void;
}

export function ConnectionOverlay({ onConnect }: ConnectionOverlayProps) {
  const [apiKey, setApiKey] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConnect() {
    const trimmed = apiKey.trim();
    if (!trimmed || connecting) return;

    setConnecting(true);
    setError(null);
    try {
      await onConnect(trimmed);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setConnecting(false);
    }
  }

  return (
    <div className={`${surface.page} grid min-h-screen place-items-center px-4`}>
      <div className="w-full max-w-5xl overflow-hidden rounded-2xl border border-white/8 bg-[#151515] shadow-2xl shadow-black/30">
        <div className="grid min-h-[560px] grid-cols-1 lg:grid-cols-[1fr_420px]">
          <section className="flex flex-col justify-between border-b border-white/8 p-8 lg:border-b-0 lg:border-r">
            <div>
              <div className="mb-8 flex items-center gap-3">
                <div className="grid h-9 w-9 place-items-center rounded-md border border-white/10 bg-white/6 text-sm font-semibold text-zinc-100">
                  Cx
                </div>
                <div>
                  <div className="text-sm font-semibold text-zinc-100">Cortx Web</div>
                  <div className="text-xs text-zinc-500">Remote agent workspace</div>
                </div>
              </div>
              <div className="max-w-2xl">
                <p className="mb-3 text-xs uppercase tracking-[0.22em] text-zinc-600">Agent control plane</p>
                <h1 className="text-3xl font-semibold tracking-tight text-zinc-50">
                  Operate workspace agents from a focused desktop surface.
                </h1>
                <p className="mt-4 text-sm leading-6 text-zinc-500">
                  Connect to a Cortx server to stream assistant output, inspect tools, answer approvals and keep session context visible while the run is active.
                </p>
              </div>
            </div>
            <div className="mt-10 grid gap-3 text-xs text-zinc-500 sm:grid-cols-3">
              <div className="rounded-lg border border-white/7 bg-black/15 p-3">
                <div className="mb-1 text-zinc-300">Runtime</div>
                Server-backed sessions
              </div>
              <div className="rounded-lg border border-white/7 bg-black/15 p-3">
                <div className="mb-1 text-zinc-300">Stream</div>
                SSE events and replay
              </div>
              <div className="rounded-lg border border-white/7 bg-black/15 p-3">
                <div className="mb-1 text-zinc-300">Inspect</div>
                Tools and sub-agents
              </div>
            </div>
          </section>

          <section className="flex flex-col justify-center p-8">
            <div className="mb-6">
              <h2 className="text-lg font-semibold text-zinc-100">Connect</h2>
              <p className="mt-1 text-sm text-zinc-500">Use the API key configured on your Cortx server.</p>
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void handleConnect();
              }}
            >
              <label className="mb-2 block text-xs font-medium uppercase tracking-[0.18em] text-zinc-600">
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
                className={`mb-4 h-11 w-full rounded-lg border border-white/8 bg-black/20 px-3 text-sm text-zinc-100 outline-none placeholder:text-zinc-700 disabled:opacity-50 ${surface.focus}`}
              />
              {error && (
                <div className="mb-4 rounded-lg border border-rose-400/20 bg-rose-950/20 px-3 py-2 text-xs leading-5 text-rose-100/80">
                  {error}
                </div>
              )}
              <button
                type="submit"
                disabled={!apiKey.trim() || connecting}
                className={`h-11 w-full rounded-lg border border-cyan-300/20 bg-cyan-300/12 px-4 text-sm font-medium text-cyan-100 transition-colors hover:bg-cyan-300/18 disabled:cursor-not-allowed disabled:border-white/8 disabled:bg-white/5 disabled:text-zinc-700 ${surface.focus}`}
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
