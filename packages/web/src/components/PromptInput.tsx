import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Select } from '@base-ui-components/react/select';
import type { AgentStatus, TokenUsage } from '@cortx/store';
import type {
  WebAgentSpecInfo,
  WebApprovalMode,
  WebModelInfo,
  WebReasoningEffortOption,
  WebSkillInfo,
  WebSkillPackInfo,
  WebToolProfileInfo,
  WebWorkspaceToolMode,
} from '../bridge/event-bridge';
import { compactPath, surface } from '../design';
import type { ContextUsageSummary } from '../context-usage';
import { ContextUsageButton } from './ContextUsageButton';
import { ControlButton } from './ControlButton';

export interface QueuedPrompt {
  id: string;
  text: string;
  createdAt: number;
}

type PromptMenuItem =
  | {
      kind: 'skill';
      id: string;
      label: string;
      detail: string;
      disabled?: boolean;
      insertText: string;
    }
  | {
      kind: 'command';
      id: string;
      label: string;
      detail: string;
      disabled?: boolean;
      run: () => void | Promise<unknown>;
    };

interface PromptInputProps {
  onSend: (message: string) => void;
  skills: WebSkillInfo[];
  agentSpecs?: WebAgentSpecInfo[];
  skillPacks?: WebSkillPackInfo[];
  selectedSkillPackIds?: string[];
  toolProfiles?: WebToolProfileInfo[];
  models: WebModelInfo[];
  model?: string;
  reasoningEffort?: string;
  historyMessages?: string[];
  queuedPrompts?: QueuedPrompt[];
  disabled?: boolean;
  status: AgentStatus;
  toolMode: WebWorkspaceToolMode;
  approvalMode: WebApprovalMode;
  contextUsage?: ContextUsageSummary;
  tokenUsage?: TokenUsage;
  canChangeModes: boolean;
  onAbort: () => void;
  onResume: () => void;
  onSteerQueuedPrompt: (id: string) => void;
  onDeleteQueuedPrompt: (id: string) => void;
  onLaunchAgentSpec?: (path: string) => void | Promise<void>;
  onSkillPackSelectionChange?: (ids: string[]) => void | Promise<void>;
  onModelChange: (model: string) => void;
  onReasoningEffortChange: (effort: string | null) => void;
  onToolModeChange: (mode: WebWorkspaceToolMode) => void;
  onApprovalModeChange: (mode: WebApprovalMode) => void;
}

interface PromptSelectOption<T extends string> {
  value: T;
  label: string;
}

const APPROVAL_MODE_OPTIONS: Array<PromptSelectOption<WebApprovalMode>> = [
  { value: 'interactive', label: 'Ask first' },
  { value: 'full-access', label: 'Full access' },
  { value: 'deny', label: 'Deny writes' },
];

function itemMatches(item: PromptMenuItem, query: string): boolean {
  if (!query) return true;
  const normalized = query.toLowerCase();
  return [item.label, item.detail].some((part) => part.toLowerCase().includes(normalized));
}

