import { useEffect, useState } from 'react';
import { Dialog } from '@base-ui-components/react/dialog';
import { compactPath, compactSessionId, surface } from '../design';
import type {
  WebRuntimeSessionInfo,
  WebWorkspaceDirectoryListing,
} from '../client/types';

interface SessionSidebarProps {
  session: WebRuntimeSessionInfo | null;
  sessions: WebRuntimeSessionInfo[];
  selectedWorkingDirectory: string | null;
  onCreateSession: (request: {
    workingDirectory: string;
    skillPacks?: string[];
  }) => void | Promise<void>;
  onBrowseWorkspaceDirectories: (path?: string) => Promise<WebWorkspaceDirectoryListing>;
  onSelectProject: (workingDirectory: string) => void | Promise<void>;
  onSwitchSession: (sessionId: string) => void | Promise<void>;
  onDeleteSession: (sessionId: string) => void | Promise<void>;
}

interface ProjectGroup {
  workingDirectory: string;
  sessions: WebRuntimeSessionInfo[];
  latestActivityAt: number;
  runningCount: number;
}

interface DeleteSessionDialogProps {
  sessionTitle: string | null;
  isDeleting: boolean;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}

interface DeleteSessionDialogContentProps {
  sessionTitle: string;
  isDeleting: boolean;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}

interface AddProjectDialogProps {
  open: boolean;
  projectPath: string;
  isAdding: boolean;
  directoryListing: WebWorkspaceDirectoryListing | null;
  directoryLoading: boolean;
  directoryError: string | null;
  projectError: string | null;
  onOpenChange: (open: boolean) => void;
  onProjectPathChange: (path: string) => void;
  onLoadDirectories: (path?: string) => void | Promise<void>;
  onSubmit: () => void | Promise<void>;
}

