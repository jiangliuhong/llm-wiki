//! Pi Agent Runtime supervisor and Host Tool Bridge.
//!
//! One single Node Agent Runtime process is spawned per Desktop application.
//! Bidirectional communication over JSONL stdio:
//! - Host sends requests (session_new, session_list, session_get, session_prompt, etc.)
//! - Runtime dispatches tool_request to Host, which executes Knowledge Core queries
//!   and writes tool_result back to Runtime stdin.
//! - Runtime streams standard AgentEvent envelopes, which Host emits to WebView.
//! - Sensitive credentials (API keys) are stored in system Keychain, never in config files.

use llm_wiki_core::store::{ListFilesOptions, SqliteStore};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{Emitter, Manager};

pub const PROTOCOL_VERSION: &str = "2";

/// Per-workspace model configuration stored in `<root>/.llm-wiki/config.json`.
/// API keys are NOT stored here; they are stored in the system Keychain.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ModelConfig {
    pub provider: String,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    /// Optional API endpoint override (e.g. Zhipu GLM Coding Plan).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    /// Reasoning effort passed to the runtime ("off" | "minimal" | "low" | "medium" | "high").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_level: Option<String>,
}

// --- Keychain Credential Management -----------------------------------------

const KEYCHAIN_SERVICE: &str = "llm-wiki";

pub fn get_keychain_secret(credential_id: &str) -> Option<String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, credential_id).ok()?;
    entry.get_password().ok()
}

pub fn set_keychain_secret(credential_id: &str, secret: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, credential_id)
        .map_err(|e| format!("keychain entry error: {e}"))?;
    entry
        .set_password(secret)
        .map_err(|e| format!("keychain set_password error: {e}"))?;
    Ok(())
}

#[allow(dead_code)]
pub fn delete_keychain_secret(credential_id: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, credential_id)
        .map_err(|e| format!("keychain entry error: {e}"))?;
    let _ = entry.delete_credential();
    Ok(())
}

pub fn read_model_config(root: &str) -> Option<ModelConfig> {
    let path = PathBuf::from(root).join(".llm-wiki").join("config.json");
    let raw = std::fs::read_to_string(path).ok()?;
    #[derive(Deserialize)]
    struct FileWithModel {
        #[serde(default)]
        model: Option<ModelConfig>,
    }
    let mut model = serde_json::from_str::<FileWithModel>(&raw).ok()?.model?;

    // Migration: If plain-text apiKey is found in config.json, migrate to Keychain
    if let Some(ref api_key) = model.api_key {
        if !api_key.trim().is_empty() {
            let cred_id = model
                .credential_id
                .clone()
                .unwrap_or_else(|| format!("llm-wiki:{}:default", model.provider));
            let _ = set_keychain_secret(&cred_id, api_key);
            model.credential_id = Some(cred_id);
            // Write back config without plain text apiKey
            let _ = write_model_config(root, &model);
        }
    }

    // Resolve apiKey from Keychain into in-memory ModelConfig
    if let Some(ref cred_id) = model.credential_id {
        if let Some(secret) = get_keychain_secret(cred_id) {
            model.api_key = Some(secret);
        }
    }

    Some(model)
}

