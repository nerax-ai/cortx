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

export interface AppProps {
  session: CortxSession;
  model: string;
  cwd: string;
}

export default function App({ session, model, cwd }: AppProps) {
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
    const reg = new TuiRegistry();
    reg.registerPlugin(commandPlugin({
      exit: () => exit(),
      clear: () => store.reset(),
      getConfig: () => ({} as Record<string, unknown>),
      getCommands: () => reg.getCommands(),
    }));

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
    reg.registerPlugin(sessPlugin);

    return reg;
  }, [exit, store, model, handleOpenSessionPicker, handleRestoreSession, sessionStore]);

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
      store.dispose();
    };
  }, [session, store, model, sessionStore]);

  const handleSubmit = useCallback(
    async (value: string) => {
      if (value.startsWith('/')) {
        const parts = value.split(/\s+/);
        const cmdName = parts[0];
        const cmdArgs = parts.slice(1).join(' ');
        const found = await registry.executeCommand(cmdName, cmdArgs, {
          args: cmdArgs,
          abort: () => session.controller?.abort('user interrupt'),
        });
        if (found) return;
      }

      store.addUserMessage(value);
      session.prompt(value).catch(() => {});
    },
    [session, registry, store],
  );

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
