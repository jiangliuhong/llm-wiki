//! Pi Runtime sidecar management.
//!
//! Each workspace root gets one long-lived `node <pi-runtime>/dist/index.js`
//! child process speaking the JSONL protocol over stdio. A dedicated reader
//! thread parses every stdout line: `event` responses are forwarded to the
//! WebView as `pi-event` Tauri events (for streaming), while other responses
//! complete the pending request with the matching id.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{Emitter, Manager};

/// Per-workspace model configuration stored in `<root>/.llm-wiki/config.json`.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ModelConfig {
    pub provider: String,
    pub id: String,
    #[serde(default)]
    pub api_key: Option<String>,
    /// Optional API endpoint override (e.g. Zhipu GLM Coding Plan).
    #[serde(default)]
    pub base_url: Option<String>,
    /// Reasoning effort passed to the runtime when creating sessions
    /// ("off" | "minimal" | "low" | "medium" | "high"); unset defaults to the
    /// runtime's "medium".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_level: Option<String>,
}

struct PiProcess {
    child: Child,
    stdin: std::process::ChildStdin,
    next_id: u64,
}

impl PiProcess {
    fn spawn(root: &str) -> Result<Self, String> {
        let script = resolve_runtime_script()?;
        // Log the absolute path actually loaded so "source changed but the
        // sidecar runs a stale bundle" is diagnosable from dev logs.
        eprintln!(
            "[pi-runtime] loading runtime script: {}",
            script.canonicalize().unwrap_or_else(|_| script.clone()).display()
        );
        let node = resolve_node_binary()?;
        let mut child = Command::new(&node)
            .arg(script)
            .current_dir(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("failed to spawn pi-runtime: {e}"))?;
        let stdin = child.stdin.take().ok_or("pi-runtime stdin unavailable")?;
        let stdout = child.stdout.take().ok_or("pi-runtime stdout unavailable")?;
        if let Some(stderr) = child.stderr.take() {
            // Surface sidecar crashes instead of swallowing them: without this
            // a crashed runtime only manifests as a frontend timeout.
            std::thread::spawn(move || {
                for line in BufReader::new(stderr).lines() {
                    match line {
                        Ok(line) => eprintln!("[pi-runtime] {line}"),
                        Err(_) => break,
                    }
                }
            });
        }
        std::thread::spawn(move || read_responses(stdout));
        Ok(Self { child, stdin, next_id: 0 })
    }

    fn is_alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }
}

impl Drop for PiProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

struct PendingRequest {
    sender: mpsc::Sender<Value>,
}

struct Registry {
    processes: HashMap<String, PiProcess>,
    pending: HashMap<String, PendingRequest>,
}

fn registry() -> &'static Mutex<Registry> {
    static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(Registry { processes: HashMap::new(), pending: HashMap::new() }))
}

/// AppHandle kept outside the registry mutex: `request()` holds the registry
/// lock while spawning the sidecar, and spawn-time path resolution must not
/// try to re-lock it (that deadlock froze the first prompt).
fn app_handle() -> &'static OnceLock<tauri::AppHandle> {
    static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
    &APP
}

/// Remember the AppHandle so the reader thread can emit streaming events.
pub fn set_app(app: tauri::AppHandle) {
    let _ = app_handle().set(app);
}

/// Reads the sidecar's stdout forever. Every response line either completes a
/// pending request (matching id) or — for `event` responses — is emitted to
/// the WebView while the pending prompt request stays registered.
fn read_responses(stdout: std::process::ChildStdout) {
    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else { break };
        let Ok(value) = serde_json::from_str::<Value>(&line) else { continue };
        let Some(id) = value.get("id").and_then(Value::as_str).map(str::to_owned) else { continue };
        let is_event = value.get("type").and_then(Value::as_str) == Some("event");
        // Emit streaming events before touching the registry: `app.emit` does
        // IPC into the WebView and can be slow, so holding the registry lock
        // across it lets stream traffic stall command completion (and vice
        // versa, since `request` takes the same lock while writing).
        if is_event {
            if let Some(app) = app_handle().get() {
                let _ = app.emit("pi-event", &value);
            }
            continue;
        }
        // Prompt requests are routed with the prompt's own id; streaming
        // events reuse that id, so only non-event responses complete it.
        let sender = registry()
            .lock()
            .ok()
            .and_then(|mut guard| guard.pending.remove(&id))
            .map(|pending| pending.sender);
        if let Some(sender) = sender {
            let _ = sender.send(value);
        }
    }
}