function useAutosizeTextArea(ref: RefObject<HTMLTextAreaElement | null>, value: string) {
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${element.scrollHeight}px`;
  }, [ref, value]);
}

interface PromptKeyEventLike {
  key: string;
  shiftKey?: boolean;
  isComposing?: boolean;
  nativeEvent?: {
    isComposing?: boolean;
    keyCode?: number;
  };
}

export function isComposingPromptInput(event: PromptKeyEventLike): boolean {
  return Boolean(event.isComposing || event.nativeEvent?.isComposing || event.nativeEvent?.keyCode === 229);
}

export function shouldSubmitPromptInput(event: PromptKeyEventLike): boolean {
  return event.key === 'Enter' && !event.shiftKey && !isComposingPromptInput(event);
}

export function buildPromptHistory(historyMessages: string[] = [], localHistory: string[] = []): string[] {
  const raw = [...historyMessages, ...localHistory]
    .map((message) => message.trim())
    .filter(Boolean);
  const lastIndex = new Map<string, number>();
  raw.forEach((message, index) => lastIndex.set(message, index));
  return raw.filter((message, index) => lastIndex.get(message) === index).slice(-100);
}

function PromptSelect<T extends string>({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<PromptSelectOption<T>>;
  disabled?: boolean;
  onChange: (value: T) => void;
}) {
  return (
    <Select.Root<T>
      value={value}
      items={options}
      disabled={disabled}
      modal={false}
      onValueChange={(nextValue) => {
        if (nextValue !== null) onChange(nextValue);
      }}
    >
      <Select.Trigger
        aria-label={label}
        className={`flex h-7 items-center gap-1 rounded-md border border-transparent bg-white px-1.5 text-xs text-zinc-800 hover:border-zinc-200 disabled:cursor-not-allowed disabled:text-zinc-400 data-[popup-open]:border-zinc-300 ${surface.focus}`}
      >
        <span className="text-[11px] text-zinc-400">{label}</span>
        <Select.Value />
        <Select.Icon className="text-zinc-400">
          <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3 w-3">
            <path d="M4.5 6.25 8 9.75l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner side="top" align="start" sideOffset={6} positionMethod="fixed" alignItemWithTrigger={false}>
          <Select.Popup className="z-50 min-w-36 overflow-hidden rounded-xl border border-zinc-200 bg-white p-1 text-sm text-zinc-800 shadow-xl shadow-zinc-200/70 outline-none">
            <Select.List>
              {options.map((option) => (
                <Select.Item
                  key={option.value}
                  value={option.value}
                  className={`flex cursor-default items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-xs outline-none data-[highlighted]:bg-zinc-100 data-[selected]:font-medium data-[disabled]:opacity-40 ${surface.focus}`}
                >
                  <Select.ItemText>{option.label}</Select.ItemText>
                  <Select.ItemIndicator className="text-zinc-500">
                    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3 w-3">
                      <path d="m3.5 8 3 3 6-6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </Select.ItemIndicator>
                </Select.Item>
              ))}
            </Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}

function formatModelContext(tokens: number | undefined): string | undefined {
  if (tokens === undefined) return undefined;
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}m`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

function modelLabel(model: WebModelInfo | undefined, fallback: string | undefined): string {
  return model?.name ?? fallback ?? 'Model';
}

function selectedReasoningLabel(
  options: WebReasoningEffortOption[] | undefined,
  value: string | undefined,
): string | undefined {
  if (!value) return undefined;
  return options?.find((option) => option.value === value)?.label ?? value;
}

function ModelSelector({
  models,
  value,
  reasoningEffort,
  disabled,
  onModelChange,
  onReasoningEffortChange,
}: {
  models: WebModelInfo[];
  value?: string;
  reasoningEffort?: string;
  disabled?: boolean;
  onModelChange: (model: string) => void;
  onReasoningEffortChange: (effort: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ bottom: number; right: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const selectedModel = models.find((model) => model.id === value) ?? models[0];
  const reasoningOptions = selectedModel?.reasoningEfforts ?? [];
  const reasoningLabel = selectedReasoningLabel(reasoningOptions, reasoningEffort);
  const canOpen = !disabled && models.length > 0;

  useLayoutEffect(() => {
    if (!open || typeof window === 'undefined') return undefined;

    function updatePosition() {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (!rect) return;
      const panelWidth = 300;
      const right = Math.max(12, Math.min(window.innerWidth - rect.right, window.innerWidth - panelWidth - 12));
      const bottom = Math.max(12, window.innerHeight - rect.top + 8);
      setPosition({ bottom, right });
    }

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open]);

  const label = modelLabel(selectedModel, value);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label="Select model"
        aria-expanded={open}
        disabled={!canOpen}
        onClick={() => setOpen((current) => !current)}
        className={`flex h-8 max-w-[220px] items-center gap-1.5 rounded-full px-2 text-xs text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:text-zinc-400 ${surface.focus}`}
      >
        <span className="truncate font-medium text-zinc-800">{label}</span>
        {reasoningLabel && <span className="truncate text-zinc-400">{reasoningLabel}</span>}
        <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3 w-3 shrink-0 text-zinc-400">
          <path d="M4.5 6.25 8 9.75l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className="fixed z-[100] w-[300px] overflow-hidden rounded-xl border border-zinc-200 bg-white p-1.5 text-sm text-zinc-800 shadow-2xl shadow-zinc-200/80"
            style={{
              bottom: position?.bottom ?? 56,
              right: position?.right ?? 12,
            }}
          >
            <div className="px-2 py-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-400">Models</div>
            <div className="max-h-56 overflow-y-auto">
              {models.map((model) => {
                const selected = model.id === selectedModel?.id;
                const context = formatModelContext(model.contextWindowTokens);
                return (
                  <button
                    key={model.id}
                    type="button"
                    onClick={() => {
                      onModelChange(model.id);
                      if (!model.reasoningEfforts?.some((option) => option.value === reasoningEffort)) {
                        onReasoningEffortChange(null);
                      }
                    }}
                    className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left outline-none ${
                      selected ? 'bg-zinc-100 text-zinc-950' : 'hover:bg-zinc-50'
                    } ${surface.focus}`}
                  >
                    <span className="min-w-0 flex-1 truncate font-medium">{model.name}</span>
                    {context && <span className="shrink-0 font-mono text-[11px] text-zinc-400">{context}</span>}
                    {selected && (
                      <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-zinc-700">
                        <path d="m3.5 8 3 3 6-6" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </button>
                );
              })}
            </div>

            {reasoningOptions.length > 0 && (
              <div className="mt-1 border-t border-zinc-200 pt-1">
                <div className="px-2 py-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-400">
                  Reasoning
                </div>
                <button
                  type="button"
                  onClick={() => onReasoningEffortChange(null)}
                  className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left outline-none hover:bg-zinc-50 ${surface.focus}`}
                >
                  <span className="min-w-0 flex-1 truncate">Off</span>
                  {!reasoningEffort && (
                    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-zinc-700">
                      <path d="m3.5 8 3 3 6-6" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </button>
                {reasoningOptions.map((option) => {
                  const selected = option.value === reasoningEffort;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => onReasoningEffortChange(option.value)}
                      className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left outline-none ${
                        selected ? 'bg-zinc-100 text-zinc-950' : 'hover:bg-zinc-50'
                      } ${surface.focus}`}
                    >
                      <span className="min-w-0 flex-1 truncate">{option.label}</span>
                      {selected && (
                        <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-zinc-700">
                          <path d="m3.5 8 3 3 6-6" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}

function TemplateSelector({
  agentSpecs,
  skillPacks,
  selectedSkillPackIds,
  disabled,
  onLaunchAgentSpec,
  onSkillPackSelectionChange,
}: {
  agentSpecs: WebAgentSpecInfo[];
  skillPacks: WebSkillPackInfo[];
  selectedSkillPackIds: string[];
  disabled?: boolean;
  onLaunchAgentSpec?: (path: string) => void | Promise<void>;
  onSkillPackSelectionChange?: (ids: string[]) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ bottom: number; left: number } | null>(null);
  const [launchingPath, setLaunchingPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const count = agentSpecs.length + skillPacks.length;
  const canOpen = !disabled;

  useLayoutEffect(() => {
    if (!open || typeof window === 'undefined') return undefined;

    function updatePosition() {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (!rect) return;
      const panelWidth = 360;
      const left = Math.max(12, Math.min(rect.left, window.innerWidth - panelWidth - 12));
      const bottom = Math.max(12, window.innerHeight - rect.top + 8);
      setPosition({ bottom, left });
    }

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open]);

  async function launch(spec: WebAgentSpecInfo) {
    if (!onLaunchAgentSpec || launchingPath) return;
    setLaunchingPath(spec.path);
    setError(null);
    try {
      await onLaunchAgentSpec(spec.path);
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLaunchingPath(null);
    }
  }

  function togglePack(id: string) {
    const next = selectedSkillPackIds.includes(id)
      ? selectedSkillPackIds.filter((item) => item !== id)
      : [...selectedSkillPackIds, id];
    void onSkillPackSelectionChange?.(next);
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label="Open templates"
        aria-expanded={open}
        disabled={!canOpen}
        onClick={() => setOpen((current) => !current)}
        className={`flex h-7 items-center gap-1 rounded-md border border-transparent bg-white px-1.5 text-xs text-zinc-800 hover:border-zinc-200 disabled:cursor-not-allowed disabled:text-zinc-400 data-[popup-open]:border-zinc-300 ${surface.focus}`}
      >
        <span className="text-[11px] text-zinc-400">Templates</span>
        <span className="font-medium text-zinc-800">{count}</span>
        <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3 w-3 text-zinc-400">
          <path d="M4.5 6.25 8 9.75l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className="fixed z-[100] w-[360px] overflow-hidden rounded-xl border border-zinc-200 bg-white p-1.5 text-sm text-zinc-800 shadow-2xl shadow-zinc-200/80"
            style={{
              bottom: position?.bottom ?? 56,
              left: position?.left ?? 12,
            }}
          >
            <div className="px-2 py-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-400">
              Agent templates
            </div>
            <div className="max-h-56 overflow-y-auto">
              {agentSpecs.length === 0 ? (
                <div className="rounded-lg border border-dashed border-zinc-200 px-2.5 py-3 text-xs text-zinc-400">
                  No templates for this project
                </div>
              ) : (
                agentSpecs.map((spec) => (
                  <button
                    key={spec.path}
                    type="button"
                    title={spec.path}
                    disabled={Boolean(launchingPath)}
                    onClick={() => void launch(spec)}
                    className={`flex w-full items-start gap-3 rounded-lg px-2.5 py-2 text-left outline-none hover:bg-zinc-50 disabled:cursor-wait disabled:opacity-50 ${surface.focus}`}
                  >
                    <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md bg-zinc-100 text-[10px] font-semibold text-zinc-500">
                      A
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center justify-between gap-2">
                        <span className="truncate font-medium text-zinc-950">{spec.name}</span>
                        <span className="shrink-0 text-[10px] text-zinc-400">
                          {launchingPath === spec.path ? 'launching' : spec.toolMode ?? 'agent'}
                        </span>
                      </span>
                      <span className="mt-0.5 block truncate font-mono text-[10px] text-zinc-400">
                        {spec.relativePath || compactPath(spec.path)}
                      </span>
                      <span className="mt-1 block max-h-8 overflow-hidden text-[11px] leading-4 text-zinc-500">
                        {spec.promptPreview}
                      </span>
                    </span>
                  </button>
                ))
              )}
            </div>

            <div className="mt-1 border-t border-zinc-200 pt-1">
              <div className="px-2 py-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-400">
                Skill packs
              </div>
              {skillPacks.length === 0 ? (
                <div className="rounded-lg border border-dashed border-zinc-200 px-2.5 py-3 text-xs text-zinc-400">
                  No installed packs in this project
                </div>
              ) : (
                <div className="max-h-40 overflow-y-auto">
                  {skillPacks.map((pack) => {
                    const selected = selectedSkillPackIds.includes(pack.id);
                    return (
                      <button
                        key={pack.id}
                        type="button"
                        title={pack.sourcePath || pack.path}
                        onClick={() => togglePack(pack.id)}
                        className={`flex w-full items-start gap-3 rounded-lg px-2.5 py-2 text-left outline-none hover:bg-zinc-50 ${surface.focus}`}
                      >
                        <span
                          className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded border text-[10px] ${
                            selected ? 'border-zinc-900 bg-zinc-900 text-white' : 'border-zinc-300 text-transparent'
                          }`}
                        >
                          ✓
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center justify-between gap-2">
                            <span className="truncate font-medium text-zinc-950">{pack.name ?? pack.id}</span>
                            <span className="shrink-0 text-[10px] text-zinc-400">{pack.skillPaths.length} skills</span>
                          </span>
                          <span className="mt-0.5 block truncate font-mono text-[10px] text-zinc-400">{pack.id}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {error && (
              <div className="mt-1 rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-2 text-xs text-rose-700">
                {error}
              </div>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}

function SendIcon({ running }: { running: boolean }) {
  return running ? (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3.5 w-3.5">
      <rect x="4.5" y="4.5" width="7" height="7" rx="1.2" fill="currentColor" />
    </svg>
  ) : (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-4 w-4">
      <path d="M8 12.5v-9M4.5 7 8 3.5 11.5 7" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function PromptInput({
  onSend,
  skills,
  agentSpecs = [],
  skillPacks = [],
  selectedSkillPackIds = [],
  toolProfiles = [],
  models,
  model,
  reasoningEffort,
  historyMessages = [],
  queuedPrompts = [],
  disabled,
  status,
  toolMode,
  approvalMode,
  contextUsage,
  tokenUsage,
  canChangeModes,
  onAbort,
  onResume,
  onSteerQueuedPrompt,
  onDeleteQueuedPrompt,
  onLaunchAgentSpec,
  onSkillPackSelectionChange,
  onModelChange,
  onReasoningEffortChange,
  onToolModeChange,
  onApprovalModeChange,
}: PromptInputProps) {
  const [value, setValue] = useState('');
  const [localHistory, setLocalHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [historyDraft, setHistoryDraft] = useState('');
  const [selectedMenuIndex, setSelectedMenuIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useAutosizeTextArea(textareaRef, value);
  const history = useMemo(
    () => buildPromptHistory(historyMessages, localHistory),
    [historyMessages, localHistory],
  );

  const placeholder = disabled
    ? 'Answer the pending request in the dialog...'
    : status === 'running'
      ? 'Type a follow-up. Enter queues it after the current turn.'
      : 'Ask Cortx to inspect, change, or explain this workspace...';
  const toolModeOptions = useMemo(() => profileSelectOptions(toolProfiles, toolMode), [toolProfiles, toolMode]);
  const menuItems = useMemo<PromptMenuItem[]>(() => [
    {
      kind: 'command',
      id: 'stop',
      label: '/stop',
      detail: 'Stop the running turn',
      disabled: status !== 'running',
      run: onAbort,
    },
    {
      kind: 'command',
      id: 'resume',
      label: '/resume',
      detail: 'Resume after an error',
      disabled: status !== 'error',
      run: onResume,
    },
    ...toolModeOptions.map((option) => ({
      kind: 'command' as const,
      id: `tools-${option.value}`,
      label: `/tools ${option.value}`,
      detail: `Set tools to ${option.label}`,
      disabled: !canChangeModes,
      run: () => onToolModeChange(option.value),
    })),
    ...([
      ['interactive', 'ask'] as const,
      ['full-access', 'full'] as const,
      ['deny', 'deny'] as const,
    ]).map(([mode, label]) => ({
      kind: 'command' as const,
      id: `control-${mode}`,
      label: `/control ${label}`,
      detail: `Set control to ${mode}`,
      disabled: !canChangeModes,
      run: () => onApprovalModeChange(mode),
    })),
    ...agentSpecs.map((spec) => ({
      kind: 'command' as const,
      id: `template-${spec.path}`,
      label: `/template ${spec.name}`,
      detail: spec.promptPreview || spec.relativePath || spec.path,
      disabled: !onLaunchAgentSpec,
      run: () => onLaunchAgentSpec?.(spec.path),
    })),
    ...skills.map((skill) => ({
      kind: 'skill' as const,
      id: `skill-${skill.name}`,
      label: `/${skill.name}`,
      detail: skill.description,
      insertText: `/${skill.name} `,
    })),
  ], [
    canChangeModes,
    onAbort,
    onLaunchAgentSpec,
    onApprovalModeChange,
    onResume,
    onToolModeChange,
    agentSpecs,
    skills,
    status,
    toolModeOptions,
  ]);
  const slashMenuOpen = !disabled && value.startsWith('/') && !value.includes('\n');
  const slashQuery = slashMenuOpen ? value.slice(1).trimStart() : '';
  const filteredMenuItems = slashMenuOpen ? menuItems.filter((item) => itemMatches(item, slashQuery)).slice(0, 12) : [];

  useEffect(() => {
    setSelectedMenuIndex(0);
  }, [slashQuery, filteredMenuItems.length]);

  function resetHistoryNavigation() {
    setHistoryIndex(null);
    setHistoryDraft('');
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (isComposingPromptInput(e)) return;

    if (slashMenuOpen && filteredMenuItems.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedMenuIndex((index) => (index + 1) % filteredMenuItems.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedMenuIndex((index) => (index - 1 + filteredMenuItems.length) % filteredMenuItems.length);
        return;
      }
      const hasArguments = /^\/\S+\s/.test(value);
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !hasArguments)) {
        e.preventDefault();
        selectMenuItem(filteredMenuItems[selectedMenuIndex]);
        return;
      }
    }

    if (!slashMenuOpen && e.key === 'ArrowUp' && history.length > 0) {
      const atStart = (e.currentTarget.selectionStart ?? 0) === 0 && (e.currentTarget.selectionEnd ?? 0) === 0;
      if (atStart || !value) {
        e.preventDefault();
        const nextIndex = historyIndex === null ? history.length - 1 : Math.max(0, historyIndex - 1);
        if (historyIndex === null) setHistoryDraft(value);
        setHistoryIndex(nextIndex);
        setValue(history[nextIndex]);
        return;
      }
    }

    if (!slashMenuOpen && e.key === 'ArrowDown' && historyIndex !== null) {
      e.preventDefault();
      const nextIndex = historyIndex + 1;
      if (nextIndex >= history.length) {
        setHistoryIndex(null);
        setValue(historyDraft);
      } else {
        setHistoryIndex(nextIndex);
        setValue(history[nextIndex]);
      }
      return;
    }

    if (shouldSubmitPromptInput(e)) {
      e.preventDefault();
      submit();
    }
  }

  function selectMenuItem(item: PromptMenuItem | undefined) {
    if (!item || item.disabled) return;
    if (item.kind === 'skill') {
      setValue(item.insertText);
      resetHistoryNavigation();
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
        textareaRef.current?.setSelectionRange(item.insertText.length, item.insertText.length);
      });
      return;
    }
    setValue('');
    resetHistoryNavigation();
    void item.run();
  }

  function rememberHistory(text: string) {
    setLocalHistory((current) => {
      const withoutDuplicateTail = current[current.length - 1] === text ? current : [...current, text];
      return withoutDuplicateTail.slice(-100);
    });
    resetHistoryNavigation();
  }

  function submit() {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    rememberHistory(trimmed);
    setValue('');
  }

  function editQueuedPrompt(prompt: QueuedPrompt) {
    setValue(prompt.text);
    onDeleteQueuedPrompt(prompt.id);
    resetHistoryNavigation();
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(prompt.text.length, prompt.text.length);
    });
  }

  return (
    <div className="border-t border-zinc-200 bg-[#fbfbfa] px-4 py-3">
      <div className="relative mx-auto max-w-4xl">
        {slashMenuOpen && filteredMenuItems.length > 0 && (
          <div className="absolute inset-x-0 bottom-full z-20 mb-3 overflow-hidden rounded-2xl border border-zinc-200 bg-white/95 shadow-2xl shadow-zinc-200/70 backdrop-blur">
            <div className="max-h-80 overflow-y-auto p-1.5">
              {filteredMenuItems.map((item, index) => {
                const selected = index === selectedMenuIndex;
                return (
                  <button
                    key={item.id}
                    type="button"
                    disabled={item.disabled}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => selectMenuItem(item)}
                    className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors ${
                      selected ? 'bg-zinc-100 text-zinc-950' : 'text-zinc-700 hover:bg-zinc-50'
                    } disabled:cursor-not-allowed disabled:opacity-40 ${surface.focus}`}
                  >
                    <span className="grid h-5 w-5 shrink-0 place-items-center rounded-md border border-zinc-200 text-[11px] text-zinc-500">
                      {item.kind === 'skill' ? 'S' : '/'}
                    </span>
                    <span className="shrink-0 font-medium">{item.label.replace(/^\//, '')}</span>
                    <span className="min-w-0 flex-1 truncate text-zinc-400">{item.detail}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-lg shadow-zinc-200/60">
          {queuedPrompts.length > 0 && (
            <div className="mx-3 mt-3 overflow-hidden rounded-xl border border-zinc-200 bg-zinc-50">
              <div className="border-b border-zinc-200 px-3 py-1.5 text-[11px] uppercase tracking-[0.16em] text-zinc-400">
                Queued for next turn
              </div>
              <div className="divide-y divide-zinc-200">
                {queuedPrompts.map((prompt) => (
                  <div key={prompt.id} className="flex items-start gap-3 px-3 py-2">
                    <p className="min-w-0 flex-1 whitespace-pre-wrap text-sm leading-5 text-zinc-700">{prompt.text}</p>
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        onClick={() => onSteerQueuedPrompt(prompt.id)}
                        disabled={disabled}
                        className={`rounded-md px-2 py-1 text-xs font-medium text-zinc-600 hover:bg-white hover:text-zinc-950 disabled:text-zinc-300 ${surface.focus}`}
                      >
                        Steer
                      </button>
                      <button
                        type="button"
                        onClick={() => editQueuedPrompt(prompt)}
                        disabled={disabled}
                        className={`rounded-md px-2 py-1 text-xs text-zinc-500 hover:bg-white hover:text-zinc-900 disabled:text-zinc-300 ${surface.focus}`}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => onDeleteQueuedPrompt(prompt.id)}
                        disabled={disabled}
                        className={`rounded-md px-2 py-1 text-xs text-zinc-500 hover:bg-white hover:text-rose-700 disabled:text-zinc-300 ${surface.focus}`}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              resetHistoryNavigation();
            }}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            disabled={disabled}
            rows={1}
            className="max-h-52 min-h-18 w-full resize-none border-0 bg-transparent px-4 py-4 text-[15px] leading-6 text-zinc-950 outline-none placeholder:text-zinc-400 focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0 disabled:opacity-40"
          />
          <div className="flex flex-wrap items-center gap-2 px-3 pb-3 text-xs text-zinc-500">
            <button
              type="button"
              className={`grid h-7 w-7 place-items-center rounded-md border border-zinc-200 text-base leading-none text-zinc-400 hover:bg-zinc-50 hover:text-zinc-700 ${surface.focus}`}
              aria-label="Open attachments and input actions"
            >
              +
            </button>
            <PromptSelect
              label="Tools"
              value={toolMode}
              options={toolModeOptions}
              disabled={!canChangeModes}
              onChange={onToolModeChange}
            />
            <PromptSelect
              label="Control"
              value={approvalMode}
              options={APPROVAL_MODE_OPTIONS}
              disabled={!canChangeModes}
              onChange={onApprovalModeChange}
            />
            <TemplateSelector
              agentSpecs={agentSpecs}
              skillPacks={skillPacks}
              selectedSkillPackIds={selectedSkillPackIds}
              disabled={disabled}
              onLaunchAgentSpec={onLaunchAgentSpec}
              onSkillPackSelectionChange={onSkillPackSelectionChange}
            />
            <div className="ml-auto flex items-center gap-2">
              <ModelSelector
                models={models}
                value={model}
                reasoningEffort={reasoningEffort}
                disabled={!canChangeModes}
                onModelChange={onModelChange}
                onReasoningEffortChange={onReasoningEffortChange}
              />
              {contextUsage && <ContextUsageButton summary={contextUsage} sessionTokenUsage={tokenUsage} />}
              <ControlButton
                aria-label={status === 'running' ? 'Stop current turn' : 'Send message'}
                tone={status === 'running' ? 'danger' : 'primary'}
                onClick={status === 'running' ? onAbort : submit}
                disabled={disabled || (status !== 'running' && !value.trim())}
                className="flex h-8 w-8 items-center justify-center rounded-full !p-0 leading-none"
              >
                <SendIcon running={status === 'running'} />
              </ControlButton>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function profileSelectOptions(
  profiles: WebToolProfileInfo[],
  current: WebWorkspaceToolMode,
): Array<PromptSelectOption<WebWorkspaceToolMode>> {
  const options = profiles.map((profile) => ({
    value: profile.id,
    label: profile.name ?? labelFromToolProfileId(profile.id),
  }));
  if (current && !options.some((option) => option.value === current)) {
    options.unshift({ value: current, label: labelFromToolProfileId(current) });
  }
  return options.length ? options : [{ value: 'none', label: 'None' }];
}

function labelFromToolProfileId(value: string): string {
  if (!value) return 'None';
  const label = value
    .split(/[./:_-]+/)
    .filter(Boolean)
    .map((part) => part.toLowerCase())
    .join(' ');
  return label.slice(0, 1).toUpperCase() + label.slice(1);
}