pub fn write_model_config(root: &str, model: &ModelConfig) -> Result<(), String> {
    let path = PathBuf::from(root).join(".llm-wiki").join("config.json");
    let mut value: Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_else(|| json!({}));

    // If an API key was passed in, write it to Keychain
    let mut model_to_persist = model.clone();
    if let Some(ref api_key) = model.api_key {
        let trimmed = api_key.trim();
        if !trimmed.is_empty() {
            let cred_id = model_to_persist
                .credential_id
                .clone()
                .unwrap_or_else(|| format!("llm-wiki:{}:default", model.provider));
            set_keychain_secret(&cred_id, trimmed)?;
            model_to_persist.credential_id = Some(cred_id);
        }
    }

    // NEVER write plain-text apiKey into config.json
    model_to_persist.api_key = None;

    value["model"] = serde_json::to_value(&model_to_persist).map_err(|e| e.to_string())?;
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(&path, serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

// --- Supervisor & Process ---------------------------------------------------

struct PendingRequest {
    sender: mpsc::Sender<Value>,
}

struct SupervisorState {
    child: Child,
    stdin: ChildStdin,
    pending: HashMap<String, PendingRequest>,
}

pub struct AgentSupervisor {
    state: Mutex<Option<SupervisorState>>,
    next_request_id: AtomicU64,
}

impl AgentSupervisor {
    fn new() -> Self {
        Self {
            state: Mutex::new(None),
            next_request_id: AtomicU64::new(0),
        }
    }

    fn ensure_process(&self) -> Result<(), String> {
        let mut guard = self.state.lock().map_err(|_| "supervisor mutex poisoned")?;
        if let Some(ref mut st) = *guard {
            if matches!(st.child.try_wait(), Ok(None)) {
                return Ok(());
            }
        }

        // Spawn new Node Agent Runtime process
        let script = resolve_runtime_script()?;
        eprintln!(
            "[pi-supervisor] spawning agent runtime: {}",
            script.canonicalize().unwrap_or_else(|_| script.clone()).display()
        );
        let node = resolve_node_binary()?;
        let mut child = Command::new(&node)
            .arg(script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("failed to spawn pi-runtime: {e}"))?;

        let stdin = child.stdin.take().ok_or("pi-runtime stdin unavailable")?;
        let stdout = child.stdout.take().ok_or("pi-runtime stdout unavailable")?;
        if let Some(stderr) = child.stderr.take() {
            std::thread::spawn(move || {
                for line in BufReader::new(stderr).lines() {
                    match line {
                        Ok(l) => eprintln!("[pi-runtime stderr] {l}"),
                        Err(_) => break,
                    }
                }
            });
        }

        std::thread::spawn(move || read_stdout_loop(stdout));

        *guard = Some(SupervisorState {
            child,
            stdin,
            pending: HashMap::new(),
        });
        Ok(())
    }

    pub fn write_line(&self, line: &str) -> Result<(), String> {
        let mut guard = self.state.lock().map_err(|_| "supervisor mutex poisoned")?;
        let st = guard.as_mut().ok_or("agent runtime not running")?;
        st.stdin
            .write_all(format!("{line}\n").as_bytes())
            .and_then(|_| st.stdin.flush())
            .map_err(|e| format!("failed to write to runtime stdin: {e}"))
    }

    pub fn request(&self, mut body: Value, timeout: Duration) -> Result<Value, String> {
        self.ensure_process()?;
        let next_id = self.next_request_id.fetch_add(1, Ordering::SeqCst) + 1;
        let id = format!("host-{}", next_id);

        body["protocolVersion"] = json!(PROTOCOL_VERSION);
        body["id"] = json!(id.clone());

        let (tx, rx) = mpsc::channel();
        {
            let mut guard = self.state.lock().map_err(|_| "supervisor mutex poisoned")?;
            if let Some(ref mut st) = *guard {
                st.pending.insert(id.clone(), PendingRequest { sender: tx });
            } else {
                return Err("agent runtime not running".into());
            }
        }

        let line = serde_json::to_string(&body).map_err(|e| e.to_string())?;
        self.write_line(&line)?;

        let res = rx.recv_timeout(timeout).map_err(|_| "agent runtime response timed out".to_string());
        if res.is_err() {
            if let Ok(mut guard) = self.state.lock() {
                if let Some(ref mut st) = *guard {
                    st.pending.remove(&id);
                }
            }
        }
        res
    }

    pub fn complete_pending(&self, id: &str, value: Value) {
        if let Ok(mut guard) = self.state.lock() {
            if let Some(ref mut st) = *guard {
                if let Some(pending) = st.pending.remove(id) {
                    let _ = pending.sender.send(value);
                }
            }
        }
    }

    pub fn shutdown(&self) {
        if let Ok(mut guard) = self.state.lock() {
            if let Some(mut st) = guard.take() {
                let _ = st.child.kill();
                let _ = st.child.wait();
            }
        }
    }
}

pub fn supervisor() -> &'static AgentSupervisor {
    static SUPERVISOR: OnceLock<AgentSupervisor> = OnceLock::new();
    SUPERVISOR.get_or_init(AgentSupervisor::new)
}

fn app_handle() -> &'static OnceLock<tauri::AppHandle> {
    static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
    &APP
}

