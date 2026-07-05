import { useEffect, useCallback, useMemo, useState, useRef } from 'react';
import { useApp } from 'ink';
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
import type { TuiAgentSpecInfo, TuiSessionAdapter } from './runtime-session.js';

export interface AppProps {
  session: TuiSessionAdapter;
  logger?: Logger;
}

export type RegistryStatus = 'loading' | 'ready' | 'failed';

interface SubmitInputDeps {
  registryStatus: RegistryStatus;
  registryError: string | null;
  registry: Pick<TuiRegistry, 'executeCommand'>;
  session: Pick<TuiSessionAdapter, 'abort' | 'prompt'>;
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
      abort: () => {
        void deps.session.abort('user interrupt');
      },
    });
    if (found) return;
  }

  deps.store.addUserMessage(value);
  Promise.resolve(deps.session.prompt(value)).catch((error) => {
    deps.store.dispatch({ type: 'error', error: error instanceof Error ? error : new Error(String(error)) });
  });
}

export default function App({ session, logger }: AppProps) {
  const { exit } = useApp();

  const [activeSession, setActiveSession] = useState<TuiSessionAdapter>(session);
  const store = useMemo(() => new TuiStore(), []);
  const sessionStore = useMemo(() => createDefaultSessionStore(), []);
  const sessionInfo = activeSession.getInfo();
  const model = sessionInfo.model;
  const cwd = sessionInfo.workingDirectory;

  const [sessionPickerOpen, setSessionPickerOpen] = useState(false);
  const sessionListRef = useRef<SessionSummary[]>([]);
  const [agentSpecPickerOpen, setAgentSpecPickerOpen] = useState(false);
  const [agentSpecs, setAgentSpecs] = useState<TuiAgentSpecInfo[]>([]);
  const [agentSpecPickerLoading, setAgentSpecPickerLoading] = useState(false);
  const [agentSpecPickerError, setAgentSpecPickerError] = useState<string | null>(null);
  const agentSpecLoadTokenRef = useRef(0);

  useEffect(() => {
    setActiveSession(session);
  }, [session]);

  useEffect(() => {
    store.reset(activeSession.getInfo().id);
  }, [activeSession, store]);

  // --- Discover skills for palette display ---
  const [skills, setSkills] = useState<SkillItem[]>([]);
  useEffect(() => {
    if (activeSession.mode === 'remote') {
      setSkills([]);
      return;
    }

    let cancelled = false;
    discoverSkillItems(cwd)
      .then((items) => {
        if (!cancelled) setSkills(items);
      })
      .catch(() => {
        if (!cancelled) setSkills([]);
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, activeSession.mode]);

  // --- Session restore handler ---
  const handleRestoreSession = useCallback(
    async (summary: SessionSummary) => {
      setSessionPickerOpen(false);
      try {
        if (!activeSession.supportsMessageRestore) {
          store.showNotice(
            'Remote sessions keep history on the server. Local transcript restore is unavailable in remote mode.',
          );
          return;
        }
        const meta = await sessionStore.read(summary.sessionId);
        if (meta && meta.messages) {
          store.reset(meta.sessionId);
          store.loadTurns(meta.messages as TurnEntry[]);
          const agentMessages = meta.agentMessages
            ? parseAgentMessages(meta.agentMessages)
            : turnsToMessages(meta.messages as TurnEntry[]);
          activeSession.replaceAgentMessages(agentMessages);
          if (meta.status === 'crashed') {
            store.showNotice(`Restored crashed session ${meta.sessionId}. Attempting checkpoint resume...`);
            activeSession.resume().catch((error) => {
              store.dispatch({ type: 'error', error: new Error(`Failed to resume session: ${errorMessage(error)}`) });
            });
          } else {
            store.showNotice(`Restored session ${meta.sessionId}.`);
          }
        }
      } catch (error) {
        store.dispatch({ type: 'error', error: new Error(`Failed to restore session: ${errorMessage(error)}`) });
      }
    },
    [store, activeSession, sessionStore],
  );

  const handleOpenSessionPicker = useCallback(async () => {
    try {
      setAgentSpecPickerOpen(false);
      sessionListRef.current = await sessionStore.list();
      setSessionPickerOpen(true);
    } catch {
      sessionListRef.current = [];
      setSessionPickerOpen(true);
    }
  }, [sessionStore]);

  const handleCloseAgentSpecPicker = useCallback(() => {
    agentSpecLoadTokenRef.current += 1;
    setAgentSpecPickerOpen(false);
    setAgentSpecPickerLoading(false);
  }, []);

  const handleOpenAgentSpecPicker = useCallback(async () => {
    const token = agentSpecLoadTokenRef.current + 1;
    agentSpecLoadTokenRef.current = token;
    setSessionPickerOpen(false);
    setAgentSpecPickerOpen(true);
    setAgentSpecPickerLoading(true);
    setAgentSpecPickerError(null);
    setAgentSpecs([]);
    try {
      const specs = await activeSession.listAgentSpecs();
      if (agentSpecLoadTokenRef.current !== token) return;
      setAgentSpecs(specs);
    } catch (error) {
      if (agentSpecLoadTokenRef.current !== token) return;
      setAgentSpecPickerError(`Failed to load AgentSpecs: ${errorMessage(error)}`);
    } finally {
      if (agentSpecLoadTokenRef.current === token) setAgentSpecPickerLoading(false);
    }
  }, [activeSession]);

  const handleSelectAgentSpec = useCallback(
    async (spec: TuiAgentSpecInfo) => {
      handleCloseAgentSpecPicker();
      try {
        const next = await activeSession.launchAgentSpec(spec.path);
        setActiveSession(next);
      } catch (error) {
        store.dispatch({ type: 'error', error: new Error(`Failed to launch AgentSpec: ${errorMessage(error)}`) });
      }
    },
    [activeSession, handleCloseAgentSpecPicker, store],
  );

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
        steer: (message) => {
          void activeSession.steer(message);
        },
        listAgentSpecs: () => activeSession.listAgentSpecs(),
        launchAgentSpec: async (identifier) => {
          const next = await activeSession.launchAgentSpec(identifier);
          setActiveSession(next);
        },
        openAgentSpecPicker: handleOpenAgentSpecPicker,
        showNotice: (message) => store.showNotice(message),
        showError: (message) => store.dispatch({ type: 'error', error: new Error(message) }),
        getConfig: () => ({}) as Record<string, unknown>,
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
  }, [
    exit,
    store,
    model,
    handleOpenSessionPicker,
    handleOpenAgentSpecPicker,
    handleRestoreSession,
    sessionStore,
    registry,
    activeSession,
  ]);

  useEffect(() => {
    const autoSaveHandler = createAutoSaveHandler({
      getSessionId: () => store.getState().sessionId,
      getMessages: () => store.getState().messages.turns,
      getMessageSnapshot: () => store.getState().messages,
      getAgentMessages: () => activeSession.getAgentMessages(),
      getModel: () => model,
      sessionStore,
      startTime: new Date().toISOString(),
    });

    const unsubscribe = activeSession.subscribe((event) => {
      processEvent(event, store, registry);
      autoSaveHandler(event.type).catch(() => {});
    });
    return () => {
      unsubscribe();
    };
  }, [activeSession, store, model, sessionStore, registry]);

  useEffect(
    () => () => {
      store.dispose();
    },
    [store],
  );

  useEffect(
    () => () => {
      activeSession.dispose();
    },
    [activeSession],
  );

  const handleSubmit = useCallback(
    (value: string) => {
      const pending = store.getState().pendingQuestion;
      if (pending) {
        Promise.resolve(activeSession.answerUser(pending.toolCallId, value)).catch((error) => {
          store.dispatch({ type: 'error', error: new Error(`Failed to answer question: ${errorMessage(error)}`) });
        });
        return;
      }
      submitInput(value, { registryStatus, registryError, registry, session: activeSession, store }).catch(() => {});
    },
    [registryStatus, registryError, registry, activeSession, store],
  );

  const handleSteer = useCallback(
    (value: string) => {
      Promise.resolve(activeSession.steer(value)).catch((error) => {
        store.dispatch({ type: 'error', error: new Error(`Failed to steer session: ${errorMessage(error)}`) });
      });
    },
    [activeSession],
  );

  const handleAbort = useCallback(() => {
    Promise.resolve(activeSession.abort('user interrupt')).catch((error) => {
      store.dispatch({ type: 'error', error: new Error(`Failed to abort session: ${errorMessage(error)}`) });
    });
    store.setInterrupting();
  }, [activeSession, store]);

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
      runtimeMode={activeSession.mode}
      skills={skills}
      agentSessionsStore={activeSession.agentSessions}
      onSubmit={handleSubmit}
      onSteer={handleSteer}
      onAbort={handleAbort}
      onForceExit={handleForceExit}
      sessionPickerOpen={sessionPickerOpen}
      sessionList={sessionListRef.current}
      onSessionSelect={handleRestoreSession}
      onSessionPickerClose={() => setSessionPickerOpen(false)}
      agentSpecPickerOpen={agentSpecPickerOpen}
      agentSpecs={agentSpecs}
      agentSpecPickerLoading={agentSpecPickerLoading}
      agentSpecPickerError={agentSpecPickerError}
      onAgentSpecSelect={handleSelectAgentSpec}
      onAgentSpecPickerClose={handleCloseAgentSpecPicker}
    />
  );
}
