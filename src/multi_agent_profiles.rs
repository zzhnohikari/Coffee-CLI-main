//! Multi-agent team presets + pane profiles.
//!
//! Stored at `~/.coffee-cli/multi-agent-profiles.json`.
//!
//! Goal: let one multi-agent tab start heterogeneous panes, e.g.
//! Claude lead + Claude-via-DeepSeek worker + Codex reviewer, each
//! with different args / env / prompt / MCP additions.
//!
//! The file is intentionally explicit JSON instead of a large UI-only
//! schema hidden in localStorage: users can back it up, diff it, and
//! edit it by hand if they prefer.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MultiAgentPaneProfile {
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub tool: String,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub extra_args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default)]
    pub prompt_append: String,
    #[serde(default)]
    pub prompt_file_path: String,
    #[serde(default)]
    pub startup_input: String,
    #[serde(default)]
    pub mcp_config_path: String,
    #[serde(default)]
    pub api_key_env_name: String,
    #[serde(default)]
    pub api_base_url_env_name: String,
    #[serde(default)]
    pub api_base_url: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub selected_mcp_ids: Vec<String>,
    #[serde(default)]
    pub skills: Vec<String>,
    #[serde(default)]
    pub notes: String,
    pub sentinel: Option<bool>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MultiAgentTeamPresetPane {
    pub pane_idx: usize,
    pub profile_id: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MultiAgentTeamPreset {
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub layout: String,
    #[serde(default)]
    pub panes: Vec<MultiAgentTeamPresetPane>,
    #[serde(default)]
    pub team_prompt: String,
    #[serde(default)]
    pub notes: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MultiAgentProfilesConfig {
    #[serde(default)]
    pub profiles: HashMap<String, MultiAgentPaneProfile>,
    #[serde(default)]
    pub team_presets: HashMap<String, MultiAgentTeamPreset>,
    #[serde(default)]
    pub deleted_profiles: Vec<String>,
    #[serde(default)]
    pub deleted_team_presets: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PaneLaunchPayload {
    #[serde(default, rename = "__coffeePaneLaunchMode")]
    pub mode: String,
    #[serde(default)]
    pub profile_id: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub extra_args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default)]
    pub prompt_append: String,
    #[serde(default)]
    pub prompt_file_path: String,
    #[serde(default)]
    pub startup_input: String,
    #[serde(default)]
    pub mcp_config_path: String,
    #[serde(default)]
    pub api_key_env_name: String,
    #[serde(default)]
    pub api_base_url_env_name: String,
    #[serde(default)]
    pub api_base_url: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub selected_mcp_ids: Vec<String>,
    #[serde(default)]
    pub skills: Vec<String>,
    #[serde(default)]
    pub team_prompt: String,
}

pub const PANE_LAUNCH_MODE: &str = "profile-v1";

fn config_path() -> Option<PathBuf> {
    Some(
        dirs::home_dir()?
            .join(".coffee-cli")
            .join("multi-agent-profiles.json"),
    )
}

pub fn default_config() -> MultiAgentProfilesConfig {
    let mut profiles = HashMap::new();
    profiles.insert(
        "claude-main".to_string(),
        MultiAgentPaneProfile {
            label: "Claude Main".to_string(),
            tool: "claude".to_string(),
            prompt_append: "You are the lead agent. Plan first, delegate intentionally, verify all returned results, and integrate the final answer.".to_string(),
            skills: vec!["planner".to_string(), "reviewer".to_string()],
            notes: "主控 pane：适合作为 orchestrator。".to_string(),
            sentinel: Some(true),
            api_key_env_name: "".to_string(),
            api_base_url_env_name: "".to_string(),
            api_base_url: "".to_string(),
            model: "".to_string(),
            selected_mcp_ids: vec![],
            ..Default::default()
        },
    );
    profiles.insert(
        "claude-worker".to_string(),
        MultiAgentPaneProfile {
            label: "Claude Worker".to_string(),
            tool: "claude".to_string(),
            prompt_append: "You are a worker agent. Execute the assigned task only, keep scope tight, and return exactly one structured RESULT block plus one DONE marker with concrete evidence.".to_string(),
            skills: vec!["coder".to_string(), "fixer".to_string()],
            notes: "通用执行 worker。".to_string(),
            sentinel: Some(true),
            api_key_env_name: "".to_string(),
            api_base_url_env_name: "".to_string(),
            api_base_url: "".to_string(),
            model: "".to_string(),
            selected_mcp_ids: vec![],
            ..Default::default()
        },
    );
    profiles.insert(
        "codex-worker".to_string(),
        MultiAgentPaneProfile {
            label: "Codex Worker".to_string(),
            tool: "codex".to_string(),
            prompt_append: "You are a worker agent focused on implementation and validation. Return concise structured RESULT blocks and exactly one DONE marker.".to_string(),
            notes: "适合代码实现与修复。".to_string(),
            sentinel: Some(true),
            api_key_env_name: "".to_string(),
            api_base_url_env_name: "".to_string(),
            api_base_url: "".to_string(),
            model: "".to_string(),
            selected_mcp_ids: vec![],
            ..Default::default()
        },
    );
    profiles.insert(
        "gemini-worker".to_string(),
        MultiAgentPaneProfile {
            label: "Gemini Worker".to_string(),
            tool: "gemini".to_string(),
            prompt_append: "You are a worker agent focused on fast research, summarization, and scoped task execution.".to_string(),
            notes: "适合研究、检索与总结。".to_string(),
            sentinel: Some(true),
            api_key_env_name: "".to_string(),
            api_base_url_env_name: "".to_string(),
            api_base_url: "".to_string(),
            model: "".to_string(),
            selected_mcp_ids: vec![],
            ..Default::default()
        },
    );
    profiles.insert(
        "ctf-manager-codex".to_string(),
        MultiAgentPaneProfile {
            label: "CTF Manager (Codex)".to_string(),
            tool: "codex".to_string(),
            prompt_append: "You are the manager for a CTF operation inside Coffee CLI. Break the target into the smallest useful tasks, delegate with coffee-cli MCP send_to_pane, keep scope tight, track evidence, and only accept verified results.".to_string(),
            skills: vec!["recon".to_string(), "targeted-pentest".to_string(), "agent-browser".to_string()],
            notes: "Primary manager profile for ctf-mode.".to_string(),
            sentinel: Some(true),
            api_key_env_name: "".to_string(),
            api_base_url_env_name: "".to_string(),
            api_base_url: "".to_string(),
            model: "".to_string(),
            selected_mcp_ids: vec![],
            ..Default::default()
        },
    );
    profiles.insert(
        "ctf-solver-codex".to_string(),
        MultiAgentPaneProfile {
            label: "CTF Solver (Codex)".to_string(),
            tool: "codex".to_string(),
            prompt_append: "You are a CTF solver. Execute only the assigned task, use local tools, return one concise structured RESULT block with evidence, and finish with the exact DONE marker back to the dispatcher.".to_string(),
            skills: vec!["recon".to_string(), "ffuf-skill".to_string(), "targeted-pentest".to_string()],
            notes: "Codex execution worker for ctf-mode.".to_string(),
            sentinel: Some(true),
            api_key_env_name: "".to_string(),
            api_base_url_env_name: "".to_string(),
            api_base_url: "".to_string(),
            model: "".to_string(),
            selected_mcp_ids: vec![],
            ..Default::default()
        },
    );
    profiles.insert(
        "ctf-solver-claude".to_string(),
        MultiAgentPaneProfile {
            label: "CTF Solver (Claude)".to_string(),
            tool: "claude".to_string(),
            prompt_append: "You are a CTF solver focused on rapid web triage and exploit validation. Stay within the assigned scope, report one concrete structured RESULT block, and end with the exact DONE marker.".to_string(),
            skills: vec!["agent-browser".to_string(), "payload-research".to_string(), "known-product-exploit".to_string()],
            notes: "Claude execution worker for ctf-mode.".to_string(),
            sentinel: Some(true),
            api_key_env_name: "".to_string(),
            api_base_url_env_name: "".to_string(),
            api_base_url: "".to_string(),
            model: "".to_string(),
            selected_mcp_ids: vec![],
            ..Default::default()
        },
    );
    profiles.insert(
        "ctf-observer-gemini".to_string(),
        MultiAgentPaneProfile {
            label: "CTF Observer (Gemini)".to_string(),
            tool: "gemini".to_string(),
            prompt_append: "You are the observer/reviewer for a CTF team. Track tested hypotheses, summarize evidence, catch duplicate work, and suggest the next smallest discriminating step.".to_string(),
            skills: vec!["recon".to_string(), "payload-research".to_string()],
            notes: "Observer profile for ctf-mode.".to_string(),
            sentinel: Some(true),
            api_key_env_name: "".to_string(),
            api_base_url_env_name: "".to_string(),
            api_base_url: "".to_string(),
            model: "".to_string(),
            selected_mcp_ids: vec![],
            ..Default::default()
        },
    );
    profiles.insert(
        "ctf-shell-worker".to_string(),
        MultiAgentPaneProfile {
            label: "CTF Shell Worker".to_string(),
            tool: "shell".to_string(),
            prompt_append: "This pane is a plain shell worker. Use it to host SSH sessions, netcat listeners, reverse shells, and interactive CLI tools. The manager pane should dispatch concrete shell commands into this pane instead of trying to host those sessions inside an AI pane.".to_string(),
            notes: "Plain shell / PowerShell worker for SSH, netcat, reverse shells, and interactive tools in ctf-mode.".to_string(),
            sentinel: Some(false),
            api_key_env_name: "".to_string(),
            api_base_url_env_name: "".to_string(),
            api_base_url: "".to_string(),
            model: "".to_string(),
            selected_mcp_ids: vec![],
            ..Default::default()
        },
    );

    let mut team_presets = HashMap::new();
    team_presets.insert(
        "claude-duo".to_string(),
        MultiAgentTeamPreset {
            label: "Claude Main + Claude Worker".to_string(),
            layout: "two-agent".to_string(),
            panes: vec![
                MultiAgentTeamPresetPane {
                    pane_idx: 1,
                    profile_id: "claude-main".to_string(),
                },
                MultiAgentTeamPresetPane {
                    pane_idx: 2,
                    profile_id: "claude-worker".to_string(),
                },
            ],
            team_prompt:
                "Pane 1 is the orchestrator. Worker panes should execute assigned tasks only and return structured results."
                    .to_string(),
            notes: "默认双人编排模板。".to_string(),
        },
    );
    team_presets.insert(
        "claude-trio".to_string(),
        MultiAgentTeamPreset {
            label: "Claude Main + 2 Workers".to_string(),
            layout: "three-agent".to_string(),
            panes: vec![
                MultiAgentTeamPresetPane {
                    pane_idx: 1,
                    profile_id: "claude-main".to_string(),
                },
                MultiAgentTeamPresetPane {
                    pane_idx: 2,
                    profile_id: "claude-worker".to_string(),
                },
                MultiAgentTeamPresetPane {
                    pane_idx: 3,
                    profile_id: "codex-worker".to_string(),
                },
            ],
            team_prompt:
                "Pane 1 orchestrates. Pane 2 focuses on execution. Pane 3 focuses on code implementation and verification."
                    .to_string(),
            notes: "适合主控 + 执行 + 编码校验。".to_string(),
        },
    );
    team_presets.insert(
        "claude-quad".to_string(),
        MultiAgentTeamPreset {
            label: "Claude Main + 3 Workers".to_string(),
            layout: "multi-agent".to_string(),
            panes: vec![
                MultiAgentTeamPresetPane {
                    pane_idx: 1,
                    profile_id: "claude-main".to_string(),
                },
                MultiAgentTeamPresetPane {
                    pane_idx: 2,
                    profile_id: "claude-worker".to_string(),
                },
                MultiAgentTeamPresetPane {
                    pane_idx: 3,
                    profile_id: "codex-worker".to_string(),
                },
                MultiAgentTeamPresetPane {
                    pane_idx: 4,
                    profile_id: "gemini-worker".to_string(),
                },
            ],
            team_prompt:
                "Pane 1 orchestrates. Pane 2 executes. Pane 3 implements/fixes code. Pane 4 researches and summarizes."
                    .to_string(),
            notes: "默认四人模板。".to_string(),
        },
    );
    team_presets.insert(
        "ctf-trio-shell".to_string(),
        MultiAgentTeamPreset {
            label: "CTF Trio (Manager + Shell + Observer)".to_string(),
            layout: "three-agent".to_string(),
            panes: vec![
                MultiAgentTeamPresetPane { pane_idx: 1, profile_id: "ctf-manager-codex".to_string() },
                MultiAgentTeamPresetPane { pane_idx: 2, profile_id: "ctf-shell-worker".to_string() },
                MultiAgentTeamPresetPane { pane_idx: 3, profile_id: "ctf-observer-gemini".to_string() },
            ],
            team_prompt: "Pane 1 is the AI manager. Pane 2 is a plain shell worker for SSH, netcat, reverse shells, and interactive tools. Pane 3 observes, summarizes, and suggests course corrections.".to_string(),
            notes: "Recommended default preset for interactive shells and reverse-shell workflows.".to_string(),
        },
    );
    team_presets.insert(
        "ctf-trio-codex".to_string(),
        MultiAgentTeamPreset {
            label: "CTF Trio (Codex Lead)".to_string(),
            layout: "three-agent".to_string(),
            panes: vec![
                MultiAgentTeamPresetPane { pane_idx: 1, profile_id: "ctf-manager-codex".to_string() },
                MultiAgentTeamPresetPane { pane_idx: 2, profile_id: "ctf-solver-codex".to_string() },
                MultiAgentTeamPresetPane { pane_idx: 3, profile_id: "ctf-observer-gemini".to_string() },
            ],
            team_prompt: "Pane 1 manages the CTF task. Pane 2 executes local testing. Pane 3 observes, summarizes, and suggests course corrections.".to_string(),
            notes: "Default ctf-mode trio preset.".to_string(),
        },
    );
    team_presets.insert(
        "ctf-quad-shell-hybrid".to_string(),
        MultiAgentTeamPreset {
            label: "CTF Quad (Manager + Shell + Solver + Observer)".to_string(),
            layout: "multi-agent".to_string(),
            panes: vec![
                MultiAgentTeamPresetPane { pane_idx: 1, profile_id: "ctf-manager-codex".to_string() },
                MultiAgentTeamPresetPane { pane_idx: 2, profile_id: "ctf-shell-worker".to_string() },
                MultiAgentTeamPresetPane { pane_idx: 3, profile_id: "ctf-solver-claude".to_string() },
                MultiAgentTeamPresetPane { pane_idx: 4, profile_id: "ctf-observer-gemini".to_string() },
            ],
            team_prompt: "Pane 1 manages the operation. Pane 2 is a shell worker for SSH, reverse shells, and interactive tooling. Pane 3 is an AI solver for scoped web/pentest tasks. Pane 4 observes and summarizes.".to_string(),
            notes: "Hybrid preset that combines a raw shell worker with an AI execution worker.".to_string(),
        },
    );
    team_presets.insert(
        "ctf-quad-hybrid".to_string(),
        MultiAgentTeamPreset {
            label: "CTF Quad (Hybrid)".to_string(),
            layout: "multi-agent".to_string(),
            panes: vec![
                MultiAgentTeamPresetPane { pane_idx: 1, profile_id: "ctf-manager-codex".to_string() },
                MultiAgentTeamPresetPane { pane_idx: 2, profile_id: "ctf-solver-codex".to_string() },
                MultiAgentTeamPresetPane { pane_idx: 3, profile_id: "ctf-solver-claude".to_string() },
                MultiAgentTeamPresetPane { pane_idx: 4, profile_id: "ctf-observer-gemini".to_string() },
            ],
            team_prompt: "Pane 1 manages the CTF operation. Pane 2 and Pane 3 execute local pentest tasks. Pane 4 tracks evidence, duplicate work, and next-step suggestions.".to_string(),
            notes: "Default hybrid ctf-mode preset.".to_string(),
        },
    );

    MultiAgentProfilesConfig {
        profiles,
        team_presets,
        deleted_profiles: Vec::new(),
        deleted_team_presets: Vec::new(),
    }
}

pub fn load() -> MultiAgentProfilesConfig {
    let Some(path) = config_path() else {
        return default_config();
    };
    load_from_path(&path)
}

pub fn save(cfg: &MultiAgentProfilesConfig) -> std::io::Result<()> {
    let Some(path) = config_path() else {
        return Err(std::io::Error::other("no home dir"));
    };
    save_to_path(cfg, &path)
}

fn load_from_path(path: &Path) -> MultiAgentProfilesConfig {
    let Ok(body) = std::fs::read_to_string(path) else {
        return default_config();
    };
    let loaded = serde_json::from_str::<MultiAgentProfilesConfig>(&body)
        .unwrap_or_else(|_| default_config());
    let defaults = default_config();
    let deleted_profiles = loaded.deleted_profiles;
    let deleted_team_presets = loaded.deleted_team_presets;

    let mut merged_profiles = defaults.profiles;
    for key in &deleted_profiles {
        merged_profiles.remove(key);
    }
    for (key, value) in loaded.profiles {
        merged_profiles.insert(key, value);
    }

    let mut merged_presets = defaults.team_presets;
    for key in &deleted_team_presets {
        merged_presets.remove(key);
    }
    for (key, value) in loaded.team_presets {
        merged_presets.insert(key, value);
    }

    MultiAgentProfilesConfig {
        profiles: merged_profiles,
        team_presets: merged_presets,
        deleted_profiles,
        deleted_team_presets,
    }
}

fn save_to_path(cfg: &MultiAgentProfilesConfig, path: &Path) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let body = serde_json::to_string_pretty(cfg)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string()))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

