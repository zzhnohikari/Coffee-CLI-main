// MultiAgentGrid.tsx — independent "four pane" tab content.
//
// Design (user spec 2026-04-23):
//   Four paper slices. No borders, no card backgrounds, no paddings, no
//   header strips. Each pane renders identically to a single-terminal
//   tab. Only visual differentiation between panes is:
//     (a) a 1/2/3/4 number badge in the top-right, tinted by the theme
//         accent;
//     (b) when any pane has keyboard focus, the other three dim to 0.35
//         opacity so the user's eye follows the cursor.
//
//   All four panes are peers — no primary/worker distinction. Every
//   pane has its own PTY session `${tabId}::pane-${idx}` where idx is
//   1..4 matching the UI badge; the backend PaneStore / MCP tools see
//   the same id, so when the user says "pane 2" the CLI's MCP call
//   targets the exact same slot.
//
// Implementation notes:
//   - focused pane detection uses onFocus (capture, because the event
//     fires on the nested xterm textarea and we want to catch it on the
//     pane wrapper). Initial state is null → all panes full brightness
//     until the first click; this keeps the first-paint visually calm.
//   - `requiresCwd: false` was set in CenterPanel's Launchpad entry, so
//     tab.folderPath may be null. TierTerminal handles that by falling
//     back to the user's home directory inside terminal::spawn.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useAppState, type TerminalSession, type ToolType, type MultiAgentPane } from '../../store/app-state';
import { TierTerminal } from './TierTerminal';
import { ErrorBoundary } from '../common/ErrorBoundary';
import { commands, waitForTauriBridge, type SavedSession, type MultiAgentProfilesConfig, type MultiAgentPaneProfile, type SkillOption, type McpOption } from '../../tauri';
import { setFocusedPane } from '../../lib/pane-focus';
import { getHistorySnapshot, prefetchHistory, subscribeHistory } from '../../lib/history-cache';
import { encodePaneResumePayload } from '../../lib/pane-resume';
import { useT } from '../../i18n/useT';
import './MultiAgentGrid.css';

interface Props {
  tab: TerminalSession;
  hasBg: boolean;
  bgUrl: string;
  bgType: 'image' | 'video' | 'none';
  paneCount?: 2 | 3 | 4;
  isTabActive: boolean;
}

