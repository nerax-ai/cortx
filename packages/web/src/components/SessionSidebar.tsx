import { useState } from 'react';
import type { AgentStatus, TokenUsage } from '@cortx/store';
import { compactPath, compactSessionId, formatElapsed, formatTokenUsage, statusTone, surface } from '../design';
import type { WebAgentSpecInfo, WebRuntimeSessionInfo, WebSkillPackInfo, WebSkillPackInstallRequest } from '../bridge/event-bridge';

interface SessionSidebarProps {
  status: AgentStatus;
  session: WebRuntimeSessionInfo | null;
  sessions: WebRuntimeSessionInfo[];
  agentSpecs: WebAgentSpecInfo[];
  skillPacks: WebSkillPackInfo[];
  selectedSkillPackIds: string[];
  selectedWorkingDirectory: string | null;
  tokenUsage: TokenUsage;
  elapsed: number;
  onCreateSession: (request: {
    workingDirectory: string;
    skillPacks?: string[];
  }) => void | Promise<void>;
  onLaunchAgentSpec: (path: string) => void | Promise<void>;
  onInstallSkillPack: (request: WebSkillPackInstallRequest) => void | Promise<void>;
  onSkillPackSelectionChange: (ids: string[]) => void;
  onSelectProject: (workingDirectory: string) => void | Promise<void>;
  onSwitchSession: (sessionId: string) => void | Promise<void>;
}

interface ProjectGroup {
  workingDirectory: string;
  sessions: WebRuntimeSessionInfo[];
  latestActivityAt: number;
  runningCount: number;
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <span className="text-zinc-500">{label}</span>
      <span className="min-w-0 truncate text-right text-zinc-800">{value}</span>
    </div>
  );
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
        runningCount: sortedSessions.filter((item) => item.isRunning).length,
      } satisfies ProjectGroup;
    })
    .sort((a, b) => b.latestActivityAt - a.latestActivityAt);
}

