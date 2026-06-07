import type { SavedSession } from '../tauri';

const PANE_RESUME_MODE = 'history';

export interface PaneResumePayload {
  __coffeePaneResumeMode: typeof PANE_RESUME_MODE;
  savedSession: SavedSession;
}

export function encodePaneResumePayload(savedSession: SavedSession): string {
  return JSON.stringify({
    __coffeePaneResumeMode: PANE_RESUME_MODE,
    savedSession,
  } satisfies PaneResumePayload);
}

function normalizeSavedSession(raw: unknown): SavedSession | null {
  if (!raw || typeof raw !== 'object') return null;
  const session = raw as Partial<SavedSession>;
  if (typeof session.id !== 'string' || typeof session.tool !== 'string') {
    return null;
  }
  const sessionToken = typeof session.session_token === 'string'
    ? session.session_token
    : null;
  return {
    id: session.id,
    name: typeof session.name === 'string' ? session.name : 'Saved Session',
    tool: session.tool,
    cwd: typeof session.cwd === 'string' ? session.cwd : '',
    session_token: sessionToken,
    saved_at: typeof session.saved_at === 'string' ? session.saved_at : '',
    file_path: typeof session.file_path === 'string' ? session.file_path : undefined,
    turn_count: typeof session.turn_count === 'number' ? session.turn_count : undefined,
  };
}

export function decodePaneResumePayload(raw: string | null | undefined): PaneResumePayload | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PaneResumePayload> | Partial<SavedSession> | null;
    if (!parsed || typeof parsed !== 'object') return null;

    // Preferred shape: explicit wrapper produced by encodePaneResumePayload().
    if (
      (parsed as Partial<PaneResumePayload>).__coffeePaneResumeMode === PANE_RESUME_MODE
      && (parsed as Partial<PaneResumePayload>).savedSession
    ) {
      const savedSession = normalizeSavedSession(
        (parsed as Partial<PaneResumePayload>).savedSession
      );
      return savedSession ? {
        __coffeePaneResumeMode: PANE_RESUME_MODE,
        savedSession,
      } : null;
    }

    // Back-compat: accept a bare SavedSession object directly in toolData.
    const savedSession = normalizeSavedSession(parsed);
    return savedSession ? {
      __coffeePaneResumeMode: PANE_RESUME_MODE,
      savedSession,
    } : null;
  } catch {
    return null;
  }
}