// Multi-agent quadrant CLIs. Each pane runs one of these as a primary
// participant — the per-pane MCP server (built lazily in
// `tier_terminal_start`) is wired into each via the CLI-specific path
// documented in `mcp_injector.rs`. OpenCode joins via the
// `OPENCODE_CONFIG=<pane-temp>/opencode.json` env var so its workspace
// stays untouched (same zero-pollution invariant as the other three).
const PANE_CLI_OPTIONS: Array<{ value: ToolType; label: string }> = [
  { value: 'claude', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
  { value: 'gemini', label: 'Gemini' },
  { value: 'opencode', label: 'OpenCode' },
  { value: 'shell', label: 'Shell / PowerShell' },
];

function encodeProfilePayload(profileId: string, profile: MultiAgentPaneProfile): string {
  return JSON.stringify({
    __coffeePaneLaunchMode: 'profile-v1',
    profile_id: profileId,
    label: profile.label || profileId,
    command: profile.command || '',
    extra_args: profile.extraArgs || [],
    env: profile.env || {},
    prompt_append: profile.promptAppend || '',
    prompt_file_path: profile.promptFilePath || '',
    startup_input: profile.startupInput || '',
    mcp_config_path: profile.mcpConfigPath || '',
    api_key_env_name: profile.apiKeyEnvName || '',
    api_base_url_env_name: profile.apiBaseUrlEnvName || '',
    api_base_url: profile.apiBaseUrl || '',
    model: profile.model || '',
    selected_mcp_ids: profile.selectedMcpIds || [],
    skills: profile.skills || [],
    team_prompt: '',
  });
}

function launchToolForProfileTool(tool?: string): ToolType {
  if ((tool || '').trim().toLowerCase() === 'shell') return 'terminal';
  return ((tool as ToolType) || null);
}

function isGeneratedProfileMcpPath(path?: string | null): boolean {
  const normalized = (path || '').replace(/\\/g, '/');
  return normalized.includes('/coffee-cli/profile-mcp/');
}

function normalizeHistoryPath(path?: string | null): string {
  return (path ?? '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

function formatSavedAt(savedAt: string, lang: string): string {
  let savedMs = Date.parse(savedAt);
  if (Number.isNaN(savedMs)) {
    const numeric = Number(savedAt);
    if (!Number.isNaN(numeric) && numeric > 0) {
      savedMs = numeric < 1e11 ? numeric * 1000 : numeric;
    } else {
      return '';
    }
  }
  const savedDate = new Date(savedMs);
  return savedDate.toLocaleDateString(lang === 'zh-CN' ? 'zh-CN' : 'en-US', {
    month: 'short',
    day: 'numeric',
  });
}

function loadingLabel(lang: string): string {
  if (lang === 'zh-CN') return '加载中...';
  if (lang === 'zh-TW') return '載入中...';
  if (lang === 'ja') return '読み込み中...';
  if (lang === 'ko') return '불러오는 중...';
  return 'Loading...';
}

export function MultiAgentGrid({ tab, hasBg, bgUrl, bgType, paneCount = 4, isTabActive }: Props) {
  const { state, dispatch } = useAppState();
  const [focusedPaneIdx, setFocusedPaneIdx] = useState<number | null>(null);

  // Detect which of the 3 coordination-eligible CLIs are actually installed
  // so the picker greys out the ones the user doesn't have (same visual
  // language as the Desktop launchpad — see .launchpad-card-disabled).
  // Runs once on mount; missing keys default to `true` so we don't flash
  // a false "disabled" state before the IPC resolves.
  const [toolsInstalled, setToolsInstalled] = useState<Record<string, boolean>>({});
  useEffect(() => {
    commands.checkToolsInstalled()
      .then(result => setToolsInstalled(result))
      .catch(() => {});
  }, []);

  // paneIdx is 1-indexed to match the user-visible badge numbering and
  // the MCP session id (`::pane-1` .. `::pane-4`). See the header comment.
  const panes: MultiAgentPane[] = (tab.multiAgent?.panes
    ?? Array.from({ length: paneCount }, (_, i) => ({
         paneIdx: i + 1,
         tool: null as ToolType,
       }))).slice(0, paneCount);

  // ─── Multi-agent mode handshake ─────────────────────────────────────
  //
  // Post-v1.5 the backend wires each pane's MCP server and CLI
  // artifacts lazily inside `tier_terminal_start` (per-pane temp dir
  // under `<temp>/coffee-cli/panes/`, plus a per-pane stub in
  // `~/.gemini/extensions/` for the Gemini extension loader).
  // Workspaces stay pristine — no CLAUDE.md / AGENTS.md / GEMINI.md /
  // .multi-agent/ ever gets written, no global ~/.codex / ~/.gemini
  // mcp_servers entries get touched.
  //
  // We still call enable/disable here so the backend has a structured
  // place to surface preflight warnings, and so future cross-cutting
  // logic (telemetry, license gating, …) has the obvious hook.
  const installedSigRef = useRef<string>('');
  const activeTools: string[] = Array.from(
    new Set(panes.map(p => p.tool).filter((t): t is NonNullable<ToolType> => !!t))
  ).map(String).sort();
  const sig = `${tab.folderPath ?? ''}|${activeTools.join(',')}`;
  useEffect(() => {
    if (!tab.folderPath) return;
    if (activeTools.length === 0) return;
    if (installedSigRef.current === sig) return;
    installedSigRef.current = sig;

    commands
      .enableMultiAgentMode(tab.folderPath, activeTools)
      .then((r) => {
        if (r.warnings?.length) {
          console.warn('[multi-agent] enable warnings:', r.warnings);
        }
      })
      .catch((e) => {
        console.warn('[multi-agent] enable_multi_agent_mode failed (UI still usable):', e);
      });
  }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cleanup on unmount: notify the backend so it can run any future
  // cross-cutting teardown. Currently a no-op on the Rust side because
  // per-pane MCP servers and temp artifacts are pruned only at next
  // app launch via `mcp_injector::prune_pane_artifacts`.
  const cleanupPathRef = useRef<string | null>(null);
  cleanupPathRef.current = tab.folderPath ?? null;
  useEffect(() => {
    return () => {
      const ws = cleanupPathRef.current;
      if (!ws) return;
      if (!installedSigRef.current) return;
      commands
        .disableMultiAgentMode(ws)
        .catch((e) => console.warn('[multi-agent] disable on unmount failed:', e));
    };
  }, []);

  const onSelectTool = (paneIdx: number, tool: ToolType, toolData?: string) => {
    dispatch({ type: 'SET_PANE_TOOL', tabId: tab.id, paneIdx, tool, toolData });
  };

  // 2-pane and 3-pane coordination always render as side-by-side columns — the 2×2
  // grid mode is only meaningful for 4 panes. The user's columns/grid
  // toggle in multi-agent settings therefore only applies when paneCount === 4.
  const isColumns = paneCount !== 4 || state.multiAgentLayout === 'columns';
  const layoutMod = isColumns
    ? ` multi-agent-grid--columns multi-agent-grid--columns-${paneCount}`
    : ' multi-agent-grid--grid';

  return (
    <div className={`multi-agent-grid-standalone${layoutMod}${hasBg && bgUrl ? ' multi-agent-has-bg' : ''}`}>
      {/* Grid-level wallpaper. Sits behind all four panes so empty
          panes (CLI picker state) and any gaps show the user's bg
          just like single-terminal tabs do. Filled panes also get
          their TierTerminal's own .tier-terminal-bg layer — harmless
          redundancy, but guarantees xterm-transparent composition
          stays correct regardless of grid-level state. Mirrors the
          .launchpad-bg pattern in CenterPanel so the wallpaper-dim
          overlay (--wallpaper-dim on :root) works the same way. */}
      {hasBg && bgUrl && (
        <div className="multi-agent-bg">
          {bgType === 'video'
            ? <video src={bgUrl} autoPlay loop muted playsInline />
            : <img src={bgUrl} alt="" draggable={false} />}
        </div>
      )}
      {panes.map((pane) => {
        const paneSessionId = `${tab.id}::pane-${pane.paneIdx}`;
        const isEmpty = pane.tool === null;
        const isFocused = focusedPaneIdx === pane.paneIdx;
        const isDimmed = focusedPaneIdx !== null && !isFocused;

        return (
          <div
            key={pane.paneIdx}
            className={`multi-agent-pane pane-slot-${pane.paneIdx}${isDimmed ? ' is-dimmed' : ''}`}
            // Capture-phase so we win the focus-intent announcement even
            // when the click lands on inert background (empty pane body,
            // padding around the CLI picker, gap between xterm canvas
            // and pane edges). onFocusCapture alone only fires when the
            // click actually hits a focusable element, which misses all
            // the "dead" pixels users expect to be clickable.
            onMouseDownCapture={() => {
              setFocusedPaneIdx(pane.paneIdx);
              // Mirror to a module-level registry so ActiveGambit (which
              // lives at App-level, outside this component) can route its
              // Send to the pane the user last clicked.
              setFocusedPane(tab.id, pane.paneIdx);
            }}
            onFocusCapture={() => {
              setFocusedPaneIdx(pane.paneIdx);
              setFocusedPane(tab.id, pane.paneIdx);
            }}
          >
            {/* Theme-tinted pane number badge.
                - Empty pane: plain numeric label (nothing to close here).
                - Active pane: button that shows the number by default and
                  swaps to × on hover. Clicking kills this pane's PTY and
                  resets its tool to null — the pane re-renders as the
                  3-button CLI picker without disturbing the other panes
                  or closing the whole Tab. */}
            {(() => {
              // Green dot if sentinel detected a [COFFEE-DONE:paneN] marker
              // within the last 30 minutes. Past that we assume the pane has
              // started a new turn and the "done" signal is stale.
              const showDot = pane.sentinelEnabled && pane.completionTs
                && Date.now() - pane.completionTs < 30 * 60 * 1000;
              return isEmpty ? (
                <div className="pane-number-badge">
                  {pane.paneIdx}
                  {showDot && <span className="pane-completion-dot" aria-hidden="true" />}
                </div>
              ) : (
                <button
                  type="button"
                  className="pane-number-badge pane-number-badge--closable"
                  aria-label={`Close pane ${pane.paneIdx}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    commands.tierTerminalKill(paneSessionId).catch(() => {});
                    if (focusedPaneIdx === pane.paneIdx) {
                      setFocusedPaneIdx(null);
                      setFocusedPane(tab.id, null);
                    }
                    dispatch({
                      type: 'SET_PANE_TOOL',
                      tabId: tab.id,
                      paneIdx: pane.paneIdx,
                      tool: null,
                    });
                  }}
                >
                  <span className="pane-badge-num">{pane.paneIdx}</span>
                  <span className="pane-badge-x" aria-hidden="true">×</span>
                  {showDot && <span className="pane-completion-dot" aria-hidden="true" />}
                </button>
              );
            })()}

            <div className="multi-agent-pane-body">
              {isEmpty ? (
                <EmptyPanePicker
                  paneIdx={pane.paneIdx}
                  onSelect={(tool, toolData) => onSelectTool(pane.paneIdx, tool, toolData)}
                  sentinelEnabled={!!pane.sentinelEnabled}
                  onToggleSentinel={() => dispatch({
                    type: 'SET_PANE_SENTINEL',
                    tabId: tab.id,
                    paneIdx: pane.paneIdx,
                    enabled: !pane.sentinelEnabled,
                  })}
                  onSetSentinel={(enabled) => dispatch({
                    type: 'SET_PANE_SENTINEL',
                    tabId: tab.id,
                    paneIdx: pane.paneIdx,
                    enabled,
                  })}
                  toolsInstalled={toolsInstalled}
                  workspaceCwd={tab.folderPath}
                  lang={state.currentLang}
                />
              ) : (
                <ErrorBoundary fallbackLabel="Tier Terminal Error">
                  {/* Pass hasBg through so xterm stays transparent when
                      the user has a wallpaper set — this lets the single
                      grid-level .multi-agent-bg show through all panes.
                      bgUrl is intentionally empty so TierTerminal never
                      renders its own per-pane .tier-terminal-bg layer;
                      the shared grid wallpaper handles that instead. */}
                  <TierTerminal
                    key={`${paneSessionId}:${pane.tool ?? 'empty'}:${typeof pane.toolData === 'string' ? pane.toolData : ''}`}
                    sessionId={paneSessionId}
                    tool={pane.tool}
                    toolName={undefined}
                    theme={state.currentTheme}
                    lang={state.currentLang}
                    isActive={isTabActive && isFocused}
                    toolData={pane.toolData}
                    folderPath={tab.folderPath}
                    hasBg={hasBg}
                    bgUrl=""
                    bgType="none"
                    termColorScheme={state.termColorScheme}
                    sentinelEnabled={!!pane.sentinelEnabled}
                  />
                </ErrorBoundary>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

interface EmptyPanePickerProps {
  paneIdx: number;
  onSelect: (tool: ToolType, toolData?: string) => void;
  sentinelEnabled: boolean;
  onToggleSentinel: () => void;
  onSetSentinel: (enabled: boolean) => void;
  toolsInstalled: Record<string, boolean>;
  workspaceCwd?: string | null;
  lang: string;
}

// Per-CLI setup hints removed per user request: the paper-slice
// aesthetic calls for a completely clean empty pane — just the three
// CLI buttons, nothing else. Auth friction (Codex login, Gemini
// /auth) surfaces naturally once the user clicks; no need to
// pre-announce it. The skip-permissions auto-accept still lives in
// server.rs for Claude, so users don't see a speed bump there.
function EmptyPanePicker({
  paneIdx: _paneIdx,
  onSelect,
  sentinelEnabled,
  onToggleSentinel,
  onSetSentinel,
  toolsInstalled,
  workspaceCwd,
  lang,
}: EmptyPanePickerProps) {
  const t = useT();
  const [historyTool, setHistoryTool] = useState<ToolType | null>(null);
  const [profileTool, setProfileTool] = useState<ToolType | null>(null);
  const [profilesCfg, setProfilesCfg] = useState<MultiAgentProfilesConfig | null>(null);
  const [editingProfileId, setEditingProfileId] = useState('');
  const [draftProfileId, setDraftProfileId] = useState('');
  const [draftProfile, setDraftProfile] = useState<MultiAgentPaneProfile | null>(null);
  const [draftApiKey, setDraftApiKey] = useState('');
  const [apiKeyStatus, setApiKeyStatus] = useState('API Key: Missing');
  const [skillOptions, setSkillOptions] = useState<SkillOption[]>([]);
  const [mcpOptions, setMcpOptions] = useState<McpOption[]>([]);
  const [openSection, setOpenSection] = useState<'basic' | 'model' | 'advanced' | null>('basic');
  const [historySearch, setHistorySearch] = useState('');
  const { sessions: cachedSessions, status } = useSyncExternalStore(
    subscribeHistory,
    getHistorySnapshot,
    getHistorySnapshot,
  );

  useEffect(() => {
    if (historyTool) prefetchHistory();
  }, [historyTool]);

  useEffect(() => {
    if (!profileTool) return;
    commands.getMultiAgentProfiles()
      .then(setProfilesCfg)
      .catch(() => setProfilesCfg(null));
    commands.discoverLocalSkills().then(setSkillOptions).catch(() => setSkillOptions([]));
    commands.discoverLocalMcpServers().then(setMcpOptions).catch(() => setMcpOptions([]));
  }, [profileTool]);

  useEffect(() => {
    if (!profileTool) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    waitForTauriBridge({ events: true, timeoutMs: 5000 })
      .then(async (ready) => {
        if (!ready || cancelled) return null;
        const { listen } = await import('@tauri-apps/api/event');
        return listen<MultiAgentProfilesConfig>('multi-agent-profiles-changed', (event) => {
          setProfilesCfg(event.payload);
        });
      })
      .then((fn) => {
        if (!fn) return;
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [profileTool]);

  const historySessions = useMemo(() => {
    if (!historyTool) return [] as SavedSession[];

    const normalizedWorkspace = normalizeHistoryPath(workspaceCwd);
    const needle = historySearch.trim().toLowerCase();
    const byTool = cachedSessions.filter((session) => {
      if (session.tool !== historyTool || !session.session_token) return false;
      if (!needle) return true;
      return (
        session.name.toLowerCase().includes(needle) ||
        session.cwd.toLowerCase().includes(needle)
      );
    });

    if (!normalizedWorkspace) return byTool.slice(0, 30);

    const matchingWorkspace = byTool.filter(
      (session) => normalizeHistoryPath(session.cwd) === normalizedWorkspace,
    );

    return (matchingWorkspace.length > 0 ? matchingWorkspace : byTool).slice(0, 30);
  }, [cachedSessions, historySearch, historyTool, workspaceCwd]);

  const historyLoading = historyTool !== null && status === 'loading' && cachedSessions.length === 0;

  const profileEntries = useMemo(() => {
    if (!profileTool || !profilesCfg) return [] as Array<[string, MultiAgentPaneProfile]>;
    return Object.entries(profilesCfg.profiles || {}).filter(([, profile]) => profile.tool === profileTool);
  }, [profileTool, profilesCfg]);

  const resetProfileEditor = () => {
    setEditingProfileId('');
    setDraftProfileId('');
    setDraftProfile(null);
    setOpenSection('basic');
  };

  const startCreateProfile = () => {
    if (!profileTool) return;
    setEditingProfileId('__new__');
    setDraftProfileId(`${String(profileTool)}-${Date.now()}`);
    setDraftProfile({
      label: '',
      tool: String(profileTool),
      command: '',
      extraArgs: [],
      env: {},
      promptAppend: '',
      promptFilePath: '',
      startupInput: '',
      mcpConfigPath: '',
      skills: [],
      notes: '',
      sentinel: true,
      apiKeyEnvName: '',
      apiBaseUrlEnvName: '',
      apiBaseUrl: '',
      model: '',
      selectedMcpIds: [],
    });
    setDraftApiKey('');
    setApiKeyStatus('API Key: Missing');
  };

  const startEditProfile = async (profileId: string, profile: MultiAgentPaneProfile) => {
    setEditingProfileId(profileId);
    setDraftProfileId(profileId);
    setDraftProfile({
      ...profile,
      extraArgs: [...(profile.extraArgs || [])],
      env: { ...(profile.env || {}) },
      skills: [...(profile.skills || [])],
      selectedMcpIds: [...(profile.selectedMcpIds || [])],
      mcpConfigPath: isGeneratedProfileMcpPath(profile.mcpConfigPath) ? '' : (profile.mcpConfigPath || ''),
      model: profile.model || '',
    });
    const apiKey = await commands.loadApiKey(profileId).catch(() => null);
    setDraftApiKey(apiKey || '');
    const status = await commands.getApiKeyStatus(profileId).catch(() => null);
    setApiKeyStatus(status?.message || (apiKey ? t('profile.api_key_saved' as any) : t('profile.api_key_missing' as any)));
  };

  const setAllMcpSelected = (selected: boolean) => {
    if (!draftProfile) return;
    setDraftProfile({
      ...draftProfile,
      selectedMcpIds: selected ? mcpOptions.map((mcp) => mcp.id) : [],
    });
  };

  const setAllSkillsSelected = (selected: boolean) => {
    if (!draftProfile) return;
    setDraftProfile({
      ...draftProfile,
      skills: selected ? skillOptions.map((skill) => skill.id) : [],
    });
  };

  const saveProfile = async () => {
    if (!profilesCfg || !draftProfile || !draftProfileId.trim()) return;
    const id = draftProfileId.trim();
    const previousId = editingProfileId && editingProfileId !== '__new__' ? editingProfileId : '';
    const isRename = !!previousId && previousId !== id;
    const nextProfiles = { ...profilesCfg.profiles };
    if (isRename) delete nextProfiles[previousId];
    nextProfiles[id] = {
      ...draftProfile,
      tool: String(profileTool || draftProfile.tool),
      mcpConfigPath: draftProfile.mcpConfigPath || '',
    };
    const deletedProfiles = new Set(profilesCfg.deletedProfiles || []);
    deletedProfiles.delete(id);
    if (isRename) deletedProfiles.add(previousId);
    const nextPresets = Object.fromEntries(
      Object.entries(profilesCfg.teamPresets || {}).map(([presetId, preset]) => [
        presetId,
        {
          ...preset,
          panes: (preset.panes || []).map((pane) =>
            isRename && pane.profileId === previousId ? { ...pane, profileId: id } : pane,
          ),
        },
      ]),
    );
    const next: MultiAgentProfilesConfig = {
      ...profilesCfg,
      profiles: nextProfiles,
      teamPresets: nextPresets,
      deletedProfiles: Array.from(deletedProfiles),
    };
    await commands.setMultiAgentProfiles(next);
    if (draftApiKey.trim()) {
      const status = await commands.saveApiKey(id, draftApiKey);
      if (isRename) await commands.deleteApiKey(previousId).catch(() => {});
      setApiKeyStatus(status.message);
    } else {
      await commands.deleteApiKey(id).catch(() => {});
      if (isRename) await commands.deleteApiKey(previousId).catch(() => {});
      setApiKeyStatus(t('profile.api_key_missing' as any));
    }
    setProfilesCfg(next);
    resetProfileEditor();
    setDraftApiKey('');
  };

  const deleteProfile = async (profileId: string) => {
    if (!profilesCfg) return;
    const nextProfiles = { ...profilesCfg.profiles };
    delete nextProfiles[profileId];
    const nextPresets = Object.fromEntries(
      Object.entries(profilesCfg.teamPresets || {}).filter(([, preset]) =>
        !(preset.panes || []).some((pane) => pane.profileId === profileId),
      ),
    );
    const deletedProfiles = new Set(profilesCfg.deletedProfiles || []);
    deletedProfiles.add(profileId);
    const deletedTeamPresets = new Set(profilesCfg.deletedTeamPresets || []);
    for (const [presetId, preset] of Object.entries(profilesCfg.teamPresets || {})) {
      if ((preset.panes || []).some((pane) => pane.profileId === profileId)) {
        deletedTeamPresets.add(presetId);
      }
    }
    const next: MultiAgentProfilesConfig = {
      ...profilesCfg,
      profiles: nextProfiles,
      teamPresets: nextPresets,
      deletedProfiles: Array.from(deletedProfiles),
      deletedTeamPresets: Array.from(deletedTeamPresets),
    };
    await commands.setMultiAgentProfiles(next);
    await commands.deleteApiKey(profileId).catch(() => {});
    setProfilesCfg(next);
    if (editingProfileId === profileId) { resetProfileEditor(); setDraftApiKey(''); setApiKeyStatus('API Key: Missing'); }
  };

  if (historyTool) {
    const toolLabel = PANE_CLI_OPTIONS.find((opt) => opt.value === historyTool)?.label ?? String(historyTool);
    return (
      <div className="empty-pane-history">
        <div className="empty-pane-history-head">
          <div className="empty-pane-history-title">
            <span>{toolLabel}</span>
            <span className="empty-pane-history-title-sep">/</span>
            <span>{t('task.tab.sessions' as any)}</span>
          </div>
          <button
            type="button"
            className="empty-pane-history-close"
            aria-label={t('action.close' as any) || 'Close'}
            onClick={(e) => {
              e.stopPropagation();
              setHistoryTool(null);
              setHistorySearch('');
            }}
          >
            x
          </button>
        </div>

        <input
          type="text"
          className="empty-pane-history-search"
          value={historySearch}
          placeholder={t('task.search_sessions' as any) || 'Search sessions...'}
          onChange={(e) => setHistorySearch(e.target.value)}
        />

        <div className="empty-pane-history-list">
          {historyLoading ? (
            <div className="empty-pane-history-empty">{loadingLabel(lang)}</div>
          ) : historySessions.length === 0 ? (
            <div className="empty-pane-history-empty">
              {t('menu.no_recent' as any) || 'No recent sessions found'}
            </div>
          ) : (
            historySessions.map((session) => (
              <button
                key={session.id}
                type="button"
                className="empty-pane-history-item"
                onClick={(e) => {
                  e.stopPropagation();
                  if (!session.session_token) return;
                  const payload = encodePaneResumePayload(session);
                  onSelect(historyTool, payload);
                }}
              >
                <span className="empty-pane-history-item-title">{session.name}</span>
                <span className="empty-pane-history-item-meta">
                  {formatSavedAt(session.saved_at, lang)}
                  {session.turn_count ? ` | ${t('task.turns' as any, { count: session.turn_count })}` : ''}
                </span>
                <span className="empty-pane-history-item-cwd">{session.cwd}</span>
              </button>
            ))
          )}
        </div>
      </div>
    );
  }

  if (profileTool) {
    const toolLabel = PANE_CLI_OPTIONS.find((opt) => opt.value === profileTool)?.label ?? String(profileTool);
    return (
      <div className="empty-pane-history">
        <div className="empty-pane-history-head">
          <div className="empty-pane-history-title">
            <span>{toolLabel}</span>
            <span className="empty-pane-history-title-sep">?</span>
            <span>{t('profile.profiles' as any)}</span>
          </div>
          <button
            type="button"
            className="empty-pane-history-close"
            aria-label={t('action.close' as any) || 'Close'}
            onClick={(e) => {
              e.stopPropagation();
              setProfileTool(null);
              setProfilesCfg(null);
              resetProfileEditor();
            }}
          >
            x
          </button>
        </div>

        <div className="empty-pane-profile-toolbar">
          <button
            type="button"
            className="empty-pane-option empty-pane-option--secondary"
            onClick={(e) => {
              e.stopPropagation();
              startCreateProfile();
            }}
          >
            {t('profile.new' as any)}
          </button>
        </div>

        {draftProfile && typeof document !== 'undefined' && createPortal(
          <div className="empty-pane-profile-modal-backdrop" onClick={() => resetProfileEditor()}>
            <div className="empty-pane-profile-modal" onClick={(e) => e.stopPropagation()}>
              <div className="empty-pane-profile-editor">
            <div className="empty-pane-profile-section">
              <button type="button" className="empty-pane-profile-section-head" onClick={() => setOpenSection(openSection === 'basic' ? null : 'basic')}>
                <span>{t('profile.basic_launch' as any)}</span>
                <span>{openSection === 'basic' ? '-' : '+'}</span>
              </button>
              {openSection === 'basic' && (
                <div className="empty-pane-profile-section-body">
                  <input type="text" className="empty-pane-history-search" value={draftProfileId} placeholder={t('profile.profile_id' as any)} onChange={(e) => setDraftProfileId(e.target.value)} />
                  <input type="text" className="empty-pane-history-search" value={draftProfile.label} placeholder={t('profile.label' as any)} onChange={(e) => setDraftProfile({ ...draftProfile, label: e.target.value })} />
                  <input type="text" className="empty-pane-history-search" value={draftProfile.command} placeholder={t('profile.command_override' as any)} onChange={(e) => setDraftProfile({ ...draftProfile, command: e.target.value })} />
                  <textarea className="empty-pane-history-search empty-pane-profile-textarea" value={(draftProfile.extraArgs || []).join('\n')} placeholder={t('profile.extra_args' as any)} onChange={(e) => setDraftProfile({ ...draftProfile, extraArgs: e.target.value.split('\n').map((x) => x.trim()).filter(Boolean) })} />
                </div>
              )}
            </div>

            <div className="empty-pane-profile-section">
              <button type="button" className="empty-pane-profile-section-head" onClick={() => setOpenSection(openSection === 'model' ? null : 'model')}>
                <span>{t('profile.model_access' as any)}</span>
                <span>{openSection === 'model' ? '-' : '+'}</span>
              </button>
              {openSection === 'model' && (
                <div className="empty-pane-profile-section-body">
                  <input type="text" className="empty-pane-history-search" value={draftProfile.apiKeyEnvName || ''} placeholder={t('profile.api_key_env' as any)} onChange={(e) => setDraftProfile({ ...draftProfile, apiKeyEnvName: e.target.value })} />
                  <input type="password" className="empty-pane-history-search" value={draftApiKey} placeholder={t('profile.api_key' as any)} onChange={(e) => setDraftApiKey(e.target.value)} />
                  <div className="empty-pane-profile-helptext">{apiKeyStatus}</div>
                  <input type="text" className="empty-pane-history-search" value={draftProfile.apiBaseUrlEnvName || ''} placeholder={t('profile.base_url_env' as any)} onChange={(e) => setDraftProfile({ ...draftProfile, apiBaseUrlEnvName: e.target.value })} />
                  <input type="text" className="empty-pane-history-search" value={draftProfile.apiBaseUrl || ''} placeholder={t('profile.base_url' as any)} onChange={(e) => setDraftProfile({ ...draftProfile, apiBaseUrl: e.target.value })} />
                  <input type="text" className="empty-pane-history-search" value={draftProfile.model || ''} placeholder={t('profile.model' as any)} onChange={(e) => setDraftProfile({ ...draftProfile, model: e.target.value })} />
                  <textarea className="empty-pane-history-search empty-pane-profile-textarea" value={Object.entries(draftProfile.env || {}).map(([k, v]) => `${k}=${v}`).join('\n')} placeholder={t('profile.extra_env' as any)} onChange={(e) => {
                    const env: Record<string, string> = {};
                    for (const line of e.target.value.split('\n')) {
                      const trimmed = line.trim();
                      if (!trimmed) continue;
                      const idx = trimmed.indexOf('=');
                      if (idx <= 0) continue;
                      env[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1);
                    }
                    setDraftProfile({ ...draftProfile, env });
                  }} />
                </div>
              )}
            </div>

            <div className="empty-pane-profile-section">
              <button type="button" className="empty-pane-profile-section-head" onClick={() => setOpenSection(openSection === 'advanced' ? null : 'advanced')}>
                <span>{t('profile.advanced' as any)}</span>
                <span>{openSection === 'advanced' ? '-' : '+'}</span>
              </button>
              {openSection === 'advanced' && (
                <div className="empty-pane-profile-section-body empty-pane-profile-section-body--scroll">
                  <div className="empty-pane-profile-advanced-grid">
                    <div className="empty-pane-profile-picklist empty-pane-profile-picklist--tall">
                      <div className="empty-pane-profile-picklist-head">
                        <div className="empty-pane-profile-picklist-title">MCP</div>
                        <div className="empty-pane-profile-picklist-actions">
                          <button type="button" onClick={() => setAllMcpSelected(true)}>{t('profile.select_all' as any)}</button>
                          <button type="button" onClick={() => setAllMcpSelected(false)}>{t('profile.clear_all' as any)}</button>
                        </div>
                      </div>
                      <input type="text" className="empty-pane-history-search" value={draftProfile.mcpConfigPath} placeholder={t('profile.mcp_config_path' as any)} onChange={(e) => setDraftProfile({ ...draftProfile, mcpConfigPath: e.target.value })} />
                      <div className="empty-pane-profile-pills empty-pane-profile-pills--scroll">
                        {mcpOptions.map((mcp) => {
                          const checked = (draftProfile.selectedMcpIds || []).includes(mcp.id);
                          return (
                            <label key={mcp.id} className={`empty-pane-profile-pill ${checked ? 'is-selected' : ''}`}>
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={(e) => setDraftProfile({
                                  ...draftProfile,
                                  selectedMcpIds: e.target.checked
                                    ? [...(draftProfile.selectedMcpIds || []), mcp.id]
                                    : (draftProfile.selectedMcpIds || []).filter((x) => x !== mcp.id),
                                })}
                              />
                              <span>{mcp.label}</span>
                            </label>
                          );
                        })}
                      </div>
                      <div className="empty-pane-profile-helptext">
                        {t('profile.mcp_help' as any)}
                      </div>
                    </div>

                    <div className="empty-pane-profile-picklist empty-pane-profile-picklist--tall">
                      <div className="empty-pane-profile-picklist-head">
                        <div className="empty-pane-profile-picklist-title">{t('profile.skills' as any)}</div>
                        <div className="empty-pane-profile-picklist-actions">
                          <button type="button" onClick={() => setAllSkillsSelected(true)}>{t('profile.select_all' as any)}</button>
                          <button type="button" onClick={() => setAllSkillsSelected(false)}>{t('profile.clear_all' as any)}</button>
                        </div>
                      </div>
                      <div className="empty-pane-profile-pills empty-pane-profile-pills--scroll">
                        {skillOptions.map((skill) => {
                          const checked = (draftProfile.skills || []).includes(skill.id);
                          return (
                            <label key={skill.id} className={`empty-pane-profile-pill ${checked ? 'is-selected' : ''}`}>
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={(e) => setDraftProfile({
                                  ...draftProfile,
                                  skills: e.target.checked
                                    ? [...(draftProfile.skills || []), skill.id]
                                    : (draftProfile.skills || []).filter((x) => x !== skill.id),
                                })}
                              />
                              <span>{skill.label}</span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  </div>

                  <textarea className="empty-pane-history-search empty-pane-profile-textarea" value={draftProfile.promptAppend} placeholder={t('profile.prompt_append' as any)} onChange={(e) => setDraftProfile({ ...draftProfile, promptAppend: e.target.value })} />
                  <input type="text" className="empty-pane-history-search" value={draftProfile.promptFilePath} placeholder={t('profile.prompt_file_path' as any)} onChange={(e) => setDraftProfile({ ...draftProfile, promptFilePath: e.target.value })} />
                  <textarea className="empty-pane-history-search empty-pane-profile-textarea" value={draftProfile.startupInput} placeholder={t('profile.startup_input' as any)} onChange={(e) => setDraftProfile({ ...draftProfile, startupInput: e.target.value })} />
                  <textarea className="empty-pane-history-search empty-pane-profile-textarea" value={draftProfile.notes} placeholder={t('profile.notes' as any)} onChange={(e) => setDraftProfile({ ...draftProfile, notes: e.target.value })} />
                  <label className="empty-pane-profile-checkbox">
                    <input type="checkbox" checked={draftProfile.sentinel !== false} onChange={(e) => setDraftProfile({ ...draftProfile, sentinel: e.target.checked })} />
                    <span>{t('profile.enable_sentinel' as any)}</span>
                  </label>
                </div>
              )}
            </div>

            <div className="empty-pane-profile-actions">
              <button type="button" className="empty-pane-option empty-pane-option--secondary" onClick={(e) => { e.stopPropagation(); resetProfileEditor(); }}>{t('profile.cancel' as any)}</button>
              <button type="button" className="empty-pane-option empty-pane-option--primary" onClick={(e) => { e.stopPropagation(); void saveProfile(); }}>{t('profile.save_profile' as any)}</button>
            </div>
              </div>
            </div>
          </div>,
          document.body
        )}

        <div className="empty-pane-history-list">
          {profileEntries.length === 0 ? (
            <div className="empty-pane-history-empty">
              {t('profile.none_found' as any, { tool: toolLabel })}
            </div>
          ) : (
            profileEntries.map(([profileId, profile]) => (
              <div key={profileId} className="empty-pane-profile-row">
                <button
                  type="button"
                  className="empty-pane-history-item empty-pane-profile-launch"
                  onClick={(e) => {
                    e.stopPropagation();
                    onSetSentinel(profile.sentinel !== false);
                    onSelect(launchToolForProfileTool(profile.tool || String(profileTool)), encodeProfilePayload(profileId, profile));
                  }}
                >
                  <span className="empty-pane-history-item-title">{profile.label || profileId}</span>
                  <span className="empty-pane-history-item-meta">
                    {profile.skills?.length ? t('profile.skills_prefix' as any, { skills: profile.skills.join(', ') }) : t('profile.custom_launch' as any)}
                  </span>
                  <span className="empty-pane-history-item-cwd">
                    {profile.notes || profile.command || profile.promptFilePath || ''}
                  </span>
                </button>
                <div className="empty-pane-profile-inline-actions">
                  <button
                    type="button"
                    className="empty-pane-option empty-pane-option--secondary"
                    onClick={(e) => {
                      e.stopPropagation();
                      startEditProfile(profileId, profile);
                    }}
                  >
                    {t('profile.edit' as any)}
                  </button>
                  <button
                    type="button"
                    className="empty-pane-option empty-pane-option--secondary"
                    onClick={(e) => {
                      e.stopPropagation();
                      void deleteProfile(profileId);
                    }}
                  >
                    {t('profile.delete' as any)}
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="empty-pane-picker">
      <div className="empty-pane-options">
        {PANE_CLI_OPTIONS.map((opt) => {
          // Default to installed when the detection result hasn't landed
          // yet (keys missing) to avoid a false-negative flash on mount.
          const installed = toolsInstalled[String(opt.value)] !== false;
          return (
            <div key={String(opt.value)} className="empty-pane-option-row">
              <button
                className="empty-pane-option empty-pane-option--primary"
                disabled={!installed}
                onClick={(e) => {
                  e.stopPropagation();
                  if (!installed) return;
                  onSelect(opt.value);
                }}
              >
                {opt.label}
              </button>
              <button
                className="empty-pane-option empty-pane-option--secondary"
                disabled={!installed}
                onClick={(e) => {
                  e.stopPropagation();
                  if (!installed) return;
                  setHistoryTool(opt.value);
                  setHistorySearch('');
                }}
              >
                {t('task.tab.sessions' as any)}
              </button>
              <button
                className="empty-pane-option empty-pane-option--secondary"
                disabled={!installed}
                onClick={(e) => {
                  e.stopPropagation();
                  if (!installed) return;
                  setProfileTool(opt.value);
                }}
              >
                {t('profile.profiles' as any)}
              </button>
            </div>
          );
        })}
      </div>
      <div className="sentinel-toggle-row">
        <div
          className="sentinel-toggle-head"
          role="button"
          tabIndex={0}
          aria-pressed={sentinelEnabled}
          aria-label={t('profile.toggle_sentinel' as any)}
          onClick={(e) => { e.stopPropagation(); onToggleSentinel(); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onToggleSentinel();
            }
          }}
        >
          <span className="sentinel-toggle-label">{t('sentinel.protocol' as any)}</span>
          <span
            className={`sentinel-switch${sentinelEnabled ? ' is-on' : ''}`}
            aria-hidden="true"
          />
        </div>
      </div>
    </div>
  );
}
