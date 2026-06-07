//! Coffee-CLI multi-agent MCP server.
//!
//! Exposes 3 tools over HTTP Streamable MCP transport:
//! - `list_panes()` — enumerate panes in the current multi-agent Tab with
//!   their CLI type, state (empty / idle / busy / terminated), and titles.
//! - `send_to_pane(id, text, timeout_sec, wait)` — inject keys into another
//!   pane's PTY; synchronously waits for that pane to return to idle if
//!   `wait=true`, otherwise fires-and-forgets.
//! - `read_pane(id, last_n_lines)` — read recent output from another pane
//!   (ANSI-stripped), useful for checking on a fire-and-forget dispatch.
//!
//! HTTP transport (not stdio) because Coffee-CLI is a resident Tauri
//! process and can't be spawned as a subprocess by each CLI. The Rust
//! backend binds `127.0.0.1:<random>` at startup, and each primary CLI's
//! config file (see `mcp_injector.rs`) is patched with a `mcpServers.coffee-cli`
//! entry pointing at that ephemeral URL — which means a shutdown hook
//! MUST clean those entries out on Coffee-CLI exit, otherwise opening a
//! standalone Claude window later hits a dead-port connection error.
//!
//! This is the FORWARD-DISPATCH layer (agent A → agent B). The Sentinel
//! Protocol sitting on top of MCP adds a BACKWARD receipt: when the
//! dispatched agent finishes, it emits `[COFFEE-DONE:paneN->paneM]` into
//! its own PTY output, and the frontend injects a "task complete"
//! notification into the dispatcher's PTY input so the dispatcher's
//! turn-loop can wake up without polling. See TierTerminal.tsx.
//!
//! History: MCP was retired in 2026-04-24 in a misread of the user's
//! product intent ("sentinel is on-top-of MCP, not replacement-for") and
//! restored 2026-04-25. See docs/MULTI-AGENT-ARCHITECTURE.md §九 decision
//! log for the embarrassing details.