pub fn set_app(app: tauri::AppHandle) {
    let _ = app_handle().set(app);
}

// --- JSONL Stdout Reader & Tool Bridge --------------------------------------

fn read_stdout_loop(stdout: std::process::ChildStdout) {
    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else { break };
        let Ok(value) = serde_json::from_str::<Value>(&line) else { continue };

        // 1. Tool Requests: Runtime requests Knowledge Core tool execution
        if value.get("type").and_then(Value::as_str) == Some("tool_request") {
            let req = value.clone();
            std::thread::spawn(move || {
                handle_tool_request(req);
            });
            continue;
        }

        // 2. Events: AgentEvent envelope streamed from Runtime
        if value.get("event").is_some() {
            if let Some(app) = app_handle().get() {
                let _ = app.emit("agent-event", &value);
                let _ = app.emit("pi-event", &value);
            }
            continue;
        }

        // 3. Responses: Responses to host requests (matching id)
        if let Some(id) = value.get("id").and_then(Value::as_str).map(str::to_string) {
            supervisor().complete_pending(&id, value);
        }
    }
}

/// Handles Pi tool_request by executing the query against Rust Knowledge Core.
fn handle_tool_request(req: Value) {
    let id = req.get("id").and_then(Value::as_str).unwrap_or("").to_string();
    let tool_call_id = req.get("toolCallId").and_then(Value::as_str).unwrap_or("").to_string();
    let tool = req.get("tool").and_then(Value::as_str).unwrap_or("");
    let workspace_root = req.get("workspaceRoot").and_then(Value::as_str).unwrap_or("");
    let input = req.get("input").cloned().unwrap_or_else(|| json!({}));

    let result = execute_core_tool(workspace_root, tool, &input);

    let response_line = match result {
        Ok(output) => json!({
            "protocolVersion": PROTOCOL_VERSION,
            "id": id,
            "type": "tool_result",
            "toolCallId": tool_call_id,
            "ok": true,
            "output": output
        }),
        Err(err) => json!({
            "protocolVersion": PROTOCOL_VERSION,
            "id": id,
            "type": "tool_result",
            "toolCallId": tool_call_id,
            "ok": false,
            "error": {
                "code": "PI_TOOL_FAILED",
                "message": err
            }
        }),
    };

    if let Ok(line_str) = serde_json::to_string(&response_line) {
        let _ = supervisor().write_line(&line_str);
    }
}