export function SessionSidebar({
  status,
  session,
  sessions,
  agentSpecs,
  skillPacks,
  selectedSkillPackIds,
  selectedWorkingDirectory,
  tokenUsage,
  elapsed,
  onCreateSession,
  onLaunchAgentSpec,
  onInstallSkillPack,
  onSkillPackSelectionChange,
  onSelectProject,
  onSwitchSession,
}: SessionSidebarProps) {
  const tone = statusTone(status);
  const [projectPath, setProjectPath] = useState('');
  const [skillPackPath, setSkillPackPath] = useState('');
  const [skillPackId, setSkillPackId] = useState('');
  const [isAdding, setIsAdding] = useState(false);
  const [isInstallingPack, setIsInstallingPack] = useState(false);
  const [launchingSpecPath, setLaunchingSpecPath] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [skillPackError, setSkillPackError] = useState<string | null>(null);
  const projects = groupSessions(sessions);

  async function submitProject() {
    const workingDirectory = projectPath.trim();
    if (!workingDirectory || isAdding) return;
    setIsAdding(true);
    setProjectError(null);
    try {
      await onCreateSession({
        workingDirectory,
        skillPacks: selectedSkillPackIds.length ? selectedSkillPackIds : undefined,
      });
      setProjectPath('');
    } catch (err) {
      setProjectError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsAdding(false);
    }
  }

  async function submitSkillPack() {
    const path = skillPackPath.trim();
    const id = skillPackId.trim();
    if (!path || isInstallingPack) return;
    setIsInstallingPack(true);
    setSkillPackError(null);
    try {
      await onInstallSkillPack({ path, id: id || undefined });
      setSkillPackPath('');
      setSkillPackId('');
    } catch (err) {
      setSkillPackError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsInstallingPack(false);
    }
  }

  function toggleSkillPack(id: string) {
    onSkillPackSelectionChange(
      selectedSkillPackIds.includes(id)
        ? selectedSkillPackIds.filter((item) => item !== id)
        : [...selectedSkillPackIds, id],
    );
  }

  async function launchSpec(spec: WebAgentSpecInfo) {
    if (launchingSpecPath) return;
    setLaunchingSpecPath(spec.path);
    setActionError(null);
    try {
      await onLaunchAgentSpec(spec.path);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setLaunchingSpecPath(null);
    }
  }

  return (
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

      <div className="border-b border-zinc-200 p-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-zinc-900">Active Project</span>
          <span className={`rounded-full border px-2 py-0.5 text-[10px] ${tone.badgeClass}`}>{tone.label}</span>
        </div>
        <div className="space-y-2">
          <DetailRow label="Model" value={session?.model ?? 'not connected'} />
          <DetailRow label="Workspace" value={session ? compactPath(session.workingDirectory) : '-'} />
          <DetailRow label="Session" value={compactSessionId(session?.id, 13)} />
          <DetailRow label="Tools" value={session?.toolMode ?? '-'} />
          <DetailRow label="Control" value={session?.approvalMode ?? '-'} />
          <DetailRow label="Packs" value={session?.skillPacks?.length ? session.skillPacks.join(', ') : 'none'} />
          <DetailRow label="Tokens" value={formatTokenUsage(tokenUsage)} />
          <DetailRow label="Elapsed" value={formatElapsed(elapsed)} />
        </div>
      </div>

      <section className="min-h-0 flex-1 overflow-y-auto p-2">
        <div className="space-y-4">
          <div>
            <div className="mb-2 px-1 text-xs font-medium text-zinc-500">Projects</div>
            <div className="space-y-2">
              {projects.map((project) => {
                const activeProject = project.workingDirectory === selectedWorkingDirectory;
                return (
                  <div key={project.workingDirectory} className="space-y-1">
                    <button
                      type="button"
                      title={project.workingDirectory}
                      onClick={() => void onSelectProject(project.workingDirectory)}
                      className={`w-full rounded-md px-2 py-2 text-left text-xs transition-colors ${
                        activeProject ? 'bg-white text-zinc-950 shadow-sm' : 'text-zinc-600 hover:bg-white/70 hover:text-zinc-950'
                      } ${surface.focus}`}
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

                    {activeProject && (
                      <div className="ml-2 space-y-1 border-l border-zinc-200 pl-2">
                        {project.sessions.map((item) => (
                          <button
                            key={item.id}
                            type="button"
                            onClick={() => void onSwitchSession(item.id)}
                            className={`w-full rounded-md px-2 py-1.5 text-left text-[11px] transition-colors ${
                              item.id === session?.id
                                ? 'bg-zinc-950 text-white shadow-sm'
                                : 'text-zinc-500 hover:bg-white/80 hover:text-zinc-900'
                            } ${surface.focus}`}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="truncate font-mono">{compactSessionId(item.id, 15)}</span>
                              <span className={item.id === session?.id ? 'text-zinc-300' : 'text-zinc-400'}>
                                {item.isRunning ? 'running' : 'ready'}
                              </span>
                            </div>
                            <div className={`mt-1 truncate ${item.id === session?.id ? 'text-zinc-300' : 'text-zinc-400'}`}>
                              {item.toolMode} · {item.approvalMode}
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {agentSpecs.length > 0 && (
            <div>
              <div className="mb-2 flex items-center justify-between px-1">
                <span className="text-xs font-medium text-zinc-500">Agents</span>
                <span className="text-[10px] text-zinc-400">{agentSpecs.length}</span>
              </div>
              <div className="space-y-1">
                {agentSpecs.map((spec) => (
                  <button
                    key={spec.path}
                    type="button"
                    title={spec.path}
                    disabled={Boolean(launchingSpecPath)}
                    onClick={() => void launchSpec(spec)}
                    className={`w-full rounded-md border border-transparent px-2 py-2 text-left text-xs text-zinc-600 transition-colors hover:border-zinc-200 hover:bg-white hover:text-zinc-950 disabled:cursor-wait disabled:opacity-60 ${surface.focus}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium">{spec.name}</span>
                      <span className="shrink-0 text-[10px] text-zinc-400">
                        {launchingSpecPath === spec.path ? 'launching' : spec.toolMode ?? 'agent'}
                      </span>
                    </div>
                    <div className="mt-1 truncate font-mono text-[10px] text-zinc-400">
                      {spec.relativePath || compactPath(spec.path)}
                    </div>
                    <div className="mt-1 max-h-8 overflow-hidden text-[11px] leading-4 text-zinc-500">{spec.promptPreview}</div>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div>
            <div className="mb-2 flex items-center justify-between px-1">
              <span className="text-xs font-medium text-zinc-500">Skill Packs</span>
              <span className="text-[10px] text-zinc-400">{skillPacks.length}</span>
            </div>
            <div className="space-y-1">
              {skillPacks.length === 0 && (
                <div className="rounded-md border border-dashed border-zinc-200 bg-white/60 px-2 py-2 text-[11px] leading-4 text-zinc-500">
                  No packs installed
                </div>
              )}
              {skillPacks.map((pack) => {
                const selected = selectedSkillPackIds.includes(pack.id);
                return (
                  <label
                    key={pack.id}
                    className={`block rounded-md border px-2 py-2 text-xs transition-colors ${
                      selected ? 'border-zinc-900 bg-white text-zinc-950' : 'border-transparent text-zinc-600 hover:border-zinc-200 hover:bg-white'
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => toggleSkillPack(pack.id)}
                        className={`mt-0.5 h-3.5 w-3.5 rounded border-zinc-300 ${surface.focus}`}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate font-medium">{pack.name ?? pack.id}</span>
                          <span className="shrink-0 text-[10px] text-zinc-400">{pack.skillPaths.length} skills</span>
                        </div>
                        <div className="mt-1 truncate font-mono text-[10px] text-zinc-400">{pack.id}</div>
                        <div className="mt-1 truncate font-mono text-[10px] text-zinc-400">
                          {pack.sourcePath || compactPath(pack.path)}
                        </div>
                      </div>
                    </div>
                  </label>
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

      <form
        className="space-y-2 border-t border-zinc-200 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submitSkillPack();
        }}
      >
        <div className="text-xs font-medium text-zinc-500">Install Skill Pack</div>
        <input
          value={skillPackPath}
          onChange={(e) => {
            setSkillPackPath(e.target.value);
            if (skillPackError) setSkillPackError(null);
          }}
          placeholder="Pack path on server"
          className={`h-9 w-full rounded-md border border-zinc-200 bg-white px-2 font-mono text-[11px] text-zinc-900 placeholder:text-zinc-400 ${surface.focus}`}
        />
        <input
          value={skillPackId}
          onChange={(e) => {
            setSkillPackId(e.target.value);
            if (skillPackError) setSkillPackError(null);
          }}
          placeholder="Optional id"
          className={`h-8 w-full rounded-md border border-zinc-200 bg-white px-2 font-mono text-[11px] text-zinc-900 placeholder:text-zinc-400 ${surface.focus}`}
        />
        <button
          type="submit"
          disabled={!skillPackPath.trim() || isInstallingPack}
          className={`h-8 w-full rounded-md border border-zinc-300 bg-white px-3 text-xs font-medium text-zinc-800 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:border-zinc-200 disabled:text-zinc-300 ${surface.focus}`}
        >
          {isInstallingPack ? 'Installing...' : 'Install pack'}
        </button>
        {skillPackError && (
          <div className="rounded-md border border-rose-200 bg-rose-50 px-2 py-1 text-[11px] leading-4 text-rose-700">
            {skillPackError}
          </div>
        )}
      </form>

      <form
        className="space-y-2 border-t border-zinc-200 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submitProject();
        }}
      >
        <div className="text-xs font-medium text-zinc-500">Add Project</div>
        <input
          value={projectPath}
          onChange={(e) => {
            setProjectPath(e.target.value);
            if (projectError) setProjectError(null);
          }}
          placeholder="Directory path on server"
          className={`h-9 w-full rounded-md border border-zinc-200 bg-white px-2 font-mono text-[11px] text-zinc-900 placeholder:text-zinc-400 ${surface.focus}`}
        />
        {projectError && (
          <div className="rounded-md border border-rose-200 bg-rose-50 px-2 py-1 text-[11px] leading-4 text-rose-700">
            {projectError}
          </div>
        )}
        <button
          type="submit"
          disabled={!projectPath.trim() || isAdding}
          className={`h-8 w-full rounded-md bg-zinc-950 px-3 text-xs font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-200 disabled:text-zinc-400 ${surface.focus}`}
        >
          {isAdding ? 'Adding...' : 'Add project'}
        </button>
      </form>
    </aside>
  );
}