use std::{
    io::Write,
    sync::{atomic::Ordering, Arc, Mutex, OnceLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use crate::terminal::{
    extract_latest_sentinel_result_block, infer_pending_task_for_target, query_task_records,
    register_dispatched_task, SentinelTaskRecord, SharedSession,
};
use tauri::{AppHandle, Emitter};

use rmcp::{
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::*,
    schemars::JsonSchema,
    tool, tool_handler, tool_router,
    transport::streamable_http_server::{
        session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
    },
    ErrorData as McpError, ServerHandler,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
pub struct ShellTaskLedgerEntry {
    pub id: String,
    pub kind: String,
    pub pane_id: String,
    pub status: String,
    pub command_preview: String,
    pub output_excerpt: String,
    pub start_cursor: u64,
    pub next_cursor: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub begin_marker: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_marker: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step_count: Option<usize>,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Debug, Clone)]
struct ShellTaskExecution {
    status: String,
    pane_id: String,
    cli: String,
    begin_marker: String,
    end_marker: String,
    output: String,
    markers_found: bool,
    raw_output: String,
    start_cursor: u64,
    next_cursor: u64,
}

#[derive(Debug, Clone)]
struct ExpectExecution {
    status: String,
    pane_id: String,
    mode: String,
    pattern: String,
    cursor: u64,
    next_cursor: u64,
    is_idle: bool,
    output: String,
}

#[derive(Debug, Clone)]
struct RawShellSendExecution {
    status: String,
    pane_id: String,
    cursor: u64,
    next_cursor: u64,
    submit: bool,
    text: String,
}

fn shell_task_ledger() -> &'static Mutex<
    std::collections::HashMap<String, std::collections::VecDeque<ShellTaskLedgerEntry>>,
> {
    static LEDGER: OnceLock<
        Mutex<std::collections::HashMap<String, std::collections::VecDeque<ShellTaskLedgerEntry>>>,
    > = OnceLock::new();
    LEDGER.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

fn preview_text(text: &str, max_chars: usize) -> String {
    let compact = text.replace('\r', "").replace('\n', " ").trim().to_string();
    if compact.chars().count() <= max_chars {
        return compact;
    }
    compact.chars().take(max_chars).collect::<String>() + "..."
}

fn record_shell_task_ledger_entry(target_full_id: &str, entry: ShellTaskLedgerEntry) {
    if let Ok(mut map) = shell_task_ledger().lock() {
        let bucket = map
            .entry(target_full_id.to_string())
            .or_insert_with(std::collections::VecDeque::new);
        bucket.push_back(entry);
        while bucket.len() > 256 {
            bucket.pop_front();
        }
    }
}

fn read_shell_task_ledger_entries(target_full_id: &str, limit: usize) -> Vec<ShellTaskLedgerEntry> {
    let Ok(map) = shell_task_ledger().lock() else {
        return Vec::new();
    };
    let Some(bucket) = map.get(target_full_id) else {
        return Vec::new();
    };
    let mut items: Vec<ShellTaskLedgerEntry> = bucket.iter().cloned().collect();
    if items.len() > limit {
        items = items.split_off(items.len() - limit);
    }
    items
}

fn is_shell_like_cli(cli: &str) -> bool {
    matches!(
        cli.trim().to_ascii_lowercase().as_str(),
        "shell" | "terminal" | "powershell" | "pwsh" | "bash" | "sh" | "zsh"
    )
}

fn build_shell_wrapper(
    dispatcher_short: &str,
    target_short: &str,
    task_id: &str,
    user_text: &str,
) -> String {
    format!(
        r#"echo [COFFEE-RESULT-BEGIN task={task_id} from={target} to={dispatcher}]
{body}
echo [COFFEE-RESULT-END task={task_id}]
echo [COFFEE-DONE task={task_id} from={target} to={dispatcher}]"#,
        task_id = task_id,
        dispatcher = dispatcher_short,
        target = target_short,
        body = user_text,
    )
}

fn build_shell_task_wrapper(begin_marker: &str, end_marker: &str, user_text: &str) -> String {
    let body = user_text
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .lines()
        .collect::<Vec<_>>()
        .join("\n");
    if body.is_empty() {
        format!(
            "echo {begin}; echo {end}",
            begin = begin_marker,
            end = end_marker
        )
    } else {
        format!(
            "echo {begin}\n{body}\necho {end}",
            begin = begin_marker,
            end = end_marker,
            body = body
        )
    }
}

fn extract_between_markers(text: &str, begin_marker: &str, end_marker: &str) -> Option<String> {
    let normalized = text.replace('\r', "");
    let mut collecting = false;
    let mut lines: Vec<&str> = Vec::new();

    for line in normalized.lines() {
        let trimmed = line.trim();
        if !collecting {
            if trimmed == begin_marker {
                collecting = true;
            }
            continue;
        }
        if trimmed == end_marker {
            return Some(lines.join("\n").trim().to_string());
        }
        lines.push(line);
    }

    None
}

fn trim_last_lines(text: &str, last_n: usize) -> String {
    let mut lines: Vec<&str> = text.lines().collect();
    if lines.len() > last_n {
        lines = lines.split_off(lines.len() - last_n);
    }
    lines.join("\n")
}

fn key_name_to_bytes(name: &str) -> Result<Vec<u8>, String> {
    let normalized = name.trim().to_ascii_lowercase();
    let bytes = match normalized.as_str() {
        "enter" | "return" => b"\r".to_vec(),
        "esc" | "escape" => b"\x1b".to_vec(),
        "tab" => b"\t".to_vec(),
        "space" => b" ".to_vec(),
        "backspace" | "bs" => vec![0x08],
        "up" | "arrowup" => b"\x1b[A".to_vec(),
        "down" | "arrowdown" => b"\x1b[B".to_vec(),
        "right" | "arrowright" => b"\x1b[C".to_vec(),
        "left" | "arrowleft" => b"\x1b[D".to_vec(),
        "home" => b"\x1b[H".to_vec(),
        "end" => b"\x1b[F".to_vec(),
        "pgup" | "pageup" => b"\x1b[5~".to_vec(),
        "pgdn" | "pagedown" => b"\x1b[6~".to_vec(),
        "insert" => b"\x1b[2~".to_vec(),
        "delete" | "del" => b"\x1b[3~".to_vec(),
        "ctrl+c" => vec![0x03],
        "ctrl+d" => vec![0x04],
        "ctrl+l" => vec![0x0c],
        "ctrl+z" => vec![0x1a],
        _ if normalized.len() == 1 => normalized.as_bytes().to_vec(),
        _ => return Err(format!("unsupported key: {}", name)),
    };
    Ok(bytes)
}

// ---------- Pane abstraction (in-memory mock for v1.0 day 1-2) ----------

/// State of a single pane as visible to the primary CLI.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
#[schemars(crate = "rmcp::schemars")]
pub enum PaneState {
    /// Pane has no CLI running yet; user hasn't selected one.
    Empty,
    /// PTY is alive and the CLI is accepting input.
    Idle,
    /// CLI is producing output or awaiting long task completion.
    Busy,
    /// PTY exited.
    Terminated,
}

/// Snapshot of a pane returned by `list_panes`.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[schemars(crate = "rmcp::schemars")]
pub struct PaneInfo {
    /// Short pane label like `pane-1`. Pass straight to `send_to_pane`
    /// / `read_pane`. (`list_panes` is already scoped to the caller's
    /// own tab, so a short tab-relative label is unambiguous; the
    /// long `tab-<uuid>::pane-N` form is also accepted on input but
    /// no longer returned here — it just blew up tool-call rendering
    /// inside narrow grid panes for no benefit.)
    pub id: String,
    /// Same as `id`. Kept for callers that read `title` to label rows.
    pub title: String,
    /// Raw full pane id (`tab-<uuid>::pane-N`). Used internally for
    /// tab-scope filtering and self-detection — `#[serde(skip)]` so
    /// it's never sent to the LLM (the whole point of this rewrite
    /// was to keep long UUIDs out of the model's context).
    #[serde(skip, default)]
    pub full_id: String,
    /// CLI running in this pane (claude / codex / gemini / opencode / shell / ...).
    pub cli: String,
    pub state: PaneState,
    /// Epoch seconds of last output from this pane.
    pub last_activity_at: u64,
    /// `true` only for the row representing the caller's own pane.
    /// Set by the MCP server based on its baked-in `self_pane_id`,
    /// so a CLI receiving this list knows unambiguously which entry
    /// is itself — even when 4 panes run the same CLI type.
    /// Omitted (None / not serialized) if the server doesn't know
    /// the caller's identity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_self: Option<bool>,
}

/// Live pane store bridging the MCP layer to `terminal::SharedSession`.
///
/// Each Coffee-CLI terminal session (one per Tab pane) is visible here as
/// a "pane". The primary pane's CLI (Claude Code / Codex / Gemini / OpenCode)
/// calls MCP tools; we translate those calls into direct operations on
/// the other panes' PTYs.
pub struct PaneStore {
    session: SharedSession,
    /// ANSI escape sequence matcher, reused across reads.
    /// Same pattern as terminal.rs emitter thread (line ~738).
    ansi_re: regex::Regex,
}

impl PaneStore {
    pub fn new(session: SharedSession) -> Self {
        Self {
            session,
            ansi_re: regex::Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\].*?(?:\x07|\x1b\\)|\x1b.")
                .expect("ANSI regex compiles"),
        }
    }

    /// Snapshot every session in the shared map as a PaneInfo row.
    ///
    /// v1.0 returns every session in the process; Tab-scoped filtering
    /// (as defined in docs §5.7) is enforced by the UI pane selector and
    /// by the primary CLI following CLAUDE.md / AGENTS.md / GEMINI.md
    /// conventions. Day 5 UI work can add a `?tab=<id>` endpoint filter.
    async fn list(&self) -> Vec<PaneInfo> {
        // Extract everything we need under a brief lock, then drop it.
        let raw = tokio::task::spawn_blocking({
            let session = self.session.clone();
            move || {
                let guard = session.lock().ok()?;
                let rows: Vec<(String, Option<String>, String, Instant)> = guard
                    .iter()
                    .map(|(id, sess)| {
                        let (status, last_at) = match sess.activity.lock() {
                            Ok(act) => (act.last_status.clone(), act.last_output_at),
                            Err(_) => ("unknown".to_string(), Instant::now()),
                        };
                        (id.clone(), sess.tool_name.clone(), status, last_at)
                    })
                    .collect();
                Some(rows)
            }
        })
        .await
        .unwrap_or(None)
        .unwrap_or_default();

        let now_instant = Instant::now();
        let now_epoch = epoch_seconds();

        let mut list: Vec<PaneInfo> = raw
            .into_iter()
            .map(|(id, tool_name, status, last_at)| {
                let elapsed = now_instant.saturating_duration_since(last_at).as_secs();
                let last_activity_at = now_epoch.saturating_sub(elapsed);
                let pane_label = pane_short(&id);
                PaneInfo {
                    title: pane_label.clone(),
                    cli: tool_name.unwrap_or_else(|| "shell".to_string()),
                    state: status_to_pane_state(&status),
                    last_activity_at,
                    id: pane_label,
                    full_id: id,
                    is_self: None, // filled in by CoffeeMcp::list_panes if known
                }
            })
            .collect();
        list.sort_by(|a, b| a.id.cmp(&b.id));
        list
    }

    async fn pane_cli_name(&self, id: &str) -> Result<String, String> {
        let id = id.to_string();
        let session = self.session.clone();
        tokio::task::spawn_blocking(move || -> Result<String, String> {
            let guard = session
                .lock()
                .map_err(|_| "session map poisoned".to_string())?;
            let sess = guard
                .get(&id)
                .ok_or_else(|| format!("pane not found: {}", id))?;
            Ok(sess
                .tool_name
                .clone()
                .unwrap_or_else(|| "shell".to_string()))
        })
        .await
        .map_err(|e| format!("blocking task join failed: {}", e))?
    }

    /// Inject text into the target pane's PTY stdin and, when `wait=true`,
    /// block until the pane's CLI returns to its prompt (or `timeout_sec`
    /// elapses), then return the ANSI-stripped output that arrived since
    /// the write.
    ///
    /// `submit=true` (default) auto-appends `\r` if the text isn't already
    /// newline-terminated, so the target CLI actually executes the command
    /// instead of leaving it in the input box. The carriage return also
    /// mirrors [`crate::server::tier_terminal_write`]'s bookkeeping: we
    /// set `activity.user_submitted_at` so the status ticker flips to
    /// `"working"` and we can later detect the transition back to
    /// `"wait_input"` as the signal that the CLI finished.
    ///
    /// Output capture works by diffing `output_buffer` snapshots taken
    /// before the write vs. after idle detection. The ring can drain
    /// (capped at 2000 chunks in `terminal.rs`); in that rare case we
    /// fall back to returning the current tail rather than failing.
    async fn dispatch(
        &self,
        id: &str,
        text: &str,
        submit: bool,
        wait: bool,
        timeout_sec: u64,
    ) -> Result<DispatchResult, String> {
        // Strip any caller-provided trailing newline; we always append our
        // own in a SECOND write so Ink/React-based REPLs (Gemini, Claude
        // Code) treat the body and the Enter as two separate stdin events
        // — not one pasted chunk where the final \r gets swallowed as
        // part of the text. Observed live: a combined "body\r" write
        // shows up in Gemini's input box but never submits; splitting
        // body + short sleep + "\r" reliably submits.
        let body = text.trim_end_matches(['\r', '\n']).to_string();
        let should_submit = submit;
        let bytes_written = body.len() + if should_submit { 1 } else { 0 };

        // Phase 1a: snapshot buffer + write BODY (no Enter yet).
        let buf_before = {
            let id2 = id.to_string();
            let body2 = body.clone();
            let session = self.session.clone();
            tokio::task::spawn_blocking(move || -> Result<String, String> {
                let (writer_arc, buffer_arc) = {
                    let guard = session
                        .lock()
                        .map_err(|_| "session map poisoned".to_string())?;
                    let sess = guard
                        .get(&id2)
                        .ok_or_else(|| format!("pane not found: {}", id2))?;
                    (sess.writer_lock.clone(), sess.output_buffer.clone())
                };

                let before = {
                    let ring = buffer_arc
                        .lock()
                        .map_err(|_| "output buffer poisoned".to_string())?;
                    ring.join("")
                };

                {
                    let mut writer = writer_arc
                        .lock()
                        .map_err(|_| "pane writer poisoned".to_string())?;
                    if !body2.is_empty() {
                        writer
                            .write_all(body2.as_bytes())
                            .map_err(|e| format!("pty write failed: {}", e))?;
                        writer
                            .flush()
                            .map_err(|e| format!("pty flush failed: {}", e))?;
                    }
                }

                Ok(before)
            })
            .await
            .map_err(|e| format!("blocking task join failed: {}", e))??
        };

        // Phase 1b: pause so the target REPL processes the body
        // characters into its input field, THEN send the Enter as a
        // separate keystroke. Observed live on 2026-04-23: a flat
        // 120ms was enough for short < 100-char prompts but failed for
        // a 300-char multi-line Claude→Gemini dispatch — Gemini's Ink
        // reconciler was still painting the last lines when `\r`
        // arrived, so the CR got absorbed into the text instead of
        // submitting. Body-size proportional delay fixes the whole
        // range: 250ms base (covers the fixed render cost) + 1ms per
        // body character (scales with paint work), clamped to 1.5s
        // so we never sit on a huge paste for ages. Still fires
        // mirror of server::tier_terminal_write's user_submitted_at
        // so the status ticker flips to "working".
        if should_submit {
            let body_len = body.chars().count() as u64;
            let delay_ms = (250 + body_len).clamp(250, 1500);
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            let id3 = id.to_string();
            let session = self.session.clone();
            tokio::task::spawn_blocking(move || -> Result<(), String> {
                let (writer_arc, activity_arc) = {
                    let guard = session
                        .lock()
                        .map_err(|_| "session map poisoned".to_string())?;
                    let sess = guard
                        .get(&id3)
                        .ok_or_else(|| format!("pane not found: {}", id3))?;
                    (sess.writer_lock.clone(), sess.activity.clone())
                };
                {
                    let mut writer = writer_arc
                        .lock()
                        .map_err(|_| "pane writer poisoned".to_string())?;
                    writer
                        .write_all(b"\r")
                        .map_err(|e| format!("pty write failed: {}", e))?;
                    writer
                        .flush()
                        .map_err(|e| format!("pty flush failed: {}", e))?;
                }
                if let Ok(mut act) = activity_arc.lock() {
                    if act.last_status == "wait_input" {
                        act.user_submitted_at = Some(Instant::now());
                    }
                }
                Ok(())
            })
            .await
            .map_err(|e| format!("blocking task join failed: {}", e))??;

            // Phase 1d: verify the CR actually submitted. This is the
            // single most critical correctness gate of the dispatch flow:
            // if the body delivered but the CR was absorbed (Ink/React
            // reconciler still painting when \r arrived, bracketed-paste
            // mode swallowing the trailing newline, etc.), the target
            // pane sits silently with the message stuck in its input
            // box and the entire orchestration hangs — exact symptom
            // user reported as "成语接龙 pane 2 不动".
            //
            // Detection: after a 1.5s grace, if no PTY output has
            // arrived since we wrote the CR AND the activity ticker
            // still thinks the pane is at its input prompt, the CR
            // almost certainly never reached the REPL's reducer.
            // (Real LLM CLIs paint *something* — Thinking…/spinner/
            // input-box clear — within 1.5s of a successful submit.)
            //
            // Recovery: send a single retry CR. Cost of a false positive
            // (CR did land but the LLM was unusually slow) is one empty
            // Enter at the prompt, which all three target CLIs (Claude
            // Code / Codex / Gemini) treat as a no-op. We deliberately
            // do not retry more than once: two retries means the agent
            // is genuinely stuck (network, OOM, model crash) and adding
            // more CRs won't help — let the wait loop time out and
            // surface that to the caller.
            let cr_send_time = Instant::now();
            tokio::time::sleep(Duration::from_millis(1500)).await;

            let cr_lost = {
                let id_check = id.to_string();
                let session_check = self.session.clone();
                tokio::task::spawn_blocking(move || -> bool {
                    let Ok(guard) = session_check.lock() else {
                        return false;
                    };
                    let Some(sess) = guard.get(&id_check) else {
                        return false;
                    };
                    let Ok(act) = sess.activity.lock() else {
                        return false;
                    };
                    act.last_output_at < cr_send_time && act.last_status == "wait_input"
                })
                .await
                .unwrap_or(false)
            };

            if cr_lost {
                log::warn!(
                    "coffee-cli mcp dispatch: CR appears absorbed by {}, retrying once",
                    id
                );
                let id_retry = id.to_string();
                let session_retry = self.session.clone();
                let _ = tokio::task::spawn_blocking(move || -> Result<(), String> {
                    let writer_arc = {
                        let guard = session_retry
                            .lock()
                            .map_err(|_| "session map poisoned".to_string())?;
                        let sess = guard
                            .get(&id_retry)
                            .ok_or_else(|| format!("pane not found: {}", id_retry))?;
                        sess.writer_lock.clone()
                    };
                    let mut writer = writer_arc
                        .lock()
                        .map_err(|_| "pane writer poisoned".to_string())?;
                    writer
                        .write_all(b"\r")
                        .map_err(|e| format!("pty write failed: {}", e))?;
                    writer
                        .flush()
                        .map_err(|e| format!("pty flush failed: {}", e))?;
                    Ok(())
                })
                .await;
            }
        }

        if !wait {
            return Ok(DispatchResult {
                bytes_written,
                waited: false,
                timed_out: false,
                captured_output: None,
            });
        }

        // Phase 2: poll for idle. Two independent paths — either one means
        // the pane is done.
        //
        //   A) marker-based: ticker flipped status back to "wait_input"
        //      (shell prompt marker seen) AND output either arrived since
        //      send or has been quiet 2s+. Primary path when terminal.rs's
        //      prompt_markers match the target CLI's actual prompt.
        //
        //   B) settle-based: we saw output come in after send time AND then
        //      it has been quiet for 2.5s+. Independent of prompt markers.
        //      Load-bearing when a CLI's prompt isn't in the marker list
        //      (observed live: Gemini CLI's "* " input prompt doesn't
        //      match its preset `✦`, so path A never fires and the
        //      controller pane would hang forever waiting on a response
        //      that already arrived).
        //
        // The settle_silence threshold is slightly longer than long_silence
        // so we don't declare idle in the gap BETWEEN our write hitting
        // the PTY and Gemini starting to render its answer.
        let send_time = Instant::now();
        let deadline = send_time + Duration::from_secs(timeout_sec);

        // Initial grace so the ticker thread (1s cadence in terminal.rs)
        // has a chance to observe output and flip status to "working".
        tokio::time::sleep(Duration::from_millis(400)).await;

        let mut timed_out = true;
        loop {
            if Instant::now() > deadline {
                break;
            }

            let idle = {
                let id2 = id.to_string();
                let session = self.session.clone();
                tokio::task::spawn_blocking(move || -> Result<bool, String> {
                    let guard = session
                        .lock()
                        .map_err(|_| "session map poisoned".to_string())?;
                    let sess = guard
                        .get(&id2)
                        .ok_or_else(|| format!("pane not found: {}", id2))?;
                    let act = sess
                        .activity
                        .lock()
                        .map_err(|_| "activity poisoned".to_string())?;
                    let at_prompt = act.last_status == "wait_input";
                    let now = Instant::now();
                    let produced_since_send = act.last_output_at >= send_time;
                    let silence = now.duration_since(act.last_output_at);
                    // Observed 2026-04-23: LLM-driven CLIs (Claude/Codex/
                    // Gemini) pause 3-8s between planning phases while
                    // the model thinks; the old 2s/2.5s thresholds
                    // treated these as "task done" and returned Claude a
                    // half-finished result. Bump to 8s/15s — Gemini's
                    // longest observed mid-task think gap was ~10s, so
                    // 15s for settle_silence is conservative without
                    // stretching too long. Real idle after a genuinely
                    // completed task (Gemini renders ✨ summary, prompt
                    // returns) hits marker_path in <2s and early-returns
                    // regardless, so this doesn't slow the happy path.
                    let long_silence = silence > Duration::from_millis(8000);
                    let settle_silence = silence > Duration::from_millis(15000);

                    let marker_path = at_prompt && (produced_since_send || long_silence);
                    let settle_path = produced_since_send && settle_silence;

                    Ok(marker_path || settle_path)
                })
                .await
                .map_err(|e| format!("blocking task join failed: {}", e))??
            };

            if idle {
                timed_out = false;
                break;
            }

            tokio::time::sleep(Duration::from_millis(500)).await;
        }

        // Phase 3: snapshot buffer after idle and extract the new suffix.
        let buf_after = {
            let id2 = id.to_string();
            let session = self.session.clone();
            tokio::task::spawn_blocking(move || -> Result<String, String> {
                let guard = session
                    .lock()
                    .map_err(|_| "session map poisoned".to_string())?;
                let sess = guard
                    .get(&id2)
                    .ok_or_else(|| format!("pane not found: {}", id2))?;
                let ring = sess
                    .output_buffer
                    .lock()
                    .map_err(|_| "output buffer poisoned".to_string())?;
                Ok(ring.join(""))
            })
            .await
            .map_err(|e| format!("blocking task join failed: {}", e))??
        };

        let raw_diff = if buf_after.starts_with(&buf_before) {
            buf_after[buf_before.len()..].to_string()
        } else {
            // Ring was drained between snapshots — best effort, return all.
            buf_after
        };

        let stripped = self.ansi_re.replace_all(&raw_diff, "").to_string();

        // Cap at last 200 lines; the MCP caller can re-read via read_pane
        // if it needs more. Keeps tool-result payload bounded.
        let trimmed = {
            let mut lines: Vec<&str> = stripped.lines().collect();
            if lines.len() > 200 {
                lines = lines.split_off(lines.len() - 200);
            }
            lines.join("\n")
        };

        Ok(DispatchResult {
            bytes_written,
            waited: true,
            timed_out,
            captured_output: Some(trimmed),
        })
    }

    /// Return either the latest structured result block (preferred) or the
    /// last `last_n` lines of ANSI-stripped output, plus an `is_idle` flag.
    async fn read(
        &self,
        id: &str,
        last_n: usize,
        mode: Option<&str>,
    ) -> Result<
        (
            String,
            bool,
            Option<crate::terminal::SentinelResultBlock>,
            String,
        ),
        String,
    > {
        let id = id.to_string();
        let session = self.session.clone();
        let ansi_re = self.ansi_re.clone();
        let mode = mode.unwrap_or("result").to_string();

        tokio::task::spawn_blocking(
            move || -> Result<
                (
                    String,
                    bool,
                    Option<crate::terminal::SentinelResultBlock>,
                    String,
                ),
                String,
            > {
            let guard = session
                .lock()
                .map_err(|_| "session map poisoned".to_string())?;
            let sess = guard
                .get(&id)
                .ok_or_else(|| format!("pane not found: {}", id))?;

            // Pull the raw output ring under its own lock, dropped immediately.
            let raw_chunks: Vec<String> = {
                let ring = sess
                    .output_buffer
                    .lock()
                    .map_err(|_| "output buffer poisoned".to_string())?;
                ring.clone()
            };

            let is_idle = sess
                .activity
                .lock()
                .map(|a| a.last_status == "wait_input")
                .unwrap_or(false);

            drop(guard);

            // Join chunks, strip ANSI, keep last N lines.
            let joined = raw_chunks.join("");
            let stripped = ansi_re.replace_all(&joined, "").to_string();
            let raw_output = trim_last_lines(&stripped, last_n);
            let semantic_result = extract_latest_sentinel_result_block(&stripped, None);
            let output = if mode.eq_ignore_ascii_case("raw") {
                raw_output.clone()
            } else if let Some(block) = &semantic_result {
                block.body.clone()
            } else {
                raw_output.clone()
            };
            Ok((output, is_idle, semantic_result, raw_output))
        })
        .await
        .map_err(|e| format!("blocking task join failed: {}", e))?
    }

    async fn read_delta_from_cursor(
        &self,
        id: &str,
        cursor: u64,
        last_n: usize,
    ) -> Result<(String, u64, bool), String> {
        let id = id.to_string();
        let session = self.session.clone();
        tokio::task::spawn_blocking(move || -> Result<(String, u64, bool), String> {
            let guard = session
                .lock()
                .map_err(|_| "session map poisoned".to_string())?;
            let sess = guard
                .get(&id)
                .ok_or_else(|| format!("pane not found: {}", id))?;

            let is_idle = sess
                .activity
                .lock()
                .map(|a| a.last_status == "wait_input")
                .unwrap_or(false);

            let current_cursor = sess.output_cursor.load(Ordering::Relaxed);
            let joined = {
                let chunks = sess
                    .output_chunks
                    .lock()
                    .map_err(|_| "output chunks poisoned".to_string())?;
                chunks
                    .iter()
                    .filter(|chunk| chunk.cursor > cursor)
                    .map(|chunk| chunk.text.as_str())
                    .collect::<Vec<_>>()
                    .join("")
            };
            Ok((trim_last_lines(&joined, last_n), current_cursor, is_idle))
        })
        .await
        .map_err(|e| format!("blocking task join failed: {}", e))?
    }
}

/// Outcome of `PaneStore::dispatch` — conveyed back to the MCP caller so
/// it can distinguish "CLI finished and here's its reply" from "timeout,
/// reply may still be coming, use read_pane to poll" from fire-and-forget.
#[derive(Debug)]
pub struct DispatchResult {
    pub bytes_written: usize,
    /// Whether the caller requested wait=true (vs fire-and-forget).
    pub waited: bool,
    /// True only when waited=true AND the deadline hit without the pane
    /// flipping back to wait_input. `captured_output` still holds whatever
    /// arrived in that window.
    pub timed_out: bool,
    /// ANSI-stripped output that arrived between the write and idle.
    /// Some(..) iff waited=true; None iff fire-and-forget.
    pub captured_output: Option<String>,
}

fn status_to_pane_state(status: &str) -> PaneState {
    match status {
        "wait_input" => PaneState::Idle,
        "working" => PaneState::Busy,
        "" | "unknown" => PaneState::Empty,
        _ => PaneState::Idle,
    }
}

fn epoch_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[derive(Debug, Deserialize, JsonSchema)]
#[schemars(crate = "rmcp::schemars")]
pub struct WaitTasksArgs {
    /// Filter by batch id returned from dispatch_task_batch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub batch_id: Option<String>,
    /// Optional explicit task ids to monitor.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_ids: Option<Vec<String>>,
    /// Wait timeout in seconds. Default 30.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_sec: Option<u64>,
    /// Poll interval in milliseconds. Default 350.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub poll_ms: Option<u64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[schemars(crate = "rmcp::schemars")]
pub struct SummarizeActiveTasksArgs {
    /// Filter by batch id returned from dispatch_task_batch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub batch_id: Option<String>,
    /// Optional explicit task ids to summarize.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_ids: Option<Vec<String>>,
    /// Include completed / wake_failed tasks. Default true.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include_completed: Option<bool>,
    /// Max tasks to return. Default 32.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
}

fn summarize_task_status_counts(records: &[SentinelTaskRecord]) -> serde_json::Value {
    let mut submitted = 0usize;
    let mut dispatched = 0usize;
    let mut result = 0usize;
    let mut completed = 0usize;
    let mut wake_failed = 0usize;
    for record in records {
        match record.status.as_str() {
            "submitted" => submitted += 1,
            "dispatched" => dispatched += 1,
            "result" => result += 1,
            "completed" => completed += 1,
            "wake_failed" => wake_failed += 1,
            _ => {}
        }
    }
    serde_json::json!({
        "submitted": submitted,
        "dispatched": dispatched,
        "result": result,
        "completed": completed,
        "wake_failed": wake_failed,
        "unfinished": submitted + dispatched + result,
    })
}

// ---------- MCP tool arguments ----------

#[derive(Debug, Deserialize, JsonSchema)]
#[schemars(crate = "rmcp::schemars")]
pub struct SendToPaneArgs {
    /// Target pane. **Use the short form** (`pane-1`, `pane-2`, …) —
    /// it's what the `pane` field of `list_panes()` returns and keeps
    /// the rendered tool call short enough to display cleanly inside
    /// a 25%-width grid pane. The full id (`<tab_id>::pane-2`) and a
    /// bare digit (`2`) are also accepted for back-compat. Must not
    /// resolve to the caller's own pane.
    pub id: String,
    /// Text to inject into the target pane's stdin.
    pub text: String,
    /// If true (default), auto-append `\r` unless `text` already ends with
    /// a newline. Set false when you need to type without submitting (e.g.
    /// inserting template text for the user to finish editing).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub submit: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[schemars(crate = "rmcp::schemars")]
pub struct ReadPaneArgs {
    /// Target pane. Same conventions as `send_to_pane`: short form
    /// (`pane-1`) preferred, full id and bare digit also accepted.
    pub id: String,
    /// Max recent lines to return. Default 200, max 2000.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_n_lines: Option<usize>,
    /// `result` (default) extracts the latest structured Coffee result block
    /// if available; `raw` returns recent ANSI-stripped terminal text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[schemars(crate = "rmcp::schemars")]
pub struct CompleteTaskArgs {
    /// Target dispatcher pane. Same conventions as `send_to_pane`.
    #[serde(default)]
    pub to: String,
    /// Task id originally assigned by `send_to_pane`.
    #[serde(default)]
    pub task_id: String,
    /// Final structured result body to send back to the dispatcher.
    pub result: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[schemars(crate = "rmcp::schemars")]
pub struct SendShellTaskArgs {
    /// Target shell-like pane (`pane-N` preferred). Intended for shell /
    /// terminal panes that host PowerShell, bash, SSH, nc, reverse shells,
    /// or interactive CLI tooling.
    pub id: String,
    /// Raw shell command body to execute inside the target shell pane.
    pub text: String,
    /// Optional explicit begin marker. If omitted, Coffee generates a unique one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub begin_marker: Option<String>,
    /// Optional explicit end marker. If omitted, Coffee generates a unique one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_marker: Option<String>,
    /// Max seconds to wait for the end marker before returning timeout.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_sec: Option<u64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[schemars(crate = "rmcp::schemars")]
pub struct ExpectPaneArgs {
    /// Target pane (`pane-N` preferred).
    pub id: String,
    /// Literal substring or regex to wait for.
    pub pattern: String,
    /// Match mode: `substring` (default) or `regex`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    /// Max seconds to wait.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_sec: Option<u64>,
    /// Return only the last N lines from the observed pane text. Default 80.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_n_lines: Option<usize>,
    /// Optional incremental cursor. When provided, only output produced after
    /// this cursor is searched, avoiding false matches from stale prompts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<u64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[schemars(crate = "rmcp::schemars")]
pub struct ReadPaneDeltaArgs {
    /// Target pane (`pane-N` preferred).
    pub id: String,
    /// Only return output produced after this cursor. Use 0 for "from start
    /// of retained incremental buffer".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<u64>,
    /// Return only the last N lines from the joined delta. Default 120.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_n_lines: Option<usize>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[schemars(crate = "rmcp::schemars")]
pub struct ReadShellTaskLedgerArgs {
    /// Target pane (`pane-N` preferred).
    pub id: String,
    /// Max recent ledger entries to return. Default 20.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[schemars(crate = "rmcp::schemars")]
pub struct SendShellArgs {
    /// Target shell-like pane (`pane-N` preferred).
    pub id: String,
    /// Raw text to inject.
    pub text: String,
    /// Whether to auto-submit Enter. Default true.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub submit: Option<bool>,
    /// Optional starting cursor to track only new output after this send.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<u64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[schemars(crate = "rmcp::schemars")]
pub struct SendKeyArgs {
    /// Target pane (`pane-N` preferred).
    pub id: String,
    /// Key name, e.g. Enter / Esc / Up / Down / Ctrl+C / a
    pub key: String,
    /// Repeat count. Default 1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repeat: Option<usize>,
    /// Optional cursor baseline for follow-up workflows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<u64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[schemars(crate = "rmcp::schemars")]
pub struct ReadScreenArgs {
    /// Target pane (`pane-N` preferred).
    pub id: String,
    /// Return only the last N visible lines. Default 120.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_n_lines: Option<usize>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[schemars(crate = "rmcp::schemars")]
pub struct ExpectScreenArgs {
    /// Target pane (`pane-N` preferred).
    pub id: String,
    /// Literal substring or regex.
    pub pattern: String,
    /// `substring` (default) or `regex`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    /// Max seconds to wait.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_sec: Option<u64>,
    /// Return only the last N visible lines from screen snapshot. Default 120.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_n_lines: Option<usize>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[schemars(crate = "rmcp::schemars")]
pub struct ShellPlaybookStep {
    /// `send`, `send_shell_task`, `expect`, `read_delta`, `send_key`, `read_screen`, or `expect_screen`.
    pub action: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub pattern: String,
    #[serde(default)]
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_sec: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub begin_marker: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_marker: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub submit: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_n_lines: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repeat: Option<usize>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[schemars(crate = "rmcp::schemars")]
pub struct RunShellPlaybookArgs {
    /// Target shell-like pane (`pane-N` preferred).
    pub id: String,
    /// Ordered steps to execute.
    pub steps: Vec<ShellPlaybookStep>,
    /// Optional initial cursor. Defaults to 0.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
pub struct SentinelDispatchEvent {
    pub tab_id: String,
    pub emitter_session_id: String,
    pub emitter_pane_id: String,
    pub target_session_id: String,
    pub target_pane_id: String,
    pub task_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub batch_id: Option<String>,
    pub dispatch_text: String,
    pub status: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[schemars(crate = "rmcp::schemars")]
pub struct DispatchTaskBatchItem {
    /// Target pane (`pane-N` preferred).
    pub to: String,
    /// Text to inject.
    pub text: String,
    /// Optional caller-side label for the subtask.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// Whether to auto-submit Enter. Default true.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub submit: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[schemars(crate = "rmcp::schemars")]
pub struct DispatchTaskBatchArgs {
    /// Optional human-readable batch label.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// Independent subtasks to dispatch in one batch.
    pub tasks: Vec<DispatchTaskBatchItem>,
}

#[derive(Clone, Debug)]
struct DispatchTaskMeta {
    batch_id: Option<String>,
    batch_label: Option<String>,
    task_label: Option<String>,
}

/// Extract the tab id portion of a pane id (`${tab_id}::pane-${idx}`).
/// Used to scope `list_panes` and `send_to_pane` to the caller's own
/// multi-agent Tab so simultaneous tabs don't see / dispatch to each
/// other. If the input doesn't match the expected format, returns the
/// whole string — that's a safe fallback (single-tab in legacy mode).
fn tab_prefix(pane_id: &str) -> &str {
    match pane_id.find("::pane-") {
        Some(idx) => &pane_id[..idx],
        None => pane_id,
    }
}

/// Extract the short pane label (e.g. `pane-1`) from a full pane id
/// like `tab-fb3f2173-...::pane-1`. Returned as a String the LLM can
/// quote inline in tool calls without dragging the 44-char tab UUID
/// along — keeps `send_to_pane(...)` arg lists short enough to render
/// cleanly inside a 25%-width grid pane. Falls back to the whole id
/// if no `::pane-` separator is found (legacy / split-pane sessions).
fn pane_short(pane_id: &str) -> String {
    match pane_id.find("::pane-") {
        Some(idx) => pane_id[idx + "::".len()..].to_string(),
        None => pane_id.to_string(),
    }
}

/// Resolve the `id` argument of `send_to_pane` / `read_pane` against
/// the caller's tab context. Accepts:
///   - full id: `tab-X::pane-N`             → returned unchanged
///   - short label: `pane-N`                → expanded with `self_tab`
///   - bare digit / number: `1` / `2` / …   → expanded as `<self_tab>::pane-N`
///
/// Short forms are the recommended way for an LLM to call these tools
/// in a 4-pane grid because the Claude/Codex/Gemini TUIs render long
/// tool-call arg lists badly when wrapped in narrow panes (the long
/// UUID + a multi-byte text payload trips emoji-width-aware folding).
/// Full ids stay accepted forever — pre-v1.5.1 callers (and the LLMs
/// they teach) keep working.
fn resolve_pane_id(arg_id: &str, self_pane_id: Option<&str>) -> String {
    if arg_id.contains("::pane-") {
        return arg_id.to_string();
    }
    let Some(self_id) = self_pane_id else {
        return arg_id.to_string();
    };
    let tab = tab_prefix(self_id);
    if let Some(stripped) = arg_id.strip_prefix("pane-") {
        if stripped.chars().all(|c| c.is_ascii_digit()) {
            return format!("{tab}::pane-{stripped}");
        }
    }
    if arg_id.chars().all(|c| c.is_ascii_digit()) && !arg_id.is_empty() {
        return format!("{tab}::pane-{arg_id}");
    }
    arg_id.to_string()
}

#[cfg(test)]
mod tests {
    use super::{build_shell_task_wrapper, extract_between_markers, tab_prefix};

    #[test]
    fn tab_prefix_extracts_tab_portion() {
        assert_eq!(tab_prefix("tab-abc::pane-1"), "tab-abc");
        assert_eq!(tab_prefix("tab-abc::pane-4"), "tab-abc");
        assert_eq!(
            tab_prefix("tab-uuid-with-dashes::pane-2"),
            "tab-uuid-with-dashes"
        );
    }

    #[test]
    fn tab_prefix_falls_back_for_unmatched_format() {
        // Legacy / split-pane / shell sessions don't use the
        // ::pane- format. Returning the whole id is the safe
        // default — these never collide cross-Tab anyway.
        assert_eq!(tab_prefix("legacy-session-id"), "legacy-session-id");
        assert_eq!(tab_prefix("tab-X::split-1"), "tab-X::split-1");
    }

    #[test]
    fn tab_prefix_distinguishes_concurrent_tabs() {
        // The whole point of tab_prefix: panes in tab-A and tab-B
        // must produce DIFFERENT prefixes so list_panes can filter
        // them apart even when both Tabs run 4 Claude panes.
        let a1 = tab_prefix("tab-A::pane-1");
        let b1 = tab_prefix("tab-B::pane-1");
        assert_ne!(a1, b1, "concurrent multi-agent tabs must be isolatable");
    }

    #[test]
    fn shell_task_wrapper_flattens_multiline_body_with_statement_separators() {
        let wrapped = build_shell_task_wrapper("__BEGIN__", "__END__", "id\npwd\r\necho OK");
        assert_eq!(wrapped, "echo __BEGIN__; id; pwd; echo OK; echo __END__");
    }

    #[test]
    fn extract_between_markers_uses_clean_marker_lines() {
        let text = "prompt$ echo __BEGIN__; id; pwd; echo __END__\n__BEGIN__\nuid=0(root)\n/root\n__END__\nprompt$";
        let between = extract_between_markers(text, "__BEGIN__", "__END__");
        assert_eq!(between.as_deref(), Some("uid=0(root)\n/root"));
    }
}

// ---------- MCP server handler ----------

#[derive(Clone)]
pub struct CoffeeMcp {
    tool_router: ToolRouter<CoffeeMcp>,
    panes: Arc<PaneStore>,
    app: AppHandle,
    /// The pane this MCP server instance is dedicated to — i.e. "the
    /// caller's identity, baked in at spawn time". Each multi-agent
    /// pane spawns its own MCP server bound to its own port, with
    /// its own `self_pane_id` set. `None` means the server is
    /// anonymous (legacy / non-multi-agent mode); in that case
    /// `whoami` returns an error and `list_panes` doesn't mark
    /// `is_self`.
    self_pane_id: Option<String>,
}

#[tool_router]
impl CoffeeMcp {
    pub fn new(app: AppHandle, panes: Arc<PaneStore>, self_pane_id: Option<String>) -> Self {
        Self {
            tool_router: Self::tool_router(),
            app,
            panes,
            self_pane_id,
        }
    }

    async fn execute_send_shell_task(
        &self,
        target_id: &str,
        args: &SendShellTaskArgs,
    ) -> Result<ShellTaskExecution, String> {
        let target_cli = self
            .panes
            .pane_cli_name(target_id)
            .await
            .unwrap_or_else(|_| "shell".to_string());

        if !is_shell_like_cli(&target_cli) {
            return Err(format!("target pane is not shell-like: {}", target_cli));
        }

        let begin_marker = args
            .begin_marker
            .clone()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| format!("__COFFEE_BEGIN_{}__", uuid::Uuid::new_v4()));
        let end_marker = args
            .end_marker
            .clone()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| format!("__COFFEE_END_{}__", uuid::Uuid::new_v4()));
        let timeout_sec = args.timeout_sec.unwrap_or(45).clamp(1, 600);
        let start_cursor = self
            .panes
            .read_delta_from_cursor(target_id, 0, 1)
            .await
            .map(|(_, next_cursor, _)| next_cursor)
            .unwrap_or(0);
        let wrapped = build_shell_task_wrapper(&begin_marker, &end_marker, &args.text);

        self.panes
            .dispatch(target_id, &wrapped, true, false, 0)
            .await?;

        let deadline = Instant::now() + Duration::from_secs(timeout_sec);
        let mut next_cursor = start_cursor;
        let mut collected = String::new();
        let mut markers_found = false;
        let mut output = String::new();
        let mut status = "timeout".to_string();

        loop {
            let (delta, cursor, _idle) = self
                .panes
                .read_delta_from_cursor(target_id, next_cursor, 400)
                .await?;
            next_cursor = cursor;
            if !delta.is_empty() {
                collected.push_str(&delta);
            }

            if let Some(between) = extract_between_markers(&collected, &begin_marker, &end_marker) {
                output = between;
                markers_found = true;
                status = "completed".to_string();
                break;
            }

            if Instant::now() > deadline {
                break;
            }

            tokio::time::sleep(Duration::from_millis(250)).await;
        }

        Ok(ShellTaskExecution {
            status,
            pane_id: pane_short(target_id),
            cli: target_cli,
            begin_marker,
            end_marker,
            output,
            markers_found,
            raw_output: trim_last_lines(&collected, 400),
            start_cursor,
            next_cursor,
        })
    }

    async fn dispatch_peer_task(
        &self,
        target_id: &str,
        text: &str,
        submit: bool,
        meta: Option<DispatchTaskMeta>,
    ) -> Result<serde_json::Value, String> {
        if let Some(self_id) = &self.self_pane_id {
            if self_id == target_id {
                return Err("cannot send_to_pane to self".to_string());
            }
            let self_tab = tab_prefix(self_id);
            let target_tab = tab_prefix(target_id);
            if self_tab != target_tab {
                return Err(
                    "target pane belongs to a different Tab; cross-Tab dispatch is not supported"
                        .to_string(),
                );
            }
        }

        let wait = false;
        let timeout_sec = 0u64;
        let task_id = uuid::Uuid::new_v4().to_string();
        let target_cli = self
            .panes
            .pane_cli_name(target_id)
            .await
            .unwrap_or_else(|_| "shell".to_string());
        let dispatcher_short = self
            .self_pane_id
            .as_ref()
            .map(|id| pane_short(id))
            .unwrap_or_else(|| "admin".to_string());
        let target_short = pane_short(target_id);
        let dispatch_text = if is_shell_like_cli(&target_cli) {
            build_shell_wrapper(&dispatcher_short, &target_short, &task_id, text)
        } else {
            match &self.self_pane_id {
                Some(self_id) => {
                    format!("[From {} | Task {}] {}", pane_short(self_id), task_id, text)
                }
                None => text.to_string(),
            }
        };

        let result = self
            .panes
            .dispatch(target_id, &dispatch_text, submit, wait, timeout_sec)
            .await?;

        let status = if !result.waited {
            "submitted"
        } else if result.timed_out {
            "timeout"
        } else {
            "completed"
        };
        let emitter_session_id = self
            .self_pane_id
            .clone()
            .unwrap_or_else(|| "admin".to_string());
        let emitter_pane_id = if emitter_session_id == "admin" {
            "admin".to_string()
        } else {
            pane_short(&emitter_session_id)
        };
        let tab_id = tab_prefix(self.self_pane_id.as_deref().unwrap_or(target_id)).to_string();
        let batch_id = meta.as_ref().and_then(|m| m.batch_id.clone());
        let batch_label = meta.as_ref().and_then(|m| m.batch_label.clone());
        let task_label = meta.as_ref().and_then(|m| m.task_label.clone());
        register_dispatched_task(SentinelTaskRecord {
            tab_id: tab_id.clone(),
            task_id: task_id.clone(),
            batch_id: batch_id.clone(),
            batch_label,
            task_label,
            emitter_session_id: emitter_session_id.clone(),
            emitter_pane_id: emitter_pane_id.clone(),
            target_session_id: target_id.to_string(),
            target_pane_id: target_short.clone(),
            dispatch_text: text.to_string(),
            status: status.to_string(),
            control_channel: None,
            result_excerpt: None,
            notify_injected: None,
            reason: None,
            created_at: epoch_seconds(),
            updated_at: epoch_seconds(),
        });
        let _ = self.app.emit(
            "sentinel-dispatch",
            SentinelDispatchEvent {
                tab_id,
                emitter_session_id,
                emitter_pane_id,
                target_session_id: target_id.to_string(),
                target_pane_id: target_short.clone(),
                task_id: task_id.clone(),
                batch_id,
                dispatch_text: text.to_string(),
                status: status.to_string(),
            },
        );
        let mut payload = serde_json::json!({
            "status": status,
            "pane_id": pane_short(target_id),
            "bytes_written": result.bytes_written,
            "task_id": task_id,
        });
        if let Some(output) = result.captured_output {
            payload["output"] = serde_json::json!(output);
        }
        Ok(payload)
    }

    async fn execute_expect_pane(
        &self,
        target_id: &str,
        args: &ExpectPaneArgs,
    ) -> Result<ExpectExecution, String> {
        let mode = args.mode.clone().unwrap_or_else(|| "substring".to_string());
        let timeout_sec = args.timeout_sec.unwrap_or(30).clamp(1, 600);
        let deadline = Instant::now() + Duration::from_secs(timeout_sec);
        let last_n = args.last_n_lines.unwrap_or(80).clamp(1, 2000);
        let mut cursor = args.cursor.unwrap_or(0);
        let regex = if mode.eq_ignore_ascii_case("regex") {
            Some(regex::Regex::new(&args.pattern).map_err(|e| format!("invalid regex: {}", e))?)
        } else {
            None
        };

        loop {
            let (stripped, next_cursor, is_idle) = self
                .panes
                .read_delta_from_cursor(target_id, cursor, last_n)
                .await?;
            cursor = next_cursor;

            let matched = if let Some(re) = &regex {
                re.is_match(&stripped)
            } else {
                stripped.contains(&args.pattern)
            };

            let preview = trim_last_lines(&stripped, last_n);
            if matched {
                return Ok(ExpectExecution {
                    status: "matched".to_string(),
                    pane_id: pane_short(target_id),
                    mode,
                    pattern: args.pattern.clone(),
                    cursor: args.cursor.unwrap_or(0),
                    next_cursor,
                    is_idle,
                    output: preview,
                });
            }

            if Instant::now() > deadline {
                return Ok(ExpectExecution {
                    status: "timeout".to_string(),
                    pane_id: pane_short(target_id),
                    mode,
                    pattern: args.pattern.clone(),
                    cursor: args.cursor.unwrap_or(0),
                    next_cursor,
                    is_idle,
                    output: preview,
                });
            }

            tokio::time::sleep(Duration::from_millis(350)).await;
        }
    }

    async fn execute_send_shell(
        &self,
        target_id: &str,
        args: &SendShellArgs,
    ) -> Result<RawShellSendExecution, String> {
        let start_cursor = args.cursor.unwrap_or(0);
        let submit = args.submit.unwrap_or(true);
        let result = self
            .panes
            .dispatch(target_id, &args.text, submit, false, 0)
            .await?;
        let (_, next_cursor, _) = self
            .panes
            .read_delta_from_cursor(target_id, 0, 1)
            .await
            .unwrap_or_else(|_| (String::new(), start_cursor, false));
        Ok(RawShellSendExecution {
            status: if result.waited {
                "completed"
            } else {
                "submitted"
            }
            .to_string(),
            pane_id: pane_short(target_id),
            cursor: start_cursor,
            next_cursor,
            submit,
            text: args.text.clone(),
        })
    }

    async fn execute_send_key(
        &self,
        target_id: &str,
        args: &SendKeyArgs,
    ) -> Result<RawShellSendExecution, String> {
        let repeat = args.repeat.unwrap_or(1).clamp(1, 100);
        let bytes = key_name_to_bytes(&args.key)?;
        let text = String::from_utf8_lossy(&bytes).to_string().repeat(repeat);
        let send_args = SendShellArgs {
            id: args.id.clone(),
            text,
            submit: Some(false),
            cursor: args.cursor,
        };
        self.execute_send_shell(target_id, &send_args).await
    }

    async fn execute_read_screen(
        &self,
        target_id: &str,
        last_n_lines: usize,
    ) -> Result<(String, bool), String> {
        let target_id = target_id.to_string();
        let session = self.panes.session.clone();
        let ansi_re = self.panes.ansi_re.clone();
        tokio::task::spawn_blocking(move || -> Result<(String, bool), String> {
            let guard = session
                .lock()
                .map_err(|_| "session map poisoned".to_string())?;
            let sess = guard
                .get(&target_id)
                .ok_or_else(|| format!("pane not found: {}", target_id))?;
            let joined = {
                let ring = sess
                    .output_buffer
                    .lock()
                    .map_err(|_| "output buffer poisoned".to_string())?;
                ring.join("")
            };
            let is_idle = sess
                .activity
                .lock()
                .map(|a| a.last_status == "wait_input")
                .unwrap_or(false);
            let stripped = ansi_re.replace_all(&joined, "").to_string();
            Ok((trim_last_lines(&stripped, last_n_lines), is_idle))
        })
        .await
        .map_err(|e| format!("blocking task join failed: {}", e))?
    }

    async fn execute_expect_screen(
        &self,
        target_id: &str,
        args: &ExpectScreenArgs,
    ) -> Result<ExpectExecution, String> {
        let mode = args.mode.clone().unwrap_or_else(|| "substring".to_string());
        let timeout_sec = args.timeout_sec.unwrap_or(30).clamp(1, 600);
        let deadline = Instant::now() + Duration::from_secs(timeout_sec);
        let last_n = args.last_n_lines.unwrap_or(120).clamp(1, 2000);
        let regex = if mode.eq_ignore_ascii_case("regex") {
            Some(regex::Regex::new(&args.pattern).map_err(|e| format!("invalid regex: {}", e))?)
        } else {
            None
        };

        loop {
            let (screen, is_idle) = self.execute_read_screen(target_id, last_n).await?;
            let matched = if let Some(re) = &regex {
                re.is_match(&screen)
            } else {
                screen.contains(&args.pattern)
            };

            if matched {
                return Ok(ExpectExecution {
                    status: "matched".to_string(),
                    pane_id: pane_short(target_id),
                    mode,
                    pattern: args.pattern.clone(),
                    cursor: 0,
                    next_cursor: 0,
                    is_idle,
                    output: screen,
                });
            }

            if Instant::now() > deadline {
                return Ok(ExpectExecution {
                    status: "timeout".to_string(),
                    pane_id: pane_short(target_id),
                    mode,
                    pattern: args.pattern.clone(),
                    cursor: 0,
                    next_cursor: 0,
                    is_idle,
                    output: screen,
                });
            }

            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }

    #[tool(
        description = "Return the caller's identity. Two modes: (1) when this \
MCP server was spawned for a specific pane (intra-Coffee-CLI sentinel mode), \
returns `{ pane_id: \"pane-N\" }` — that's the id you pass as `from` in \
[COFFEE-DONE] markers. (2) when this MCP server is the global Hyper-Agent \
admin endpoint (used by external orchestrators like OpenClaw / Hermes Agent), \
returns `{ role: \"admin\", scope: \"all-panes\" }` — meaning you can see and \
dispatch to every pane across every tab in this Coffee-CLI instance."
    )]
    async fn whoami(&self) -> Result<CallToolResult, McpError> {
        match &self.self_pane_id {
            Some(id) => {
                // Return the short label (e.g. `pane-1`) so the LLM
                // sees a value short enough to drop straight into
                // tool calls without bloating the rendered arg list.
                let payload = serde_json::json!({ "pane_id": pane_short(id) });
                Ok(CallToolResult::success(vec![Content::text(
                    serde_json::to_string_pretty(&payload).unwrap_or_default(),
                )]))
            }
            None => Ok(CallToolResult::success(vec![Content::text(
                serde_json::json!({
                    "role": "admin",
                    "scope": "all-panes",
                    "note": "Hyper-Agent endpoint — list_panes returns every pane across every tab; send_to_pane accepts any pane id. From the target pane's POV, your input arrives as plain stdin, indistinguishable from human typing.",
                })
                .to_string(),
            )])),
        }
    }

    #[tool(
        description = "List panes. Default scope is the caller's own multi-agent \
Tab — cross-Tab panes are filtered out. EXCEPTION: when called via the global \
Hyper-Agent admin endpoint (whoami → role=admin), this returns ALL panes across \
ALL tabs in the Coffee-CLI instance — that's the 'super admin' scope used by \
OpenClaw / Hermes Agent. Each row has id, title, cli, state (empty/idle/busy/\
terminated). Use this to discover what peers exist before calling send_to_pane."
    )]
    async fn list_panes(&self) -> Result<CallToolResult, McpError> {
        let mut panes = self.panes.list().await;
        if let Some(self_id) = &self.self_pane_id {
            // Tab-scope filter: only show panes whose tab matches the
            // caller's. This is what makes simultaneous multi-agent
            // tabs safe — a pane in Tab A can't accidentally dispatch
            // to a pane in Tab B because it never sees Tab B's panes
            // in the first place. We filter on the internal `full_id`
            // (the long `tab-<uuid>::pane-N` form), since the public
            // `id` field is now a short tab-relative `pane-N`.
            let self_tab = tab_prefix(self_id);
            panes.retain(|p| tab_prefix(&p.full_id) == self_tab);
            for p in &mut panes {
                if &p.full_id == self_id {
                    p.is_self = Some(true);
                }
            }
        }
        let payload = serde_json::to_string_pretty(&panes).unwrap_or_default();
        Ok(CallToolResult::success(vec![Content::text(payload)]))
    }

    #[tool(description = "Dispatch a task to a peer pane and end your own turn. \
This is fire-and-forget — there is no waiting mode. The call returns \
immediately, your turn ends, and you sit at idle until the target's \
`[COFFEE-DONE task=<id> from=paneT to=paneSelf]` marker reactivates your LLM with the result. \
\
From the target pane's POV the text is indistinguishable from human typing — \
no special framing, no source flag — and Coffee-CLI auto-prefixes it with \
`[From paneN | Task <id>]` so the receiver knows who dispatched it and where to send the \
matching RESULT/DONE markers. A carriage return is auto-appended (set submit=false to disable). \
Self-dispatch is rejected. The intra-tab MCP server can only dispatch within \
its own tab; the global Hyper-Agent admin endpoint can dispatch to any pane \
in any tab.")]
    async fn send_to_pane(
        &self,
        Parameters(args): Parameters<SendToPaneArgs>,
    ) -> Result<CallToolResult, McpError> {
        let target_id = resolve_pane_id(&args.id, self.self_pane_id.as_deref());
        let submit = args.submit.unwrap_or(true);
        match self
            .dispatch_peer_task(&target_id, &args.text, submit, None)
            .await
        {
            Ok(payload) => Ok(CallToolResult::success(vec![Content::text(
                serde_json::to_string_pretty(&payload).unwrap_or_default(),
            )])),
            Err(e) => Ok(CallToolResult::success(vec![Content::text(
                serde_json::json!({ "status": "failed", "error": e }).to_string(),
            )])),
        }
    }

    #[tool(
        description = "Dispatch a batch of independent tasks to multiple panes in one manager turn. Use this when subtasks can proceed in parallel. The batch is fire-and-forget: all tasks are submitted immediately, each gets its own task_id, and results return later through the normal RESULT/DONE wake-up path."
    )]
    async fn dispatch_task_batch(
        &self,
        Parameters(args): Parameters<DispatchTaskBatchArgs>,
    ) -> Result<CallToolResult, McpError> {
        if args.tasks.is_empty() {
            return Ok(CallToolResult::success(vec![Content::text(
                serde_json::json!({ "status": "failed", "error": "tasks cannot be empty" })
                    .to_string(),
            )]));
        }
        let batch_id = uuid::Uuid::new_v4().to_string();
        let mut results = Vec::new();
        for item in &args.tasks {
            let target_id = resolve_pane_id(&item.to, self.self_pane_id.as_deref());
            match self
                .dispatch_peer_task(
                    &target_id,
                    &item.text,
                    item.submit.unwrap_or(true),
                    Some(DispatchTaskMeta {
                        batch_id: Some(batch_id.clone()),
                        batch_label: args.label.clone(),
                        task_label: item.label.clone(),
                    }),
                )
                .await
            {
                Ok(mut payload) => {
                    payload["target"] = serde_json::json!(pane_short(&target_id));
                    payload["label"] = serde_json::json!(item.label.clone());
                    results.push(payload);
                }
                Err(e) => {
                    results.push(serde_json::json!({
                        "status": "failed",
                        "target": pane_short(&target_id),
                        "label": item.label.clone(),
                        "error": e,
                    }));
                }
            }
        }
        let payload = serde_json::json!({
            "status": "submitted",
            "batch_id": batch_id,
            "label": args.label,
            "results": results,
        });
        Ok(CallToolResult::success(vec![Content::text(
            serde_json::to_string_pretty(&payload).unwrap_or_default(),
        )]))
    }

    #[tool(
        description = "Wait for a batch of dispatched tasks to settle. You can watch either a batch_id returned by dispatch_task_batch or an explicit list of task_ids. Returns as soon as every tracked task is completed / wake_failed, or when timeout is hit."
    )]
    async fn wait_tasks(
        &self,
        Parameters(args): Parameters<WaitTasksArgs>,
    ) -> Result<CallToolResult, McpError> {
        let Some(self_id) = &self.self_pane_id else {
            return Ok(CallToolResult::success(vec![Content::text(
                serde_json::json!({
                    "status": "failed",
                    "error": "wait_tasks requires a pane-scoped MCP server",
                })
                .to_string(),
            )]));
        };
        let tab_id = tab_prefix(self_id).to_string();
        let timeout_sec = args.timeout_sec.unwrap_or(30).clamp(1, 600);
        let poll_ms = args.poll_ms.unwrap_or(350).clamp(100, 5000);
        let deadline = Instant::now() + Duration::from_secs(timeout_sec);
        let tracked_task_ids = args.task_ids.clone();

        let mut last_snapshot = query_task_records(
            &tab_id,
            args.batch_id.as_deref(),
            tracked_task_ids.as_deref(),
            true,
            256,
        );
        loop {
            let unfinished = last_snapshot
                .iter()
                .filter(|record| record.status != "completed" && record.status != "wake_failed")
                .count();
            if unfinished == 0 && !last_snapshot.is_empty() {
                let payload = serde_json::json!({
                    "status": "completed",
                    "batch_id": args.batch_id,
                    "task_ids": tracked_task_ids,
                    "counts": summarize_task_status_counts(&last_snapshot),
                    "tasks": last_snapshot,
                });
                return Ok(CallToolResult::success(vec![Content::text(
                    serde_json::to_string_pretty(&payload).unwrap_or_default(),
                )]));
            }
            if Instant::now() >= deadline {
                let payload = serde_json::json!({
                    "status": "timeout",
                    "batch_id": args.batch_id,
                    "task_ids": tracked_task_ids,
                    "counts": summarize_task_status_counts(&last_snapshot),
                    "tasks": last_snapshot,
                });
                return Ok(CallToolResult::success(vec![Content::text(
                    serde_json::to_string_pretty(&payload).unwrap_or_default(),
                )]));
            }
            tokio::time::sleep(Duration::from_millis(poll_ms)).await;
            last_snapshot = query_task_records(
                &tab_id,
                args.batch_id.as_deref(),
                tracked_task_ids.as_deref(),
                true,
                256,
            );
        }
    }

    #[tool(
        description = "Summarize active / completed dispatched tasks for the caller's tab. Useful for managers and observers to inspect a batch without rereading pane output."
    )]
    async fn summarize_active_tasks(
        &self,
        Parameters(args): Parameters<SummarizeActiveTasksArgs>,
    ) -> Result<CallToolResult, McpError> {
        let Some(self_id) = &self.self_pane_id else {
            return Ok(CallToolResult::success(vec![Content::text(
                serde_json::json!({
                    "status": "failed",
                    "error": "summarize_active_tasks requires a pane-scoped MCP server",
                })
                .to_string(),
            )]));
        };
        let tab_id = tab_prefix(self_id).to_string();
        let limit = args.limit.unwrap_or(32).clamp(1, 256);
        let include_completed = args.include_completed.unwrap_or(true);
        let records = query_task_records(
            &tab_id,
            args.batch_id.as_deref(),
            args.task_ids.as_deref(),
            include_completed,
            limit,
        );
        let summary_lines = records
            .iter()
            .map(|record| {
                format!(
                    "- {} [{}] {} -> {}{}",
                    record.task_id,
                    record.status,
                    record.emitter_pane_id,
                    record.target_pane_id,
                    record
                        .batch_id
                        .as_ref()
                        .map(|batch_id| format!(" (batch {})", batch_id))
                        .unwrap_or_default()
                )
            })
            .collect::<Vec<_>>();
        let payload = serde_json::json!({
            "status": "ok",
            "batch_id": args.batch_id,
            "counts": summarize_task_status_counts(&records),
            "tasks": records,
            "summary": summary_lines.join("\n"),
        });
        Ok(CallToolResult::success(vec![Content::text(
            serde_json::to_string_pretty(&payload).unwrap_or_default(),
        )]))
    }

    #[tool(
        description = "Dispatch a shell task to a shell/terminal pane using automatic begin/end markers. \
Use this instead of send_to_pane when the target hosts PowerShell, bash, SSH, nc, reverse shells, or interactive shell tooling. \
Coffee wraps the command with unique markers, waits for the end marker, and returns only the text between the markers."
    )]
    async fn send_shell_task(
        &self,
        Parameters(args): Parameters<SendShellTaskArgs>,
    ) -> Result<CallToolResult, McpError> {
        let target_id = resolve_pane_id(&args.id, self.self_pane_id.as_deref());
        match self.execute_send_shell_task(&target_id, &args).await {
            Ok(exec) => {
                record_shell_task_ledger_entry(
                    &target_id,
                    ShellTaskLedgerEntry {
                        id: format!("shell-task-{}", uuid::Uuid::new_v4()),
                        kind: "send_shell_task".to_string(),
                        pane_id: exec.pane_id.clone(),
                        status: exec.status.clone(),
                        command_preview: preview_text(&args.text, 160),
                        output_excerpt: preview_text(&exec.output, 220),
                        start_cursor: exec.start_cursor,
                        next_cursor: exec.next_cursor,
                        begin_marker: Some(exec.begin_marker.clone()),
                        end_marker: Some(exec.end_marker.clone()),
                        step_count: None,
                        created_at: epoch_seconds(),
                        updated_at: epoch_seconds(),
                    },
                );
                let payload = serde_json::json!({
                    "status": exec.status,
                    "pane_id": exec.pane_id,
                    "cli": exec.cli,
                    "begin_marker": exec.begin_marker,
                    "end_marker": exec.end_marker,
                    "output": exec.output,
                    "markers_found": exec.markers_found,
                    "raw_output": exec.raw_output,
                    "start_cursor": exec.start_cursor,
                    "next_cursor": exec.next_cursor,
                });
                Ok(CallToolResult::success(vec![Content::text(
                    serde_json::to_string_pretty(&payload).unwrap_or_default(),
                )]))
            }
            Err(e) => Ok(CallToolResult::success(vec![Content::text(
                serde_json::json!({ "status": "failed", "error": e }).to_string(),
            )])),
        }
    }

    #[tool(description = "Read the most recent output lines from another pane. \
Useful after a send_to_pane(wait=false) long task, to check progress or pull final output. \
Returns plain text plus an is_idle flag. Default result mode extracts the latest structured Coffee RESULT block and falls back to raw terminal text only when needed.")]
    async fn read_pane(
        &self,
        Parameters(args): Parameters<ReadPaneArgs>,
    ) -> Result<CallToolResult, McpError> {
        // Accept short forms (`pane-2`, `2`) — same convenience as
        // send_to_pane.
        let target_id = resolve_pane_id(&args.id, self.self_pane_id.as_deref());
        let last_n = args.last_n_lines.unwrap_or(200).min(2000);
        match self
            .panes
            .read(&target_id, last_n, args.mode.as_deref())
            .await
        {
            Ok((output, is_idle, semantic_result, raw_output)) => {
                let payload = serde_json::json!({
                    "output": output,
                    "is_idle": is_idle,
                    "mode": if semantic_result.is_some() && !matches!(args.mode.as_deref(), Some("raw")) {
                        "result"
                    } else {
                        "raw"
                    },
                    "task_id": semantic_result.as_ref().map(|r| r.task_id.clone()),
                    "from_pane": semantic_result.as_ref().map(|r| format!("pane-{}", r.from_pane_idx)),
                    "to_pane": semantic_result.as_ref().map(|r| format!("pane-{}", r.to_pane_idx)),
                    "raw_output": if semantic_result.is_some() && !matches!(args.mode.as_deref(), Some("raw")) {
                        serde_json::Value::String(raw_output)
                    } else {
                        serde_json::Value::Null
                    },
                });
                Ok(CallToolResult::success(vec![Content::text(
                    serde_json::to_string_pretty(&payload).unwrap_or_default(),
                )]))
            }
            Err(e) => Ok(CallToolResult::success(vec![Content::text(
                serde_json::json!({ "status": "failed", "error": e }).to_string(),
            )])),
        }
    }

    #[tool(
        description = "Read only the output produced after a given incremental cursor. \
Useful for shell/interactive workflows where you want to avoid rereading old pane output. \
Returns the new cursor plus the delta text since the supplied cursor."
    )]
    async fn read_pane_delta(
        &self,
        Parameters(args): Parameters<ReadPaneDeltaArgs>,
    ) -> Result<CallToolResult, McpError> {
        let target_id = resolve_pane_id(&args.id, self.self_pane_id.as_deref());
        let cursor = args.cursor.unwrap_or(0);
        let last_n = args.last_n_lines.unwrap_or(120).clamp(1, 2000);
        match self
            .panes
            .read_delta_from_cursor(&target_id, cursor, last_n)
            .await
        {
            Ok((output, next_cursor, is_idle)) => {
                let payload = serde_json::json!({
                    "status": "ok",
                    "pane_id": pane_short(&target_id),
                    "cursor": cursor,
                    "next_cursor": next_cursor,
                    "is_idle": is_idle,
                    "output": output,
                });
                Ok(CallToolResult::success(vec![Content::text(
                    serde_json::to_string_pretty(&payload).unwrap_or_default(),
                )]))
            }
            Err(e) => Ok(CallToolResult::success(vec![Content::text(
                serde_json::json!({ "status": "failed", "error": e }).to_string(),
            )])),
        }
    }

    #[tool(
        description = "Wait until a pane's output matches a substring or regex. \
Useful for interactive shell workflows such as waiting for prompts, menu text, nc listeners, reverse shells, or known end markers."
    )]
    async fn expect_pane(
        &self,
        Parameters(args): Parameters<ExpectPaneArgs>,
    ) -> Result<CallToolResult, McpError> {
        let target_id = resolve_pane_id(&args.id, self.self_pane_id.as_deref());
        match self.execute_expect_pane(&target_id, &args).await {
            Ok(exec) => {
                record_shell_task_ledger_entry(
                    &target_id,
                    ShellTaskLedgerEntry {
                        id: format!("expect-{}", uuid::Uuid::new_v4()),
                        kind: "expect_pane".to_string(),
                        pane_id: exec.pane_id.clone(),
                        status: exec.status.clone(),
                        command_preview: preview_text(
                            &format!("{}: {}", exec.mode, exec.pattern),
                            160,
                        ),
                        output_excerpt: preview_text(&exec.output, 220),
                        start_cursor: exec.cursor,
                        next_cursor: exec.next_cursor,
                        begin_marker: None,
                        end_marker: None,
                        step_count: None,
                        created_at: epoch_seconds(),
                        updated_at: epoch_seconds(),
                    },
                );
                let payload = serde_json::json!({
                    "status": exec.status,
                    "pane_id": exec.pane_id,
                    "mode": exec.mode,
                    "pattern": exec.pattern,
                    "cursor": exec.cursor,
                    "next_cursor": exec.next_cursor,
                    "is_idle": exec.is_idle,
                    "output": exec.output,
                });
                return Ok(CallToolResult::success(vec![Content::text(
                    serde_json::to_string_pretty(&payload).unwrap_or_default(),
                )]));
            }
            Err(e) => {
                return Ok(CallToolResult::success(vec![Content::text(
                    serde_json::json!({ "status": "failed", "error": e }).to_string(),
                )]))
            }
        }
    }

    #[tool(
        description = "Inject raw text into a shell-like pane, optionally submitting Enter, and return the updated cursor. \
Use this for truly interactive shell flows where you want to type first and inspect / expect later."
    )]
    async fn send_shell(
        &self,
        Parameters(args): Parameters<SendShellArgs>,
    ) -> Result<CallToolResult, McpError> {
        let target_id = resolve_pane_id(&args.id, self.self_pane_id.as_deref());
        match self.execute_send_shell(&target_id, &args).await {
            Ok(exec) => {
                record_shell_task_ledger_entry(
                    &target_id,
                    ShellTaskLedgerEntry {
                        id: format!("send-shell-{}", uuid::Uuid::new_v4()),
                        kind: "send_shell".to_string(),
                        pane_id: exec.pane_id.clone(),
                        status: exec.status.clone(),
                        command_preview: preview_text(&exec.text, 160),
                        output_excerpt: String::new(),
                        start_cursor: exec.cursor,
                        next_cursor: exec.next_cursor,
                        begin_marker: None,
                        end_marker: None,
                        step_count: None,
                        created_at: epoch_seconds(),
                        updated_at: epoch_seconds(),
                    },
                );
                let payload = serde_json::json!({
                    "status": exec.status,
                    "pane_id": exec.pane_id,
                    "cursor": exec.cursor,
                    "next_cursor": exec.next_cursor,
                    "submit": exec.submit,
                    "text": exec.text,
                });
                Ok(CallToolResult::success(vec![Content::text(
                    serde_json::to_string_pretty(&payload).unwrap_or_default(),
                )]))
            }
            Err(e) => Ok(CallToolResult::success(vec![Content::text(
                serde_json::json!({ "status": "failed", "error": e }).to_string(),
            )])),
        }
    }

    #[tool(
        description = "Inject a single semantic key into a pane. Use this for interactive TUI/termbox/ncurses tools where raw text + newline is not enough. Supported keys include Enter, Esc, Tab, Backspace, Up, Down, Left, Right, Home, End, PgUp, PgDn, Ctrl+C and single printable characters."
    )]
    async fn send_key(
        &self,
        Parameters(args): Parameters<SendKeyArgs>,
    ) -> Result<CallToolResult, McpError> {
        let target_id = resolve_pane_id(&args.id, self.self_pane_id.as_deref());
        match self.execute_send_key(&target_id, &args).await {
            Ok(exec) => {
                record_shell_task_ledger_entry(
                    &target_id,
                    ShellTaskLedgerEntry {
                        id: format!("send-key-{}", uuid::Uuid::new_v4()),
                        kind: "send_key".to_string(),
                        pane_id: exec.pane_id.clone(),
                        status: exec.status.clone(),
                        command_preview: preview_text(&args.key, 80),
                        output_excerpt: String::new(),
                        start_cursor: exec.cursor,
                        next_cursor: exec.next_cursor,
                        begin_marker: None,
                        end_marker: None,
                        step_count: None,
                        created_at: epoch_seconds(),
                        updated_at: epoch_seconds(),
                    },
                );
                let payload = serde_json::json!({
                    "status": exec.status,
                    "pane_id": exec.pane_id,
                    "cursor": exec.cursor,
                    "next_cursor": exec.next_cursor,
                    "key": args.key,
                    "repeat": args.repeat.unwrap_or(1),
                });
                Ok(CallToolResult::success(vec![Content::text(
                    serde_json::to_string_pretty(&payload).unwrap_or_default(),
                )]))
            }
            Err(e) => Ok(CallToolResult::success(vec![Content::text(
                serde_json::json!({ "status": "failed", "error": e }).to_string(),
            )])),
        }
    }

    #[tool(
        description = "Read the current visible screen snapshot from a pane. This is intended for interactive full-screen tools (termbox/ncurses/TUI) where current screen state matters more than output delta."
    )]
    async fn read_screen(
        &self,
        Parameters(args): Parameters<ReadScreenArgs>,
    ) -> Result<CallToolResult, McpError> {
        let target_id = resolve_pane_id(&args.id, self.self_pane_id.as_deref());
        let last_n = args.last_n_lines.unwrap_or(120).clamp(1, 2000);
        match self.execute_read_screen(&target_id, last_n).await {
            Ok((screen, is_idle)) => {
                let payload = serde_json::json!({
                    "status": "ok",
                    "pane_id": pane_short(&target_id),
                    "is_idle": is_idle,
                    "screen": screen,
                });
                Ok(CallToolResult::success(vec![Content::text(
                    serde_json::to_string_pretty(&payload).unwrap_or_default(),
                )]))
            }
            Err(e) => Ok(CallToolResult::success(vec![Content::text(
                serde_json::json!({ "status": "failed", "error": e }).to_string(),
            )])),
        }
    }

    #[tool(
        description = "Wait until the current visible screen snapshot of a pane matches a substring or regex. Use this for interactive TUI/termbox tools where menu state is shown on-screen rather than appended as plain output."
    )]
    async fn expect_screen(
        &self,
        Parameters(args): Parameters<ExpectScreenArgs>,
    ) -> Result<CallToolResult, McpError> {
        let target_id = resolve_pane_id(&args.id, self.self_pane_id.as_deref());
        match self.execute_expect_screen(&target_id, &args).await {
            Ok(exec) => {
                record_shell_task_ledger_entry(
                    &target_id,
                    ShellTaskLedgerEntry {
                        id: format!("expect-screen-{}", uuid::Uuid::new_v4()),
                        kind: "expect_screen".to_string(),
                        pane_id: exec.pane_id.clone(),
                        status: exec.status.clone(),
                        command_preview: preview_text(
                            &format!("{}: {}", exec.mode, exec.pattern),
                            160,
                        ),
                        output_excerpt: preview_text(&exec.output, 220),
                        start_cursor: 0,
                        next_cursor: 0,
                        begin_marker: None,
                        end_marker: None,
                        step_count: None,
                        created_at: epoch_seconds(),
                        updated_at: epoch_seconds(),
                    },
                );
                let payload = serde_json::json!({
                    "status": exec.status,
                    "pane_id": exec.pane_id,
                    "mode": exec.mode,
                    "pattern": exec.pattern,
                    "is_idle": exec.is_idle,
                    "screen": exec.output,
                });
                Ok(CallToolResult::success(vec![Content::text(
                    serde_json::to_string_pretty(&payload).unwrap_or_default(),
                )]))
            }
            Err(e) => Ok(CallToolResult::success(vec![Content::text(
                serde_json::json!({ "status": "failed", "error": e }).to_string(),
            )])),
        }
    }

    #[tool(
        description = "Read the recent shell-task ledger for a shell/terminal pane. \
Shows recent send_shell_task / expect_pane / send_shell / playbook activity with cursors and excerpts."
    )]
    async fn read_shell_task_ledger(
        &self,
        Parameters(args): Parameters<ReadShellTaskLedgerArgs>,
    ) -> Result<CallToolResult, McpError> {
        let target_id = resolve_pane_id(&args.id, self.self_pane_id.as_deref());
        let limit = args.limit.unwrap_or(20).clamp(1, 200);
        let entries = read_shell_task_ledger_entries(&target_id, limit);
        let payload = serde_json::json!({
            "status": "ok",
            "pane_id": pane_short(&target_id),
            "entries": entries,
        });
        Ok(CallToolResult::success(vec![Content::text(
            serde_json::to_string_pretty(&payload).unwrap_or_default(),
        )]))
    }

    #[tool(
        description = "Run a multi-step shell playbook against a shell/terminal pane. \
Supported step actions: send, send_shell_task, expect, read_delta, send_key, read_screen, expect_screen. \
Coffee threads a rolling cursor through the steps and records the whole run into the shell-task ledger."
    )]
    async fn run_shell_playbook(
        &self,
        Parameters(args): Parameters<RunShellPlaybookArgs>,
    ) -> Result<CallToolResult, McpError> {
        let target_id = resolve_pane_id(&args.id, self.self_pane_id.as_deref());
        let mut cursor = args.cursor.unwrap_or(0);
        let mut results: Vec<serde_json::Value> = Vec::new();
        let started_at = epoch_seconds();

        for (idx, step) in args.steps.iter().enumerate() {
            let action = step.action.trim().to_ascii_lowercase();
            match action.as_str() {
                "send" => {
                    let send_args = SendShellArgs {
                        id: args.id.clone(),
                        text: step.text.clone(),
                        submit: step.submit,
                        cursor: Some(cursor),
                    };
                    let exec = match self.execute_send_shell(&target_id, &send_args).await {
                        Ok(v) => v,
                        Err(e) => {
                            let payload = serde_json::json!({
                                "status": "failed",
                                "step_index": idx,
                                "action": action,
                                "error": e,
                                "results": results,
                            });
                            return Ok(CallToolResult::success(vec![Content::text(
                                serde_json::to_string_pretty(&payload).unwrap_or_default(),
                            )]));
                        }
                    };
                    cursor = exec.next_cursor;
                    results.push(serde_json::json!({
                        "step_index": idx,
                        "action": "send",
                        "status": exec.status,
                        "cursor": exec.cursor,
                        "next_cursor": exec.next_cursor,
                        "submit": exec.submit,
                        "text": exec.text,
                    }));
                }
                "send_shell_task" => {
                    let task_args = SendShellTaskArgs {
                        id: args.id.clone(),
                        text: step.text.clone(),
                        begin_marker: step.begin_marker.clone(),
                        end_marker: step.end_marker.clone(),
                        timeout_sec: step.timeout_sec,
                    };
                    let exec = match self.execute_send_shell_task(&target_id, &task_args).await {
                        Ok(v) => v,
                        Err(e) => {
                            let payload = serde_json::json!({
                                "status": "failed",
                                "step_index": idx,
                                "action": action,
                                "error": e,
                                "results": results,
                            });
                            return Ok(CallToolResult::success(vec![Content::text(
                                serde_json::to_string_pretty(&payload).unwrap_or_default(),
                            )]));
                        }
                    };
                    cursor = exec.next_cursor;
                    results.push(serde_json::json!({
                        "step_index": idx,
                        "action": "send_shell_task",
                        "status": exec.status,
                        "begin_marker": exec.begin_marker,
                        "end_marker": exec.end_marker,
                        "start_cursor": exec.start_cursor,
                        "next_cursor": exec.next_cursor,
                        "markers_found": exec.markers_found,
                        "output": exec.output,
                    }));
                }
                "expect" => {
                    let expect_args = ExpectPaneArgs {
                        id: args.id.clone(),
                        pattern: step.pattern.clone(),
                        mode: step.mode.clone(),
                        timeout_sec: step.timeout_sec,
                        last_n_lines: step.last_n_lines,
                        cursor: Some(cursor),
                    };
                    let exec = match self.execute_expect_pane(&target_id, &expect_args).await {
                        Ok(v) => v,
                        Err(e) => {
                            let payload = serde_json::json!({
                                "status": "failed",
                                "step_index": idx,
                                "action": action,
                                "error": e,
                                "results": results,
                            });
                            return Ok(CallToolResult::success(vec![Content::text(
                                serde_json::to_string_pretty(&payload).unwrap_or_default(),
                            )]));
                        }
                    };
                    cursor = exec.next_cursor;
                    results.push(serde_json::json!({
                        "step_index": idx,
                        "action": "expect",
                        "status": exec.status,
                        "mode": exec.mode,
                        "pattern": exec.pattern,
                        "cursor": exec.cursor,
                        "next_cursor": exec.next_cursor,
                        "is_idle": exec.is_idle,
                        "output": exec.output,
                    }));
                    if exec.status == "timeout" {
                        let payload = serde_json::json!({
                            "status": "timeout",
                            "step_index": idx,
                            "action": action,
                            "cursor": cursor,
                            "results": results,
                        });
                        record_shell_task_ledger_entry(
                            &target_id,
                            ShellTaskLedgerEntry {
                                id: format!("playbook-{}", uuid::Uuid::new_v4()),
                                kind: "run_shell_playbook".to_string(),
                                pane_id: pane_short(&target_id),
                                status: "timeout".to_string(),
                                command_preview: preview_text(
                                    &format!("playbook steps={}", args.steps.len()),
                                    160,
                                ),
                                output_excerpt: preview_text(&exec.output, 220),
                                start_cursor: args.cursor.unwrap_or(0),
                                next_cursor: cursor,
                                begin_marker: None,
                                end_marker: None,
                                step_count: Some(args.steps.len()),
                                created_at: started_at,
                                updated_at: epoch_seconds(),
                            },
                        );
                        return Ok(CallToolResult::success(vec![Content::text(
                            serde_json::to_string_pretty(&payload).unwrap_or_default(),
                        )]));
                    }
                }
                "send_key" => {
                    let key_args = SendKeyArgs {
                        id: args.id.clone(),
                        key: step.key.clone(),
                        repeat: step.repeat,
                        cursor: Some(cursor),
                    };
                    let exec = match self.execute_send_key(&target_id, &key_args).await {
                        Ok(v) => v,
                        Err(e) => {
                            let payload = serde_json::json!({
                                "status": "failed",
                                "step_index": idx,
                                "action": action,
                                "error": e,
                                "results": results,
                            });
                            return Ok(CallToolResult::success(vec![Content::text(
                                serde_json::to_string_pretty(&payload).unwrap_or_default(),
                            )]));
                        }
                    };
                    cursor = exec.next_cursor;
                    results.push(serde_json::json!({
                        "step_index": idx,
                        "action": "send_key",
                        "status": exec.status,
                        "cursor": exec.cursor,
                        "next_cursor": exec.next_cursor,
                        "key": step.key,
                        "repeat": step.repeat.unwrap_or(1),
                    }));
                }
                "read_delta" => {
                    let last_n = step.last_n_lines.unwrap_or(120).clamp(1, 2000);
                    let (output, next_cursor, is_idle) = match self
                        .panes
                        .read_delta_from_cursor(&target_id, cursor, last_n)
                        .await
                    {
                        Ok(v) => v,
                        Err(e) => {
                            let payload = serde_json::json!({
                                "status": "failed",
                                "step_index": idx,
                                "action": action,
                                "error": e,
                                "results": results,
                            });
                            return Ok(CallToolResult::success(vec![Content::text(
                                serde_json::to_string_pretty(&payload).unwrap_or_default(),
                            )]));
                        }
                    };
                    results.push(serde_json::json!({
                        "step_index": idx,
                        "action": "read_delta",
                        "status": "ok",
                        "cursor": cursor,
                        "next_cursor": next_cursor,
                        "is_idle": is_idle,
                        "output": output,
                    }));
                    cursor = next_cursor;
                }
                "read_screen" => {
                    let last_n = step.last_n_lines.unwrap_or(120).clamp(1, 2000);
                    let (screen, is_idle) = match self.execute_read_screen(&target_id, last_n).await
                    {
                        Ok(v) => v,
                        Err(e) => {
                            let payload = serde_json::json!({
                                "status": "failed",
                                "step_index": idx,
                                "action": action,
                                "error": e,
                                "results": results,
                            });
                            return Ok(CallToolResult::success(vec![Content::text(
                                serde_json::to_string_pretty(&payload).unwrap_or_default(),
                            )]));
                        }
                    };
                    results.push(serde_json::json!({
                        "step_index": idx,
                        "action": "read_screen",
                        "status": "ok",
                        "is_idle": is_idle,
                        "screen": screen,
                    }));
                }
                "expect_screen" => {
                    let expect_args = ExpectScreenArgs {
                        id: args.id.clone(),
                        pattern: step.pattern.clone(),
                        mode: step.mode.clone(),
                        timeout_sec: step.timeout_sec,
                        last_n_lines: step.last_n_lines,
                    };
                    let exec = match self.execute_expect_screen(&target_id, &expect_args).await {
                        Ok(v) => v,
                        Err(e) => {
                            let payload = serde_json::json!({
                                "status": "failed",
                                "step_index": idx,
                                "action": action,
                                "error": e,
                                "results": results,
                            });
                            return Ok(CallToolResult::success(vec![Content::text(
                                serde_json::to_string_pretty(&payload).unwrap_or_default(),
                            )]));
                        }
                    };
                    results.push(serde_json::json!({
                        "step_index": idx,
                        "action": "expect_screen",
                        "status": exec.status,
                        "mode": exec.mode,
                        "pattern": exec.pattern,
                        "is_idle": exec.is_idle,
                        "screen": exec.output,
                    }));
                    if exec.status == "timeout" {
                        let payload = serde_json::json!({
                            "status": "timeout",
                            "step_index": idx,
                            "action": action,
                            "results": results,
                        });
                        return Ok(CallToolResult::success(vec![Content::text(
                            serde_json::to_string_pretty(&payload).unwrap_or_default(),
                        )]));
                    }
                }
                _ => {
                    let payload = serde_json::json!({
                        "status": "failed",
                        "step_index": idx,
                        "action": step.action,
                        "error": format!("unsupported playbook action: {}", step.action),
                        "results": results,
                    });
                    return Ok(CallToolResult::success(vec![Content::text(
                        serde_json::to_string_pretty(&payload).unwrap_or_default(),
                    )]));
                }
            }
        }

        let final_output = results
            .last()
            .and_then(|v| v.get("output"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        record_shell_task_ledger_entry(
            &target_id,
            ShellTaskLedgerEntry {
                id: format!("playbook-{}", uuid::Uuid::new_v4()),
                kind: "run_shell_playbook".to_string(),
                pane_id: pane_short(&target_id),
                status: "completed".to_string(),
                command_preview: preview_text(&format!("playbook steps={}", args.steps.len()), 160),
                output_excerpt: preview_text(&final_output, 220),
                start_cursor: args.cursor.unwrap_or(0),
                next_cursor: cursor,
                begin_marker: None,
                end_marker: None,
                step_count: Some(args.steps.len()),
                created_at: started_at,
                updated_at: epoch_seconds(),
            },
        );
        let payload = serde_json::json!({
            "status": "completed",
            "pane_id": pane_short(&target_id),
            "cursor": args.cursor.unwrap_or(0),
            "next_cursor": cursor,
            "results": results,
        });
        Ok(CallToolResult::success(vec![Content::text(
            serde_json::to_string_pretty(&payload).unwrap_or_default(),
        )]))
    }

    #[tool(
        description = "Preferred completion path for workers. Use this instead of printing raw COFFEE-DONE markers when possible. \
Pass the original task_id from send_to_pane, the dispatcher pane id as `to`, and the final structured result text. \
Coffee-CLI emits RESULT/DONE control events directly and wakes the dispatcher via PTY injection."
    )]
    async fn complete_task(
        &self,
        Parameters(args): Parameters<CompleteTaskArgs>,
    ) -> Result<CallToolResult, McpError> {
        let Some(self_id) = &self.self_pane_id else {
            return Ok(CallToolResult::success(vec![Content::text(
                serde_json::json!({
                    "status": "failed",
                    "error": "complete_task requires a pane-scoped MCP server",
                })
                .to_string(),
            )]));
        };
        let inferred = if args.task_id.trim().is_empty() || args.to.trim().is_empty() {
            match infer_pending_task_for_target(self_id) {
                Ok(record) => Some(record),
                Err(e) => {
                    return Ok(CallToolResult::success(vec![Content::text(
                        serde_json::json!({
                            "status": "failed",
                            "error": format!("complete_task could not infer pending task context: {}", e),
                        })
                        .to_string(),
                    )]));
                }
            }
        } else {
            None
        };
        let effective_task_id = if args.task_id.trim().is_empty() {
            inferred
                .as_ref()
                .map(|record| record.task_id.clone())
                .unwrap_or_default()
        } else {
            args.task_id.clone()
        };
        let raw_target = if args.to.trim().is_empty() {
            inferred
                .as_ref()
                .map(|record| record.emitter_pane_id.clone())
                .unwrap_or_default()
        } else {
            args.to.clone()
        };
        let target_id = resolve_pane_id(&raw_target, self.self_pane_id.as_deref());
        match crate::terminal::complete_task_via_control(
            &self.app,
            &self.panes.session,
            self_id,
            &target_id,
            &effective_task_id,
            &args.result,
        ) {
            Ok(()) => Ok(CallToolResult::success(vec![Content::text(
                serde_json::json!({
                    "status": "completed",
                    "task_id": effective_task_id,
                    "to": pane_short(&target_id),
                    "channel": "mcp-complete-v1",
                    "inferred_context": inferred.is_some(),
                })
                .to_string(),
            )])),
            Err(e) => Ok(CallToolResult::success(vec![Content::text(
                serde_json::json!({
                    "status": "failed",
                    "task_id": effective_task_id,
                    "to": pane_short(&target_id),
                    "error": e,
                    "inferred_context": inferred.is_some(),
                })
                .to_string(),
            )])),
        }
    }
}

