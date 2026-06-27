import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { commands, waitForTauriBridge, type CtfModeStatus, type MultiAgentPaneProfile, type MultiAgentProfilesConfig, type MultiAgentTeamPreset } from '../../tauri';
import { useAppState, type AgentStatus, type MultiAgentPane, type TerminalSession, type ToolType } from '../../store/app-state';
import { MultiAgentGrid } from './MultiAgentGrid';
import { ErrorBoundary } from '../common/ErrorBoundary';

interface Props {
  tab: TerminalSession;
  hasBg: boolean;
  bgUrl: string;
  bgType: 'image' | 'video' | 'none';
}

type MainView = 'coffee' | 'breachweave' | 'logs';

interface CtfModeTimelineEntry {
  id: string;
  ts: number;
  paneIdx?: number;
  taskId?: string;
  kind: 'launch' | 'completion' | 'status' | 'info' | 'result';
  text: string;
}

interface CtfResultCard {
  id: string;
  ts: number;
  paneIdx: number;
  targetPaneIdx?: number;
  taskId: string;
  resultExcerpt: string;
  notifyInjected?: boolean;
  reason?: string;
  controlChannel?: string;
}

interface SentinelDonePayload {
  tab_id: string;
  emitter_pane_idx: number;
  target_pane_idx: number;
  notify_injected: boolean;
  task_id?: string;
  result_excerpt?: string;
  reason?: string;
}

interface SentinelResultPayload {
  tab_id: string;
  emitter_pane_idx: number;
  target_pane_idx: number;
  task_id: string;
  result_excerpt: string;
  control_channel?: string;
}

interface SentinelDispatchPayload {
  tab_id: string;
  emitter_session_id: string;
  emitter_pane_id: string;
  target_session_id: string;
  target_pane_id: string;
  task_id: string;
  batch_id?: string;
  dispatch_text: string;
  status: string;
}

interface CtfTaskLedgerEntry {
  id: string;
  ts: number;
  taskId: string;
  batchId?: string;
  fromPaneId: string;
  toPaneId: string;
  dispatchText: string;
  status: 'dispatched' | 'result' | 'completed' | 'wake_failed';
  resultExcerpt?: string;
  updatedAt: number;
  wakeReason?: string;
}

interface CtfModeConfig {
  rootPath: string;
  target: string;
  notes: string;
  operatorPrompt: string;
  teamPresetId: string;
}

interface CtfModeRuntimeState {
  mainView: MainView;
  timeline: CtfModeTimelineEntry[];
  resultCards: CtfResultCard[];
  taskLedger: CtfTaskLedgerEntry[];
}

interface CtfPresetDraft {
  id: string;
  label: string;
  layout: 'two-agent' | 'three-agent' | 'multi-agent';
  pane1: string;
  pane2: string;
  pane3: string;
  pane4: string;
  teamPrompt: string;
  notes: string;
}

type PresetPaneLike = {
  paneIdx?: number;
  pane_idx?: number;
  profileId?: string;
  profile_id?: string;
};

const DEFAULT_ROOT = 'G:\\coffee\\BreachWeave-main';
const DEFAULT_URL = 'http://127.0.0.1:3000/';
const DEFAULT_PRESET = 'ctf-trio-shell';
const MAX_TIMELINE_ITEMS = 60;
const MAX_RESULT_CARDS = 12;
const MAX_TASK_LEDGER_ITEMS = 24;
const EMPTY_MULTI_AGENT_PANES: MultiAgentPane[] = [];

function defaultConfig(): CtfModeConfig {
  return {
    rootPath: DEFAULT_ROOT,
    target: '',
    notes: '',
    operatorPrompt: '',
    teamPresetId: DEFAULT_PRESET,
  };
}

function defaultRuntime(): CtfModeRuntimeState {
  return {
    mainView: 'coffee',
    timeline: [],
    resultCards: [],
    taskLedger: [],
  };
}

function decodeConfig(raw?: string): CtfModeConfig {
  if (!raw) return defaultConfig();
  try {
    const parsed = JSON.parse(raw);
    return {
      rootPath: typeof parsed.rootPath === 'string' && parsed.rootPath.trim() ? parsed.rootPath.trim() : DEFAULT_ROOT,
      target: typeof parsed.target === 'string' ? parsed.target : '',
      notes: typeof parsed.notes === 'string' ? parsed.notes : '',
      operatorPrompt: typeof parsed.operatorPrompt === 'string' ? parsed.operatorPrompt : '',
      teamPresetId: typeof parsed.teamPresetId === 'string' && parsed.teamPresetId.trim() ? parsed.teamPresetId.trim() : DEFAULT_PRESET,
    };
  } catch {
    return defaultConfig();
  }
}

function decodeRuntime(raw?: string): CtfModeRuntimeState {
  if (!raw) return defaultRuntime();
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const runtime = parsed.runtime && typeof parsed.runtime === 'object'
      ? parsed.runtime as Record<string, unknown>
      : null;
    if (!runtime) return defaultRuntime();
    const mainView = runtime.mainView === 'breachweave' || runtime.mainView === 'logs' ? runtime.mainView : 'coffee';
    const timeline = Array.isArray(runtime.timeline) ? runtime.timeline.filter(Boolean).slice(0, MAX_TIMELINE_ITEMS) as CtfModeTimelineEntry[] : [];
    const resultCards = Array.isArray(runtime.resultCards) ? runtime.resultCards.filter(Boolean).slice(0, MAX_RESULT_CARDS) as CtfResultCard[] : [];
    const taskLedger = Array.isArray(runtime.taskLedger) ? runtime.taskLedger.filter(Boolean).slice(0, MAX_TASK_LEDGER_ITEMS) as CtfTaskLedgerEntry[] : [];
    return { mainView, timeline, resultCards, taskLedger };
  } catch {
    return defaultRuntime();
  }
}

function encodeToolData(config: CtfModeConfig, runtime: CtfModeRuntimeState): string {
  return JSON.stringify({
    ...config,
    runtime: {
      mainView: runtime.mainView,
      timeline: runtime.timeline.slice(0, MAX_TIMELINE_ITEMS),
      resultCards: runtime.resultCards.slice(0, MAX_RESULT_CARDS),
      taskLedger: runtime.taskLedger.slice(0, MAX_TASK_LEDGER_ITEMS),
    },
  });
}

function launchToolForProfileTool(tool?: string): ToolType {
  if ((tool || '').trim().toLowerCase() === 'shell') return 'terminal';
  return ((tool as ToolType) || null);
}

function paneCountForLayout(layout: string): 2 | 3 | 4 {
  if (layout === 'two-agent') return 2;
  if (layout === 'three-agent') return 3;
  return 4;
}

function encodeProfilePayload(
  profileId: string,
  profile: MultiAgentPaneProfile,
  teamPrompt: string,
  startupInput: string,
): string {
  return JSON.stringify({
    __coffeePaneLaunchMode: 'profile-v1',
    profile_id: profileId,
    label: profile.label || profileId,
    command: profile.command || '',
    extra_args: profile.extraArgs || [],
    env: profile.env || {},
    prompt_append: profile.promptAppend || '',
    prompt_file_path: profile.promptFilePath || '',
    startup_input: startupInput,
    mcp_config_path: profile.mcpConfigPath || '',
    api_key_env_name: profile.apiKeyEnvName || '',
    api_base_url_env_name: profile.apiBaseUrlEnvName || '',
    api_base_url: profile.apiBaseUrl || '',
    model: profile.model || '',
    selected_mcp_ids: profile.selectedMcpIds || [],
    skills: profile.skills || [],
    team_prompt: teamPrompt,
  });
}

function buildTeamPrompt(config: CtfModeConfig, breachWeaveUrl: string, preset: MultiAgentTeamPreset): string {
  const target = config.target.trim() || '(target not set)';
  const notes = config.notes.trim();
  const operatorPrompt = config.operatorPrompt.trim();
  return [
    `CTF mode is active inside Coffee CLI.`,
    `Primary target: ${target}`,
    notes ? `Operator notes:\n${notes}` : '',
    operatorPrompt ? `Custom CTF prompt:\n${operatorPrompt}` : '',
    `Use only local tools and Coffee pane coordination by default.`,
    `If you need the external execution shell / dashboard, BreachWeave is available at ${breachWeaveUrl}.`,
    `Current team preset: ${preset.label}`,
    `Team rule: ${preset.teamPrompt}`,
  ].filter(Boolean).join('\n\n');
}