pub fn decode_pane_launch_payload(raw: Option<&str>) -> Option<PaneLaunchPayload> {
    let raw = raw?;
    let payload: PaneLaunchPayload = serde_json::from_str(raw).ok()?;
    if payload.mode == PANE_LAUNCH_MODE {
        Some(payload)
    } else {
        None
    }
}

pub fn prompt_block(payload: &PaneLaunchPayload) -> String {
    let mut sections: Vec<String> = Vec::new();

    if !payload.team_prompt.trim().is_empty() {
        sections.push(format!(
            "## Team preset context\n{}",
            payload.team_prompt.trim()
        ));
    }

    if !payload.skills.is_empty() {
        let body = payload
            .skills
            .iter()
            .map(|s| format!("- {}", s))
            .collect::<Vec<_>>()
            .join("\n");
        sections.push(format!(
            "## Preferred skills\nPrefer these skills / workflows when helpful:\n{}",
            body
        ));
    }

    if !payload.prompt_append.trim().is_empty() {
        sections.push(payload.prompt_append.trim().to_string());
    }

    if !payload.prompt_file_path.trim().is_empty() {
        let path = crate::tool_config::expand_path(payload.prompt_file_path.trim());
        match std::fs::read_to_string(&path) {
            Ok(text) => {
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    sections.push(format!("## Prompt file: {}\n{}", path.display(), trimmed));
                }
            }
            Err(e) => {
                log::warn!(
                    "[multi-agent profiles] could not read prompt file {}: {}",
                    path.display(),
                    e
                );
            }
        }
    }

    sections.join("\n\n")
}