#[tool_handler]
impl ServerHandler for CoffeeMcp {
    fn get_info(&self) -> ServerInfo {
        ServerInfo {
            protocol_version: ProtocolVersion::V_2024_11_05,
            capabilities: ServerCapabilities::builder().enable_tools().build(),
            server_info: Implementation::from_build_env(),
            instructions: Some(
                "Coffee-CLI multi-agent MCP server. \
Tools: list_panes, send_to_pane, dispatch_task_batch, wait_tasks, summarize_active_tasks, send_shell_task, send_shell, expect_pane, read_pane, read_pane_delta, read_shell_task_ledger, run_shell_playbook, complete_task. \
Use these to coordinate ACROSS different CLIs (Claude/Codex/Gemini/OpenCode). \
For intra-CLI parallelism, prefer your native subagent SDK (Agent Teams / app-server / TaskTool). \
See CLAUDE.md / AGENTS.md / GEMINI.md in the workspace root for full protocol."
                    .to_string(),
            ),
        }
    }
}

// ---------- Entry point: spawn HTTP server on a dynamic port ----------

/// Information written to ~/.coffee-cli/mcp-endpoint.json so the CLI
/// injection scripts can find the running Coffee-CLI MCP server.
#[derive(Clone, Debug, Serialize)]
pub struct McpEndpoint {
    pub url: String,
    pub port: u16,
    pub pid: u32,
    pub started_at: u64,
}

