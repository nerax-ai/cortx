export type WorkbenchLayoutMode = 'wide' | 'drawer' | 'single-pane';

export interface WorkbenchLayoutState {
  mode: WorkbenchLayoutMode;
  railDocked: boolean;
  sidePaneDocked: boolean;
  conversationMinimum: number;
}

export function resolveWorkbenchLayout(width: number, sidePaneOpen: boolean): WorkbenchLayoutState {
  if (width >= 1180) {
    return {
      mode: 'wide',
      railDocked: true,
      sidePaneDocked: sidePaneOpen,
      conversationMinimum: 560,
    };
  }
  if (width >= 720) {
    return {
      mode: 'drawer',
      railDocked: true,
      sidePaneDocked: false,
      conversationMinimum: 480,
    };
  }
  return {
    mode: 'single-pane',
    railDocked: false,
    sidePaneDocked: false,
    conversationMinimum: 0,
  };
}
