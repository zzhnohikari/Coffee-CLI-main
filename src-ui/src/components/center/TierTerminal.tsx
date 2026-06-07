// TierTerminal.tsx — xterm.js terminal renderer with PTY backend.
//
// Pure terminal — no text interception, no overlay. Output from the child
// process is piped byte-for-byte to xterm.
//
// Perf note: this component is wrapped in React.memo at the bottom of this
// file. All state that affects rendering is passed in via props so that
// unrelated global state changes (agent status, other tabs' folder changes,
// etc.) don't cascade into this component.

import { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { clipboardRead, clipboardWrite } from '../../lib/clipboard';
import { subscribeTerminalEvents } from '../../lib/pty-event-bus';
import { registerTerminalFocus } from '../../lib/focus-registry';
import { registerTabActions, getTabActions } from '../../lib/tab-actions';
import { registerFileDropTarget, formatPathsForInsert } from '../../lib/file-drop';
import { notifyUserInputSubmitted } from '../../lib/agent-status-bus';
import { commands } from '../../tauri';
import { decodePaneResumePayload } from '../../lib/pane-resume';
import { useAppDispatch, type ToolType, type ThemeColor } from '../../store/app-state';
import { useT } from '../../i18n/useT';
import '@xterm/xterm/css/xterm.css';
import './TierTerminal.css';

// Installer scripts are fetched at runtime from CF (hot-updatable, no release needed).
// Falls back to GitHub raw if CF is unreachable.
// ─── Terminal Color Schemes ──────────────────────────────────────────────────
// Full ANSI palettes for readability on different wallpapers.
// "default" = use built-in warm theme, no override.

// Each scheme overrides ONLY the terminal foreground (and matching cursor)
// color. The 16 ANSI palette stays whatever the active theme provides, so
// switching schemes only re-tints the text — no full theme swap, no style
// shift. The chip's own swatch in the picker reuses the same fg value.
export interface TermColorScheme {
  id: string;
  fg: string;
}

export const TERM_COLOR_SCHEMES: TermColorScheme[] = [
  { id: 'red',    fg: '#ff5252' },
  { id: 'orange', fg: '#ff8a00' },
  { id: 'yellow', fg: '#ffd740' },
  { id: 'green',  fg: '#69f0ae' },
  { id: 'cyan',   fg: '#18ffff' },
  { id: 'blue',   fg: '#448aff' },
  { id: 'pink',   fg: '#ff4081' },
  { id: 'purple', fg: '#b388ff' },
];

// Mirror of `--bg-terminal` from global.css. Kept in JS so the terminal can
// pick the right background synchronously on theme prop change — reading the
// CSS variable lags by one switch (child effects fire before App.tsx writes
// `data-theme`). Must stay in sync with each [data-theme] block in global.css.
// Dark themes follow "terminal bg == bg-app" for a continuous surface.
// Light theme deliberately uses a softer cream than --bg-app: pure ivory
// #FAFAF7 is too bright for CLI mid-tone palettes (Claude Code's RGB tan
// branding, ANSI bright-black), and going too gray makes those same colors
// vanish. #eeebe2 keeps the daytime feel while giving dark + gray text
// 5–12:1 contrast so primary/secondary copy stays legible.
const THEME_TERMINAL_BG: Record<string, string> = {
  dark:       '#1a1917',
  light:      '#eeebe2',
  cappuccino: '#1a1a1a',
  sakura:     '#1a1520',
  lavender:   '#1a1826',
  mint:       '#0f1e1c',
  obsidian:   '#0a0a0a',
  cobalt:     '#0a1020',
  moss:       '#0b1612',
};

// Collapse any mix of CRLF / bare CR into plain LF before handing text to
// xterm.paste. Windows puts CRLF into the clipboard and most TUIs on the
// other side of the PTY treat the CR as an "Enter" (submit) keystroke —
// so a 5-line paste becomes 5 submissions plus 5 visible blank lines.
// Normalizing here gives every paste path a single line-ending contract
// regardless of where the clipboard text originally came from
// (Notepad / browser / another terminal / macOS / Linux).
function normalizePasteNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

function buildXtermTheme(themeName: string, hasBg: boolean | undefined, hideCursor: boolean, schemeId?: string) {
  const isDark = themeName !== 'light';
  const scheme = schemeId ? TERM_COLOR_SCHEMES.find(s => s.id === schemeId) : undefined;
  const bgOpaque = THEME_TERMINAL_BG[themeName] || (isDark ? '#0c0c0c' : '#eeebe2');
  const bg = hasBg ? 'rgba(0,0,0,0)' : bgOpaque;

  // Build the default warm palette first (full 16 ANSI colors), then let
  // the scheme — if any — re-tint only the foreground and cursor.
  const defaultFg = isDark ? '#e8e4de' : '#2d2c2a';
  const fg = scheme?.fg ?? defaultFg;

  const base = isDark ? {
    selectionBackground: 'rgba(196,149,106,0.3)',
    black: '#0c0c0c', red: '#e07070', green: '#7ec77e', yellow: '#d4a846',
    blue: '#78a8d4', magenta: '#b07cc6', cyan: '#5fc4c0', white: '#e8e4de',
    brightBlack: '#6b6762',
  } : {
    selectionBackground: 'rgba(196,149,106,0.25)',
    black: '#2d2c2a', red: '#cc3333', green: '#2d7a2d', yellow: '#8a6000',
    blue: '#2952a3', magenta: '#7a3d8a', cyan: '#1a6b6b', white: '#f4f3ee',
    brightBlack: '#5a5854',
  };

  return {
    ...base,
    background: bg,
    foreground: fg,
    cursor: hideCursor ? bgOpaque : fg,
    cursorAccent: bgOpaque,
  };
}


// Sessions being detached to a new window — skip kill on unmount
export const detachedSessions = new Set<string>();

// ─── Terminal Context Menu ────────────────────────────────────────────────────

interface CtxMenu { x: number; y: number; hasSelection: boolean; }

function TermContextMenu({ menu, onClose, onCopy, onPaste, onSelectAll }: {
  menu: CtxMenu;
  onClose: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onSelectAll: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const isMac = navigator.platform.toUpperCase().includes('MAC');
  const t = useT();
  const mod = isMac ? '⌘' : 'Ctrl';

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const closeKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    // Delay so the triggering mousedown doesn't immediately close the menu
    const t = setTimeout(() => {
      document.addEventListener('mousedown', close);
      document.addEventListener('keydown', closeKey);
    }, 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', closeKey);
    };
  }, [onClose]);

  // Clamp to viewport so menu never overflows off-screen
  const left = Math.min(menu.x, window.innerWidth  - 164);
  const top  = Math.min(menu.y, window.innerHeight - 116);

  return createPortal(
    <div ref={ref} className="term-ctx-menu" style={{ left, top }}>
      <button
        className={`term-ctx-item${menu.hasSelection ? '' : ' disabled'}`}
        onMouseDown={(e) => { e.preventDefault(); if (menu.hasSelection) onCopy(); }}
      >
        <span>{t('menu.copy')}</span><kbd>{mod}+C</kbd>
      </button>
      <button
        className="term-ctx-item"
        onMouseDown={(e) => { e.preventDefault(); onPaste(); }}
      >
        <span>{t('menu.paste')}</span><kbd>{mod}+V</kbd>
      </button>
      <div className="term-ctx-sep" />
      <button
        className="term-ctx-item"
        onMouseDown={(e) => { e.preventDefault(); onSelectAll(); }}
      >
        <span>{t('menu.select_all')}</span><kbd>{mod}+A</kbd>
      </button>
    </div>,
    document.body,
  );
}

