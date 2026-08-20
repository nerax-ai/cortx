import { useEffect, useRef, useState, type ReactNode } from 'react';
import { surface } from '../design';
import { resolveWorkbenchLayout } from './layout';

interface WorkbenchFrameProps {
  rail: ReactNode;
  header: ReactNode;
  conversation: ReactNode;
  sidePane: ReactNode;
  railOpen: boolean;
  sidePaneOpen: boolean;
  onRailOpenChange(open: boolean): void;
  onSidePaneOpenChange(open: boolean): void;
}

export function WorkbenchFrame({
  rail,
  header,
  conversation,
  sidePane,
  railOpen,
  sidePaneOpen,
  onRailOpenChange,
  onSidePaneOpenChange,
}: WorkbenchFrameProps) {
  const [width, setWidth] = useState(() => typeof window === 'undefined' ? 1440 : window.innerWidth);
  const railTriggerRef = useRef<HTMLButtonElement>(null);
  const paneTriggerRef = useRef<HTMLButtonElement>(null);
  const previousRailOpen = useRef(railOpen);
  const previousPaneOpen = useRef(sidePaneOpen);
  const layout = resolveWorkbenchLayout(width, sidePaneOpen);

  useEffect(() => {
    const update = () => setWidth(window.innerWidth);
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (sidePaneOpen && !layout.sidePaneDocked) {
        onSidePaneOpenChange(false);
        return;
      }
      if (railOpen && !layout.railDocked) onRailOpenChange(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [layout.railDocked, layout.sidePaneDocked, onRailOpenChange, onSidePaneOpenChange, railOpen, sidePaneOpen]);

  useEffect(() => {
    if (previousRailOpen.current && !railOpen) railTriggerRef.current?.focus();
    if (previousPaneOpen.current && !sidePaneOpen) paneTriggerRef.current?.focus();
    previousRailOpen.current = railOpen;
    previousPaneOpen.current = sidePaneOpen;
  }, [railOpen, sidePaneOpen]);

  const railVisible = layout.railDocked || railOpen;
  const paneVisible = layout.sidePaneDocked || sidePaneOpen;
  const overlayVisible = (railOpen && !layout.railDocked) || (sidePaneOpen && !layout.sidePaneDocked);

  return (
    <div className={`${surface.page} relative flex h-screen overflow-hidden`} data-layout-mode={layout.mode}>
      {overlayVisible && (
        <button
          type="button"
          aria-label="Close workspace overlay"
          className="fixed inset-0 z-30 bg-zinc-950/25 backdrop-blur-[1px]"
          onClick={() => {
            onRailOpenChange(false);
            onSidePaneOpenChange(false);
          }}
        />
      )}

      <aside
        aria-label="Projects and sessions"
        className={`${layout.railDocked ? 'relative z-10 w-[260px] shrink-0' : 'fixed inset-y-0 left-0 z-40 w-[min(88vw,320px)]'} border-r border-zinc-200 bg-[#f2f2f0] transition-transform duration-200 ${railVisible ? 'translate-x-0' : '-translate-x-full'}`}
      >
        {rail}
      </aside>

      <main aria-label="Conversation workbench" className="relative flex min-w-0 flex-1 flex-col bg-[var(--cortx-surface-main,#fbfbfa)]">
        {!layout.railDocked && (
            <button
              ref={railTriggerRef}
              type="button"
              aria-label="Open projects and sessions"
              aria-expanded={railOpen}
              onClick={() => onRailOpenChange(true)}
              className={`absolute left-2 top-2 z-20 grid h-10 w-10 place-items-center rounded-lg border border-zinc-200 bg-white text-zinc-700 shadow-sm ${surface.focus}`}
            >
              ☰
            </button>
        )}
        {!layout.sidePaneDocked && (
            <button
              ref={paneTriggerRef}
              type="button"
              aria-label="Open workspace details"
              aria-expanded={sidePaneOpen}
              onClick={() => onSidePaneOpenChange(true)}
              className={`absolute right-2 top-2 z-20 grid h-10 w-10 place-items-center rounded-lg border border-zinc-200 bg-white text-zinc-700 shadow-sm ${surface.focus}`}
            >
              ⓘ
            </button>
        )}
        <div className={`${!layout.railDocked ? 'pl-12' : ''} ${!layout.sidePaneDocked ? 'pr-12' : ''}`}>
          {header}
        </div>
        {conversation}
      </main>

      <aside
        aria-label="Workspace details"
        aria-hidden={!paneVisible}
        className={`${layout.sidePaneDocked ? 'relative z-10 w-[380px] shrink-0' : `fixed inset-y-0 right-0 z-40 ${layout.mode === 'single-pane' ? 'w-full' : 'w-[min(88vw,420px)]'}`} border-l border-zinc-200 bg-[#f3f3f1] transition-all duration-200 ${paneVisible ? 'translate-x-0 visible' : 'translate-x-full invisible pointer-events-none'}`}
      >
        {sidePane}
      </aside>
    </div>
  );
}
