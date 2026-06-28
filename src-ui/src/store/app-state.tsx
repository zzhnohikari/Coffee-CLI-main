// Coffee CLI — Global App State (React Context)

import { createContext, useContext, useReducer } from 'react';
import type { ReactNode } from 'react';

// ─── Types ───────────────────────────────────────────────────────────────────

export type ToolType = 'claude' | 'qwen' | 'installer' | 'hermes' | 'opencode' | 'openclaw' | 'codex' | 'gemini' | 'shell' | 'arcade' | 'terminal' | 'remote' | 'history' | 'vibeid' | 'insights_prerun' | 'multi-agent' | 'two-agent' | 'three-agent' | 'two-split' | 'three-split' | 'four-split' | 'hyper-agent' | 'ctf-mode' | null;

/**
 * Tab status shown as an animated 9-dot glyph. Three states only —
 * Claude Code is the only CLI we drive a real status machine for.
 *
 *   idle       — ready for input (green Wave-Double)
 *   working    — LLM generating / tool call in flight (orange Snake-CCW)
 *   wait_input — permission prompt blocking, user must confirm (blue Ripple)
 *
 * CSS classes are `status-idle / -working / -waiting`
 * (the `wait_input → waiting` rename happens at render time).
 */
export type AgentStatus = 'idle' | 'working' | 'wait_input';

// Theme: color palette (orthogonal to shape)
export type ThemeColor =
  | 'dark' | 'light' | 'cappuccino' | 'sakura' | 'lavender' | 'mint'
  | 'obsidian' | 'cobalt' | 'moss';
// Theme: shape form (orthogonal to color)
export type ThemeShape = 'soft' | 'slab' | 'sharp' | 'glass' | 'panel';
// Icon theme: visual style for file/folder icons in the explorer.
// 8 themes, each with genuinely distinct folder silhouette + file icon style.
// Fetched upstream (6): material, vscode-icons, catppuccin-mocha, devicon, fluent, symbols
// Self-authored (2): outline (line-frame), coffee (Coffee CLI brand)
export type IconTheme =
  | 'outline' | 'material' | 'vscode-icons' | 'catppuccin-mocha'
  | 'devicon' | 'fluent' | 'symbols' | 'coffee';

/// One pane inside a multi-agent Tab. `paneIdx` is 1-indexed (1..4)
/// matching the user-visible badge and the MCP session id suffix —
/// sessionId = `${tabId}::pane-${paneIdx}`. The Rust MCP server's
/// list_panes returns the same ids, so when the user says "pane 2"
/// a CLI's MCP call can target it verbatim.
export interface MultiAgentPane {
  paneIdx: number;
  tool: ToolType;
  toolData?: string;
  agentStatus?: AgentStatus;
  // Per-pane working directory. Only used by the four-split (independent quad) tab
  // where each pane can run in its own project. Multi-agent panes ignore this
  // and use the tab-level folderPath (all 4 panes share one workspace because
  // they coordinate via MCP against that workspace's config).
  folderPath?: string | null;
  // Sentinel Protocol (opt-in per pane). When true, TierTerminal scans the
  // PTY output stream of this pane for the marker `[COFFEE-DONE:pane<N>]`
  // that the user instructs their agent to emit on task completion. On a
  // match, completionTs is set to Date.now() — the pane number badge
  // renders a small green dot while the timestamp is fresh.
  sentinelEnabled?: boolean;
  completionTs?: number;
}

/// State attached to a Tab with `tool === 'multi-agent'`. All four panes
/// are peers — there is no primary/worker distinction — so this type is
/// deliberately minimal. Each pane's CLI and toolData live on
/// `MultiAgentPane`; focus tracking happens inside `<MultiAgentGrid/>`.
export interface MultiAgentState {
  panes: MultiAgentPane[];
}

export interface TerminalSession {
  id: string;
  tool: ToolType;
  toolData?: string;  // Extra context for the tool (e.g. game filename for arcade)
  folderPath: string | null;
  restartKey?: number;
  isHidden?: boolean;
  agentStatus?: AgentStatus;
  gambitDraft?: string;    // Unsent textarea content, preserved across tab switches
  /// When present, this Tab renders as a 2×2+ pane grid instead of a
  /// single terminal. See docs/MULTI-AGENT-ARCHITECTURE.md §5.7 and §7.
  multiAgent?: MultiAgentState;
}

// ─── State Shape ─────────────────────────────────────────────────────────────