/// Axum middleware that (a) logs every incoming request for debugging
/// and (b) works around rmcp 0.8.5's strict Accept-header check.
///
/// rmcp 0.8.5 StreamableHttpService returns **HTTP 406 Not Acceptable**
/// unless the request's `Accept` header contains BOTH `application/json`
/// AND `text/event-stream`. Some MCP clients (observed with Claude Code
/// v2.1.114) only send one of the two and get rejected before they can
/// call any tool.
///
/// We rewrite the Accept header to the canonical combination so rmcp
/// always proceeds. rmcp then decides response shape (JSON vs SSE) based
/// on the request; both shapes are MCP-spec compliant.
async fn mcp_request_middleware(
    mut req: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    use axum::http::{header, HeaderValue};
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    let accept_in = req
        .headers()
        .get(header::ACCEPT)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .unwrap_or_default();

    // Always present both media types to rmcp; that's the only combo it accepts.
    req.headers_mut().insert(
        header::ACCEPT,
        HeaderValue::from_static("application/json, text/event-stream"),
    );

    log::info!(
        "[mcp] {} {} accept-in=\"{}\" → \"application/json, text/event-stream\"",
        method,
        path,
        accept_in
    );

    next.run(req).await
}

/// Spawn the MCP server bound to `127.0.0.1:0` (OS-assigned port).
/// Returns the full endpoint info once bound. Server runs in a detached
/// tokio task; caller can drop the returned value (server keeps running
/// for the lifetime of the tokio runtime).
///
/// `self_pane_id` bakes a specific pane identity into THIS server
/// instance: every tool call to it is treated as coming from that pane.
/// Pass `None` for an "anonymous" server (legacy / non-multi-agent),
/// or `Some(pane_id)` to make `whoami()`, `is_self` in `list_panes`,
/// and `[From <id>]` prefixing in `send_to_pane` all work without the
/// LLM needing to guess.
pub async fn spawn(
    app: AppHandle,
    panes: Arc<PaneStore>,
    self_pane_id: Option<String>,
) -> anyhow::Result<McpEndpoint> {
    spawn_with_port(app, panes, self_pane_id, 0).await
}