function buildStartupInput(profileId: string, config: CtfModeConfig): string {
  const target = config.target.trim() || '(target not set)';
  const notes = config.notes.trim().replace(/\s+/g, ' ').trim();
  const notesText = notes ? ` Notes: ${notes}.` : '';
  const promptText = config.operatorPrompt.trim().replace(/\s+/g, ' ').trim();
  const promptSuffix = promptText ? ` Extra rule: ${promptText}.` : '';
  if (profileId.includes('manager')) {
    return `Start the CTF operation now for target ${target}.${notesText}${promptSuffix} Create the smallest useful plan, then delegate concrete tasks with coffee-cli MCP send_to_pane and keep the team moving toward the flag.\r`;
  }
  if (profileId.includes('observer')) {
    return `Observer standby for target ${target}.${notesText}${promptSuffix} Track hypotheses, evidence, and duplicate work. Summarize and redirect when needed.\r`;
  }
  if (profileId.includes('shell')) {
    return '';
  }
  return `Worker standby for target ${target}.${notesText}${promptSuffix} Wait for a specific task from the manager pane before acting.\r`;
}

function statusLabel(status?: AgentStatus): string {
  if (!status) return 'booting';
  if (status === 'idle') return 'idle';
  if (status === 'working') return 'working';
  return 'wait_input';
}

function roleLabel(profileId?: string): string {
  const id = profileId || '';
  if (id.includes('manager')) return 'Manager';
  if (id.includes('shell')) return 'Shell Worker';
  if (id.includes('observer')) return 'Observer';
  return 'Worker';
}

function roleDescription(profileId?: string): string {
  const id = profileId || '';
  if (id.includes('manager')) return '拆解任务、分发给其他 pane、回收结果并决定下一步。';
  if (id.includes('shell')) return '承载 PowerShell / shell / SSH / nc / 反弹 shell / 交互式工具，由 manager pane 派发具体命令进去执行。';
  if (id.includes('observer')) return '跟踪证据、避免重复劳动、总结当前进展并提示换路。';
  if (id.includes('claude')) return '偏 Web 入口摸排、页面交互、漏洞验证。';
  if (id.includes('codex')) return '偏自动化执行、脚本化验证、本地工具链联动。';
  return '按 manager 派发的具体任务执行并回传 DONE。';
}

function paneProfileIdFromToolData(toolData?: string): string | undefined {
  if (!toolData) return;
  try {
    const parsed = JSON.parse(toolData);
    return typeof parsed.profile_id === 'string' ? parsed.profile_id : undefined;
  } catch {
    return;
  }
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

function pushTimelineEntry(
  setTimeline: React.Dispatch<React.SetStateAction<CtfModeTimelineEntry[]>>,
  entry: CtfModeTimelineEntry,
) {
  setTimeline((current) => [entry, ...current].slice(0, MAX_TIMELINE_ITEMS));
}

function shortenTaskId(taskId?: string): string {
  if (!taskId) return 'legacy';
  return taskId.length > 14 ? `${taskId.slice(0, 8)}...${taskId.slice(-4)}` : taskId;
}

function summarizeResultExcerpt(text?: string): string {
  const compact = (text || '').replace(/\s+/g, ' ').trim();
  if (!compact) return '(no structured result body)';
  return compact.length > 220 ? `${compact.slice(0, 220)}…` : compact;
}

function summarizeLedgerPreview(item: CtfTaskLedgerEntry): string {
  if (item.status === 'dispatched') {
    return summarizeResultExcerpt(item.dispatchText);
  }
  if (item.status === 'result') {
    return 'Structured result received. See Task Results for the full worker output.';
  }
  if (item.status === 'completed') {
    return 'Task completed and dispatcher wake-up was sent successfully.';
  }
  if (item.status === 'wake_failed') {
    return 'Task completed, but dispatcher wake-up failed. See reason below.';
  }
  return summarizeResultExcerpt(item.dispatchText);
}

function sectionStyle(): React.CSSProperties {
  return {
    padding: 12,
    borderRadius: 10,
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid rgba(255,255,255,0.08)',
  };
}

function ledgerStatusTone(status: CtfTaskLedgerEntry['status']): React.CSSProperties {
  if (status === 'completed') {
    return { color: '#79d48f', background: 'rgba(121,212,143,0.12)', border: '1px solid rgba(121,212,143,0.25)' };
  }
  if (status === 'result') {
    return { color: '#8dc4ff', background: 'rgba(141,196,255,0.12)', border: '1px solid rgba(141,196,255,0.25)' };
  }
  if (status === 'wake_failed') {
    return { color: '#ff9a9a', background: 'rgba(255,154,154,0.12)', border: '1px solid rgba(255,154,154,0.25)' };
  }
  return { color: '#e2c27b', background: 'rgba(226,194,123,0.12)', border: '1px solid rgba(226,194,123,0.25)' };
}

function trimPreview(text: string, limit = 96): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= limit) return compact;
  return `${compact.slice(0, limit)}…`;
}

interface TaskLedgerGroup {
  id: string;
  label: string;
  entries: CtfTaskLedgerEntry[];
}

function groupLedgerEntries(entries: CtfTaskLedgerEntry[]): TaskLedgerGroup[] {
  const groups = new Map<string, CtfTaskLedgerEntry[]>();
  for (const entry of entries) {
    const key = entry.batchId || `task:${entry.taskId}`;
    const bucket = groups.get(key) || [];
    bucket.push(entry);
    groups.set(key, bucket);
  }
  return [...groups.entries()]
    .map(([id, groupedEntries]) => ({
      id,
      label: id.startsWith('task:') ? `single ${shortenTaskId(groupedEntries[0]?.taskId)}` : `batch ${shortenTaskId(id)}`,
      entries: groupedEntries.sort((a, b) => b.updatedAt - a.updatedAt),
    }))
    .sort((a, b) => {
      const aTs = a.entries[0]?.updatedAt || 0;
      const bTs = b.entries[0]?.updatedAt || 0;
      return bTs - aTs;
    });
}