interface TierTerminalProps {
  sessionId: string;
  tool: ToolType;
  /** Display name of the tool (from the local built-in catalog). Used by
   * splash + launch-failed panels; lets the splash show a friendly name
   * even for agents that aren't in the hardcoded `toolLabel` fallback. */
  toolName?: string;
  theme: ThemeColor;
  lang: string;
  isActive: boolean;
  toolData?: string;
  folderPath?: string | null;
  hasBg?: boolean;
  bgUrl?: string;
  bgType?: 'image' | 'video' | 'none';
  termColorScheme?: string;
  /** Multi-agent only. When true, the backend wires this pane's
   *  `coffee-cli` MCP server + injects the cross-pane protocol prompt
   *  into the CLI's system instructions. When false (default), the
   *  pane runs hands-free but with NO peer awareness — it shares only
   *  the workspace folder with sibling panes. Ignored outside
   *  multi-agent grids (single-terminal tabs always pass false). */
  sentinelEnabled?: boolean;
}

// ─── Component ───────────────────────────────────────────────────────────────

function TierTerminalImpl({
  sessionId, tool, toolName, theme, lang, isActive, toolData, folderPath, hasBg, bgUrl, bgType, termColorScheme, sentinelEnabled,
}: TierTerminalProps) {
  // Dispatch-only subscription. Never re-renders this component.
  const dispatch = useAppDispatch();

  const termRef  = useRef<HTMLDivElement>(null);
  const wrapRef  = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitRef   = useRef<FitAddon | null>(null);
  const hiddenOutputQueueRef = useRef<string[]>([]);
  const hiddenOutputBytesRef = useRef(0);
  const hiddenOutputTruncatedRef = useRef(false);
  const flushHiddenRafRef = useRef<number | null>(null);

  // ── Startup splash state ─────────────────────────────────────────────────
  const [showSplash, setShowSplash] = useState(true);
  const [splashFading, setSplashFading] = useState(false);
  const splashStartRef = useRef(Date.now());
  const altScreenRef = useRef(false); // True when TUI enters alternate screen buffer

  // ── Launch failure detection ─────────────────────────────────────────────
  const hasOutputRef = useRef(false); // Set to true when PTY emits visible output
  const [processExited, setProcessExited] = useState(false);
  const [startFailed, setStartFailed] = useState(false);
  // True when the child died with a non-zero exit code. Drives the failure
  // banner; on code 0 (user typed /exit or Ctrl+D) we render nothing because
  // the user ended the session deliberately and doesn't need to be told.
  const [exitFailed, setExitFailed] = useState(false);
  // First exit event to arrive (onExit from child-watcher, or onStatus from
  // reader EOF) wins the right to write the "[Process exited]" scrollback
  // line. Prevents duplication when both fire. The child-watcher's onExit
  // typically arrives first with the real exit code; reader-EOF onStatus
  // then arrives with a hardcoded 0 and correctly becomes a no-op.
  const exitMessageWrittenRef = useRef(false);

  const MAX_HIDDEN_OUTPUT_BYTES = 512 * 1024;
  const HIDDEN_FLUSH_CHUNK_BYTES = 64 * 1024;

  const isTerminalActuallyVisible = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return false;
    if (el.offsetParent === null) return false;
    const rect = el.getBoundingClientRect();
    return rect.width >= 10 && rect.height >= 10;
  }, []);

  const enqueueHiddenOutput = useCallback((data: string) => {
    if (!data) return;
    hiddenOutputQueueRef.current.push(data);
    hiddenOutputBytesRef.current += data.length;
    while (hiddenOutputBytesRef.current > MAX_HIDDEN_OUTPUT_BYTES && hiddenOutputQueueRef.current.length > 0) {
      const removed = hiddenOutputQueueRef.current.shift();
      if (removed) hiddenOutputBytesRef.current -= removed.length;
      hiddenOutputTruncatedRef.current = true;
    }
  }, []);

  const flushHiddenOutput = useCallback(() => {
    if (flushHiddenRafRef.current !== null) return;
    const run = () => {
      flushHiddenRafRef.current = null;
      const term = xtermRef.current;
      if (!term || !isTerminalActuallyVisible()) return;
      let budget = HIDDEN_FLUSH_CHUNK_BYTES;
      let chunk = '';
      if (hiddenOutputTruncatedRef.current) {
        chunk += '\r\n\x1b[33m[output truncated while tab was hidden]\x1b[0m\r\n';
        hiddenOutputTruncatedRef.current = false;
      }
      while (hiddenOutputQueueRef.current.length > 0 && budget > 0) {
        const next = hiddenOutputQueueRef.current[0];
        if (next.length <= budget) {
          chunk += next;
          hiddenOutputQueueRef.current.shift();
          hiddenOutputBytesRef.current -= next.length;
          budget -= next.length;
        } else {
          chunk += next.slice(0, budget);
          hiddenOutputQueueRef.current[0] = next.slice(budget);
          hiddenOutputBytesRef.current -= budget;
          budget = 0;
        }
      }
      if (chunk) term.write(chunk);
      if (hiddenOutputQueueRef.current.length > 0) {
        flushHiddenRafRef.current = requestAnimationFrame(run);
      }
    };
    flushHiddenRafRef.current = requestAnimationFrame(run);
  }, [isTerminalActuallyVisible]);

  const writeOrBufferTerminalOutput = useCallback((data: string) => {
    if (!data) return;
    if (isTerminalActuallyVisible() && hiddenOutputQueueRef.current.length === 0 && !hiddenOutputTruncatedRef.current) {
      xtermRef.current?.write(data);
      return;
    }
    enqueueHiddenOutput(data);
    if (isTerminalActuallyVisible()) flushHiddenOutput();
  }, [enqueueHiddenOutput, flushHiddenOutput, isTerminalActuallyVisible]);

  // ── Terminal context menu ────────────────────────────────────────────────
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);
  const closeCtxMenu = useCallback(() => setCtxMenu(null), []);

  const t = useT();

  const toolLabel: Record<string, string> = {
    claude: 'Claude Code',
    qwen: 'Qwen Code', hermes: 'Hermes Agent', opencode: 'OpenCode', openclaw: 'OpenClaw',
    codex: 'Codex CLI', gemini: 'Gemini CLI',
    remote: t('tool.remote'), terminal: t('tool.terminal'),
  };

  // ── xterm.js init ────────────────────────────────────────────────────────

  useEffect(() => {
    if (!termRef.current || xtermRef.current) return;

    let mounted = true;
    const unlisteners: (() => void)[] = [];

    const isLinux = navigator.userAgent.toLowerCase().includes('linux');
    const isMac = navigator.userAgent.toLowerCase().includes('mac');
    // Embedded CascadiaMono (woff2) guarantees consistent box-drawing glyphs on
    // every platform — no more border misalignment from font-fallback jitter.
    // Platform-native fonts remain as fallbacks if the embedded font fails to load.
    //
    // Nerd Font names are inserted right after CascadiaMono so per-character
    // font fallback covers the Unicode private-use-area glyphs (powerline
    // separators, git/branch icons, etc.) that oh-my-posh / starship / p10k
    // emit and that CascadiaMono lacks. Users who haven't installed a Nerd
    // Font see no change (these names just don't resolve); users who have
    // installed one — which oh-my-posh's setup explicitly tells them to do —
    // automatically get the missing glyphs without us bundling a 5 MB font.
    const NERD_FONTS = "'CaskaydiaCove Nerd Font', 'JetBrainsMono Nerd Font', 'MesloLGS NF', 'FiraCode Nerd Font', 'Hack Nerd Font'";
    const fontFamily = isLinux
      ? `CascadiaMono, ${NERD_FONTS}, 'Ubuntu Mono', 'Noto Sans Mono', 'DejaVu Sans Mono', 'Liberation Mono', monospace`
      : isMac
        ? `CascadiaMono, ${NERD_FONTS}, ui-monospace, Menlo, Monaco, 'Courier New', monospace`
        : `CascadiaMono, ${NERD_FONTS}, 'Cascadia Mono', Consolas, 'Courier New', monospace`;
    const term = new Terminal({
      fontFamily,
      fontSize: 14,
      lineHeight: 1.3,
      letterSpacing: 0,
      fontWeight: '400',
      fontWeightBold: '400', // Prevent bold glyphs from using wider metrics
      // allowTransparency forces the WebGL compositor through an extra blend
      // pass on every frame. Only enable when there is actually a wallpaper
      // behind the terminal — opaque background is the common case and pays
      // measurably less GPU time on Apple Silicon / integrated GPUs.
      allowTransparency: hasBg,
      customGlyphs: true, // Pixel-perfect box-drawing on all platforms (canvas-drawn, font-independent)
      rescaleOverlappingGlyphs: true, // Force ambiguous-width chars (block chars ▀▄█) to single cell width
      cursorStyle: 'bar' as const,
      // Cursor blink fires a GPU repaint every ~530ms for the entire app
      // lifetime. On laptops (especially Apple Silicon Air without a fan)
      // that's a constant power draw users feel as warmth. Off by default.
      cursorBlink: false,
      scrollback: 5000,
      theme: buildXtermTheme(theme, hasBg, tool === 'claude', termColorScheme),
    });

    const fit = new FitAddon();
    term.loadAddon(fit);

    // Register focus function in the singleton focus registry.
    // CenterPanel handles the global focusin/mouseup listener and routes
    // focus to the active terminal — each tab no longer needs its own pair
    // of window listeners.
    const unregisterFocus = registerTerminalFocus(sessionId, () => {
      xtermRef.current?.focus();
    });

    // Wait for CascadiaMono to load before opening the terminal so xterm
    // measures cell metrics with the correct font (avoids box-drawing misalignment).
    const fontReady = document.fonts.load('14px CascadiaMono').catch(() => {});
    const initTerminal = async () => {
      await fontReady;
      if (!mounted || !termRef.current) return;

      term.open(termRef.current);

      // Disable font ligatures on the DOM renderer rows to prevent
      // box-drawing characters from being merged into ligature glyphs.
      const xtermRows = termRef.current.querySelector('.xterm-rows') as HTMLElement | null;
      if (xtermRows) xtermRows.style.fontVariantLigatures = 'none';

    // GPU-accelerated rendering: WebGL is required for customGlyphs +
    // rescaleOverlappingGlyphs (correct ASCII art / Claude mascot / box
    // border alignment). DOM renderer silently drops those options AND
    // burns ~100% CPU per terminal under AI-CLI token streams.
    //
    // The only veto is software rasterization (llvmpipe, swrast,
    // SwiftShader, Mesa offscreen) — typically headless / VM Linux where
    // WebGL silently falls back to CPU. Modern integrated GPUs (Apple
    // M-series, Intel Iris Xe, AMD APU) handle xterm WebGL fine; the
    // older "dedicated-GPU only" gate was misclassifying Apple Silicon
    // and Intel UHD laptops as DOM-only and tanking their CPU.
    let useWebgl = false;
    try {
      const testCanvas = document.createElement('canvas');
      const gl = testCanvas.getContext('webgl') || testCanvas.getContext('experimental-webgl');
      if (gl) {
        const debugExt = (gl as WebGLRenderingContext).getExtension('WEBGL_debug_renderer_info');
        if (debugExt) {
          const renderer = (gl as WebGLRenderingContext).getParameter(debugExt.UNMASKED_RENDERER_WEBGL) as string;
          const isSoftware = /llvmpipe|softpipe|swrast|swiftshader|software|microsoft basic render|mesa offscreen/i.test(renderer);
          useWebgl = !isSoftware;
          console.log(`[TierTerminal] GPU: ${renderer} → ${useWebgl ? 'WebGL' : 'DOM'} (software=${isSoftware})`);
        } else {
          // No debug extension — assume the GPU is real. Modern browsers
          // hide UNMASKED_RENDERER_WEBGL behind a privacy flag in some
          // contexts; defaulting to DOM here was the old behavior and
          // caused the same per-window CPU spike on locked-down builds.
          useWebgl = true;
          console.log('[TierTerminal] GPU info hidden → WebGL (assuming hardware acceleration)');
        }
      } else {
        console.log('[TierTerminal] WebGL unavailable → DOM renderer');
      }
    } catch {
      console.warn('[TierTerminal] WebGL probe failed → DOM renderer');
    }

    // Always use WebGL renderer when possible — DOM renderer does NOT support
    // customGlyphs or rescaleOverlappingGlyphs, causing ASCII art (Claude mascot,
    // box borders) to misalign. WebGL supports allowTransparency for wallpapers.
    if (useWebgl) {
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => { webgl.dispose(); });
        term.loadAddon(webgl);
      } catch (err) {
        console.error('[TierTerminal] WebGL instantiation failed, falling back to DOM renderer', err);
      }
    }

    fit.fit();

    // Forward keyboard input to Rust PTY backend
    term.onData((data) => {
      commands.tierTerminalInput(sessionId, data).catch(() => {});
      // Optimistic status update — Dynamic Island style. A newline means
      // the user just submitted; turn the dot to "executing" immediately
      // so the UI reacts before any hook event arrives. Scoped to Claude
      // only — the other CLIs have a steady "executing" pulse and don't
      // consume agentStatus, so emitting for them is wasted dispatch.
      if ((data.includes('\r') || data.includes('\n')) && tool === 'claude') {
        notifyUserInputSubmitted(sessionId, tool);
      }
    });

    // Handle native Copy/Paste shortcuts
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown') {
        const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
        const cmdOrCtrl = isMac ? e.metaKey : e.ctrlKey;

        // Copy: Ctrl+C / Cmd+C — only when text is selected (otherwise send SIGINT).
        if (cmdOrCtrl && e.code === 'KeyC') {
          if (term.hasSelection()) {
            clipboardWrite(term.getSelection());
            return false;
          }
        }

        // Paste: Ctrl+V / Cmd+V
        // IMPORTANT: e.preventDefault() stops the browser's native paste
        // event from firing after keydown — without it, xterm's built-in
        // paste handler ALSO fires on the same keystroke, inserting the
        // clipboard text twice.
        if (cmdOrCtrl && e.code === 'KeyV') {
          e.preventDefault();
          clipboardRead().then(text => {
            if (text) term.paste(normalizePasteNewlines(text));
          });
          return false;
        }

        // Linux convention: Ctrl+Shift+C always copies, Ctrl+Shift+V always pastes
        if (e.ctrlKey && e.shiftKey && e.code === 'KeyC') {
          if (term.hasSelection()) clipboardWrite(term.getSelection());
          return false;
        }
        if (e.ctrlKey && e.shiftKey && e.code === 'KeyV') {
          e.preventDefault();
          clipboardRead().then(text => {
            if (text) term.paste(normalizePasteNewlines(text));
          });
          return false;
        }
      }
      return true; // Let xterm handle all other keys natively
    });

    // Clickable links: URLs (http/https/file) + absolute file paths.
    // Underlines matched tokens on hover; click opens via Tauri's open_url
    // command (delegates to the OS shell — system browser for URLs, default
    // handler for local files like report.html).
    const LINK_RE = /(https?:\/\/[^\s<>()"']+|file:\/\/\/[^\s<>()"']+|[A-Za-z]:[/\\][^\s<>()"']+)/g;
    term.registerLinkProvider({
      provideLinks(bufferLineNumber, callback) {
        const line = term.buffer.active.getLine(bufferLineNumber - 1);
        const text = line ? line.translateToString(true) : '';
        const links: any[] = [];
        let m;
        LINK_RE.lastIndex = 0;
        while ((m = LINK_RE.exec(text)) !== null) {
          const raw = m[0].replace(/[),.]+$/, '');
          const startCol = m.index + 1;
          const endCol = m.index + raw.length;
          links.push({
            range: {
              start: { x: startCol, y: bufferLineNumber },
              end: { x: endCol, y: bufferLineNumber },
            },
            text: raw,
            activate: () => {
              const url = /^[A-Za-z]:[/\\]/.test(raw)
                ? 'file:///' + raw.replace(/\\/g, '/')
                : raw;
              commands.openUrl(url).catch(() => {});
            },
          });
        }
        callback(links);
      },
    });

    xtermRef.current = term;
    fitRef.current   = fit;

    // Auto-focus only when the tab/pane is actually active; hidden tabs
    // should not steal focus during eager mount.
    if (isActive) term.focus();

    // ── Register event listeners BEFORE starting PTY ──────────────────────
    // This prevents the race condition where PTY output arrives before
    // the frontend has registered its listeners, causing a blank terminal.

      const startPty = async () => {
      try {
      let remoteConfig: any = {};
      try {
        if (tool === 'remote' && toolData) remoteConfig = JSON.parse(toolData);
      } catch (e) {}
      let hasInjectedPassword = false;

      // Subscribe to PTY events via the singleton bus. One listen() call per
      // event type lives in the bus; we just register per-session handlers
      // into a Map. No N-tab fan-out on hot path.
      const unsubEvents = await subscribeTerminalEvents(sessionId, {
        onOutput: (data) => {
          if (!mounted) return;
          hasOutputRef.current = true;
          writeOrBufferTerminalOutput(data);

          // Handle SSH Auto-login via Password injection
          if (tool === 'remote' && remoteConfig.protocol === 'ssh' && remoteConfig.password && !hasInjectedPassword) {
            if (data.toLowerCase().includes('password:')) {
              hasInjectedPassword = true;
              setTimeout(() => {
                commands.tierTerminalRawWrite(sessionId, remoteConfig.password + '\r').catch(() => {});
              }, 200);
            }
          }

          // Track alt-screen flag for other TUI heuristics (splash, focus).
          // Agent status is now driven by hooks via agent-status-bus, not PTY scraping.
          if (data.includes('\x1b[?1049h') || data.includes('\x1b[?47h')) {
            altScreenRef.current = true;
          }
          if (data.includes('\x1b[?1049l') || data.includes('\x1b[?47l')) {
            altScreenRef.current = false;
          }

        },
        onStatus: (running, exitCode) => {
          if (!mounted || running) return;
          setProcessExited(true);
          if (exitCode !== null && exitCode !== 0) setExitFailed(true);
          dispatch({ type: 'SET_AGENT_STATUS', id: sessionId, status: 'idle' });
          if (exitMessageWrittenRef.current) return;
          exitMessageWrittenRef.current = true;
          const msg = exitCode === 0
            ? '\r\n\x1b[32m[Process exited normally]\x1b[0m\r\n'
            : `\r\n\x1b[31m[Process exited with code ${exitCode}]\x1b[0m\r\n`;
          writeOrBufferTerminalOutput(msg);
        },
        onExit: (exitCode) => {
          // Authoritative "process is actually dead" signal from the Rust
          // child-watcher thread. Critical for the lockup scenario where an
          // intermediate cmd.exe keeps the PTY slave open so reader never
          // sees EOF — without this, the terminal looked frozen forever.
          if (!mounted) return;
          setProcessExited(true);
          if (exitCode !== 0) setExitFailed(true);
          dispatch({ type: 'SET_AGENT_STATUS', id: sessionId, status: 'idle' });
          if (exitMessageWrittenRef.current) return;
          exitMessageWrittenRef.current = true;
          const msg = exitCode === 0
            ? '\r\n\x1b[32m[Process exited normally]\x1b[0m\r\n'
            : `\r\n\x1b[31m[Process exited with code ${exitCode}]\x1b[0m\r\n`;
          writeOrBufferTerminalOutput(msg);
        },
        onCwd: (cwd) => {
          if (!mounted) return;
          dispatch({ type: 'SET_FOLDER', path: cwd });
        },
      });
      if (mounted) unlisteners.push(unsubEvents); else { unsubEvents(); return; }

      // All listeners registered — NOW start the PTY process
      if (!mounted) return;

      const initialCols = term.cols || 80;
      const initialRows = term.rows || 24;

      const paneResume = decodePaneResumePayload(toolData);
      const resumeSession = paneResume?.savedSession;
      const resumeToken = typeof resumeSession?.session_token === 'string'
        ? resumeSession.session_token
        : null;
      const shouldResumeInPlace = !!(
        resumeSession &&
        tool &&
        typeof resumeSession.id === 'string' &&
        resumeToken &&
        typeof resumeSession.cwd === 'string'
      );

      console.warn('[tier-terminal] startPty routing', {
        sessionId,
        tool,
        hasToolData: typeof toolData === 'string' && toolData.length > 0,
        toolDataPreview: typeof toolData === 'string' ? toolData.slice(0, 160) : null,
        paneResumeDetected: !!paneResume,
        resumeSessionId: resumeSession?.id ?? null,
        resumeToken,
        shouldResumeInPlace,
      });

        // VibeID routes through the backend's own `'vibeid'` match arm, which
        // spawns `claude` with `/vibeid` as the initial positional prompt.
        // No frontend remap + no PTY-write hack: Claude Code's REPL parses the
        // slash command natively on first input.
        if (shouldResumeInPlace && tool && resumeSession) {
          await commands.tierTerminalResume(
            resumeSession.id,
            sessionId,
            tool,
            resumeToken,
            initialCols,
            initialRows,
            resumeSession.cwd || folderPath || '',
            sentinelEnabled,
          );
        } else {
          await commands.tierTerminalStart(sessionId, tool, initialCols, initialRows, theme, lang, toolData, folderPath ?? undefined, sentinelEnabled);
        }

        // After PTY is running, wait two frames for layout to settle then
        // send the true terminal size. This fixes TUI adaptive-width tools
        // (Claude Code, etc.) that respond to SIGWINCH — the initial fit may
        // have run before the container reached its final dimensions.
        await new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));
        if (mounted && fitRef.current && xtermRef.current) {
          fitRef.current.fit();
          const t2 = xtermRef.current;
          if (t2.cols > 0 && t2.rows > 0) {
            commands.tierTerminalResize(sessionId, t2.cols, t2.rows).catch(() => {});
          }
        }

        // Trust prompt is shown to the user directly. Previously auto-skipped,
        // but we want the user to see the real agent screen and decide.

