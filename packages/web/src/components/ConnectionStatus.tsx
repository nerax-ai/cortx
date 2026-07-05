import { surface } from '../design';

interface ConnectionStatusProps {
  error: string | null;
  onRetry: () => void | Promise<void>;
}

export function ConnectionStatus({ error, onRetry }: ConnectionStatusProps) {
  return (
    <div className={`${surface.page} grid min-h-screen place-items-center px-4`}>
      <div className="w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-5 shadow-xl shadow-zinc-200/70">
        <div className="mb-4 flex items-center gap-3">
          <div className="grid h-9 w-9 place-items-center rounded-md border border-zinc-300 bg-white text-sm font-semibold text-zinc-900">
            Cx
          </div>
          <div>
            <div className="text-sm font-semibold text-zinc-950">Cortx</div>
            <div className="text-xs text-zinc-500">{error ? 'Connection failed' : 'Connecting to runtime'}</div>
          </div>
        </div>
        {error ? (
          <>
            <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs leading-5 text-rose-700">
              {error}
            </div>
            <button
              type="button"
              onClick={() => void onRetry()}
              className={`mt-4 h-10 w-full rounded-lg border border-zinc-900 bg-zinc-950 px-4 text-sm font-medium text-white transition-colors hover:bg-zinc-800 ${surface.focus}`}
            >
              Retry
            </button>
          </>
        ) : (
          <div className="text-sm leading-6 text-zinc-600">
            Opening the server-backed agent workspace.
          </div>
        )}
      </div>
    </div>
  );
}