/// Executes a Knowledge Core tool using SqliteStore or WorkspaceManifest.
fn execute_core_tool(workspace_root: &str, tool: &str, input: &Value) -> Result<Value, String> {
    if workspace_root.is_empty() || !Path::new(workspace_root).exists() {
        return Err(format!("Invalid workspace root: '{workspace_root}'"));
    }

    match tool {
        "workspace_get" => {
            let manifest_path = PathBuf::from(workspace_root).join(".llm-wiki").join("workspace.json");
            if let Ok(content) = std::fs::read_to_string(&manifest_path) {
                if let Ok(val) = serde_json::from_str::<Value>(&content) {
                    return Ok(val);
                }
            }
            Ok(json!({ "id": workspace_root, "root": workspace_root, "title": "LLM Wiki" }))
        }

        "workspace_status" => {
            let store = SqliteStore::from_root(workspace_root);
            let stats = store.stats().map_err(|e| e.to_string())?;
            Ok(json!({
                "workspaceRoot": workspace_root,
                "runtime": "pi-runtime-v2",
                "core": "rust",
                "files": stats.files,
                "chunks": stats.chunks,
                "tablesOk": stats.tables_ok
            }))
        }

        "document_list" => {
            let limit = input.get("limit").and_then(Value::as_i64).unwrap_or(50);
            let store = SqliteStore::from_root(workspace_root);
            let page = store
                .list_files(ListFilesOptions {
                    page: Some(1),
                    page_size: Some(limit),
                    q: input.get("q").and_then(Value::as_str).map(str::to_string),
                })
                .map_err(|e| e.to_string())?;
            serde_json::to_value(page.files).map_err(|e| e.to_string())
        }

        "document_search" => {
            let query = input.get("query").and_then(Value::as_str).unwrap_or("").trim();
            if query.is_empty() {
                return Err("query must not be empty".into());
            }
            let limit = input.get("limit").and_then(Value::as_u64).unwrap_or(20) as usize;
            let store = SqliteStore::from_root(workspace_root);
            let hits = store.search(query, Some(limit)).map_err(|e| e.to_string())?;
            serde_json::to_value(hits).map_err(|e| e.to_string())
        }

        "document_read" => {
            let store = SqliteStore::from_root(workspace_root);
            if let Some(file_id) = input.get("fileId").and_then(Value::as_i64) {
                let content = store.file_content(file_id).map_err(|e| e.to_string())?;
                return serde_json::to_value(content).map_err(|e| e.to_string());
            }
            if let Some(path) = input.get("path").and_then(Value::as_str) {
                // Find file_id by path
                let page = store.list_files(ListFilesOptions { page: Some(1), page_size: Some(100), q: Some(path.to_string()) })
                    .map_err(|e| e.to_string())?;
                if let Some(file) = page.files.into_iter().find(|f| f.path == path) {
                    let content = store.file_content(file.id).map_err(|e| e.to_string())?;
                    return serde_json::to_value(content).map_err(|e| e.to_string());
                }
            }
            Err("Document not found for given fileId or path".into())
        }

        "document_read_range" => {
            let store = SqliteStore::from_root(workspace_root);
            let start = input.get("startLine").and_then(Value::as_i64).unwrap_or(1);
            let end = input.get("endLine").and_then(Value::as_i64).unwrap_or(start);

            let file_id = if let Some(id) = input.get("fileId").and_then(Value::as_i64) {
                Some(id)
            } else if let Some(path) = input.get("path").and_then(Value::as_str) {
                let page = store.list_files(ListFilesOptions { page: Some(1), page_size: Some(100), q: Some(path.to_string()) })
                    .map_err(|e| e.to_string())?;
                page.files.into_iter().find(|f| f.path == path).map(|f| f.id)
            } else {
                None
            };

            let Some(file_id) = file_id else {
                return Err("Document not found for given fileId or path".into());
            };

            let content = store.file_content(file_id).map_err(|e| e.to_string())?;
            let Some(doc) = content else {
                return Err("Document content is empty".into());
            };

            let lines: Vec<&str> = doc.content.lines().collect();
            let start_idx = (start.max(1) - 1) as usize;
            let end_idx = (end as usize).min(lines.len());
            let sliced = if start_idx < lines.len() {
                lines[start_idx..end_idx].join("\n")
            } else {
                String::new()
            };

            Ok(json!({
                "fileId": doc.file_id,
                "path": doc.path,
                "language": doc.language,
                "startLine": start,
                "endLine": end,
                "content": sliced
            }))
        }

        "document_relations" => {
            let store = SqliteStore::from_root(workspace_root);
            let all = store.all_relations().map_err(|e| e.to_string())?;
            let file_id = input.get("fileId").and_then(Value::as_i64);
            let path = input.get("path").and_then(Value::as_str);

            let filtered: Vec<_> = all
                .into_iter()
                .filter(|rel| {
                    if let Some(fid) = file_id {
                        rel.source_file_id == fid || rel.target_file_id == fid
                    } else if let Some(p) = path {
                        rel.source_path == p || rel.target_path == p
                    } else {
                        true
                    }
                })
                .collect();
            serde_json::to_value(filtered).map_err(|e| e.to_string())
        }

        "document_neighborhood" => {
            let store = SqliteStore::from_root(workspace_root);
            let all = store.all_relations().map_err(|e| e.to_string())?;
            let depth = input.get("depth").and_then(Value::as_i64).unwrap_or(1).clamp(1, 3);
            let file_id = input.get("fileId").and_then(Value::as_i64);
            let path = input.get("path").and_then(Value::as_str);

            // Breadth-first search for neighborhood
            let mut current_paths: Vec<String> = Vec::new();
            if let Some(p) = path {
                current_paths.push(p.to_string());
            } else if let Some(fid) = file_id {
                if let Ok(Some(file)) = store.file_content(fid) {
                    current_paths.push(file.path);
                }
            }

            let mut visited = std::collections::HashSet::<String>::new();
            for p in &current_paths {
                visited.insert(p.clone());
            }

            let mut edges = Vec::new();
            for level in 1..=depth {
                if current_paths.is_empty() {
                    break;
                }
                let mut next_paths = Vec::new();
                for rel in &all {
                    if current_paths.contains(&rel.source_path) {
                        edges.push(json!({
                            "relationType": rel.relation_type,
                            "sourcePath": rel.source_path,
                            "targetPath": rel.target_path,
                            "depth": level
                        }));
                        if !visited.contains(&rel.target_path) {
                            visited.insert(rel.target_path.clone());
                            next_paths.push(rel.target_path.clone());
                        }
                    } else if current_paths.contains(&rel.target_path) {
                        edges.push(json!({
                            "relationType": rel.relation_type,
                            "sourcePath": rel.source_path,
                            "targetPath": rel.target_path,
                            "depth": level
                        }));
                        if !visited.contains(&rel.source_path) {
                            visited.insert(rel.source_path.clone());
                            next_paths.push(rel.source_path.clone());
                        }
                    }
                }
                current_paths = next_paths;
            }

            Ok(json!({
                "depth": depth,
                "edges": edges,
                "documentCount": visited.len()
            }))
        }

        other => Err(format!("Tool '{other}' is not allowed or supported")),
    }
}