export interface AppState {
  // UI
  currentTheme: ThemeColor;
  currentShape: ThemeShape;
  currentLang: string;
  iconTheme: IconTheme;

  // Background wallpaper
  bgPath: string;
  bgType: 'image' | 'video' | 'none';
  // Wallpaper dim overlay opacity, 0-80 (percent). 30 by default for legibility.
  wallpaperDim: number;

  // Terminal foreground color override ('' = use theme default)
  termColorScheme: string;

  // Terminals
  terminals: TerminalSession[];
  activeTerminalId: string | null;
  recentFolders: string[];

  // Gambit (global floating compose window). Visibility is app-wide so the
  // panel doesn't appear/disappear when switching tabs; only the draft is
  // per-tab (stored on TerminalSession.gambitDraft).
  gambitOpen: boolean;

  // IDE-style layout toggles driven from titlebar controls.
  // Default both panels visible — matches first-time user expectation.
  leftPanelHidden: boolean;
  rightPanelHidden: boolean;

  // Multi-agent pane arrangement. 'grid' = 2×2 quadrant (default),
  // 'columns' = 1×4 vertical strip. Only takes effect inside a tab
  // whose tool is 'multi-agent'; other tabs ignore it.
  multiAgentLayout: 'grid' | 'columns';
}


function tabUsesCoordinatedMultiAgentMcp(tool: ToolType): boolean {
  return tool === 'multi-agent'
    || tool === 'two-agent'
    || tool === 'three-agent'
    || tool === 'ctf-mode';
}

function toolGetsPaneMcpByDefault(tool: ToolType): boolean {
  return tool === 'claude'
    || tool === 'codex'
    || tool === 'gemini'
    || tool === 'opencode';
}

// ─── Actions ─────────────────────────────────────────────────────────────────

type Action =
  | { type: 'SET_FOLDER'; path: string }
  | { type: 'CLEAR_FOLDER' }
  | { type: 'SET_THEME'; theme: ThemeColor }
  | { type: 'SET_SHAPE'; shape: ThemeShape }
  | { type: 'SET_ICON_THEME'; theme: IconTheme }
  | { type: 'SET_LANG'; lang: string }
  | { type: 'ADD_TERMINAL'; session: TerminalSession }
  | { type: 'REMOVE_TERMINAL'; id: string }
  | { type: 'SET_ACTIVE_TERMINAL'; id: string | null }
  | { type: 'SET_TERMINAL_TOOL'; id: string; tool: ToolType; toolData?: string }
  | { type: 'SET_TERMINAL_HIDDEN'; id: string; isHidden: boolean }
  | { type: 'RESTART_TERMINAL'; id: string; newId: string }
  | { type: 'OPEN_HISTORY_TAB'; sessionData: string; folderPath: string }
  | { type: 'OPEN_HYPER_AGENT_TAB' }
  | { type: 'SET_AGENT_STATUS'; id: string; status: AgentStatus }
  | { type: 'SET_BG'; path: string; bgType: 'image' | 'video' }
  | { type: 'CLEAR_BG' }
  | { type: 'SET_WALLPAPER_DIM'; dim: number }
  | { type: 'SET_WALLPAPER_DIM'; dim: number }
  | { type: 'SET_TERM_SCHEME'; scheme: string }
  | { type: 'TOGGLE_GAMBIT' }
  | { type: 'SET_GAMBIT_DRAFT'; id: string; draft: string }
  | { type: 'SET_PANE_TOOL'; tabId: string; paneIdx: number; tool: ToolType; toolData?: string; folderPath?: string | null }
  | { type: 'SET_PANE_SENTINEL'; tabId: string; paneIdx: number; enabled: boolean }
  | { type: 'SET_PANE_COMPLETION'; tabId: string; paneIdx: number; ts: number }
  | { type: 'TOGGLE_LEFT_PANEL' }
  | { type: 'TOGGLE_RIGHT_PANEL' }
  | { type: 'SET_MULTI_AGENT_LAYOUT'; layout: 'grid' | 'columns' };