// (VibeID no longer needs a frontend auto-prompt timer — the backend
        // spawns `claude /vibeid` directly, so the REPL fires the skill on its
        // very first parse pass.)
      } catch (err) {
        console.warn('[TierTerminal] startPty failed:', err);
        term.writeln(`\x1b[31mFailed to start terminal: ${err}\x1b[0m`);
        if (mounted) setStartFailed(true);
      }
    };

    startPty();
    }; // end initTerminal

    initTerminal();

    // Resize observer — CRITICAL: Never call fit() when the container is hidden
    // (display:none gives zero dimensions, causing xterm to collapse to 1 column)
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      // Skip if container has zero dimensions (hidden tab)
      if (width < 10 || height < 10) return;
      try { fit.fit(); } catch {}
      flushHiddenOutput();
      // Notify PTY backend of the new size so the CLI tool can redraw
      try {
        const cols = term.cols;
        const rows = term.rows;
        if (cols > 0 && rows > 0) {
          commands.tierTerminalResize(sessionId, cols, rows).catch(() => {});
        }
      } catch {}
    });
    ro.observe(termRef.current!);

    return () => {
      mounted = false;
      if (flushHiddenRafRef.current !== null) {
        cancelAnimationFrame(flushHiddenRafRef.current);
        flushHiddenRafRef.current = null;
      }
      unregisterFocus();
      ro.disconnect();
      term.dispose();
      xtermRef.current = null;
      unlisteners.forEach(u => u());
      // Skip kill if this session was detached to a new window
      if (detachedSessions.has(sessionId)) {
        detachedSessions.delete(sessionId);
      } else {
        commands.tierTerminalKill(sessionId).catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Theme sync ───────────────────────────────────────────────────────────

  useEffect(() => {
    const term = xtermRef.current;
    if (!term) return;
    term.options.theme = buildXtermTheme(theme, hasBg, tool === 'claude', termColorScheme);
  }, [theme, tool, termColorScheme, hasBg]);

  // ── IME focus-scroll guard ───────────────────────────────────────────────
  // Defense-in-depth for the `overflow: clip` fix in TierTerminal.css.
  // Scroll events DO NOT bubble, so a listener on `wrapRef` alone misses
  // scrolls happening on descendants like `.xterm` (xterm.js creates that
  // element, so it's not directly reffable). We use capture-phase listening
  // to catch scroll events from any descendant element and snap them back.
  // This guards against WebView2 builds without `overflow: clip` support
  // and any future descendant that silently becomes scrollable.
  useEffect(() => {
    const root = wrapRef.current;
    if (!root) return;
    const onScroll = (e: Event) => {
      const target = e.target as HTMLElement | null;
      if (!target || !root.contains(target)) return;
      if (target.scrollLeft !== 0) target.scrollLeft = 0;
    };
    root.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => root.removeEventListener('scroll', onScroll, { capture: true });
  }, []);

  // ── Tab actions registry ────────────────────────────────────────────────
  // Expose "paste into this tab's xterm" and "where is the cursor on screen"
  // to the app-level Gambit overlay. Gambit is rendered outside the
  // TierTerminal tree, so it can't access xtermRef directly — it looks up
  // the active tab's actions in the registry instead.
  useEffect(() => {
    const unregister = registerTabActions(sessionId, {
      paste: (text: string): boolean => {
        const term = xtermRef.current;
        // If the xterm isn't mounted yet (tab still loading, PTY spawn in
        // flight, etc.) report failure so the caller can preserve the
        // source draft instead of silently losing it.
        if (!term) return false;
        // term.paste() goes through onData, which our handler forwards to the
        // PTY with bracketed-paste framing when the TUI has enabled it.
        // Newlines and IME composition round-trip correctly. Follow with CR
        // to submit.
        //
        // Defer the CR so it arrives as a separate PTY read. Claude Code's
        // Ink input handler enters a paste-end digestion state for ~100ms
        // after the bracketed-paste close (`\x1b[201~`) — any CR that lands
        // inside that window is absorbed as part of the paste buffer, so the
        // text stays in the prompt without submitting. The original 30ms
        // worked on older Claude versions; modern builds need ≥120ms (live
        // measurement on 2026-04-26 was 152–164ms across two pane types).
        // 150ms with the natural ~10ms timer slack puts us comfortably past
        // the window. Windows ConPTY coalesces PTY writes differently but
        // the delay is harmless there.
        term.paste(normalizePasteNewlines(text));
        setTimeout(() => {
          commands.tierTerminalInput(sessionId, '\r').catch(() => {});
        }, 150);
        return true;
      },
      insertText: (text: string): boolean => {
        const term = xtermRef.current;
        if (!term) return false;
        // Same path as paste() but without the trailing CR — file-drop
        // mirrors OS-native terminal behavior: path appears at the cursor
        // as if typed, user edits/sends from there.
        term.paste(normalizePasteNewlines(text));
        return true;
      },
      cursorScreenPos: () => {
        const wrap = wrapRef.current;
        const term = xtermRef.current;
        if (!wrap || !term) return null;
        const wrapRect = wrap.getBoundingClientRect();
        const screenEl = termRef.current?.querySelector('.xterm-screen') as HTMLElement | null;
        const cellW = screenEl && term.cols > 0 ? screenEl.clientWidth / term.cols : 8;
        const cellH = screenEl && term.rows > 0 ? screenEl.clientHeight / term.rows : 17;
        // .tier-xterm-wrap has padding: 20px 0 20px 24px
        return {
          x: wrapRect.left + 24 + term.buffer.active.cursorX * cellW,
          y: wrapRect.top + 20 + term.buffer.active.cursorY * cellH + cellH + 4,
        };
      },
    });
    return unregister;
  }, [sessionId]);

  // ── File-drop target ────────────────────────────────────────────────────
  // Match OS-native terminal behavior: dragging a file onto the terminal
  // inserts its absolute path at the cursor as if typed. Only the active
  // tab claims the rect — inactive tabs return null and are skipped.
  const isActiveRef = useRef(isActive);
  useEffect(() => { isActiveRef.current = isActive; }, [isActive]);
  useEffect(() => {
    return registerFileDropTarget({
      priority: 100,
      rect: () => {
        if (!isActiveRef.current) return null;
        return wrapRef.current?.getBoundingClientRect() ?? null;
      },
      insert: (paths) => {
        getTabActions(sessionId)?.insertText(formatPathsForInsert(paths));
      },
    });
  }, [sessionId]);

  // ── Active tab focus restoration ─────────────────────────────────────────
  // Cache last-sent size so we skip redundant PTY resize calls when tab
  // switches back to the same dimensions (no window resize in between).
  const lastResizeRef = useRef<{ cols: number; rows: number } | null>(null);

  // When this session becomes the active tab, refit + focus after layout.
  // Uses double-rAF instead of a 150ms setTimeout so perceived switch latency
  // drops from 150ms to ~32ms (two frames).
  useEffect(() => {
    if (!isActive) return;
    let f1 = 0, f2 = 0;
    f1 = requestAnimationFrame(() => {
      f2 = requestAnimationFrame(() => {
        fitRef.current?.fit();
        flushHiddenOutput();
        xtermRef.current?.focus();
        const term = xtermRef.current;
        if (!term || term.cols <= 0 || term.rows <= 0) return;
        const prev = lastResizeRef.current;
        if (prev && prev.cols === term.cols && prev.rows === term.rows) return;
        lastResizeRef.current = { cols: term.cols, rows: term.rows };
        commands.tierTerminalResize(sessionId, term.cols, term.rows).catch(() => {});
      });
    });
    return () => { cancelAnimationFrame(f1); cancelAnimationFrame(f2); };
  }, [flushHiddenOutput, isActive, sessionId]);

  // ── Startup splash dismissal ────────────────────────────────────────────
  // Detect real TUI via alternate screen buffer entry (\x1b[?1049h).
  // This precisely distinguishes "database migration text" from "actual TUI rendered".
  // Also: dismiss immediately if the process exited or IPC failed — no need to
  // make the user wait the full timeout when the tool clearly can't start.
  useEffect(() => {
    if (!showSplash) return;
    let dismissed = false;
    const dismiss = () => {
      if (dismissed) return;
      dismissed = true;
      setSplashFading(true);
      // 300 ms fade-out (was 600). The splash is dismissed quickly
      // now that we trigger on first real output, so the underlying
      // tool content is usually already painted; a long crossfade
      // makes the splash "linger" visibly on top of the live REPL.
      setTimeout(() => setShowSplash(false), 300);
    };
    const poll = setInterval(() => {
      const elapsed = Date.now() - splashStartRef.current;
      if (elapsed < 800) return; // brief branding flash
      // Immediate bail-out: process already exited or IPC call failed
      if (processExited || startFailed) {
        dismiss();
        clearInterval(poll);
        return;
      }
      // Primary signal: TUI has entered alternate screen buffer (\x1b[?1049h),
      // set by the PTY output handler. Covers Claude/Codex/OpenCode/Hermes.
      if (altScreenRef.current) {
        dismiss();
        clearInterval(poll);
        return;
      }
      // Inline-mode signal: some tools (current Claude Code builds, simple
      // CLIs) print their banner directly to the regular terminal instead
      // of entering alt-screen. Threshold 1500 ms post-splash-start; once
      // we've passed the 800 ms branding window AND output is flowing AND
      // the process is alive, the tool is clearly running. Tighter than
      // the prior 2500 ms because tools usually finish painting their
      // banner well within 1 s — anything slower would make the splash
      // feel "stuck" over a visibly working REPL.
      if (hasOutputRef.current && elapsed > 1500) {
        dismiss();
        clearInterval(poll);
        return;
      }
      // Fallback timeout: shell tabs are fast (3s), AI CLI tools may
      // take longer (15s) before the first meaningful frame.
      const maxWait = tool === 'terminal' ? 3000 : 15000;
      if (elapsed > maxWait) {
        dismiss();
        clearInterval(poll);
      }
    }, 150);
    return () => clearInterval(poll);
  }, [showSplash, processExited, startFailed]);

  // ── Render ───────────────────────────────────────────────────────────────

  const solidBg = THEME_TERMINAL_BG[theme] || (theme === 'light' ? '#eeebe2' : '#0c0c0c');
  const terminalBg = hasBg ? 'transparent' : solidBg;

  // Show fallback UI when splash is gone but terminal has no content
  const showFallback = !showSplash && !hasOutputRef.current && (processExited || startFailed);

  return (
    <div className="tier-terminal" style={{ background: terminalBg, position: 'relative' }}>
      {/* Custom background (image/video) behind terminal text */}
      {hasBg && bgUrl && (
        <div className="tier-terminal-bg">
          {bgType === 'video' ? (
            <video src={bgUrl} autoPlay loop muted playsInline />
          ) : (
            <img src={bgUrl} alt="" draggable={false} />
          )}
        </div>
      )}
      {/* Mid-session process-exited banner — only shows after the terminal
          had output and the process later died. For "never launched" case
          the full-cover `tier-launch-failed` fallback below handles it. */}
      {/* Failure banner — shown only on non-zero exit. Code 0 is a deliberate
          /exit / Ctrl+D and needs no surface UI. The message is intentionally
          unified across all 7 tools and all failure modes: the user wants
          to be told whether they got back into the conversation or not, not
          why specifically (errors are out of our control once the upstream
          CLI is invoked). */}
      {processExited && exitFailed && hasOutputRef.current && (
        <div className="tier-process-exited-banner">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="8" x2="12" y2="12"/>
            <line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          <span>{t('terminal.exit_failed' as any) || 'Could not return to the conversation'}</span>
        </div>
      )}

      {/* xterm.js: handles all rendering, input, and scrolling. */}
      <div
        ref={wrapRef}
        className="tier-xterm-wrap"
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setCtxMenu({ x: e.clientX, y: e.clientY, hasSelection: !!xtermRef.current?.hasSelection() });
        }}
      >
        <div ref={termRef} className="tier-xterm" />
      </div>

      {/* Terminal right-click context menu */}
      {ctxMenu && (
        <TermContextMenu
          menu={ctxMenu}
          onClose={closeCtxMenu}
          onCopy={() => {
            const text = xtermRef.current?.getSelection();
            if (text) clipboardWrite(text);
            closeCtxMenu();
          }}
          onPaste={() => {
            clipboardRead().then(text => {
              if (text && xtermRef.current) xtermRef.current.paste(normalizePasteNewlines(text));
            });
            closeCtxMenu();
          }}
          onSelectAll={() => {
            xtermRef.current?.selectAll();
            closeCtxMenu();
          }}
        />
      )}

      {/* Gambit — the floating compose window — is rendered once at the App
          level (see ActiveGambit). It reads the active tab's session state
          and uses the tab-actions registry to paste into whichever xterm is
          active, so TierTerminal no longer needs to host it. */}

      {/* Fallback UI when tool fails to launch or exits before producing output */}
      {showFallback && (
        <div className="tier-launch-failed" style={{ background: solidBg }}>
          <div className="launch-failed-group">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--accent, #C4956A)', opacity: 0.7 }}>
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <span className="launch-failed-title">
              {toolName || (tool && toolLabel[tool]) || 'Tool'}
            </span>
            <span className="launch-failed-hint">
              {startFailed
                ? t('launch.error.ipc_failed' as any) || 'Could not connect to backend'
                : t('launch.error.tool_exited' as any) || 'Process exited unexpectedly'}
            </span>
            <span className="launch-failed-sub">
              {t('launch.error.check_install' as any) || 'Make sure the tool is installed and available in your PATH'}
            </span>
          </div>
        </div>
      )}

      {/* Startup splash — covers ugly init output with branded loading screen */}
      {showSplash && (
        <div
          className={`tier-loading-splash ${splashFading ? 'fade-out' : ''}`}
          style={{ background: solidBg }}
        >
          {/* Animated coffee cup + label + dots — grouped as one visual unit */}
          <div className="splash-group">
            <div className="splash-icon">
              <svg width="48" height="48" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <defs>
                  <mask id={`splashMask-${sessionId}`}>
                    <path fill="none" stroke="#fff" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"
                      d="M8 -8c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4M12 -8c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4M16 -8c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4">
                      <animate attributeName="d" dur="3s" repeatCount="indefinite"
                        values="M8 0c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4M12 0c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4M16 0c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4;M8 -8c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4M12 -8c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4M16 -8c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4"/>
                    </path>
                    <path d="M4 7h16v0h-16v12h16v-32h-16Z">
                      <animate fill="freeze" attributeName="d" begin="1s" dur="0.6s" to="M4 2h16v5h-16v12h16v-24h-16Z"/>
                    </path>
                  </mask>
                </defs>
                <g stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2">
                  <path fill="currentColor" fillOpacity="0" strokeDasharray="48"
                    d="M17 9v9c0 1.66 -1.34 3 -3 3h-6c-1.66 0 -3 -1.34 -3 -3v-9Z">
                    <animate fill="freeze" attributeName="stroke-dashoffset" dur="0.6s" values="48;0"/>
                    <animate fill="freeze" attributeName="fill-opacity" begin="1.6s" dur="0.4s" to="1"/>
                  </path>
                  <path fill="none" strokeDasharray="16" strokeDashoffset="16"
                    d="M17 9h3c0.55 0 1 0.45 1 1v3c0 0.55 -0.45 1 -1 1h-3">
                    <animate fill="freeze" attributeName="stroke-dashoffset" begin="0.6s" dur="0.3s" to="0"/>
                  </path>
                </g>
                <path fill="currentColor" d="M0 0h24v24H0z" mask={`url(#splashMask-${sessionId})`}/>
              </svg>
            </div>
            {(() => {
              const splashText =
                tool === 'insights_prerun' ? `${t('tool.vibeid' as any)} (1/2)` :
                tool === 'vibeid'          ? `${t('tool.vibeid' as any)} (2/2)` :
                (toolName || (tool && toolLabel[tool]) || 'Loading');
              // Pick splash font by CONTENT language, not UI language. The tab
              // for Claude Code shows "Claude Code" in any UI locale, and the
              // italic-serif art treatment only reads well for Latin glyphs.
              // Conversely, CJK splash text (人格测试 / 終端 / etc.) breaks
              // under italic serif and needs the stable bold display.
              const hasCJK = /[一-鿿぀-ヿ가-힯]/.test(splashText);
              return <span className="splash-label" lang={hasCJK ? 'zh' : 'en'}>{splashText}</span>;
            })()}
            <div className="splash-dots">
              <span className="splash-dot" />
              <span className="splash-dot" />
              <span className="splash-dot" />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Temporarily exported without memo wrapper while investigating a
// regression where CLI tools wouldn't launch. All other perf wins (split
// contexts, useAppDispatch, focus registry, pty-event-bus, tab-switch rAF,
// dead menu scanner removal) are still active.
export const TierTerminal = TierTerminalImpl;
