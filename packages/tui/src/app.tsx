import { useEffect, useCallback, useMemo, useState, useRef } from 'react';
import { useApp } from 'ink';
import type { CortxSession } from '@cortx/core';
import { AppShell } from './components/app-shell.js';
import { TuiStore } from './store.js';
import { TuiRegistry } from './tui-registry.js';
import { commandPlugin } from './plugins/command-plugin.js';
import { sessionPlugin, createAutoSaveHandler, type SessionSummary } from './plugins/session-plugin.js';
import { createDefaultSessionStore } from './session-store.js';
import { discoverSkillItems, type SkillItem } from './plugins/skill-plugin.js';
import type { TurnEntry } from './types/tui-state.js';
import { processEvent } from './renderer.js';
import { parseAgentMessages, turnsToMessages } from './message-io.js';
import type { Logger } from '@nerax-ai/logger';

export interface AppProps {
  session: CortxSession;
  model: string;
  cwd: string;
  logger?: Logger;
}

export type RegistryStatus = 'loading' | 'ready' | 'failed';

interface SubmitInputDeps {
  registryStatus: RegistryStatus;
  registryError: string | null;
  registry: Pick<TuiRegistry, 'executeCommand'>;
  session: Pick<CortxSession, 'controller' | 'prompt'>;
  store: Pick<TuiStore, 'addUserMessage' | 'dispatch'>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function registryUnavailableMessage(status: RegistryStatus, error: string | null): string {
  return status === 'failed'
    ? `TUI commands are unavailable: ${error ?? 'plugin registration failed'}`
    : 'TUI commands are still loading.';
}

export async function submitInput(value: string, deps: SubmitInputDeps): Promise<void> {
  if (value.startsWith('/')) {
    if (deps.registryStatus !== 'ready') {
      deps.store.dispatch({
        type: 'error',
        error: new Error(registryUnavailableMessage(deps.registryStatus, deps.registryError)),
      });
      return;
    }

    const parts = value.split(/\s+/);
    const cmdName = parts[0];
    const cmdArgs = parts.slice(1).join(' ');
    const found = await deps.registry.executeCommand(cmdName, cmdArgs, {
      args: cmdArgs,
      abort: () => deps.session.controller?.abort('user interrupt'),
    });
    if (found) return;
  }

  deps.store.addUserMessage(value);
  Promise.resolve(deps.session.prompt(value)).catch(() => {});
}

export default function App({ session, model, cwd, logger }: AppProps) {
  const { exit } = useApp();

  const store = useMemo(() => new TuiStore(), []);
  const sessionStore = useMemo(() => createDefaultSessionStore(), []);

  const [sessionPickerOpen, setSessionPickerOpen] = useState(false);
  const sessionListRef = useRef<SessionSummary[]>([]);

  // --- Discover skills for palette display ---
  const [skills, setSkills] = useState<SkillItem[]>([]);
  useEffect(() => {
    let cancelled = false;
    discoverSkillItems(cwd).then((items) => {
      if (!cancelled) setSkills(items);
    });
    return () => { cancelled = true; };
  }, [cwd]);

  // --- Session restore handler ---
  const handleRestoreSession = useCallback(
    async (summary: SessionSummary) => {
      setSessionPickerOpen(false);
      try {
        const meta = await sessionStore.read(summary.sessionId);
        if (meta && meta.messages) {
          store.reset(meta.sessionId);
          store.loadTurns(meta.messages as TurnEntry[]);
          const agentMessages = meta.agentMessages
            ? parseAgentMessages(meta.agentMessages)
            : turnsToMessages(meta.messages as TurnEntry[]);
          session.cortx.replaceMessages(agentMessages);
          if (meta.status === 'crashed') {
            session.resume().catch(() => {});
          }
        }
      } catch {
        // Graceful error
      }
    },
    [store, session, sessionStore],
  );

  const handleOpenSessionPicker = useCallback(async () => {
    try {
      sessionListRef.current = await sessionStore.list();
      setSessionPickerOpen(true);
    } catch {
      sessionListRef.current = [];
      setSessionPickerOpen(true);
    }
  }, [sessionStore]);

  const registry = useMemo(() => {
    return new TuiRegistry({ logger });
  }, [logger, exit, store, model, handleOpenSessionPicker, handleRestoreSession, sessionStore]);
  const [registryStatus, setRegistryStatus] = useState<RegistryStatus>('loading');
  const [registryError, setRegistryError] = useState<string | null>(null);
  const registryReady = registryStatus === 'ready';

  useEffect(() => {
    let cancelled = false;
    setRegistryStatus('loading');
    setRegistryError(null);

    const registerPlugins = async () => {
      const command = commandPlugin({
        exit: () => exit(),
        clear: () => store.reset(),
        getConfig: () => ({} as Record<string, unknown>),
        getCommands: () => registry.getCommands(),
      });

      const sessPlugin = sessionPlugin({
        getSessionId: () => store.getState().sessionId,
        getMessages: () => store.getState().messages.turns,
        getModel: () => model,
        openSessionPicker: handleOpenSessionPicker,
        sessionStore,
        onRestoreSession: async (sessionId: string) => {
          const summary = sessionListRef.current.find((s) => s.sessionId === sessionId);
          if (summary) {
            await handleRestoreSession(summary);
          }
        },
      });

      await registry.registerPlugin(command);
      if (!cancelled) await registry.registerPlugin(sessPlugin);
      if (!cancelled) setRegistryStatus('ready');
    };

    registerPlugins().catch((error) => {
      if (cancelled) return;
      const message = errorMessage(error);
      setRegistryError(message);
      setRegistryStatus('failed');
      store.dispatch({ type: 'error', error: new Error(`Failed to initialize TUI plugins: ${message}`) });
    });
    return () => {
      cancelled = true;
    };
  }, [exit, store, model, handleOpenSessionPicker, handleRestoreSession, sessionStore, registry]);

  useEffect(() => {
    const autoSaveHandler = createAutoSaveHandler({
      getSessionId: () => store.getState().sessionId,
      getMessages: () => store.getState().messages.turns,
      getAgentMessages: () => session.cortx.messages,
      getModel: () => model,
      sessionStore,
      startTime: new Date().toISOString(),
    });

    const unsubscribe = session.subscribe((event) => {
      // Auto-save BEFORE processEvent flushes turns to the terminal,
      // so the session metadata captures the full conversation.
      if (event.type === 'done' || event.type === 'error') {
        autoSaveHandler(event.type).catch(() => {});
      }
      processEvent(event, store, registry, true);
    });
    return () => {
      unsubscribe();
    };
  }, [session, store, model, sessionStore, registry]);

  useEffect(() => () => {
    store.dispose();
  }, [store]);

  const handleSubmit = useCallback((value: string) => {
    submitInput(value, { registryStatus, registryError, registry, session, store }).catch(() => {});
  }, [registryStatus, registryError, registry, session, store]);

  const handleAbort = useCallback(() => {
    session.controller?.abort('user interrupt');
    store.setInterrupting();
  }, [session, store]);

  const handleForceExit = useCallback(() => {
    exit();
  }, [exit]);

  return (
    <AppShell
      store={store}
      registry={registry}
      registryReady={registryReady}
      model={model}
      cwd={cwd}
      skills={skills}
      agentSessionsStore={session.cortx.agentSessions}
      onSubmit={handleSubmit}
      onAbort={handleAbort}
      onForceExit={handleForceExit}
      sessionPickerOpen={sessionPickerOpen}
      sessionList={sessionListRef.current}
      onSessionSelect={handleRestoreSession}
      onSessionPickerClose={() => setSessionPickerOpen(false)}
    />
  );
}