// ─── Reducer ─────────────────────────────────────────────────────────────────

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'SET_FOLDER':
      // Persist as the "last folder" so a fresh launch lands here instead
      // of the C-drive default. Read back in getInitialState().
      {
        const path = normalizeFolderPath(action.path);
        try { localStorage.setItem('cc-folder', path); } catch {}
        const recentFolders = pushRecentFolder(state.recentFolders, path);
        return {
          ...state,
          recentFolders,
          terminals: state.terminals.map(t => t.id === state.activeTerminalId ? { ...t, folderPath: path } : t)
        };
      }
    case 'CLEAR_FOLDER':
      try { localStorage.removeItem('cc-folder'); } catch {}
      return {
        ...state,
        terminals: state.terminals.map(t => t.id === state.activeTerminalId ? { ...t, folderPath: null } : t)
      };
    case 'SET_THEME':
      return { ...state, currentTheme: action.theme };
    case 'SET_SHAPE':
      return { ...state, currentShape: action.shape };
    case 'SET_ICON_THEME':
      return { ...state, iconTheme: action.theme };
    case 'SET_LANG':
      return { ...state, currentLang: action.lang };
    case 'ADD_TERMINAL':
      console.debug('[app-state] ADD_TERMINAL', action.session);
      return { 
        ...state, 
        terminals: [...state.terminals, action.session],
        activeTerminalId: action.session.id 
      };
    case 'REMOVE_TERMINAL': {
      let newTerminals = state.terminals.filter(t => t.id !== action.id);
      let newActiveId = state.activeTerminalId;
      
      if (newTerminals.length === 0) {
        const defaultId = crypto.randomUUID();
        const folderPath = state.terminals.length > 0 ? state.terminals[0].folderPath : null;
        newTerminals = [{ id: defaultId, tool: null, folderPath }];
        newActiveId = defaultId;
      } else if (state.activeTerminalId === action.id) {
         newActiveId = newTerminals[newTerminals.length - 1].id;
      }
      return { ...state, terminals: newTerminals, activeTerminalId: newActiveId };
    }
    case 'SET_ACTIVE_TERMINAL':
      console.debug('[app-state] SET_ACTIVE_TERMINAL', action.id);
      return { ...state, activeTerminalId: action.id };
    case 'SET_TERMINAL_TOOL':
      console.debug('[app-state] SET_TERMINAL_TOOL', {
        id: action.id,
        tool: action.tool,
        hasToolData: !!action.toolData,
      });
      return {
        ...state,
        terminals: state.terminals.map(t => t.id === action.id ? { ...t, tool: action.tool, toolData: action.toolData } : t)
      };
    case 'SET_TERMINAL_HIDDEN':
      return {
        ...state,
        terminals: state.terminals.map(t => t.id === action.id ? { ...t, isHidden: action.isHidden } : t)
      };
    case 'RESTART_TERMINAL':
      console.debug('[app-state] RESTART_TERMINAL', action);
      return {
        ...state,
        terminals: state.terminals.map(t =>
          t.id === action.id ? { ...t, id: action.newId } : t
        ),
        activeTerminalId: state.activeTerminalId === action.id ? action.newId : state.activeTerminalId
      };
    case 'OPEN_HISTORY_TAB': {
      const existingHistoryTab = state.terminals.find(t => t.tool === 'history');
      if (existingHistoryTab) {
        return {
          ...state,
          terminals: state.terminals.map(t =>
            t.id === existingHistoryTab.id ? { ...t, toolData: action.sessionData, folderPath: action.folderPath } : t
          ),
          activeTerminalId: existingHistoryTab.id
        };
      } else {
        const newId = crypto.randomUUID();
        return {
          ...state,
          terminals: [...state.terminals, {
            id: newId,
            tool: 'history',
            toolData: action.sessionData,
            folderPath: action.folderPath,
          }],
          activeTerminalId: newId
        };
      }
    }
    case 'OPEN_HYPER_AGENT_TAB': {
      // Singleton tab — like history. Bypasses the 5-tab cap because
      // Hyper-Agent is a system panel (MCP admin endpoint), not a
      // user workspace. Reuse the existing one if already open;
      // otherwise append a new tab and focus it.
      const existing = state.terminals.find(t => t.tool === 'hyper-agent');
      if (existing) {
        return { ...state, activeTerminalId: existing.id };
      }
      const newId = crypto.randomUUID();
      return {
        ...state,
        terminals: [...state.terminals, { id: newId, tool: 'hyper-agent', folderPath: null }],
        activeTerminalId: newId,
      };
    }
    case 'SET_AGENT_STATUS':
      if (typeof action.id !== 'string' || action.id.length === 0) {
        return state;
      }
      {
        let changed = false;
        const terminals = state.terminals.map(t => {
          if (t.id === action.id) {
            if (t.agentStatus === action.status) return t;
            changed = true;
            return { ...t, agentStatus: action.status };
          }
          if (!t.multiAgent) return t;
          const panePrefix = `${t.id}::pane-`;
          if (!action.id.startsWith(panePrefix)) return t;
          const paneIdx = parseInt(action.id.slice(panePrefix.length), 10);
          if (!Number.isFinite(paneIdx)) return t;
          let paneChanged = false;
          const panes = t.multiAgent.panes.map(p => {
            if (p.paneIdx !== paneIdx) return p;
            if (p.agentStatus === action.status) return p;
            paneChanged = true;
            return { ...p, agentStatus: action.status };
          });
          if (!paneChanged) return t;
          changed = true;
          return { ...t, multiAgent: { panes } };
        });
        return changed ? { ...state, terminals } : state;
      }
    case 'SET_BG':
      return { ...state, bgPath: action.path, bgType: action.bgType };
    case 'CLEAR_BG':
      return { ...state, bgPath: '', bgType: 'none' };
    case 'SET_WALLPAPER_DIM':
      return { ...state, wallpaperDim: Math.max(0, Math.min(80, action.dim)) };
    case 'SET_TERM_SCHEME':
      return { ...state, termColorScheme: action.scheme };
    case 'TOGGLE_GAMBIT':
      return { ...state, gambitOpen: !state.gambitOpen };
    case 'SET_GAMBIT_DRAFT':
      return {
        ...state,
        terminals: state.terminals.map(t => t.id === action.id ? { ...t, gambitDraft: action.draft } : t)
      };
    case 'SET_PANE_TOOL': {
      // Seed a MultiAgentState lazily on the first pane selection so
      // quadrant tabs don't need a separate enable-step ? point of entry
      // is the user clicking a CLI button in any empty pane slot.
      let changed = false;
      const terminals = state.terminals.map(t => {
        if (t.id !== action.tabId) return t;
        const existing = t.multiAgent?.panes
          ?? ([1, 2, 3, 4].map(i => ({ paneIdx: i, tool: null as ToolType })) as MultiAgentPane[]);
        let paneChanged = false;
        const panes = existing.map(p => {
          if (p.paneIdx !== action.paneIdx) return p;
          const nextFolderPath = action.folderPath !== undefined
            ? action.folderPath
            : (action.tool === null ? null : p.folderPath);
          // Load-bearing default:
          // In coordinated multi-agent tabs, AI panes (Claude/Codex/Gemini/OpenCode)
          // need sentinelEnabled=true at first launch, otherwise the backend
          // intentionally suppresses per-pane MCP injection and the pane comes
          // up in a confusing half-configured state: profile/skills may exist,
          // but live coffee-cli tools (whoami/list_panes/send_to_pane/...) do not.
          // Keep four-split / plain terminal tabs untouched.
          const shouldAutoEnableSentinel = (
            t.tool !== null
            && tabUsesCoordinatedMultiAgentMcp(t.tool)
            && action.tool !== null
            && toolGetsPaneMcpByDefault(action.tool)
          );
          const nextSentinelEnabled = action.tool === null
            ? p.sentinelEnabled
            : (shouldAutoEnableSentinel ? true : p.sentinelEnabled);
          if (
            p.tool === action.tool
            && p.toolData === action.toolData
            && p.folderPath === nextFolderPath
            && p.sentinelEnabled === nextSentinelEnabled
          ) {
            return p;
          }
          paneChanged = true;
          return {
            ...p,
            tool: action.tool,
            toolData: action.toolData,
            folderPath: nextFolderPath,
            sentinelEnabled: nextSentinelEnabled,
          };
        });
        if (!paneChanged) return t;
        changed = true;
        return { ...t, multiAgent: { panes } };
      });
      return changed ? { ...state, terminals } : state;
    }
    case 'SET_PANE_SENTINEL': {
      let changed = false;
      const terminals = state.terminals.map(t => {
        if (t.id !== action.tabId) return t;
        const existing = t.multiAgent?.panes
          ?? ([1, 2, 3, 4].map(i => ({ paneIdx: i, tool: null as ToolType })) as MultiAgentPane[]);
        let paneChanged = false;
        const panes = existing.map(p => {
          if (p.paneIdx !== action.paneIdx) return p;
          if (p.sentinelEnabled === action.enabled) return p;
          paneChanged = true;
          return { ...p, sentinelEnabled: action.enabled };
        });
        if (!paneChanged) return t;
        changed = true;
        return { ...t, multiAgent: { panes } };
      });
      return changed ? { ...state, terminals } : state;
    }
    case 'SET_PANE_COMPLETION': {
      let changed = false;
      const terminals = state.terminals.map(t => {
        if (t.id !== action.tabId) return t;
        if (!t.multiAgent) return t;
        let paneChanged = false;
        const panes = t.multiAgent.panes.map(p => {
          if (p.paneIdx !== action.paneIdx) return p;
          if (p.completionTs === action.ts) return p;
          paneChanged = true;
          return { ...p, completionTs: action.ts };
        });
        if (!paneChanged) return t;
        changed = true;
        return { ...t, multiAgent: { panes } };
      });
      return changed ? { ...state, terminals } : state;
    }
    case 'TOGGLE_LEFT_PANEL': {
      const next = !state.leftPanelHidden;
      try { localStorage.setItem('cc-left-hidden', next ? '1' : '0'); } catch {}
      return { ...state, leftPanelHidden: next };
    }
    case 'TOGGLE_RIGHT_PANEL': {
      const next = !state.rightPanelHidden;
      try { localStorage.setItem('cc-right-hidden', next ? '1' : '0'); } catch {}
      return { ...state, rightPanelHidden: next };
    }
    case 'SET_MULTI_AGENT_LAYOUT': {
      try { localStorage.setItem('cc-ma-layout', action.layout); } catch {}
      return { ...state, multiAgentLayout: action.layout };
    }
    default:
      return state;
  }
}