/// Sends one JSONL request to the workspace's sidecar, (re)spawning it if
/// needed, and waits for the matching non-event response.
pub fn request(root: &str, mut body: Value, timeout: Duration) -> Result<Value, String> {
    let mut guard = registry().lock().map_err(|_| "pi registry poisoned")?;
    let mut alive = false;
    if let Some(process) = guard.processes.get_mut(root) {
        alive = process.is_alive();
    }
    if !alive {
        let process = PiProcess::spawn(root)?;
        guard.processes.insert(root.to_string(), process);
    }
    let id = {
        let process = guard.processes.get_mut(root).unwrap();
        process.next_id += 1;
        format!("host-{}", process.next_id)
    };
    body["protocolVersion"] = json!("1");
    body["id"] = json!(id.clone());
    let (tx, rx) = mpsc::channel();
    guard.pending.insert(id.clone(), PendingRequest { sender: tx });
    let line = serde_json::to_string(&body).map_err(|e| e.to_string())?;
    let write_result = {
        let process = guard.processes.get_mut(root).unwrap();
        process
            .stdin
            .write_all(format!("{line}\n").as_bytes())
            .and_then(|_| process.stdin.flush())
    };
    drop(guard);
    write_result.map_err(|e| format!("failed to write to pi-runtime: {e}"))?;
    let response = rx
        .recv_timeout(timeout)
        .map_err(|_| "pi-runtime response timed out".to_string());
    if response.is_err() {
        // Reap the pending entry so a timed-out request doesn't leak.
        if let Ok(mut guard) = registry().lock() {
            guard.pending.remove(&id);
        }
    }
    response
}

/// Kills the sidecar for a workspace (used after session deletion / cleanup).
pub fn shutdown(root: &str) {
    if let Ok(mut guard) = registry().lock() {
        guard.processes.remove(root);
    }
}

/// Kills every sidecar (application exit).
pub fn shutdown_all() {
    let roots = {
        match registry().lock() {
            Ok(guard) => guard.processes.keys().cloned().collect::<Vec<String>>(),
            Err(_) => return,
        }
    };
    for root in roots {
        shutdown(&root);
    }
}

/// Resolves the Node.js binary used to run the sidecar. Returns a friendly
/// error when Node is unavailable (packaged builds have no bundled runtime).
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

/// Locates the compiled pi-runtime entry point. Resolution order:
/// `LLM_WIKI_PI_RUNTIME` env var, then (in debug builds) the workspace
/// checkout's freshly built `apps/pi-runtime/dist/index.js` by walking up from
/// the current directory, then the staged/packaged bundle next to the
/// executable or in the Tauri resource dir. Debug prefers the workspace dist
/// so `tauri dev` never picks up a stale staged bundle from an older build;
/// release builds have no workspace checkout and prefer packaged resources.
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
        // Walk up ancestors so src-tauri/, apps/, and repo-root cwds all resolve.
        let mut ancestor = cwd.as_path();
        for _ in 0..6 {
            workspace_candidates.push(ancestor.join("apps/pi-runtime/dist/index.js"));
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
    let mut candidates = vec![PathBuf::from("apps/pi-runtime/dist/index.js")];
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("pi-runtime").join("index.js"));
            candidates.push(dir.join("../pi-runtime").join("index.js"));
        }
    }
    // Packaged builds ship the runtime as a Tauri resource (Contents/Resources
    // on macOS, next to the exe elsewhere).
    if let Some(app) = app_handle().get() {
        if let Ok(resource_dir) = app.path().resource_dir() {
            candidates.push(resource_dir.join("pi-runtime").join("index.js"));
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

/// Dev-only: kills any pi-runtime sidecar processes left over from a previous
/// `tauri dev` session. Sidecars are long-lived node processes; without this a
/// rebuilt runtime keeps serving the old bundle until the stale process dies.
pub fn kill_stale_dev_sidecars() {
    if !cfg!(debug_assertions) {
        return;
    }
    let patterns = ["pi-runtime/dist/index.js", "pi-runtime/pi-runtime.bundle.js", "pi-runtime/index.js"];
    for pattern in patterns {
        // pkill -f matches the full command line (node <path>); the desktop
        // process itself never matches those path suffixes.
        let _ = Command::new("pkill")
            .arg("-f")
            .arg(pattern)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

// --- model config ----------------------------------------------------------

pub fn read_model_config(root: &str) -> Option<ModelConfig> {
    let path = PathBuf::from(root).join(".llm-wiki").join("config.json");
    let raw = std::fs::read_to_string(path).ok()?;
    #[derive(Deserialize)]
    struct FileWithModel {
        #[serde(default)]
        model: Option<ModelConfig>,
    }
    serde_json::from_str::<FileWithModel>(&raw).ok()?.model
}

pub fn write_model_config(root: &str, model: &ModelConfig) -> Result<(), String> {
    let path = PathBuf::from(root).join(".llm-wiki").join("config.json");
    let mut value: Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_else(|| json!({}));
    value["model"] = serde_json::to_value(model).map_err(|e| e.to_string())?;
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(&path, serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}