function truncatePromptTitle(value: string, max = 34): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1)}…`;
}

function sessionTitle(session: WebRuntimeSessionInfo): string {
  const firstPrompt = session.promptHistory?.find((item) => item.trim());
  return firstPrompt ? truncatePromptTitle(firstPrompt) : compactSessionId(session.id, 15);
}

export function sessionStatusLabel(session: WebRuntimeSessionInfo): string {
  if (session.sessionHealth === 'durability_failed') return 'storage error';
  if (session.runPhase === 'waiting_user') return 'needs input';
  if (session.runPhase === 'waiting_approval') return 'needs approval';
  if (session.runPhase === 'aborting') return 'stopping';
  if (session.runPhase === 'interrupted') return session.resumable ? 'resumable' : 'interrupted';
  if (session.runPhase === 'running' || session.isRunning) return 'running';
  if (session.sessionHealth === 'run_failed') return 'last run failed';
  return 'ready';
}

function groupSessions(sessions: WebRuntimeSessionInfo[]): ProjectGroup[] {
  const groups = new Map<string, WebRuntimeSessionInfo[]>();
  for (const item of sessions) {
    const existing = groups.get(item.workingDirectory) ?? [];
    existing.push(item);
    groups.set(item.workingDirectory, existing);
  }

  return Array.from(groups.entries())
    .map(([workingDirectory, groupSessions]) => {
      const sortedSessions = [...groupSessions].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
      return {
        workingDirectory,
        sessions: sortedSessions,
        latestActivityAt: sortedSessions[0]?.lastActivityAt ?? 0,
        runningCount: sortedSessions.filter((item) => item.isRunning || (item.runPhase !== undefined && item.runPhase !== 'idle')).length,
      } satisfies ProjectGroup;
    })
    .sort((a, b) => b.latestActivityAt - a.latestActivityAt);
}

export function DeleteSessionDialog({ sessionTitle, isDeleting, onCancel, onConfirm }: DeleteSessionDialogProps) {
  const open = Boolean(sessionTitle);

  return (
    <Dialog.Root
      open={open}
      modal
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !isDeleting) onCancel();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-zinc-950/20 backdrop-blur-sm" />
        <Dialog.Popup
          initialFocus
          className={`fixed left-1/2 top-1/2 z-50 w-[min(420px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-2xl p-5 shadow-2xl shadow-zinc-300/60 ${surface.panel}`}
        >
          <DeleteSessionDialogContent
            sessionTitle={sessionTitle ?? 'this session'}
            isDeleting={isDeleting}
            onCancel={onCancel}
            onConfirm={onConfirm}
          />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function DeleteSessionDialogContent({
  sessionTitle,
  isDeleting,
  onCancel,
  onConfirm,
}: DeleteSessionDialogContentProps) {
  return (
    <>
      <h2 className="text-lg font-semibold text-zinc-950">Delete session</h2>
      <p className="mt-2 text-sm leading-6 text-zinc-600">
        Delete <span className="font-medium text-zinc-950">{sessionTitle}</span> and remove its saved history. Any
        active run in this session will be stopped.
      </p>

      <div className="mt-5 flex justify-end gap-2">
        <button
          type="button"
          disabled={isDeleting}
          onClick={onCancel}
          className={`h-9 rounded-md border border-zinc-200 bg-white px-3 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:cursor-wait disabled:opacity-50 ${surface.focus}`}
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={isDeleting}
          onClick={() => void onConfirm()}
          className={`h-9 rounded-md bg-rose-600 px-3 text-sm font-medium text-white hover:bg-rose-700 disabled:cursor-wait disabled:bg-rose-200 ${surface.focus}`}
        >
          {isDeleting ? 'Deleting...' : 'Delete'}
        </button>
      </div>
    </>
  );
}

function AddProjectDialog({
  open,
  projectPath,
  isAdding,
  directoryListing,
  directoryLoading,
  directoryError,
  projectError,
  onOpenChange,
  onProjectPathChange,
  onLoadDirectories,
  onSubmit,
}: AddProjectDialogProps) {
  return (
    <Dialog.Root
      open={open}
      modal
      onOpenChange={(nextOpen) => {
        if (!nextOpen && isAdding) return;
        onOpenChange(nextOpen);
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-zinc-950/20 backdrop-blur-sm" />
        <Dialog.Popup
          initialFocus
          className={`fixed left-1/2 top-1/2 z-50 flex max-h-[82vh] w-[min(760px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl shadow-2xl shadow-zinc-300/60 ${surface.panel}`}
        >
          <form
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={(event) => {
              event.preventDefault();
              void onSubmit();
            }}
          >
            <div className="border-b border-zinc-200 px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <Dialog.Title className="text-sm font-semibold text-zinc-950">Add project</Dialog.Title>
                  <Dialog.Description className="mt-1 text-xs text-zinc-500">
                    Enter a server directory or choose one from the browser.
                  </Dialog.Description>
                </div>
                <button
                  type="button"
                  disabled={isAdding}
                  onClick={() => onOpenChange(false)}
                  className={`rounded-md border border-zinc-200 px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-50 disabled:cursor-wait disabled:opacity-50 ${surface.focus}`}
                >
                  Close
                </button>
              </div>
              <input
                value={projectPath}
                onChange={(event) => onProjectPathChange(event.target.value)}
                placeholder="/Users/you/work/project"
                className={`mt-3 h-9 w-full rounded-md border border-zinc-200 bg-white px-2 font-mono text-xs text-zinc-900 placeholder:text-zinc-400 ${surface.focus}`}
              />
              {projectError && (
                <div className="mt-2 rounded-md border border-rose-200 bg-rose-50 px-2 py-1 text-xs leading-4 text-rose-700">
                  {projectError}
                </div>
              )}
            </div>

            <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[180px_minmax(0,1fr)]">
              <div className="border-b border-zinc-200 bg-zinc-50 p-3 md:border-b-0 md:border-r">
                <div className="mb-2 text-xs font-medium text-zinc-500">Roots</div>
                <div className="space-y-1">
                  {(directoryListing?.roots ?? []).map((root) => (
                    <button
                      key={root}
                      type="button"
                      title={root}
                      onClick={() => void onLoadDirectories(root)}
                      className={`w-full rounded-md px-2 py-1.5 text-left font-mono text-[11px] text-zinc-600 hover:bg-white hover:text-zinc-950 ${surface.focus}`}
                    >
                      <span className="block truncate">{compactPath(root)}</span>
                    </button>
                  ))}
                  {!directoryListing?.roots.length && (
                    <div className="rounded-md border border-dashed border-zinc-200 bg-white/60 px-2 py-2 text-[11px] leading-4 text-zinc-500">
                      Loading roots...
                    </div>
                  )}
                </div>
              </div>

              <div className="min-h-0 overflow-y-auto p-3">
                {directoryError && (
                  <div className="mb-2 rounded-md border border-rose-200 bg-rose-50 px-2 py-1 text-xs text-rose-700">
                    {directoryError}
                  </div>
                )}
                {directoryLoading ? (
                  <div className="rounded-md border border-dashed border-zinc-200 px-3 py-8 text-center text-xs text-zinc-500">
                    Loading directories...
                  </div>
                ) : (
                  <div className="space-y-1">
                    {directoryListing?.parent && (
                      <button
                        type="button"
                        onClick={() => void onLoadDirectories(directoryListing.parent)}
                        className={`w-full rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-left text-xs text-zinc-700 hover:bg-white ${surface.focus}`}
                      >
                        ..
                      </button>
                    )}
                    {(directoryListing?.entries ?? []).map((entry) => (
                      <button
                        key={entry.path}
                        type="button"
                        title={entry.path}
                        onClick={() => void onLoadDirectories(entry.path)}
                        className={`w-full rounded-md border border-transparent px-3 py-2 text-left text-xs text-zinc-700 hover:border-zinc-200 hover:bg-zinc-50 hover:text-zinc-950 ${surface.focus}`}
                      >
                        <div className="truncate font-medium">{entry.name}</div>
                        <div className="mt-1 truncate font-mono text-[10px] text-zinc-400">{entry.path}</div>
                      </button>
                    ))}
                    {!directoryListing?.entries.length && !directoryListing?.parent && (
                      <div className="rounded-md border border-dashed border-zinc-200 px-3 py-8 text-center text-xs text-zinc-500">
                        No folders
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-zinc-200 px-4 py-3">
              <button
                type="button"
                disabled={isAdding}
                onClick={() => onOpenChange(false)}
                className={`h-8 rounded-md border border-zinc-200 px-3 text-xs text-zinc-700 hover:bg-zinc-50 disabled:cursor-wait disabled:opacity-50 ${surface.focus}`}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!projectPath.trim() || isAdding}
                className={`h-8 rounded-md bg-zinc-950 px-3 text-xs font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-200 disabled:text-zinc-400 ${surface.focus}`}
              >
                {isAdding ? 'Adding...' : 'Add project'}
              </button>
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function SessionSidebar({
  session,
  sessions,
  selectedWorkingDirectory,
  onCreateSession,
  onBrowseWorkspaceDirectories,
  onSelectProject,
  onSwitchSession,
  onDeleteSession,
}: SessionSidebarProps) {
  const [projectPath, setProjectPath] = useState('');
  const [isAdding, setIsAdding] = useState(false);
  const [isAddProjectOpen, setAddProjectOpen] = useState(false);
  const [directoryListing, setDirectoryListing] = useState<WebWorkspaceDirectoryListing | null>(null);
  const [directoryLoading, setDirectoryLoading] = useState(false);
  const [directoryError, setDirectoryError] = useState<string | null>(null);
  const [deleteCandidate, setDeleteCandidate] = useState<WebRuntimeSessionInfo | null>(null);
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [expandedProjects, setExpandedProjects] = useState<string[]>(
    () => (selectedWorkingDirectory ? [selectedWorkingDirectory] : []),
  );
  const projects = groupSessions(sessions);

  useEffect(() => {
    if (!selectedWorkingDirectory) return;
    setExpandedProjects((current) =>
      current.includes(selectedWorkingDirectory) ? current : [...current, selectedWorkingDirectory],
    );
  }, [selectedWorkingDirectory]);

  function expandProject(workingDirectory: string) {
    setExpandedProjects((current) => (current.includes(workingDirectory) ? current : [...current, workingDirectory]));
  }

  function toggleProject(workingDirectory: string) {
    setExpandedProjects((current) =>
      current.includes(workingDirectory)
        ? current.filter((item) => item !== workingDirectory)
        : [...current, workingDirectory],
    );
  }

  async function createProjectFromPath(workingDirectory: string) {
    const path = workingDirectory.trim();
    if (!path || isAdding) return;
    setIsAdding(true);
    setProjectError(null);
    try {
      await onCreateSession({
        workingDirectory: path,
      });
      expandProject(path);
      setProjectPath('');
      setAddProjectOpen(false);
    } catch (err) {
      setProjectError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsAdding(false);
    }
  }

  async function submitProject() {
    await createProjectFromPath(projectPath.trim());
  }

  async function loadDirectories(path?: string) {
    setDirectoryLoading(true);
    setDirectoryError(null);
    try {
      const listing = await onBrowseWorkspaceDirectories(path);
      setDirectoryListing(listing);
      setProjectPath(listing.current);
    } catch (err) {
      setDirectoryError(err instanceof Error ? err.message : String(err));
    } finally {
      setDirectoryLoading(false);
    }
  }

  async function openAddProjectDialog() {
    setAddProjectOpen(true);
    setProjectError(null);
    await loadDirectories(selectedWorkingDirectory ?? undefined);
  }

  function requestDeleteSession(item: WebRuntimeSessionInfo) {
    if (deletingSessionId) return;
    setDeleteCandidate(item);
  }

  async function confirmDeleteSession() {
    if (!deleteCandidate || deletingSessionId) return;
    setDeletingSessionId(deleteCandidate.id);
    setActionError(null);
    try {
      await onDeleteSession(deleteCandidate.id);
      setDeleteCandidate(null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingSessionId(null);
    }
  }

  return (
    <>
      <aside className="flex h-full min-h-0 flex-col border-r border-zinc-200 bg-[#f3f3f1]">
      <div className="border-b border-zinc-200 p-3">
        <div className="mb-3 flex items-center gap-2">
          <div className="grid h-8 w-8 place-items-center rounded-md border border-zinc-300 bg-white text-sm font-semibold text-zinc-950">
            Cx
          </div>
          <div>
            <div className="text-sm font-semibold text-zinc-950">Cortx</div>
            <div className="text-xs text-zinc-500">Agent workspace</div>
          </div>
        </div>
      </div>

      <section className="min-h-0 flex-1 overflow-y-auto p-2">
        <div className="space-y-4">
          <div>
            <div className="mb-2 flex items-center justify-between px-1">
              <span className="text-xs font-medium text-zinc-500">Projects</span>
              <button
                type="button"
                title="Add project"
                aria-label="Add project"
                onClick={() => void openAddProjectDialog()}
                className={`grid h-6 w-6 place-items-center rounded-md text-sm leading-none text-zinc-400 hover:bg-white hover:text-zinc-900 ${surface.focus}`}
              >
                +
              </button>
            </div>
            <div className="space-y-2">
              {projects.map((project) => {
                const activeProject = project.workingDirectory === selectedWorkingDirectory;
                const expanded = expandedProjects.includes(project.workingDirectory);
                return (
                  <div key={project.workingDirectory} className="space-y-1">
                    <div
                      className={`flex items-start gap-1 rounded-md transition-colors ${
                        activeProject ? 'bg-white text-zinc-950 shadow-sm' : 'text-zinc-600 hover:bg-white/70 hover:text-zinc-950'
                      }`}
                    >
                      <button
                        type="button"
                        title={expanded ? 'Collapse project' : 'Expand project'}
                        aria-label={`${expanded ? 'Collapse' : 'Expand'} ${compactPath(project.workingDirectory)}`}
                        onClick={() => toggleProject(project.workingDirectory)}
                        className={`ml-1 mt-1 grid h-6 w-5 shrink-0 place-items-center rounded-md text-[10px] text-zinc-400 hover:bg-zinc-100 hover:text-zinc-900 ${surface.focus}`}
                      >
                        {expanded ? '▾' : '▸'}
                      </button>
                      <button
                        type="button"
                        title={project.workingDirectory}
                        onClick={() => {
                          expandProject(project.workingDirectory);
                          void onSelectProject(project.workingDirectory);
                        }}
                        className={`min-w-0 flex-1 px-2 py-2 text-left text-xs ${surface.focus}`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate font-medium">{compactPath(project.workingDirectory)}</span>
                          <span className="shrink-0 text-[10px] text-zinc-400">
                            {project.sessions.length} session{project.sessions.length === 1 ? '' : 's'}
                          </span>
                        </div>
                        <div className="mt-1 truncate font-mono text-[10px] text-zinc-400">
                          {project.runningCount > 0 ? `${project.runningCount} running · ` : ''}
                          {project.workingDirectory}
                        </div>
                      </button>
                      <button
                        type="button"
                        title={`New session for ${project.workingDirectory}`}
                        aria-label={`New session for ${compactPath(project.workingDirectory)}`}
                        disabled={isAdding}
                        onClick={() => void createProjectFromPath(project.workingDirectory)}
                        className={`mr-1 mt-1 grid h-6 w-6 shrink-0 place-items-center rounded-md text-sm leading-none text-zinc-400 hover:bg-zinc-100 hover:text-zinc-900 disabled:cursor-wait disabled:text-zinc-300 ${surface.focus}`}
                      >
                        +
                      </button>
                    </div>

                    {expanded && (
                      <div className="ml-2 space-y-1 border-l border-zinc-200 pl-2">
                        {project.sessions.map((item) => {
                          const activeSession = item.id === session?.id;
                          const title = sessionTitle(item);
                          return (
                            <div
                              key={item.id}
                              className={`group flex items-stretch gap-1 rounded-md transition-colors ${
                                activeSession
                                  ? 'bg-zinc-950 text-white shadow-sm'
                                  : 'text-zinc-500 hover:bg-white/80 hover:text-zinc-900'
                              }`}
                            >
                              <button
                                type="button"
                                title={item.promptHistory?.[0] || item.id}
                                onClick={() => void onSwitchSession(item.id)}
                                className={`min-w-0 flex-1 px-2 py-1.5 text-left text-[11px] ${surface.focus}`}
                              >
                                <div className="flex items-center justify-between gap-2">
                                  <span className="truncate font-medium">{title}</span>
                                  <span className={activeSession ? 'text-zinc-300' : 'text-zinc-400'}>
                                    {sessionStatusLabel(item)}
                                  </span>
                                </div>
                                <div className={`mt-1 truncate font-mono ${activeSession ? 'text-zinc-300' : 'text-zinc-400'}`}>
                                  {item.toolMode} · {item.approvalMode}
                                </div>
                              </button>
                              <button
                                type="button"
                                title={`Delete ${title}`}
                                aria-label={`Delete ${title}`}
                                disabled={deletingSessionId === item.id}
                                onClick={() => requestDeleteSession(item)}
                                className={`mr-1 my-1 grid w-6 shrink-0 place-items-center rounded-md text-sm leading-none opacity-70 transition hover:bg-rose-50 hover:text-rose-700 disabled:cursor-wait disabled:opacity-40 ${
                                  activeSession ? 'text-zinc-300 hover:bg-white/10 hover:text-white' : 'text-zinc-400'
                                } ${surface.focus}`}
                              >
                                {deletingSessionId === item.id ? '…' : '×'}
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {actionError && (
            <div className="rounded-md border border-rose-200 bg-rose-50 px-2 py-1 text-[11px] leading-4 text-rose-700">
              {actionError}
            </div>
          )}
        </div>
      </section>

      </aside>
      <AddProjectDialog
        open={isAddProjectOpen}
        projectPath={projectPath}
        isAdding={isAdding}
        directoryListing={directoryListing}
        directoryLoading={directoryLoading}
        directoryError={directoryError}
        projectError={projectError}
        onOpenChange={setAddProjectOpen}
        onProjectPathChange={(path) => {
          setProjectPath(path);
          if (projectError) setProjectError(null);
        }}
        onLoadDirectories={loadDirectories}
        onSubmit={submitProject}
      />
      <DeleteSessionDialog
        sessionTitle={deleteCandidate ? sessionTitle(deleteCandidate) : null}
        isDeleting={Boolean(deletingSessionId)}
        onCancel={() => setDeleteCandidate(null)}
        onConfirm={confirmDeleteSession}
      />
    </>
  );
}