// ─── Initial State ────────────────────────────────────────────────────────────

const VALID_THEMES: ThemeColor[] = [
  'dark', 'light', 'cappuccino', 'sakura', 'lavender', 'mint',
  'obsidian', 'cobalt', 'moss',
];
const VALID_SHAPES: ThemeShape[] = ['soft', 'slab', 'sharp', 'glass', 'panel'];
const VALID_ICON_THEMES: IconTheme[] = [
  'outline', 'material', 'vscode-icons', 'catppuccin-mocha',
  'devicon', 'fluent', 'symbols', 'coffee',
];

const RECENT_FOLDERS_KEY = 'cc-recent-folders';
const RECENT_FOLDERS_LIMIT = 10;

function normalizeFolderPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return '';
  return trimmed.replace(/\\/g, '/').replace(/\/+$/, '') || trimmed;
}

function pushRecentFolder(recentFolders: string[], path: string): string[] {
  const normalized = normalizeFolderPath(path);
  if (!normalized) return recentFolders;
  const next = [
    normalized,
    ...recentFolders.filter(p => normalizeFolderPath(p) !== normalized),
  ].slice(0, RECENT_FOLDERS_LIMIT);
  try { localStorage.setItem(RECENT_FOLDERS_KEY, JSON.stringify(next)); } catch {}
  return next;
}

