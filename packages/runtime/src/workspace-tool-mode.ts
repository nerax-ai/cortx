export type WorkspaceToolMode = 'none' | 'read-only' | 'coding' | 'all';
export type WorkspaceToolPackMode = Exclude<WorkspaceToolMode, 'none'>;

