import { useSyncExternalStore } from 'react';
import type { AgentStore } from '@cortx/store';
import type { AgentState } from '@cortx/store';

export function useStore(store: AgentStore): AgentState {
  return useSyncExternalStore(
    (callback) => {
      const statusSub = store.select((s) => s.status);
      const unsub = statusSub.subscribe(callback);
      return unsub;
    },
    () => store.getState(),
  );
}