const TaskLedgerSection = memo(function TaskLedgerSection({
  entries,
  title = 'Task Ledger',
  minHeight = 200,
}: {
  entries: CtfTaskLedgerEntry[];
  title?: string;
  minHeight?: number;
}) {
  const counts = useMemo(() => ({
    dispatched: entries.filter((item) => item.status === 'dispatched').length,
    result: entries.filter((item) => item.status === 'result').length,
    completed: entries.filter((item) => item.status === 'completed').length,
    wake_failed: entries.filter((item) => item.status === 'wake_failed').length,
  }), [entries]);
  const groups = useMemo(() => groupLedgerEntries(entries), [entries]);

  return (
    <div style={{ ...sectionStyle(), minHeight }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
        <div style={{ fontSize: 12, opacity: 0.72 }}>{title}</div>
        <div style={{ fontSize: 11, opacity: 0.62 }}>
          G {groups.length} · D {counts.dispatched} · R {counts.result} · C {counts.completed} · F {counts.wake_failed}
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 12 }}>
        {entries.length === 0 ? (
          <div style={{ opacity: 0.7 }}>
            No dispatch recorded yet. Once the manager calls send_to_pane, the task ledger will show dispatch, result, completion, and wake-up state.
          </div>
        ) : groups.map((group) => {
          const groupCounts = {
            dispatched: group.entries.filter((item) => item.status === 'dispatched').length,
            result: group.entries.filter((item) => item.status === 'result').length,
            completed: group.entries.filter((item) => item.status === 'completed').length,
            wake_failed: group.entries.filter((item) => item.status === 'wake_failed').length,
          };
          return (
          <div
            key={group.id}
            style={{
              padding: '9px 10px',
              borderRadius: 8,
              background: 'rgba(255,255,255,0.03)',
              border: '1px solid rgba(255,255,255,0.08)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 8, alignItems: 'center' }}>
              <div>
                <div style={{ fontWeight: 700 }}>{group.label}</div>
                <div style={{ opacity: 0.62, fontSize: 11 }}>
                  {group.entries.length} task events
                </div>
              </div>
              <div style={{ fontSize: 11, opacity: 0.62, textAlign: 'right' }}>
                <div>{formatTime(group.entries[0]?.updatedAt || Date.now())}</div>
                <div>D {groupCounts.dispatched} · R {groupCounts.result} · C {groupCounts.completed} · F {groupCounts.wake_failed}</div>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {group.entries.map((item) => (
                <div
                  key={item.id}
                  style={{
                    padding: '8px 9px',
                    borderRadius: 8,
                    background: 'rgba(255,255,255,0.025)',
                    border: '1px solid rgba(255,255,255,0.06)',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', minWidth: 0 }}>
                      <strong>{shortenTaskId(item.taskId)}</strong>
                      <span style={{
                        ...ledgerStatusTone(item.status),
                        fontSize: 10,
                        padding: '2px 6px',
                        borderRadius: 999,
                        whiteSpace: 'nowrap',
                      }}>
                        {item.status}
                      </span>
                    </div>
                    <span style={{ opacity: 0.62, whiteSpace: 'nowrap' }}>{formatTime(item.updatedAt)}</span>
                  </div>
                  <div style={{ opacity: 0.78, marginTop: 5 }}>{item.fromPaneId} {'->'} {item.toPaneId}</div>
                  <div style={{ opacity: 0.68, marginTop: 6, lineHeight: 1.45 }}>
                    {trimPreview(summarizeLedgerPreview(item), 140)}
                  </div>
                  {item.wakeReason ? (
                    <div style={{ marginTop: 6, color: '#ff9a9a' }}>{item.wakeReason}</div>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        )})}
      </div>
    </div>
  );
});

const ResultCardsSection = memo(function ResultCardsSection({
  resultCards,
  title = 'Task Results',
  minHeight = 180,
}: {
  resultCards: CtfResultCard[];
  title?: string;
  minHeight?: number;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  return (
    <div style={{ ...sectionStyle(), minHeight }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
        <div style={{ fontSize: 12, opacity: 0.72 }}>{title}</div>
        <div style={{ fontSize: 11, opacity: 0.62 }}>{resultCards.length} cards</div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 12 }}>
        {resultCards.length === 0 ? (
          <div style={{ opacity: 0.7 }}>
            No structured RESULT yet. Once a worker emits `COFFEE-RESULT-BEGIN/END`, cards appear here directly without rereading noisy pane output.
          </div>
        ) : resultCards.map((item) => (
          <div
            key={item.id}
            style={{
              padding: 10,
              borderRadius: 8,
              background: 'rgba(255,255,255,0.03)',
              border: '1px solid rgba(255,255,255,0.08)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
              <strong>Pane {item.paneIdx}</strong>
              <span style={{ opacity: 0.62 }}>{formatTime(item.ts)}</span>
            </div>
            <div style={{ opacity: 0.78, marginBottom: 4 }}>
              Task {shortenTaskId(item.taskId)} {'->'} pane {item.targetPaneIdx || '?'}
            </div>
              <div style={{ opacity: 0.66, marginBottom: 6 }}>
                channel: {item.controlChannel || 'sentinel-control-v1'}
                {typeof item.notifyInjected === 'boolean'
                  ? ` | wake-up: ${item.notifyInjected ? 'ok' : 'failed'}`
                  : ''}
              </div>
            <div style={{ lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {expanded[item.id] ? item.resultExcerpt : summarizeResultExcerpt(item.resultExcerpt)}
            </div>
            {item.resultExcerpt.length > 220 ? (
              <button
                onClick={() => setExpanded((current) => ({ ...current, [item.id]: !current[item.id] }))}
                style={{
                  marginTop: 8,
                  padding: '4px 8px',
                  borderRadius: 8,
                  border: '1px solid rgba(255,255,255,0.12)',
                  background: 'transparent',
                  color: 'inherit',
                  cursor: 'pointer',
                  fontSize: 11,
                }}
              >
                {expanded[item.id] ? '收起全文' : '展开全文'}
              </button>
            ) : null}
            {item.reason ? (
              <div style={{ marginTop: 6, color: '#ff9a9a', lineHeight: 1.5 }}>
                {item.reason}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
});

const TimelineSection = memo(function TimelineSection({ timeline }: { timeline: CtfModeTimelineEntry[] }) {
  return (
    <div style={{ ...sectionStyle(), minHeight: 180 }}>
      <div style={{ fontSize: 12, opacity: 0.72, marginBottom: 8 }}>Timeline</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12 }}>
        {timeline.length === 0 ? (
          <div style={{ opacity: 0.7 }}>暂无队伍事件。启动队伍后，这里记录 manager kickoff、worker 状态变化、dispatch、RESULT、DONE 回执。</div>
        ) : timeline.map((item) => (
          <div key={item.id}>
            <div style={{ opacity: 0.58 }}>{formatTime(item.ts)}</div>
            <div>{item.text}</div>
          </div>
        ))}
      </div>
    </div>
  );
});

const MainStageTaskFlow = memo(function MainStageTaskFlow({
  resultCards,
  taskLedger,
}: {
  resultCards: CtfResultCard[];
  taskLedger: CtfTaskLedgerEntry[];
}) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.35fr) minmax(280px, 0.95fr)', gap: 12 }}>
      <ResultCardsSection resultCards={resultCards} title="Main Stage Results" minHeight={0} />
      <TaskLedgerSection entries={taskLedger.slice(0, 10)} title="Task Flow" minHeight={0} />
    </div>
  );
});

function getPresetPaneIdx(pane: PresetPaneLike): number {
  return typeof pane.paneIdx === 'number' ? pane.paneIdx : Number(pane.pane_idx ?? 0);
}

function getPresetProfileId(pane: PresetPaneLike): string {
  return typeof pane.profileId === 'string' && pane.profileId.trim()
    ? pane.profileId.trim()
    : typeof pane.profile_id === 'string'
      ? pane.profile_id.trim()
      : '';
}

export function CtfModePanel({ tab, hasBg, bgUrl, bgType }: Props) {
  const { state, dispatch } = useAppState();
  const [config, setConfig] = useState<CtfModeConfig>(() => decodeConfig(tab.toolData));
  const [status, setStatus] = useState<CtfModeStatus | null>(null);
  const [profilesCfg, setProfilesCfg] = useState<MultiAgentProfilesConfig | null>(null);
  const [toolsInstalled, setToolsInstalled] = useState<Record<string, boolean>>({});
  const [timeline, setTimeline] = useState<CtfModeTimelineEntry[]>(() => decodeRuntime(tab.toolData).timeline);
  const [resultCards, setResultCards] = useState<CtfResultCard[]>(() => decodeRuntime(tab.toolData).resultCards);
  const [taskLedger, setTaskLedger] = useState<CtfTaskLedgerEntry[]>(() => decodeRuntime(tab.toolData).taskLedger);
  const statusSeenRef = useRef<Record<number, AgentStatus | undefined>>({});
  const seenTaskIdsRef = useRef<Set<string>>(new Set(decodeRuntime(tab.toolData).resultCards.map((item) => item.taskId)));
  const [busy, setBusy] = useState<'start' | 'stop' | 'team' | ''>('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [mainView, setMainView] = useState<MainView>(() => decodeRuntime(tab.toolData).mainView);
  const [editingPreset, setEditingPreset] = useState(false);
  const kickoffTimersRef = useRef<number[]>([]);
  const lastPersistedToolDataRef = useRef<string>(typeof tab.toolData === 'string' ? tab.toolData : '');
  const [presetDraft, setPresetDraft] = useState<CtfPresetDraft>({
    id: '',
    label: '',
    layout: 'three-agent',
    pane1: 'ctf-manager-codex',
    pane2: 'ctf-solver-codex',
    pane3: 'ctf-observer-gemini',
    pane4: 'ctf-solver-claude',
    teamPrompt: '',
    notes: '',
  });

  useEffect(() => {
    const incoming = typeof tab.toolData === 'string' ? tab.toolData : '';
    if (incoming === lastPersistedToolDataRef.current) return;
    const nextConfig = decodeConfig(tab.toolData);
    const nextRuntime = decodeRuntime(tab.toolData);
    lastPersistedToolDataRef.current = incoming;
    setConfig(nextConfig);
    setTimeline(nextRuntime.timeline);
    setResultCards(nextRuntime.resultCards);
    setTaskLedger(nextRuntime.taskLedger);
    setMainView(nextRuntime.mainView);
    seenTaskIdsRef.current = new Set(nextRuntime.resultCards.map((item) => item.taskId));
  }, [tab.toolData]);

  useEffect(() => {
    commands.getMultiAgentProfiles().then(setProfilesCfg).catch(() => setProfilesCfg(null));
    commands.checkToolsInstalled().then(setToolsInstalled).catch(() => setToolsInstalled({}));
  }, []);

  useEffect(() => {
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
  }, []);

  const persistConfig = (next: CtfModeConfig) => {
    setConfig(next);
  };

  const persistRuntime = useCallback((nextConfig: CtfModeConfig, nextRuntime: CtfModeRuntimeState) => {
    const nextToolData = encodeToolData(nextConfig, nextRuntime);
    if (nextToolData === lastPersistedToolDataRef.current) return;
    lastPersistedToolDataRef.current = nextToolData;
    dispatch({
      type: 'SET_TERMINAL_TOOL',
      id: tab.id,
      tool: tab.tool,
      toolData: nextToolData,
    });
  }, [dispatch, tab.id, tab.tool]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      persistRuntime(config, { mainView, timeline, resultCards, taskLedger });
    }, 120);
    return () => window.clearTimeout(timer);
  }, [config, mainView, timeline, resultCards, taskLedger, persistRuntime]);

  const upsertLedgerEntry = (patch: CtfTaskLedgerEntry) => {
    setTaskLedger((current) => {
      const idx = current.findIndex((item) => item.taskId === patch.taskId);
      if (idx === -1) return [patch, ...current].slice(0, MAX_TASK_LEDGER_ITEMS);
      const next = [...current];
      next[idx] = { ...next[idx], ...patch, updatedAt: patch.updatedAt };
      next.sort((a, b) => b.updatedAt - a.updatedAt);
      return next.slice(0, MAX_TASK_LEDGER_ITEMS);
    });
  };

  const refreshStatus = async () => {
    try {
      const next = await commands.ctfModeStatus(config.rootPath, 120);
      setStatus(next);
      setError('');
      return next;
    } catch (e) {
      setError(String(e));
      return null;
    }
  };

  const clearKickoffTimers = () => {
    for (const timer of kickoffTimersRef.current) window.clearTimeout(timer);
    kickoffTimersRef.current = [];
  };

  const queueTerminalPacket = (sessionId: string, body: string, delayMs: number) => {
    kickoffTimersRef.current.push(window.setTimeout(() => {
      commands.tierTerminalInput(sessionId, body).catch(() => {});
    }, delayMs));
    kickoffTimersRef.current.push(window.setTimeout(() => {
      commands.tierTerminalInput(sessionId, '\r').catch(() => {});
    }, delayMs + 450));
  };

  useEffect(() => () => clearKickoffTimers(), []);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const next = await commands.ctfModeStatus(config.rootPath, 120).catch((e) => {
        if (!cancelled) setError(String(e));
        return null;
      });
      if (!cancelled && next) {
        setStatus(next);
        setError('');
      }
    };
    run();
    const timer = window.setInterval(run, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [config.rootPath]);

  const launchUrl = status?.serviceUrl || DEFAULT_URL;

  const ctfPresets = useMemo(() => {
    const presets = profilesCfg?.teamPresets || {};
    return Object.entries(presets).filter(([id]) => id.startsWith('ctf-'));
  }, [profilesCfg]);

  const ctfProfileOptions = useMemo(() => {
    const entries = Object.entries(profilesCfg?.profiles || {}).filter(([id]) => id.startsWith('ctf-'));
    return entries.map(([id, profile]) => ({
      id,
      label: profile.label || id,
      tool: profile.tool || 'unknown',
      installed: profile.tool
        ? (profile.tool === 'shell' ? true : toolsInstalled[profile.tool] !== false)
        : true,
    }));
  }, [profilesCfg, toolsInstalled]);

  const selectedPreset = useMemo(
    () => profilesCfg?.teamPresets?.[config.teamPresetId],
    [profilesCfg, config.teamPresetId],
  );

  const presetMissingTools = useMemo(() => {
    if (!selectedPreset || !profilesCfg) return [] as string[];
    const required = new Set<string>();
    for (const pane of selectedPreset.panes) {
      const profileId = getPresetProfileId(pane as PresetPaneLike);
      const profile = profilesCfg.profiles[profileId];
      const tool = profile?.tool?.trim();
      if (tool) required.add(tool);
    }
    return [...required].filter((tool) => toolsInstalled[tool] === false);
  }, [profilesCfg, selectedPreset, toolsInstalled]);

  const isPresetRunnable = useCallback((presetId: string): boolean => {
    if (!profilesCfg) return false;
    const preset = profilesCfg.teamPresets[presetId];
    if (!preset) return false;
    return preset.panes.every((pane) => {
      const profileId = getPresetProfileId(pane as PresetPaneLike);
      const tool = profilesCfg.profiles[profileId]?.tool?.trim();
      return !tool || tool === 'shell' || toolsInstalled[tool] !== false;
    });
  }, [profilesCfg, toolsInstalled]);

  const compatiblePresetId = useMemo(() => {
    if (!profilesCfg) return '';
    const ctfIds = Object.keys(profilesCfg.teamPresets).filter((id) => id.startsWith('ctf-'));
    const currentLayout = selectedPreset?.layout || 'multi-agent';
    const sameLayout = ctfIds.filter((id) => profilesCfg.teamPresets[id]?.layout === currentLayout);
    return sameLayout.find((id) => isPresetRunnable(id))
      || ctfIds.find((id) => isPresetRunnable(id))
      || '';
  }, [profilesCfg, selectedPreset, isPresetRunnable]);

  useEffect(() => {
    if (!profilesCfg) return;
    if (config.teamPresetId && profilesCfg.teamPresets[config.teamPresetId]) return;
    const ctfIds = Object.keys(profilesCfg.teamPresets).filter((id) => id.startsWith('ctf-'));
    const first = compatiblePresetId || ctfIds[0] || DEFAULT_PRESET;
    persistConfig({ ...config, teamPresetId: first });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profilesCfg, toolsInstalled, compatiblePresetId]);

  const teamPanes = useMemo(() => tab.multiAgent?.panes ?? EMPTY_MULTI_AGENT_PANES, [tab.multiAgent?.panes]);
  const paneCount = paneCountForLayout(selectedPreset?.layout || 'multi-agent');

  useEffect(() => {
    if (!teamPanes.length) return;
    for (const pane of teamPanes) {
      if (pane.agentStatus && statusSeenRef.current[pane.paneIdx] !== pane.agentStatus) {
        statusSeenRef.current[pane.paneIdx] = pane.agentStatus;
        const profileId = paneProfileIdFromToolData(pane.toolData);
        pushTimelineEntry(setTimeline, {
          id: `status-${pane.paneIdx}-${pane.agentStatus}-${Date.now()}`,
          ts: Date.now(),
          paneIdx: pane.paneIdx,
          kind: 'status',
          text: `Pane ${pane.paneIdx} (${roleLabel(profileId)}) → ${statusLabel(pane.agentStatus)}`,
        });
      }
    }
  }, [teamPanes]);

  useEffect(() => {
    let cancelled = false;
    let unlistenDispatch: (() => void) | null = null;
    let unlistenDone: (() => void) | null = null;
    let unlistenResult: (() => void) | null = null;

    waitForTauriBridge({ events: true, timeoutMs: 5000 })
      .then(async (ready) => {
        if (!ready || cancelled) return;
        const { listen } = await import('@tauri-apps/api/event');
        const dispatchUnlisten = await listen<SentinelDispatchPayload>('sentinel-dispatch', (event) => {
          if (cancelled) return;
          const payload = event.payload;
          if (payload.tab_id !== tab.id) return;
          const now = Date.now();
          upsertLedgerEntry({
            id: `dispatch-${payload.task_id}`,
            ts: now,
            updatedAt: now,
            taskId: payload.task_id,
            batchId: payload.batch_id,
            fromPaneId: payload.emitter_pane_id,
            toPaneId: payload.target_pane_id,
            dispatchText: payload.dispatch_text,
            status: 'dispatched',
          });
          pushTimelineEntry(setTimeline, {
            id: `dispatch-${payload.task_id}-${now}`,
            ts: now,
            taskId: payload.task_id,
            kind: 'info',
            text: `${payload.emitter_pane_id} dispatched task ${shortenTaskId(payload.task_id)} to ${payload.target_pane_id}${payload.batch_id ? ` (batch ${shortenTaskId(payload.batch_id)})` : ''}.`,
          });
        });

        const resultUnlisten = await listen<SentinelResultPayload>('sentinel-result', (event) => {
          if (cancelled) return;
          const payload = event.payload;
          if (payload.tab_id !== tab.id) return;
          const taskKey = payload.task_id || `pane-${payload.emitter_pane_idx}-${Date.now()}`;
          const now = Date.now();
          upsertLedgerEntry({
            id: `dispatch-${payload.task_id}`,
            ts: now,
            updatedAt: now,
            taskId: payload.task_id,
            fromPaneId: `pane-${payload.emitter_pane_idx}`,
            toPaneId: `pane-${payload.target_pane_idx}`,
            dispatchText: '',
            status: 'result',
            resultExcerpt: payload.result_excerpt,
          });
          if (!payload.task_id || !seenTaskIdsRef.current.has(taskKey)) {
            seenTaskIdsRef.current.add(taskKey);
            setResultCards((current) => [
              {
                id: `result-${taskKey}`,
                ts: now,
                paneIdx: payload.emitter_pane_idx,
                targetPaneIdx: payload.target_pane_idx,
                taskId: payload.task_id,
                resultExcerpt: payload.result_excerpt,
                controlChannel: payload.control_channel || 'sentinel-control-v1',
              },
              ...current,
            ].slice(0, MAX_RESULT_CARDS));
            pushTimelineEntry(setTimeline, {
              id: `result-${taskKey}`,
              ts: now,
              paneIdx: payload.emitter_pane_idx,
              taskId: payload.task_id,
              kind: 'result',
              text: `Pane ${payload.emitter_pane_idx} published RESULT for task ${shortenTaskId(payload.task_id)} via ${payload.control_channel || 'sentinel-control-v1'}.`,
            });
          }
        });

        const doneUnlisten = await listen<SentinelDonePayload>('sentinel-done', (event) => {
          if (cancelled) return;
          const payload = event.payload;
          if (payload.tab_id !== tab.id) return;
          const now = Date.now();
          const doneKey = payload.task_id || `legacy-${payload.emitter_pane_idx}-${now}`;
          if (payload.task_id) {
            upsertLedgerEntry({
              id: `dispatch-${payload.task_id}`,
              ts: now,
              updatedAt: now,
              taskId: payload.task_id,
              fromPaneId: `pane-${payload.emitter_pane_idx}`,
              toPaneId: `pane-${payload.target_pane_idx}`,
              dispatchText: '',
              status: payload.notify_injected ? 'completed' : 'wake_failed',
              resultExcerpt: payload.result_excerpt,
              wakeReason: payload.reason,
            });
          }
          setResultCards((current) => {
            const existing = current.find((item) => item.taskId === payload.task_id);
            if (existing) {
              return current.map((item) => (
                item.taskId === payload.task_id
                  ? { ...item, notifyInjected: payload.notify_injected, reason: payload.reason }
                  : item
              ));
            }
            if (!payload.task_id || !payload.result_excerpt) return current;
            seenTaskIdsRef.current.add(doneKey);
            return [
              {
                id: `done-${doneKey}`,
                ts: now,
                paneIdx: payload.emitter_pane_idx,
                targetPaneIdx: payload.target_pane_idx,
                taskId: payload.task_id,
                resultExcerpt: payload.result_excerpt,
                notifyInjected: payload.notify_injected,
                reason: payload.reason,
                controlChannel: 'sentinel-done',
              },
              ...current,
            ].slice(0, MAX_RESULT_CARDS);
          });
          pushTimelineEntry(setTimeline, {
            id: `done-${doneKey}-${now}`,
            ts: now,
            paneIdx: payload.emitter_pane_idx,
            taskId: payload.task_id,
            kind: 'completion',
            text: payload.notify_injected
              ? `Pane ${payload.emitter_pane_idx} completed task ${shortenTaskId(payload.task_id)} and woke pane ${payload.target_pane_idx}.`
              : `Pane ${payload.emitter_pane_idx} completed task ${shortenTaskId(payload.task_id)}, but wake-up injection failed: ${payload.reason || 'unknown reason'}.`,
          });
        });

        unlistenDispatch = dispatchUnlisten;
        unlistenResult = resultUnlisten;
        unlistenDone = doneUnlisten;
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      unlistenDispatch?.();
      unlistenDone?.();
      unlistenResult?.();
    };
  }, [tab.id]);

  const stateLabel = useMemo(() => {
    if (!status) return '检测中';
    if (!status.rootExists) return 'BreachWeave 路径不存在';
    if (!status.launcherExists) return '缺少 BreachWeave-local.bat';
    return status.running ? '运行中' : '未运行';
  }, [status]);

  const handleStart = async () => {
    setBusy('start');
    setInfo('');
    setError('');
    try {
      const result = await commands.ctfModeStart(config.rootPath);
      if (result.status) setStatus(result.status);
      setInfo(result.message || 'CTF mode started');
      await refreshStatus();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy('');
    }
  };

  const handleStop = async () => {
    setBusy('stop');
    setInfo('');
    setError('');
    try {
      const result = await commands.ctfModeStop(config.rootPath);
      if (result.status) setStatus(result.status);
      setInfo(result.message || 'CTF mode stopped');
      await refreshStatus();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy('');
    }
  };

  const handleLaunchTeam = async () => {
    if (!profilesCfg) {
      setError('Multi-agent profiles are not available yet.');
      return;
    }
    const preset = profilesCfg.teamPresets[config.teamPresetId];
    if (!preset) {
      setError('Selected CTF preset was not found.');
      return;
    }
    if (presetMissingTools.length > 0) {
      setError(`当前模板依赖未安装的 CLI：${presetMissingTools.join(', ')}。请切换模板或先安装对应工具。`);
      return;
    }

    setBusy('team');
    setError('');
    setInfo('');
    try {
      const teamPrompt = buildTeamPrompt(config, launchUrl, preset);
      const paneMap = new Map<number, { profileId: string; profile: MultiAgentPaneProfile }>();
      for (const pane of preset.panes) {
        const presetPane = pane as PresetPaneLike;
        const profileId = getPresetProfileId(presetPane);
        const paneIdx = getPresetPaneIdx(presetPane);
        const profile = profilesCfg.profiles[profileId];
        if (!profileId) throw new Error('Preset pane is missing profileId.');
        if (!Number.isFinite(paneIdx) || paneIdx <= 0) throw new Error(`Preset pane has invalid paneIdx: ${String((presetPane as any).paneIdx ?? (presetPane as any).pane_idx)}`);
        if (!profile) throw new Error(`Profile not found: ${profileId}`);
        paneMap.set(paneIdx, { profileId, profile });
      }

      for (let idx = 1; idx <= 4; idx += 1) {
        dispatch({ type: 'SET_PANE_SENTINEL', tabId: tab.id, paneIdx: idx, enabled: false });
        dispatch({ type: 'SET_PANE_TOOL', tabId: tab.id, paneIdx: idx, tool: null });
      }

      for (const pane of preset.panes) {
        const presetPane = pane as PresetPaneLike;
        const paneIdx = getPresetPaneIdx(presetPane);
        const entry = paneMap.get(paneIdx);
        if (!entry) continue;
        const startupInput = buildStartupInput(entry.profileId, config);
        dispatch({
          type: 'SET_PANE_SENTINEL',
          tabId: tab.id,
          paneIdx,
          enabled: entry.profile.sentinel !== false,
        });
        dispatch({
          type: 'SET_PANE_TOOL',
          tabId: tab.id,
          paneIdx,
          tool: launchToolForProfileTool(entry.profile.tool),
          toolData: encodeProfilePayload(entry.profileId, entry.profile, teamPrompt, startupInput),
          folderPath: tab.folderPath ?? null,
        });
      }

      clearKickoffTimers();
      const target = config.target.trim() || '(target not set)';
      const notes = config.notes.trim().replace(/\s+/g, ' ').trim();
      const notesText = notes ? ` Notes: ${notes}.` : '';
      const operatorPromptText = config.operatorPrompt.trim().replace(/\s+/g, ' ').trim();
      const operatorPromptSuffix = operatorPromptText ? ` Extra rule: ${operatorPromptText}.` : '';
      const makeSessionId = (idx: number) => `${tab.id}::pane-${idx}`;

      const managerPane = preset.panes.find((pane) => getPresetProfileId(pane as PresetPaneLike).includes('manager'));
      if (managerPane) {
        const managerPaneIdx = getPresetPaneIdx(managerPane as PresetPaneLike);
        const managerSessionId = `${tab.id}::pane-${managerPaneIdx}`;
        const managerMessage = `CTF MODE KICKOFF. Target: ${target}.${notesText}${operatorPromptSuffix} Act now. First call whoami() and list_panes(). If a shell worker pane exists, treat it as the host for SSH, reverse shells, netcat, and interactive CLI tools. If you identify multiple independent subtasks, dispatch them as one parallel batch in the same turn (prefer dispatch_task_batch; otherwise submit a complete batch of multiple dispatches and then stop). Use observer panes for cross-checking, not primary execution.`;
        queueTerminalPacket(managerSessionId, managerMessage, 3500);
      }

      for (const pane of preset.panes) {
        const profileId = getPresetProfileId(pane as PresetPaneLike);
        const paneIdx = getPresetPaneIdx(pane as PresetPaneLike);
        if (profileId.includes('manager')) continue;
        if (profileId.includes('shell')) {
          const shellPacket = `Write-Host '[Coffee CTF] Shell worker ready. Use this pane for ssh / nc / reverse shell / interactive CLI tasks.'`;
          queueTerminalPacket(makeSessionId(paneIdx), shellPacket, 4200);
          continue;
        }
        const packet = profileId.includes('observer')
          ? `CTF MODE OBSERVER STANDBY. Target: ${target}.${notesText}${operatorPromptSuffix} Remain in observer mode. Track evidence, duplicate work, and next-step guidance. Do not execute attacks unless explicitly instructed.`
          : `CTF MODE WORKER STANDBY. Target: ${target}.${notesText}${operatorPromptSuffix} Do not free-run. Wait for a concrete task from the manager pane, then execute only that task and finish with the exact DONE marker.`;
        queueTerminalPacket(makeSessionId(paneIdx), packet, profileId.includes('observer') ? 5200 : 4500);
      }

      statusSeenRef.current = {};
      seenTaskIdsRef.current = new Set();
      setResultCards([]);
      setTaskLedger([]);
      setTimeline([
        {
          id: `launch-${Date.now()}`,
          ts: Date.now(),
          kind: 'launch',
          text: `Launched Coffee CTF team: ${preset.label}`,
        },
        {
          id: `kickoff-${Date.now() + 1}`,
          ts: Date.now(),
          kind: 'info',
          text: `Manager / shell worker / observer startup packets were queued for delivery.`,
        },
      ]);
      setMainView('coffee');
      setInfo(`已在当前 CTF 模式页内启动 Coffee CTF 队伍：${preset.label}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy('');
    }
  };

  const roleCards = useMemo(() => {
    if (!teamPanes.length) return [];
    return teamPanes
      .filter((pane) => pane.paneIdx <= paneCount)
      .map((pane) => {
        const profileId = paneProfileIdFromToolData(pane.toolData);
        return {
          paneIdx: pane.paneIdx,
          role: roleLabel(profileId),
          tool: pane.tool || 'empty',
          status: statusLabel(pane.agentStatus),
          doneAt: pane.completionTs,
        };
      });
  }, [teamPanes, paneCount]);

  const presetRoleCards = useMemo(() => {
    if (!selectedPreset || !profilesCfg) return [];
    return selectedPreset.panes.map((pane) => {
      const presetPane = pane as PresetPaneLike;
      const profileId = getPresetProfileId(presetPane);
      const profile = profilesCfg.profiles[profileId];
      return {
        paneIdx: getPresetPaneIdx(presetPane),
        role: roleLabel(profileId),
        tool: (profile?.tool || 'unknown'),
        status: 'template',
        doneAt: undefined,
        description: roleDescription(profileId),
        profileLabel: profile?.label || profileId,
      };
    });
  }, [selectedPreset, profilesCfg]);

  const hasLaunchedTeam = roleCards.length > 0;
  const teamPaneMap = useMemo(() => new Map(teamPanes.map((pane) => [pane.paneIdx, pane])), [teamPanes]);

  const visibleRoleCards = hasLaunchedTeam
    ? roleCards.map((item) => ({
        ...item,
        description: roleDescription(teamPaneMap.get(item.paneIdx)?.toolData ? paneProfileIdFromToolData(teamPaneMap.get(item.paneIdx)?.toolData) : undefined),
        profileLabel: teamPaneMap.get(item.paneIdx)?.toolData
          ? (paneProfileIdFromToolData(teamPaneMap.get(item.paneIdx)?.toolData) || item.role)
          : item.role,
      }))
    : presetRoleCards;

  const ideaText = useMemo(() => {
    const latest = resultCards[0]?.resultExcerpt || '';
    const nextLine = latest.split(/\r?\n/).find((line) => line.trim().toLowerCase().startsWith('next:'));
    return nextLine || (latest ? summarizeResultExcerpt(latest) : '暂无真实想法沉淀；当前仅会从最新 RESULT 卡片提取 next/summary。');
  }, [resultCards]);

  const memoryText = useMemo(() => {
    if (resultCards.length === 0) {
      return '暂无真实记忆沉淀；当前 Memory 仅聚合最近的 task/result 摘要，还没有接长期记忆或 Obsidian。';
    }
    const recentTasks = resultCards
      .slice(0, 3)
      .map((item) => `${shortenTaskId(item.taskId)}@pane-${item.paneIdx}`)
      .join(' | ');
    return `Recent task memory: ${recentTasks}`;
  }, [resultCards]);

  const handleViewTeam = () => {
    setMainView('coffee');
    if (!hasLaunchedTeam) {
      setInfo('当前还没启动 Coffee CTF 队伍，请先点击“启动队伍”。');
    }
  };

  const handleUseCompatiblePreset = () => {
    if (!compatiblePresetId) return;
    persistConfig({ ...config, teamPresetId: compatiblePresetId });
    setError('');
    const next = profilesCfg?.teamPresets?.[compatiblePresetId];
    setInfo(`Switched to compatible preset: ${next?.label || compatiblePresetId} (layout=${next?.layout || 'unknown'}, installed CLI only)`);
  };

  const openPresetEditor = (presetId?: string) => {
    if (!profilesCfg) return;
    const currentId = presetId || config.teamPresetId;
    const preset = profilesCfg.teamPresets[currentId];
    if (!preset) return;
    const paneLookup = new Map<number, string>();
    for (const pane of preset.panes) {
      paneLookup.set(getPresetPaneIdx(pane as PresetPaneLike), getPresetProfileId(pane as PresetPaneLike));
    }
    setPresetDraft({
      id: currentId,
      label: preset.label || currentId,
      layout: (preset.layout as CtfPresetDraft['layout']) || 'three-agent',
      pane1: paneLookup.get(1) || '',
      pane2: paneLookup.get(2) || '',
      pane3: paneLookup.get(3) || '',
      pane4: paneLookup.get(4) || '',
      teamPrompt: preset.teamPrompt || '',
      notes: preset.notes || '',
    });
    setEditingPreset(true);
  };

  const handleDeleteSelectedPreset = async () => {
    if (!profilesCfg) return;
    const presetId = config.teamPresetId;
    if (!presetId.startsWith('ctf-custom-')) {
      setError('Only custom ctf-custom-* presets can be deleted here. Built-in presets are protected.');
      return;
    }
    const nextPresets = { ...profilesCfg.teamPresets };
    delete nextPresets[presetId];
    const next: MultiAgentProfilesConfig = {
      ...profilesCfg,
      teamPresets: nextPresets,
    };
    await commands.setMultiAgentProfiles(next);
    setProfilesCfg(next);
    const fallbackId = compatiblePresetId && compatiblePresetId !== presetId
      ? compatiblePresetId
      : (Object.keys(nextPresets).find((id) => id.startsWith('ctf-')) || DEFAULT_PRESET);
    persistConfig({ ...config, teamPresetId: fallbackId });
    setEditingPreset(false);
    setError('');
    setInfo(`Deleted preset: ${presetId}`);
  };

  const openCustomPresetEditor = () => {
    setPresetDraft({
      id: `ctf-custom-${Date.now()}`,
      label: 'CTF Custom Team',
      layout: 'three-agent',
      pane1: 'ctf-manager-codex',
      pane2: 'ctf-solver-codex',
      pane3: 'ctf-observer-gemini',
      pane4: 'ctf-solver-claude',
      teamPrompt: config.target.trim()
        ? `Target: ${config.target.trim()}\nManager coordinates the run. Workers execute scoped tasks. Observer summarizes and redirects.`
        : 'Manager coordinates the run. Workers execute scoped tasks. Observer summarizes and redirects.',
      notes: config.notes,
    });
    setEditingPreset(true);
  };

  const handleSaveCustomPreset = async () => {
    if (!profilesCfg) return;
    const id = presetDraft.id.trim();
    const label = presetDraft.label.trim();
    if (!id || !label) {
      setError('自定义模板需要填写 id 和名称。');
      return;
    }
    const panes: Array<{ paneIdx: number; profileId: string }> = [];
    if (presetDraft.pane1.trim()) panes.push({ paneIdx: 1, profileId: presetDraft.pane1.trim() });
    if (presetDraft.pane2.trim()) panes.push({ paneIdx: 2, profileId: presetDraft.pane2.trim() });
    if (presetDraft.layout !== 'two-agent' && presetDraft.pane3.trim()) panes.push({ paneIdx: 3, profileId: presetDraft.pane3.trim() });
    if (presetDraft.layout === 'multi-agent' && presetDraft.pane4.trim()) panes.push({ paneIdx: 4, profileId: presetDraft.pane4.trim() });

    const next: MultiAgentProfilesConfig = {
      ...profilesCfg,
      teamPresets: {
        ...profilesCfg.teamPresets,
        [id]: {
          label,
          layout: presetDraft.layout,
          panes,
          teamPrompt: presetDraft.teamPrompt,
          notes: presetDraft.notes,
        },
      },
    };

    try {
      await commands.setMultiAgentProfiles(next);
      setProfilesCfg(next);
      persistConfig({ ...config, teamPresetId: id });
      setEditingPreset(false);
      setError('');
      setInfo(`已保存自定义模板：${label}`);
    } catch (e) {
      setError(String(e));
    }
  };

  const mainViewButton = (view: MainView, label: string) => (
    <button
      onClick={() => setMainView(view)}
      style={{
        padding: '8px 12px',
        borderRadius: 8,
        border: mainView === view ? '1px solid rgba(255,255,255,0.18)' : '1px solid rgba(255,255,255,0.08)',
        background: mainView === view ? 'rgba(255,255,255,0.09)' : 'rgba(255,255,255,0.03)',
        color: 'inherit',
        cursor: 'pointer',
        fontSize: 12,
      }}
    >
      {label}
    </button>
  );

  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        display: 'grid',
        gridTemplateColumns: '320px minmax(0, 1fr)',
        overflow: 'hidden',
        color: 'var(--text-primary)',
      }}
    >
      {hasBg && bgUrl && (
        <div className="launchpad-bg" style={{ position: 'absolute', inset: 0, zIndex: 0 }}>
          {bgType === 'video' ? <video src={bgUrl} autoPlay loop muted playsInline /> : <img src={bgUrl} alt="" />}
        </div>
      )}

      <div
        style={{
          position: 'relative',
          zIndex: 1,
          padding: '12px 10px 14px 12px',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          borderRight: '1px solid rgba(255,255,255,0.08)',
          backdropFilter: 'blur(6px)',
          overflowY: 'auto',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <div style={{ fontSize: 20, fontWeight: 700 }}>CTF 模式</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              onClick={() => dispatch({ type: 'TOGGLE_LEFT_PANEL' })}
              style={{ padding: '6px 8px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.12)', background: state.leftPanelHidden ? 'rgba(255,255,255,0.09)' : 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 11 }}
            >
              左栏
            </button>
            <button
              onClick={() => dispatch({ type: 'TOGGLE_RIGHT_PANEL' })}
              style={{ padding: '6px 8px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.12)', background: state.rightPanelHidden ? 'rgba(255,255,255,0.09)' : 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 11 }}
            >
              右栏
            </button>
          </div>
        </div>

        <div style={sectionStyle()}>
          <div style={{ fontSize: 12, opacity: 0.72, marginBottom: 10 }}>目标</div>
          <input
            value={config.target}
            onChange={(e) => persistConfig({ ...config, target: e.target.value })}
            placeholder="https://target / IP:PORT / nc / 题目名"
            style={{ width: '100%', padding: '9px 10px', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, color: 'inherit' }}
          />
          <div style={{ height: 8 }} />
          <div style={{ fontSize: 12, opacity: 0.72, marginBottom: 6 }}>备注</div>
          <textarea
            value={config.notes}
            onChange={(e) => persistConfig({ ...config, notes: e.target.value })}
            placeholder="题型、提示、账号、限制..."
            rows={4}
            style={{ width: '100%', padding: '9px 10px', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, color: 'inherit', resize: 'vertical' }}
          />
          <div style={{ height: 8 }} />
          <div style={{ fontSize: 12, opacity: 0.72, marginBottom: 6 }}>CTF Prompt</div>
          <textarea
            value={config.operatorPrompt}
            onChange={(e) => persistConfig({ ...config, operatorPrompt: e.target.value })}
            placeholder="例如：优先 Web 黑盒；避免盲目 fuzz；每次输出 RESULT + DONE"
            rows={4}
            style={{ width: '100%', padding: '9px 10px', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, color: 'inherit', resize: 'vertical' }}
          />
          <div style={{ display: 'grid', gridTemplateColumns: '72px 1fr', gap: 8, marginTop: 10, fontSize: 12 }}>
            <div style={{ opacity: 0.68 }}>状态</div>
            <div>{stateLabel}</div>
          </div>
        </div>

        <div style={sectionStyle()}>
          <div style={{ fontSize: 12, opacity: 0.72, marginBottom: 8 }}>队伍模板</div>
          <select
            value={config.teamPresetId}
            onChange={(e) => persistConfig({ ...config, teamPresetId: e.target.value })}
            style={{ width: '100%', padding: '9px 10px', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, color: 'inherit' }}
          >
            {ctfPresets.map(([id, preset]) => (
              <option key={id} value={id}>{preset.label}</option>
            ))}
          </select>
          {selectedPreset ? (
            <div style={{ fontSize: 12, opacity: 0.72, marginTop: 8, lineHeight: 1.6 }}>
              {selectedPreset.teamPrompt}
            </div>
          ) : null}
          {presetMissingTools.length > 0 ? (
            <div style={{ fontSize: 12, color: '#ff8a8a', marginTop: 8, lineHeight: 1.6 }}>
              当前模板缺少 CLI：{presetMissingTools.join(', ')}
            </div>
          ) : null}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 10 }}>
            <button onClick={handleLaunchTeam} disabled={busy === 'team' || !profilesCfg || ctfPresets.length === 0 || presetMissingTools.length > 0} style={{ padding: '9px 12px', borderRadius: 8, border: 0, cursor: 'pointer' }}>
              {busy === 'team' ? '启动中...' : '启动队伍'}
            </button>
            <button onClick={handleViewTeam} style={{ padding: '9px 12px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.15)', background: 'transparent', color: 'inherit', cursor: 'pointer', opacity: hasLaunchedTeam ? 1 : 0.72 }}>
              查看主舞台
            </button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 8 }}>
            <button onClick={() => openPresetEditor()} disabled={!selectedPreset} style={{ padding: '9px 12px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.15)', background: 'transparent', color: 'inherit', cursor: 'pointer' }}>
              编辑模板
            </button>
            <button onClick={openCustomPresetEditor} disabled={!profilesCfg} style={{ padding: '9px 12px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.15)', background: 'transparent', color: 'inherit', cursor: 'pointer' }}>
              新建模板
            </button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 8 }}>
            <button onClick={handleUseCompatiblePreset} disabled={!compatiblePresetId || compatiblePresetId === config.teamPresetId} style={{ padding: '9px 12px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.15)', background: 'transparent', color: 'inherit', cursor: 'pointer', opacity: compatiblePresetId && compatiblePresetId !== config.teamPresetId ? 1 : 0.6 }}>
              兼容模式
            </button>
            <button onClick={handleDeleteSelectedPreset} disabled={!config.teamPresetId.startsWith('ctf-custom-')} style={{ padding: '9px 12px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.15)', background: 'transparent', color: 'inherit', cursor: 'pointer', opacity: config.teamPresetId.startsWith('ctf-custom-') ? 1 : 0.5 }}>
              删除模板
            </button>
          </div>
          {editingPreset ? (
            <div style={{ marginTop: 10, padding: 10, borderRadius: 8, border: '1px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.03)', display: 'flex', flexDirection: 'column', gap: 8 }}>
              <input value={presetDraft.id} onChange={(e) => setPresetDraft((d) => ({ ...d, id: e.target.value }))} placeholder="模板ID，例如 ctf-custom-no-gemini" style={{ width: '100%', padding: '8px 10px', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, color: 'inherit' }} />
              <input value={presetDraft.label} onChange={(e) => setPresetDraft((d) => ({ ...d, label: e.target.value }))} placeholder="模板名称" style={{ width: '100%', padding: '8px 10px', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, color: 'inherit' }} />
              <select value={presetDraft.layout} onChange={(e) => setPresetDraft((d) => ({ ...d, layout: e.target.value as CtfPresetDraft['layout'] }))} style={{ width: '100%', padding: '8px 10px', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, color: 'inherit' }}>
                <option value="two-agent">2 智能体</option>
                <option value="three-agent">3 智能体</option>
                <option value="multi-agent">4 智能体</option>
              </select>
              {[1, 2, 3, 4].map((idx) => {
                const key = (`pane${idx}` as keyof CtfPresetDraft);
                const disabled = (idx === 3 && presetDraft.layout === 'two-agent') || (idx === 4 && presetDraft.layout !== 'multi-agent');
                return (
                  <select
                    key={idx}
                    value={String(presetDraft[key] || '')}
                    onChange={(e) => setPresetDraft((d) => ({ ...d, [key]: e.target.value }))}
                    disabled={disabled}
                    style={{ width: '100%', padding: '8px 10px', background: disabled ? 'rgba(255,255,255,0.02)' : 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, color: 'inherit', opacity: disabled ? 0.55 : 1 }}
                  >
                    <option value="">面板 {idx} 未使用</option>
                    {ctfProfileOptions.map((opt) => (
                      <option key={`${idx}-${opt.id}`} value={opt.id}>
                        {opt.label} · {opt.tool}{opt.installed ? '' : ' (缺失)'}
                      </option>
                    ))}
                  </select>
                );
              })}
              <textarea value={presetDraft.teamPrompt} onChange={(e) => setPresetDraft((d) => ({ ...d, teamPrompt: e.target.value }))} rows={3} placeholder="团队规则" style={{ width: '100%', padding: '8px 10px', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, color: 'inherit', resize: 'vertical' }} />
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <button onClick={handleSaveCustomPreset} style={{ padding: '9px 12px', borderRadius: 8, border: 0, cursor: 'pointer' }}>保存模板</button>
                <button onClick={() => setEditingPreset(false)} style={{ padding: '9px 12px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.15)', background: 'transparent', color: 'inherit', cursor: 'pointer' }}>取消</button>
              </div>
            </div>
          ) : null}
        </div>

        <div style={sectionStyle()}>
          <div style={{ fontSize: 12, opacity: 0.72, marginBottom: 8 }}>角色设计</div>
          {!visibleRoleCards.length ? (
            <div style={{ fontSize: 12, opacity: 0.7 }}>当前模板还没有角色配置。</div>
          ) : visibleRoleCards.map((item, index) => (
            <div key={item.paneIdx} style={{ padding: '8px 0', borderTop: index === 0 ? 'none' : '1px solid rgba(255,255,255,0.06)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <strong>{item.role}</strong>
                <span>Pane {item.paneIdx}</span>
              </div>
              <div style={{ fontSize: 12, opacity: 0.78 }}>{item.tool} · {(item as any).profileLabel}</div>
              <div style={{ fontSize: 12, opacity: 0.78 }}>
                状态：{item.status === 'template' ? '模板预览' : item.status}
              </div>
              <div style={{ fontSize: 12, opacity: 0.72, lineHeight: 1.6 }}>{(item as any).description}</div>
              <div style={{ fontSize: 12, opacity: 0.6 }}>DONE：{item.doneAt ? formatTime(item.doneAt) : '—'}</div>
            </div>
          ))}
        </div>

        <div style={sectionStyle()}>
          <div style={{ fontSize: 12, opacity: 0.72, marginBottom: 8 }}>Idea</div>
          <div style={{ fontSize: 12, opacity: 0.7 }}>{ideaText}</div>
        </div>

        <div style={sectionStyle()}>
          <div style={{ fontSize: 12, opacity: 0.72, marginBottom: 8 }}>Memory</div>
          <div style={{ fontSize: 12, opacity: 0.7 }}>{memoryText}</div>
        </div>

        <TaskLedgerSection entries={taskLedger} />
        <TimelineSection timeline={timeline} />
      </div>

      <div style={{ position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, padding: '12px' }}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
          {mainViewButton('coffee', 'Coffee Team')}
          {mainViewButton('breachweave', 'BreachWeave')}
          {mainViewButton('logs', 'Logs')}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button onClick={handleStart} disabled={busy !== ''} style={{ padding: '8px 12px', borderRadius: 8, border: 0, cursor: 'pointer' }}>
              {busy === 'start' ? '启动中...' : '启动 BreachWeave'}
            </button>
            <button onClick={handleStop} disabled={busy !== ''} style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.15)', background: 'transparent', color: 'inherit', cursor: 'pointer' }}>
              {busy === 'stop' ? '停止中...' : '停止'}
            </button>
          </div>
        </div>

        {info ? <div style={{ fontSize: 12, color: '#79d48f', marginBottom: 8 }}>{info}</div> : null}
        {error ? <div style={{ fontSize: 12, color: '#ff8a8a', whiteSpace: 'pre-wrap', marginBottom: 8 }}>{error}</div> : null}

        <div style={{ ...sectionStyle(), flex: 1, minHeight: 0, padding: 0, overflow: 'hidden', position: 'relative' }}>
          <div style={{ display: mainView === 'coffee' ? 'block' : 'none', width: '100%', height: '100%' }}>
            <div style={{ display: 'grid', gridTemplateRows: 'minmax(180px, 240px) minmax(0, 1fr)', gap: 12, width: '100%', height: '100%', padding: 12, boxSizing: 'border-box' }}>
              <MainStageTaskFlow resultCards={resultCards} taskLedger={taskLedger} />
              {teamPanes.length > 0 ? (
                <ErrorBoundary fallbackLabel="CTF Coffee Team Error">
                  <div style={{ width: '100%', height: '100%', minHeight: 0 }}>
                    <MultiAgentGrid tab={tab} hasBg={hasBg} bgUrl={bgUrl} bgType={bgType} paneCount={paneCount} isTabActive={true} />
                  </div>
                </ErrorBoundary>
              ) : (
                <div style={{ width: '100%', height: '100%', minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 32, opacity: 0.78 }}>
                  <div>
                    <div style={{ fontSize: 22, fontWeight: 700, marginBottom: 10 }}>Coffee 原生作战台</div>
                    <div style={{ fontSize: 14, lineHeight: 1.8, maxWidth: 760 }}>
                      左侧填写目标与备注，选择队伍模板后点击“启动队伍”。现在主舞台顶部先显示 Task Flow / Task Results，
                      下方再承载 manager / worker / observer panes；切换 tab 后这些运行态摘要也会跟着 ctf-mode 配置一起恢复。
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div style={{ display: mainView === 'breachweave' ? 'block' : 'none', width: '100%', height: '100%' }}>
            {status?.running ? (
              <iframe src={launchUrl} title="BreachWeave" style={{ width: '100%', height: '100%', border: 0, background: '#111' }} />
            ) : (
              <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 32, opacity: 0.78 }}>
                BreachWeave 未运行。先启动后再查看。
              </div>
            )}
          </div>

          <div style={{ display: mainView === 'logs' ? 'block' : 'none', width: '100%', height: '100%', overflow: 'auto', padding: 16 }}>
            <div style={{ fontSize: 12, opacity: 0.72, marginBottom: 8 }}>stdout</div>
            <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 11, lineHeight: 1.5 }}>
              {status?.stdoutTail || '暂无 stdout'}
            </pre>
            <div style={{ fontSize: 12, opacity: 0.72, marginTop: 18, marginBottom: 8 }}>stderr</div>
            <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 11, lineHeight: 1.5 }}>
              {status?.stderrTail || '暂无 stderr'}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}