pub fn load_extra_mcp_servers(path_str: &str) -> Map<String, Value> {
    if path_str.trim().is_empty() {
        return Map::new();
    }
    let path = crate::tool_config::expand_path(path_str.trim());
    let Ok(body) = std::fs::read_to_string(&path) else {
        log::warn!(
            "[multi-agent profiles] could not read MCP config file {}",
            path.display()
        );
        return Map::new();
    };
    let Ok(value) = serde_json::from_str::<Value>(&body) else {
        log::warn!(
            "[multi-agent profiles] invalid MCP config JSON {}",
            path.display()
        );
        return Map::new();
    };
    match value {
        Value::Object(mut root) => {
            if let Some(Value::Object(map)) = root.remove("mcpServers") {
                return map;
            }
            if let Some(Value::Object(map)) = root.remove("mcp") {
                return map;
            }
            root
        }
        _ => {
            log::warn!(
                "[multi-agent profiles] MCP config file {} must be a JSON object",
                path.display()
            );
            Map::new()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn load_missing_profile_file_returns_defaults_without_writing() {
        let dir =
            std::env::temp_dir().join(format!("coffee-cli-profile-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("multi-agent-profiles.json");

        let cfg = load_from_path(&path);
        assert!(!cfg.profiles.is_empty());
        assert!(!path.exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_respects_deleted_default_profiles() {
        let dir =
            std::env::temp_dir().join(format!("coffee-cli-profile-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("multi-agent-profiles.json");
        std::fs::write(
            &path,
            r#"{
              "profiles": {},
              "teamPresets": {},
              "deletedProfiles": ["codex-worker"],
              "deletedTeamPresets": ["claude-trio"]
            }"#,
        )
        .expect("write profile fixture");

        let cfg = load_from_path(&path);
        assert!(!cfg.profiles.contains_key("codex-worker"));
        assert!(!cfg.team_presets.contains_key("claude-trio"));
        assert!(cfg.profiles.contains_key("claude-main"));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