function loadRecentFolders(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_FOLDERS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((p): p is string => typeof p === 'string' && normalizeFolderPath(p).length > 0)
      .map(normalizeFolderPath)
      .filter((p, idx, arr) => arr.indexOf(p) === idx)
      .slice(0, RECENT_FOLDERS_LIMIT);
  } catch {
    return [];
  }
}

function getInitialState(): AppState {
  let theme: ThemeColor = 'dark';
  let shape: ThemeShape = 'panel';
  let iconTheme: IconTheme = 'devicon';
  let lang = 'zh-CN';
  let folderPath: string | null = null;

  try {
    const savedTheme = localStorage.getItem('cc-theme') as ThemeColor | null;
    if (savedTheme && VALID_THEMES.includes(savedTheme)) theme = savedTheme;
  } catch {}

  try {
    const savedShape = localStorage.getItem('cc-shape') as ThemeShape | null;
    if (savedShape && VALID_SHAPES.includes(savedShape)) shape = savedShape;
  } catch {}

  try {
    const savedIconTheme = localStorage.getItem('cc-icon-theme') as IconTheme | null;
    if (savedIconTheme && VALID_ICON_THEMES.includes(savedIconTheme)) iconTheme = savedIconTheme;
  } catch {}

  try {
    const savedFolder = localStorage.getItem('cc-folder');
    folderPath = savedFolder ? normalizeFolderPath(savedFolder) : null;
  } catch {}
  const recentFolders = folderPath
    ? pushRecentFolder(loadRecentFolders(), folderPath)
    : loadRecentFolders();

  try {
    const savedLang = localStorage.getItem('cc-lang');
    if (savedLang) lang = savedLang;
  } catch {}

  // No factory-default wallpaper — the bundled /wallpapers/default.png
  // didn't load reliably across platforms (Linux WebKit asset URL
  // resolution diverges from Windows/macOS WebView2/WKWebView), so a
  // chunk of new users saw a black panel and assumed wallpaper was
  // broken. Default is now an empty wallpaper; users who want one pick
  // their own via the theme menu.
  let bgPath = '';
  let bgType: 'image' | 'video' | 'none' = 'none';
  let termColorScheme = '';
  let wallpaperDim = 30;
  try {
    const storedPath = localStorage.getItem('cc-bg-path');
    const storedType = localStorage.getItem('cc-bg-type') as 'image' | 'video' | 'none' | null;

    // Migration: clear legacy seeded /wallpapers/default.png from
    // existing installs so they don't keep trying to load a file we
    // no longer ship. Anything else (user-picked) is preserved.
    if (storedPath && storedPath.startsWith('/wallpapers/')) {
      bgPath = '';
      bgType = 'none';
      try {
        localStorage.removeItem('cc-bg-path');
        localStorage.removeItem('cc-bg-type');
        localStorage.removeItem('cc-bg-init');
      } catch {}
    } else {
      bgPath = storedPath || '';
      bgType = storedType || 'none';
    }

    termColorScheme = localStorage.getItem('cc-term-scheme') || '';
    const savedDim = localStorage.getItem('cc-wallpaper-dim');
    if (savedDim !== null) {
      const n = parseInt(savedDim, 10);
      if (!Number.isNaN(n) && n >= 0 && n <= 80) wallpaperDim = n;
    }
  } catch {}

  const defaultTerminalId = crypto.randomUUID();

  let leftPanelHidden = false;
  let rightPanelHidden = false;
  let multiAgentLayout: 'grid' | 'columns' = 'grid';
  try {
    leftPanelHidden = localStorage.getItem('cc-left-hidden') === '1';
    rightPanelHidden = localStorage.getItem('cc-right-hidden') === '1';
    const savedLayout = localStorage.getItem('cc-ma-layout');
    if (savedLayout === 'columns' || savedLayout === 'grid') multiAgentLayout = savedLayout;
  } catch {}

  return {
    currentTheme: theme,
    currentShape: shape,
    iconTheme,
    currentLang: lang,
    bgPath,
    bgType,
    wallpaperDim,
    termColorScheme,
    terminals: [{ id: defaultTerminalId, tool: null, folderPath }],
    activeTerminalId: defaultTerminalId,
    recentFolders,
    gambitOpen: false,
    leftPanelHidden,
    rightPanelHidden,
    multiAgentLayout,
  };
}