// --- Binary and Script Resolution -------------------------------------------

fn resolve_node_binary() -> Result<PathBuf, String> {
    let candidates = if cfg!(windows) {
        vec!["node.exe", "node"]
    } else {
        vec!["node"]
    };
    for candidate in candidates {
        if Command::new(candidate)
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok()
        {
            return Ok(PathBuf::from(candidate));
        }
    }
    Err("未找到 Node.js，AI 问答功能需要安装 Node.js (>= 22) 后重启应用".into())
}

fn resolve_runtime_script() -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var("LLM_WIKI_PI_RUNTIME") {
        let path = PathBuf::from(path);
        if path.exists() {
            return Ok(path);
        }
    }
    let mut workspace_candidates = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        workspace_candidates.push(cwd.join("apps/pi-runtime/dist/index.js"));
        workspace_candidates.push(cwd.join("apps/pi-runtime/dist/pi-runtime.bundle.js"));
        let mut ancestor = cwd.as_path();
        for _ in 0..6 {
            workspace_candidates.push(ancestor.join("apps/pi-runtime/dist/index.js"));
            workspace_candidates.push(ancestor.join("apps/pi-runtime/dist/pi-runtime.bundle.js"));
            match ancestor.parent() {
                Some(parent) => ancestor = parent,
                None => break,
            }
        }
    }
    if cfg!(debug_assertions) {
        if let Some(found) = workspace_candidates.iter().find(|c| c.exists()) {
            return Ok(found.clone());
        }
    }
    let mut candidates = vec![
        PathBuf::from("apps/pi-runtime/dist/index.js"),
        PathBuf::from("apps/pi-runtime/dist/pi-runtime.bundle.js"),
    ];
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("pi-runtime").join("index.js"));
            candidates.push(dir.join("pi-runtime").join("pi-runtime.bundle.js"));
            candidates.push(dir.join("../pi-runtime").join("index.js"));
        }
    }
    if let Some(app) = app_handle().get() {
        if let Ok(resource_dir) = app.path().resource_dir() {
            candidates.push(resource_dir.join("pi-runtime").join("index.js"));
            candidates.push(resource_dir.join("pi-runtime").join("pi-runtime.bundle.js"));
        }
    }
    candidates.extend(workspace_candidates);
    candidates
        .into_iter()
        .find(|candidate| candidate.exists())
        .ok_or_else(|| {
            "pi-runtime not found; set LLM_WIKI_PI_RUNTIME to apps/pi-runtime/dist/index.js".into()
        })
}

pub fn kill_stale_dev_sidecars() {
    if !cfg!(debug_assertions) {
        return;
    }
    let patterns = [
        "pi-runtime/dist/index.js",
        "pi-runtime/dist/pi-runtime.bundle.js",
        "pi-runtime/index.js",
    ];
    for pattern in patterns {
        let _ = Command::new("pkill")
            .arg("-f")
            .arg(pattern)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}
