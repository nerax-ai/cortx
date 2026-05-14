import { useSyncExternalStore } from 'react';
import type { AgentStore } from '@cortx/store';
import type { AgentState } from '@cortx/store';

export function useStore(store: AgentStore): AgentState {
  return useSyncExternalStore(
    (callback) => store.onChange(callback),
    () => store.getState(),
  );
}
