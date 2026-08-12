use llm_wiki_core::WorkspaceManifest;
use serde::Serialize;
use std::env;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceInfo {
    id: String,
    title: String,
    root: PathBuf,
    resolved_by: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CoreStatus {
    runtime: String,
    storage: String,
    index: String,
    graph: String,
}

#[tauri::command]
fn workspace_current() -> WorkspaceInfo {
    let configured_root = env::var_os("LLM_WIKI_WORKSPACE_ROOT").map(PathBuf::from);
    let cwd = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let start = configured_root.as_deref().unwrap_or(&cwd);
    if let Ok((root, manifest)) = WorkspaceManifest::discover_from(start) {
        return WorkspaceInfo {
            id: manifest.id,
            title: manifest.title,
            root,
            resolved_by: if configured_root.is_some() { "env".into() } else { "cwd".into() },
        };
    }
    WorkspaceInfo {
        id: "local-default".into(),
        title: "LLM Wiki".into(),
        root: configured_root.unwrap_or(cwd),
        resolved_by: "default".into(),
    }
}

#[tauri::command]
fn workspace_open(root: String) -> Result<WorkspaceInfo, String> {
    let requested = root.trim();
    if requested.is_empty() {
        return Err("workspace path is empty".into());
    }
    let (resolved_root, manifest) = WorkspaceManifest::discover_from(PathBuf::from(requested))
        .map_err(|error| error.to_string())?;
    Ok(WorkspaceInfo {
        id: manifest.id,
        title: manifest.title,
        root: resolved_root,
        resolved_by: "manual".into(),
    })
}

#[tauri::command]
fn workspace_create(title: String, root: String) -> Result<WorkspaceInfo, String> {
    let title = title.trim();
    let requested = root.trim();
    if title.is_empty() || requested.is_empty() {
        return Err("workspace title and path are required".into());
    }
    let root_path = PathBuf::from(requested);
    fs::create_dir_all(root_path.join(".llm-wiki"))
        .map_err(|error| format!("failed to create workspace directory: {error}"))?;
    let resolved_root = root_path
        .canonicalize()
        .map_err(|error| format!("failed to resolve workspace directory: {error}"))?;
    let manifest_path = resolved_root.join(".llm-wiki").join("workspace.json");
    if manifest_path.exists() {
        return Err("workspace manifest already exists; use 打开工作区".into());
    }
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_secs();
    let manifest = WorkspaceManifest {
        version: llm_wiki_core::WORKSPACE_MANIFEST_VERSION,
        id: format!("workspace-{timestamp}-{}", std::process::id()),
        title: title.to_owned(),
        root: resolved_root.to_string_lossy().into_owned(),
        created_at: timestamp.to_string(),
    };
    let bytes = serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?;
    fs::write(&manifest_path, bytes).map_err(|error| format!("failed to write workspace manifest: {error}"))?;
    Ok(WorkspaceInfo {
        id: manifest.id,
        title: manifest.title,
        root: resolved_root,
        resolved_by: "created".into(),
    })
}

#[tauri::command]
fn workspace_status() -> CoreStatus {
    CoreStatus { runtime: "rust".into(), storage: "sqlite-adapter-pending".into(), index: "ready-or-unindexed".into(), graph: "core-contract-ready".into() }
}

#[tauri::command]
fn document_search(_query: String) -> Result<serde_json::Value, String> {
    Err("CORE_SEARCH_NOT_CONFIGURED: SQLite/FTS adapter is the next Rust milestone".into())
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![workspace_current, workspace_open, workspace_create, workspace_status, document_search])
        .run(tauri::generate_context!())
        .expect("error while running LLM Wiki Desktop");
}