// ─── Context ─────────────────────────────────────────────────────────────────
//
// Two separate contexts so components that only need to dispatch (not read
// state) don't get re-rendered on every state change. This is what lets the
// React.memo'd TierTerminal skip re-renders when unrelated state updates fire.

const StateContext = createContext<AppState | null>(null);
const DispatchContext = createContext<React.Dispatch<Action> | null>(null);

// Kept for backward compatibility with existing consumers that read both
// state and dispatch from a single hook. New code should prefer the split
// hooks below.
const AppContext = createContext<{
  state: AppState;
  dispatch: React.Dispatch<Action>;
} | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, getInitialState);
  // The combined-context value has to be recomputed whenever state changes,
  // so keeping the split contexts lets hot components subscribe only to the
  // half they care about.
  const combined = { state, dispatch };
  return (
    <DispatchContext.Provider value={dispatch}>
      <StateContext.Provider value={state}>
        <AppContext.Provider value={combined}>
          {children}
        </AppContext.Provider>
      </StateContext.Provider>
    </DispatchContext.Provider>
  );
}

export function useAppState() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useAppState must be inside AppProvider');
  return ctx;
}

/**
 * Dispatch-only hook for components that don't need to read state.
 *
 * Components using this hook do NOT re-render when state changes — the
 * DispatchContext value (the dispatch function itself) is stable across
 * every render, so useContext never triggers a subscription update.
 *
 * Use this in any hot-path component (e.g. TierTerminal) that reads all of
 * its state via props and only needs to call dispatch() in event handlers.
 */
export function useAppDispatch(): React.Dispatch<Action> {
  const ctx = useContext(DispatchContext);
  if (!ctx) throw new Error('useAppDispatch must be inside AppProvider');
  return ctx;
}
