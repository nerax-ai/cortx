---
title: Full-Screen TUI Rendering with Ink v7
created: 2026-04-21
status: draft
type: requirements
origin: brainstorm
---

# Requirements: Full-Screen TUI Rendering with Ink v7

## Problem

The cortx TUI renders incrementally in the primary terminal buffer. When new content arrives (tool results, streaming text, status changes), Ink v5 redraws by erasing and re-outputting lines in the scroll history. This causes:

- Visual glitches when content arrives rapidly (streaming deltas, multiple tool calls)
- User input messages not visible in the output area (added as turns but lost in scrollback noise)
- Layout jumps as previous output gets displaced
- No clean full-screen separation — TUI output mixes with shell history

Compare with opencode, which uses `@opentui/solid` for a full-screen alternate-buffer TUI where the entire layout reflows cleanly on resize, and exiting restores the user's shell state.

## Goal

Upgrade the TUI to render in an alternate screen buffer with proper full-screen reflow, eliminating incremental display glitches and providing a clean, professional terminal experience.

## Success Criteria

1. TUI renders in alternate screen buffer — exiting restores previous terminal content
2. No visual glitches when streaming text, tool results, or status changes arrive
3. Layout reflows correctly on terminal resize
4. User messages are clearly visible in the conversation output
5. All existing functionality preserved (skill palette, commands, session restore, input)
6. Users can scroll up/down through conversation history with PageUp/PageDown and arrow keys (in-app virtual scroll)

## Scope

### In Scope
- Upgrade Ink from v5 to v7
- Upgrade React from 18 to 19 (required by Ink v7)
- Enable `alternateScreen: true` and `incrementalRendering: true` in `render()`
- Add `useWindowSize()` for resize-aware layout
- Verify all existing components work with Ink v7 API
- Fix the output display issues (user input visibility, tool call rendering)
- Virtual scroll viewport for output region — PageUp/PageDown/j/k to scroll history, auto-scroll to bottom on new content

### Out of Scope
- Complete visual redesign — same layout structure, just proper rendering
- Multi-pane layout (lazygit-style split views) — future work
- Mouse support
- Color theme system

## Key Decisions

1. **Ink v7 over opentui/terminal-kit** — Ink v7 adds the needed rendering primitives while preserving the existing React component model. opentui would require rewriting all components in Solid.js; terminal-kit is imperative. Ink is proven at scale (Claude Code, Gemini CLI).

2. **React 19 upgrade** — Required by Ink v7. Only the TUI package uses React; no other packages are affected.

3. **Incremental rendering** — Enable to reduce flicker. Ink will only update changed lines instead of full redraws.

4. **Custom virtual scroll** — No built-in Ink scroll container. Implement a scroll state (offset into line array) with `useWindowSize()` to determine viewport height. Bind PageUp/PageDown and j/k for scroll, auto-follow new content. Simpler than pulling in a third-party scroll library.

## Risks

- **Ink v7 breaking changes** — Need to verify `useInput`, `useApp`, `useSyncExternalStore`, `Box`, `Text` APIs haven't changed. Quick scan suggests they're stable.
- **React 19 compatibility** — `useSyncExternalStore` is available in React 18+ so this is safe. The `useState`/`useEffect`/`useCallback`/`useRef` APIs are identical.
- **Virtual scroll complexity** — Variable-height lines (Markdown rendering, tool results) make simple line-count offset inaccurate. May need to flatten content into uniform lines or measure rendered heights.

## Dependencies

- Ink v7 (`ink@7.0.1`)
- React 19 (`react@19.1.0`, `@types/react@19.x`)