/// Like `spawn`, but lets the caller request a specific port. Used by
/// the Hyper-Agent global server to keep its URL stable across Coffee-CLI
/// restarts — a stable URL means OpenClaw / Hermes Agent's config-file
/// watchers don't see a change every launch (which would trigger their
/// own gateway restarts and on OpenClaw also fire its mDNS/Ciao
/// "PROBING CANCELLED" unhandled-rejection bug).
///
/// `preferred_port = 0` falls back to OS-assigned (the per-pane sentinel
/// servers want this — they're transient and ephemeral by design).
///
/// If the preferred port is busy we silently fall back to OS-assigned
/// rather than fail; the caller persists whatever port we got.
pub async fn spawn_with_port(
    app: AppHandle,
    panes: Arc<PaneStore>,
    self_pane_id: Option<String>,
    preferred_port: u16,
) -> anyhow::Result<McpEndpoint> {
    let service = StreamableHttpService::new(
        {
            let app = app.clone();
            let panes = panes.clone();
            let pane_id = self_pane_id.clone();
            move || Ok(CoffeeMcp::new(app.clone(), panes.clone(), pane_id.clone()))
        },
        LocalSessionManager::default().into(),
        StreamableHttpServerConfig::default(),
    );

    let router = axum::Router::new()
        .nest_service("/mcp", service)
        .layer(axum::middleware::from_fn(mcp_request_middleware));
    let listener = match preferred_port {
        0 => tokio::net::TcpListener::bind("127.0.0.1:0").await?,
        p => match tokio::net::TcpListener::bind(("127.0.0.1", p)).await {
            Ok(l) => l,
            Err(e) => {
                log::warn!(
                    "[mcp] preferred port {p} unavailable ({e}); falling back to OS-assigned"
                );
                tokio::net::TcpListener::bind("127.0.0.1:0").await?
            }
        },
    };
    let addr = listener.local_addr()?;

    let endpoint = McpEndpoint {
        url: format!("http://{}/mcp", addr),
        port: addr.port(),
        pid: std::process::id(),
        started_at: epoch_seconds(),
    };

    log::info!("coffee-cli mcp server listening at {}", endpoint.url);

    // Persist endpoint for injection scripts.
    write_endpoint_file(&endpoint)?;

    // Detach: server owns the listener and runs until the runtime shuts down.
    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, router).await {
            log::error!("coffee-cli mcp server exited with error: {}", e);
        }
    });

    Ok(endpoint)
}

