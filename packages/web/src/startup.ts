import type { WebToolProfileInfo } from './bridge/event-bridge';

/** Prefer the full official profile when available; otherwise let the server apply its safe default. */
export function preferredInitialToolMode(profiles: WebToolProfileInfo[]): string | undefined {
  const profile = profiles.find((candidate) =>
    candidate.id === 'all' ||
    candidate.use === 'all' ||
    candidate.id.endsWith('/all') ||
    candidate.use.endsWith('/all'),
  );
  return profile?.use || profile?.id;
}
