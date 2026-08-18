import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from 'ink';
import type { Logger } from '@nerax-ai/logger';
import { AppShell } from './components/app-shell.js';
import { discoverSkillItems, type SkillItem } from './plugins/skill-plugin.js';
import { processEvent } from './renderer.js';
import { TuiStore } from './store.js';
import type { TuiHost } from './tui-host.js';
import type { TuiAgentSpecInfo, TuiSessionAdapter } from './runtime-session.js';
import type { TuiRegistry } from './tui-registry.js';

export interface AppProps {
  host: TuiHost;
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
      deps.store.dispatch({ type: 'error', error: new Error(registryUnavailableMessage(deps.registryStatus, deps.registryError)) });
      return;
    }
    const [name, ...args] = value.split(/\s+/);
    const commandArgs = args.join(' ');
    const found = await deps.registry.executeCommand(name, commandArgs, {
      args: commandArgs,
      abort: () => { void deps.session.abort('user interrupt'); },
    });
    if (found) return;
  }

  deps.store.addUserMessage(value);
  Promise.resolve(deps.session.prompt(value)).catch((error) => {
    deps.store.dispatch({ type: 'error', error: asError(error) });
  });
}

export default function App({ host }: AppProps) {
  const { exit } = useApp();
  const registry = host.registry;
  const store = useMemo(() => new TuiStore(), []);
  const [activeSession, setActiveSession] = useState(() => host.sessions.current);
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [agentSpecPickerOpen, setAgentSpecPickerOpen] = useState(false);
  const [agentSpecs, setAgentSpecs] = useState<TuiAgentSpecInfo[]>([]);
  const [agentSpecPickerLoading, setAgentSpecPickerLoading] = useState(false);
  const [agentSpecPickerError, setAgentSpecPickerError] = useState<string | null>(null);

  const info = activeSession.getInfo();

  useEffect(() => host.sessions.subscribe(setActiveSession), [host]);

  useEffect(() => {
    store.reset(activeSession.getInfo().id);
  }, [activeSession, store]);

  useEffect(() => {
    if (activeSession.mode === 'remote') {
      setSkills([]);
      return;
    }
    let cancelled = false;
    discoverSkillItems(info.workingDirectory)
      .then((items) => { if (!cancelled) setSkills(items); })
      .catch(() => { if (!cancelled) setSkills([]); });
    return () => { cancelled = true; };
  }, [activeSession.mode, info.workingDirectory]);

  const closeAgentSpecPicker = useCallback(() => {
    setAgentSpecPickerOpen(false);
    setAgentSpecPickerLoading(false);
  }, []);

  const openAgentSpecPicker = useCallback(async () => {
    setAgentSpecPickerOpen(true);
    setAgentSpecPickerLoading(true);
    setAgentSpecPickerError(null);
    setAgentSpecs([]);
    try {
      setAgentSpecs(await host.sessions.listAgentSpecs());
    } catch (error) {
      setAgentSpecPickerError(`Failed to load AgentSpecs: ${errorMessage(error)}`);
    } finally {
      setAgentSpecPickerLoading(false);
    }
  }, [host]);

  useEffect(() => {
    host.updateActions({
      exit,
      clear: () => store.reset(host.sessions.current.getInfo().id),
      getConfig: () => ({
        mode: host.sessions.current.mode,
        sessionId: host.sessions.current.getInfo().id,
        workingDirectory: host.sessions.current.getInfo().workingDirectory,
      }),
      openAgentSpecPicker,
      showNotice: (message) => store.showNotice(message),
      showError: (message) => store.dispatch({ type: 'error', error: new Error(message) }),
    });
  }, [exit, host, openAgentSpecPicker, store]);

  useEffect(() => {
    const subscription = activeSession.subscribe((event) => processEvent(event, store, registry));
    return () => { void subscription.close(); };
  }, [activeSession, registry, store]);

  useEffect(() => () => store.dispose(), [store]);

  const submit = useCallback((value: string) => {
    const pending = store.getState().pendingQuestion;
    if (pending) {
      Promise.resolve(activeSession.answerUser(pending.toolCallId, value)).catch((error) => {
        store.dispatch({ type: 'error', error: new Error(`Failed to answer question: ${errorMessage(error)}`) });
      });
      return;
    }
    void submitInput(value, {
      registryStatus: 'ready',
      registryError: null,
      registry,
      session: activeSession,
      store,
    });
  }, [activeSession, registry, store]);

  const steer = useCallback((value: string) => {
    Promise.resolve(host.sessions.steer(value)).catch((error) => {
      store.dispatch({ type: 'error', error: new Error(`Failed to steer session: ${errorMessage(error)}`) });
    });
  }, [host, store]);

  const abort = useCallback(() => {
    Promise.resolve(activeSession.abort('user interrupt')).catch((error) => {
      store.dispatch({ type: 'error', error: new Error(`Failed to abort session: ${errorMessage(error)}`) });
    });
    store.setInterrupting();
  }, [activeSession, store]);

  const selectAgentSpec = useCallback(async (spec: TuiAgentSpecInfo) => {
    closeAgentSpecPicker();
    try { await host.sessions.launchAgentSpec(spec.path); }
    catch (error) {
      store.dispatch({ type: 'error', error: new Error(`Failed to launch AgentSpec: ${errorMessage(error)}`) });
    }
  }, [closeAgentSpecPicker, host, store]);

  return (
    <AppShell
      store={store}
      registry={registry}
      registryReady
      model={info.model}
      cwd={info.workingDirectory}
      runtimeMode={activeSession.mode}
      skills={skills}
      agentSessionsStore={activeSession.agentSessions}
      onSubmit={submit}
      onSteer={steer}
      onAbort={abort}
      onForceExit={exit}
      agentSpecPickerOpen={agentSpecPickerOpen}
      agentSpecs={agentSpecs}
      agentSpecPickerLoading={agentSpecPickerLoading}
      agentSpecPickerError={agentSpecPickerError}
      onAgentSpecSelect={selectAgentSpec}
      onAgentSpecPickerClose={closeAgentSpecPicker}
    />
  );
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