/// Write the endpoint info to `~/.coffee-cli/mcp-endpoint.json` so CLI
/// injection scripts (v1.0 day 7) can discover it.
fn write_endpoint_file(endpoint: &McpEndpoint) -> anyhow::Result<()> {
    let dir = dirs::home_dir()
        .ok_or_else(|| anyhow::anyhow!("no home dir"))?
        .join(".coffee-cli");
    std::fs::create_dir_all(&dir)?;
    let path = dir.join("mcp-endpoint.json");
    let json = serde_json::to_string_pretty(endpoint)?;
    std::fs::write(&path, json)?;
    log::debug!("wrote mcp endpoint to {}", path.display());
    Ok(())
}

/// Full snapshot of every running MCP server in this Coffee CLI
/// process. Persisted to `~/.coffee-cli/mcp-state.json` on every
/// spawn so the `coffee-cli mcp-status` subcommand can introspect
/// the live state from outside the GUI process — invaluable for
/// support tickets.
#[derive(Clone, Debug, Serialize)]
pub struct McpStateManifest {
    pub pid: u32,
    pub written_at: u64,
    /// Anonymous (no `self_pane_id`) MCP server, only spawned when
    /// non-Claude CLIs need global-config injection. May be absent
    /// in a pure-Claude workspace.
    pub anonymous: Option<McpEndpoint>,
    /// Per-pane MCP servers, one entry per multi-agent Claude pane.
    pub panes: Vec<PaneEndpointEntry>,
}

#[derive(Clone, Debug, Serialize)]
pub struct PaneEndpointEntry {
    pub pane_id: String,
    pub url: String,
    pub port: u16,
    pub started_at: u64,
}

/// Path of the manifest file. Returned even when the home dir lookup
/// fails so callers can show a useful "tried path" diagnostic.
pub fn state_manifest_path() -> std::path::PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join(".coffee-cli")
        .join("mcp-state.json")
}

/// Atomically write the current MCP topology to disk. Caller passes
/// the anonymous endpoint (if any) and the per-pane endpoint map
/// extracted from `AppState`. Best-effort — errors are logged but
/// don't propagate, since a missing manifest just means the
/// `mcp-status` subcommand won't see this run (not a runtime fault).
pub fn write_state_manifest(
    anonymous: Option<&McpEndpoint>,
    panes: &std::collections::HashMap<String, McpEndpoint>,
) {
    let manifest = McpStateManifest {
        pid: std::process::id(),
        written_at: epoch_seconds(),
        anonymous: anonymous.cloned(),
        panes: panes
            .iter()
            .map(|(pane_id, ep)| PaneEndpointEntry {
                pane_id: pane_id.clone(),
                url: ep.url.clone(),
                port: ep.port,
                started_at: ep.started_at,
            })
            .collect(),
    };
    let path = state_manifest_path();
    let body = match serde_json::to_string_pretty(&manifest) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("[mcp] manifest serialize failed: {}", e);
            return;
        }
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Err(e) = std::fs::write(&path, body) {
        log::warn!("[mcp] manifest write to {} failed: {}", path.display(), e);
    }
}
