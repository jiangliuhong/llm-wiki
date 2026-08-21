mod extractor;
mod pi;

use llm_wiki_core::indexer::{index_files, IndexRunOptions, KbConfig};
use llm_wiki_core::store::{ListFilesOptions, SqliteStore};
use llm_wiki_core::WorkspaceManifest;
use serde::{Deserialize, Serialize};
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
fn workspace_rename(root: String, title: String) -> Result<WorkspaceInfo, String> {
    let requested = root.trim();
    let new_title = title.trim();
    if requested.is_empty() || new_title.is_empty() {
        return Err("工作区路径和名称不能为空".into());
    }
    let root_path = PathBuf::from(requested);
    let resolved_root = root_path
        .canonicalize()
        .map_err(|error| format!("failed to resolve workspace directory: {error}"))?;
    let manifest_path = resolved_root.join(".llm-wiki").join("workspace.json");
    if !manifest_path.is_file() {
        return Err("工作区配置文件不存在".into());
    }
    let bytes = fs::read(&manifest_path)
        .map_err(|error| format!("failed to read workspace manifest: {error}"))?;
    let mut manifest: WorkspaceManifest = serde_json::from_slice(&bytes)
        .map_err(|error| format!("failed to parse workspace manifest: {error}"))?;
    manifest.title = new_title.to_string();
    let updated_bytes = serde_json::to_vec_pretty(&manifest)
        .map_err(|error| error.to_string())?;
    fs::write(&manifest_path, updated_bytes)
        .map_err(|error| format!("failed to write workspace manifest: {error}"))?;
    Ok(WorkspaceInfo {
        id: manifest.id,
        title: manifest.title,
        root: resolved_root,
        resolved_by: "renamed".into(),
    })
}

#[tauri::command]
fn workspace_delete(root: String, purge: bool) -> Result<PathBuf, String> {
    let requested = root.trim();
    if requested.is_empty() {
        return Err("workspace path is empty".into());
    }
    if !purge {
        // Metadata-only removal is handled entirely on the frontend
        // (the desktop app keeps its recent list in localStorage); there is
        // no on-disk registry to touch here.
        return Ok(PathBuf::from(requested));
    }
    let root_path = PathBuf::from(requested);
    let resolved_root = root_path
        .canonicalize()
        .map_err(|error| format!("failed to resolve workspace directory: {error}"))?;
    let metadata_dir = resolved_root.join(".llm-wiki");
    let manifest_path = metadata_dir.join("workspace.json");
    if !manifest_path.is_file() {
        return Err(format!(
            "该目录下没有找到工作区（缺少 {}）；未删除任何文件。如只想移除列表记录，请使用「移除记录」。",
            metadata_dir.display()
        ));
    }
    // Safety: only ever remove the `.llm-wiki` metadata directory. We never
    // touch the workspace root itself or the `wiki/` document directory.
    fs::remove_dir_all(&metadata_dir)
        .map_err(|error| format!("failed to remove workspace metadata: {error}"))?;
    Ok(resolved_root)
}

#[tauri::command]
fn workspace_status(root: Option<String>) -> CoreStatus {
    // If we have a workspace root, report real storage/index status.
    if let Some(root) = root {
        let store = SqliteStore::from_root(&root);
        if let Ok(stats) = store.stats() {
            let storage = if stats.tables_ok { "sqlite-wal".into() } else { "unindexed".into() };
            let index = if stats.files > 0 {
                format!("{} files · {} chunks", stats.files, stats.chunks)
            } else {
                "empty".into()
            };
            let graph = if stats.files > 0 { "ready".into() } else { "no-data".into() };
            return CoreStatus { runtime: "rust".into(), storage, index, graph };
        }
    }
    CoreStatus { runtime: "rust".into(), storage: "unindexed".into(), index: "empty".into(), graph: "no-data".into() }
}

// --- Read-only knowledge-base commands -------------------------------------
//
// Each command resolves a `SqliteStore` from the workspace root and runs a
// single short-lived read-only query against `<root>/.llm-wiki/index.db`.
// The DB is written by the CLI (`llm-wiki index`); the desktop app only reads
// it here. A missing DB or missing tables yield well-formed empty results so
// the UI can show a "not yet indexed" state instead of erroring.

#[tauri::command]
fn documents_list(
    root: String,
    page: Option<i64>,
    page_size: Option<i64>,
    q: Option<String>,
) -> Result<llm_wiki_core::store::KbFileListPage, String> {
    let store = SqliteStore::from_root(&root);
    store
        .list_files(ListFilesOptions {
            page,
            page_size: page_size.or(Some(1000)),
            q,
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn document_read(
    root: String,
    file_id: i64,
) -> Result<Option<llm_wiki_core::store::KbFileContent>, String> {
    let store = SqliteStore::from_root(&root);
    store.file_content(file_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn relations_list(
    root: String,
    status: Option<String>,
) -> Result<RelationsPayload, String> {
    let store = SqliteStore::from_root(&root);
    let proposals = store
        .relation_proposals(status.as_deref())
        .map_err(|e| e.to_string())?;
    let published = store.all_relations().map_err(|e| e.to_string())?;
    Ok(RelationsPayload { proposals, published })
}

#[tauri::command]
fn relation_proposal_create(
    root: String,
    input: llm_wiki_core::store::RelationProposalCreateInput,
) -> Result<llm_wiki_core::store::RelationProposal, String> {
    let store = SqliteStore::from_root(&root);
    store.create_relation_proposal(&input).map_err(|e| e.to_string())
}

#[tauri::command]
fn relation_proposal_approve(
    root: String,
    id: i64,
) -> Result<llm_wiki_core::store::RelationProposal, String> {
    let store = SqliteStore::from_root(&root);
    store.approve_relation_proposal(id).map_err(|e| e.to_string())
}

#[tauri::command]
fn relation_proposal_reject(
    root: String,
    id: i64,
) -> Result<llm_wiki_core::store::RelationProposal, String> {
    let store = SqliteStore::from_root(&root);
    store.reject_relation_proposal(id).map_err(|e| e.to_string())
}

#[tauri::command]
fn relation_proposal_delete(
    root: String,
    id: i64,
) -> Result<(), String> {
    let store = SqliteStore::from_root(&root);
    store.delete_relation_proposal(id).map_err(|e| e.to_string())
}

/// Bundles the two relation surfaces the graph view needs in one round-trip:
/// pending agent proposals (for review) and published (approved) edges.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RelationsPayload {
    proposals: Vec<llm_wiki_core::store::RelationProposal>,
    published: Vec<llm_wiki_core::store::DocumentRelation>,
}

#[tauri::command]
fn kb_stats(root: String) -> Result<llm_wiki_core::store::KbStats, String> {
    let store = SqliteStore::from_root(&root);
    store.stats().map_err(|e| e.to_string())
}

/// Runs an FTS5 full-text search against the workspace index. Returns ranked
/// hits with content snippets. This is the local retrieval path used by the
/// ChatView when no Pi LLM is connected.
#[tauri::command]
fn document_search(
    root: String,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<llm_wiki_core::store::SearchHit>, String> {
    let store = SqliteStore::from_root(&root);
    store.search(&query, limit).map_err(|e| e.to_string())
}

/// Per-workspace KB config, persisted at `<root>/.llm-wiki/config.json`.
/// Only the fields the desktop UI manages are stored; everything else falls
/// back to `KbConfig::default()` when indexing.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct KbConfigFile {
    #[serde(default)]
    include: Option<Vec<String>>,
    #[serde(default)]
    exclude: Option<Vec<String>>,
    #[serde(default)]
    model: Option<pi::ModelConfig>,
}

fn kb_config_path(root: &str) -> PathBuf {
    PathBuf::from(root).join(".llm-wiki").join("config.json")
}

fn read_kb_config(root: &str) -> KbConfigFile {
    match fs::read_to_string(kb_config_path(root)) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => KbConfigFile::default(),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct KbConfigInfo {
    include: Vec<String>,
    exclude: Vec<String>,
    defaults: Vec<String>,
    default_exclude: Vec<String>,
}

/// Returns the workspace's configured index and exclude rules, falling back to
/// built-in defaults when no config file exists.
#[tauri::command]
fn kb_config_get(root: String) -> Result<KbConfigInfo, String> {
    let default_cfg = KbConfig::default();
    let stored = read_kb_config(&root);
    let include = stored.include.filter(|v| !v.is_empty()).unwrap_or_else(|| default_cfg.include.clone());
    let exclude = stored.exclude.filter(|v| !v.is_empty()).unwrap_or_else(|| default_cfg.exclude.clone());
    Ok(KbConfigInfo {
        include,
        exclude,
        defaults: default_cfg.include,
        default_exclude: default_cfg.exclude,
    })
}

/// Persists the workspace's index directories. Each entry must be a non-empty,
/// workspace-relative directory path; duplicates are dropped.
#[tauri::command]
fn kb_config_set_include(root: String, include: Vec<String>) -> Result<KbConfigInfo, String> {
    let mut cleaned: Vec<String> = Vec::new();
    for entry in include {
        let trimmed = entry.trim().trim_start_matches('/').trim_end_matches('/').to_string();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.contains("..") || trimmed.contains('\\') {
            return Err(format!("invalid index directory: '{trimmed}' (must be workspace-relative)"));
        }
        if !cleaned.iter().any(|v| v == &trimmed) {
            cleaned.push(trimmed);
        }
    }
    if cleaned.is_empty() {
        return Err("至少需要一个索引目录".into());
    }
    let path = kb_config_path(&root);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("failed to create .llm-wiki directory: {e}"))?;
    }
    // Read-modify-write so sibling keys (e.g. the Pi model config) survive.
    let mut value: serde_json::Value = fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    value["include"] = serde_json::to_value(&cleaned).map_err(|e| e.to_string())?;
    let raw = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
    fs::write(&path, raw).map_err(|e| format!("failed to write config: {e}"))?;
    kb_config_get(root)
}

/// Persists the workspace's ignore / exclude list. Entries can be filenames,
/// directory names, relative paths or wildcard patterns (e.g. AGENTS.md, *.log).
#[tauri::command]
fn kb_config_set_exclude(root: String, exclude: Vec<String>) -> Result<KbConfigInfo, String> {
    let mut cleaned: Vec<String> = Vec::new();
    for entry in exclude {
        let trimmed = entry.trim().trim_start_matches('/').to_string();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.contains("..") || trimmed.contains('\\') {
            return Err(format!("invalid ignore rule: '{trimmed}'"));
        }
        if !cleaned.iter().any(|v| v == &trimmed) {
            cleaned.push(trimmed);
        }
    }
    let path = kb_config_path(&root);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("failed to create .llm-wiki directory: {e}"))?;
    }
    let mut value: serde_json::Value = fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    value["exclude"] = serde_json::to_value(&cleaned).map_err(|e| e.to_string())?;
    let raw = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
    fs::write(&path, raw).map_err(|e| format!("failed to write config: {e}"))?;
    kb_config_get(root)
}

/// Triggers an incremental index pass on the workspace using the Rust indexer.
/// This is the desktop's native alternative to running `llm-wiki index` in a
/// terminal. Phase A: FTS-only (no vector embeddings). Index directories come
/// from `<root>/.llm-wiki/config.json` when present, otherwise the defaults.
#[tauri::command]
fn index_run(root: String, reset: Option<bool>) -> Result<llm_wiki_core::indexer::IndexStats, String> {
    let mut config = KbConfig::default();
    let stored = read_kb_config(&root);
    if let Some(include) = stored.include.filter(|v| !v.is_empty()) {
        config.include = include;
    }
    if let Some(exclude) = stored.exclude.filter(|v| !v.is_empty()) {
        config.exclude = exclude;
    }
    let options = IndexRunOptions {
        project_root: PathBuf::from(&root),
        db_path: None,
        config,
        reset: reset.unwrap_or(false),
        source_revision: None,
        source_branch: None,
        on_progress: None,
    };
    index_files(options).map_err(|e| e.to_string())
}

// --- Draft lifecycle commands ----------------------------------------------
//
// Drafts (待确认草稿) are staged content awaiting user confirmation before
// being written to wiki/. The lifecycle is: create → list/get → apply (or
// reject). Apply follows architecture-v1.md §8.6 (expectedHash validation,
// backup, atomic rename). These commands use read-write connections on the
// same `<root>/.llm-wiki/index.db` the indexer writes.

#[tauri::command]
fn draft_list(root: String, status: Option<String>) -> Result<Vec<llm_wiki_core::store::Draft>, String> {
    let store = SqliteStore::from_root(&root);
    store.list_drafts(status.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
fn draft_get(root: String, draft_id: String) -> Result<Option<llm_wiki_core::store::Draft>, String> {
    let store = SqliteStore::from_root(&root);
    store.get_draft(&draft_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn draft_create(
    root: String,
    workspace_id: String,
    target_path: String,
    operation_type: String,
    base_document_hash: Option<String>,
    generated_content: String,
    source_citations: Option<Vec<String>>,
    section_slug: Option<String>,
    created_by: Option<String>,
) -> Result<llm_wiki_core::store::Draft, String> {
    let store = SqliteStore::from_root(&root);
    let input = llm_wiki_core::store::DraftCreateInput {
        workspace_id,
        target_path,
        operation_type,
        base_document_hash: base_document_hash.unwrap_or_default(),
        generated_content,
        source_citations: source_citations.unwrap_or_default(),
        section_slug: section_slug.unwrap_or_default(),
        created_by: created_by.unwrap_or_else(|| "desktop".into()),
    };
    store.create_draft(&input).map_err(|e| e.to_string())
}

#[tauri::command]
fn draft_apply(root: String, draft_id: String) -> Result<llm_wiki_core::store::DraftApplyResult, String> {
    let store = SqliteStore::from_root(&root);
    store.apply_draft(&draft_id, &root, "desktop").map_err(|e| e.to_string())
}

#[tauri::command]
fn draft_reject(root: String, draft_id: String) -> Result<llm_wiki_core::store::Draft, String> {
    let store = SqliteStore::from_root(&root);
    store.reject_draft(&draft_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn draft_delete(root: String, draft_id: String) -> Result<bool, String> {
    let store = SqliteStore::from_root(&root);
    store.delete_draft(&draft_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn draft_delete_by_status(root: String, status: String) -> Result<usize, String> {
    let store = SqliteStore::from_root(&root);
    store.delete_drafts_by_status(&status).map_err(|e| e.to_string())
}

// --- File import (MVP: copy to attachments/ + optional draft creation) -----
//
// Per architecture-v1.md §10.1: select file → save to attachments/ → (text
// only) create a draft for user to confirm target path in wiki/ → apply draft
// → re-index. Binary extraction (PDF/DOCX) is deferred.

/// A copied attachment file.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AttachmentInfo {
    name: String,
    size: i64,
    /// True if the file is likely text (readable as UTF-8).
    is_text: bool,
    /// True if the file is PDF/DOCX and text can be extracted.
    is_extractable: bool,
}

/// Copies an external file into `<workspace>/attachments/`, preserving the
/// original filename. Returns the attachment info including whether it's text.
#[tauri::command]
fn import_file(root: String, source_path: String) -> Result<AttachmentInfo, String> {
    let source = PathBuf::from(&source_path);
    let file_name = source
        .file_name()
        .ok_or_else(|| "source path has no file name".to_string())?
        .to_string_lossy()
        .into_owned();

    let attachments_dir = PathBuf::from(&root).join("attachments");
    fs::create_dir_all(&attachments_dir).map_err(|e| format!("cannot create attachments dir: {e}"))?;

    let dest = attachments_dir.join(&file_name);
    fs::copy(&source, &dest).map_err(|e| format!("copy failed: {e}"))?;

    let metadata = fs::metadata(&dest).map_err(|e| format!("stat failed: {e}"))?;
    let is_text = fs::read_to_string(&dest).is_ok();
    let is_extractable = extractor::is_extractable(&dest);

    Ok(AttachmentInfo {
        name: file_name,
        size: metadata.len() as i64,
        is_text,
        is_extractable,
    })
}

/// Lists files in `<workspace>/attachments/`.
#[tauri::command]
fn attachments_list(root: String) -> Result<Vec<AttachmentInfo>, String> {
    let dir = PathBuf::from(&root).join("attachments");
    if !dir.is_dir() {
        return Ok(vec![]);
    }
    let mut result = Vec::new();
    let entries = fs::read_dir(&dir).map_err(|e| format!("cannot read attachments: {e}"))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("dir entry error: {e}"))?;
        let file_type = entry.file_type().map_err(|e| format!("file type error: {e}"))?;
        if !file_type.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let metadata = entry.metadata().map_err(|e| format!("metadata error: {e}"))?;
        let path = entry.path();
        let is_text = fs::read_to_string(&path).is_ok();
        let is_extractable = extractor::is_extractable(&path);
        result.push(AttachmentInfo {
            name,
            size: metadata.len() as i64,
            is_text,
            is_extractable,
        });
    }
    result.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(result)
}

/// Reads an attachment's text content (for text files only). Returns an error
/// for binary files.
#[tauri::command]
fn attachment_read(root: String, name: String) -> Result<String, String> {
    let path = PathBuf::from(&root).join("attachments").join(&name);
    fs::read_to_string(&path).map_err(|e| format!("cannot read attachment '{name}': {e}"))
}

/// Extracts text from a PDF or DOCX attachment. Returns an error for
/// unsupported formats or extraction failures.
#[tauri::command]
fn attachment_extract(root: String, name: String) -> Result<String, String> {
    let path = PathBuf::from(&root).join("attachments").join(&name);
    extractor::extract_text(&path)
}

// --- Pi sidecar commands ----------------------------------------------------

/// Returns the workspace's configured Pi model, if any.
#[tauri::command]
fn pi_config_get(root: String) -> Result<Option<pi::ModelConfig>, String> {
    Ok(pi::read_model_config(&root))
}

/// Persists the Pi model configuration (provider / model id / optional API
/// key) into `<root>/.llm-wiki/config.json` with API key stored in Keychain.
#[tauri::command]
fn pi_config_set(root: String, model: pi::ModelConfig) -> Result<pi::ModelConfig, String> {
    pi::write_model_config(&root, &model)?;
    Ok(model)
}

/// Lists available and authenticated models from Pi runtime.
#[tauri::command]
async fn pi_models_list() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let response = pi::supervisor().request(
            serde_json::json!({
                "type": "models_list",
            }),
            std::time::Duration::from_secs(15),
        );
        check_ok(response, "获取 Pi 可用模型列表失败")
    })
    .await
    .map_err(|e| format!("Pi 后台任务异常：{e}"))?
}

/// Starts a new Pi chat session for the workspace.
/// Starts a new Pi chat session for the workspace.
/// If workspace has no explicit model override, passes empty model so Pi Runtime
/// automatically inherits Pi CLI's global credentials and default model.
#[tauri::command]
async fn pi_session_new(
    root: String,
    title: Option<String>,
    model: Option<pi::ModelConfig>,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let effective_model = model.or_else(|| {
            pi::read_model_config(&root)
                .filter(|m| !m.provider.is_empty() && !m.id.is_empty())
        });
        let model_value = match effective_model {
            Some(ref m) => serde_json::to_value(m).map_err(|e| e.to_string())?,
            None => serde_json::json!({ "provider": "", "id": "" }),
        };
        let mut body = serde_json::json!({
            "type": "session_new",
            "workspaceId": root,
            "workspaceRoot": root,
            "model": model_value,
        });
        if let Some(ref t) = title {
            body["title"] = serde_json::json!(t);
        }
        let response = pi::supervisor().request(body, std::time::Duration::from_secs(30))?;
        if response.get("ok").and_then(serde_json::Value::as_bool) == Some(true) {
            if let Some(summary) = response.get("output") {
                if let Some(sid) = summary.get("sessionId").and_then(serde_json::Value::as_str) {
                    let store = SqliteStore::from_root(&root);
                    let now = now_iso();
                    let title_str = summary.get("title").and_then(serde_json::Value::as_str).unwrap_or(title.as_deref().unwrap_or("新对话"));
                    let model_provider = summary.pointer("/model/provider").and_then(serde_json::Value::as_str).unwrap_or("pi-global");
                    let model_id = summary.pointer("/model/id").and_then(serde_json::Value::as_str).unwrap_or("default");
                    let _ = store.upsert_chat_session(&llm_wiki_core::store::ChatSessionRecord {
                        id: sid.to_string(),
                        workspace_id: root.clone(),
                        title: title_str.to_string(),
                        model_provider: model_provider.to_string(),
                        model_id: model_id.to_string(),
                        created_at: now.clone(),
                        updated_at: now,
                        archived: false,
                        pinned: false,
                    });
                }
            }
            Ok(response)
        } else {
            Err(extract_error_message(&response, "创建 Pi 会话失败"))
        }
    })
    .await
    .map_err(|e| format!("Pi 后台任务异常：{e}"))?
}

/// Lists chat sessions for the given workspace from SQLite metadata.
#[tauri::command]
fn pi_session_list(root: String) -> Result<Vec<llm_wiki_core::store::ChatSessionRecord>, String> {
    let store = SqliteStore::from_root(&root);
    store.list_chat_sessions(Some(&root)).map_err(|e| e.to_string())
}

/// Gets a Pi session snapshot (including message history) from the agent runtime.
#[tauri::command]
async fn pi_session_get(root: String, session_id: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let body = serde_json::json!({
            "type": "session_get",
            "sessionId": session_id,
            "workspaceRoot": root,
        });
        let response = pi::supervisor().request(body, std::time::Duration::from_secs(30));
        check_ok(response, "获取 Pi 会话快照失败")
    })
    .await
    .map_err(|e| format!("Pi 后台任务异常：{e}"))?
}

/// Sends a prompt to an existing session.
#[tauri::command]
async fn pi_prompt(
    root: String,
    session_id: String,
    text: String,
    model: Option<pi::ModelConfig>,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut body = serde_json::json!({
            "type": "session_prompt",
            "sessionId": session_id,
            "workspaceRoot": root,
            "text": text,
        });
        if let Some(ref m) = model {
            if let Ok(val) = serde_json::to_value(m) {
                body["model"] = val;
            }
        } else if let Some(workspace_model) = pi::read_model_config(&root) {
            if let Some(model_value) = serde_json::to_value(&workspace_model).ok() {
                body["model"] = model_value;
            }
        }
        let response = pi::supervisor().request(body, std::time::Duration::from_secs(300));
        let outcome = check_ok(response, "Pi 问答失败")?;

        // Update session's updated_at in SQLite
        let store = SqliteStore::from_root(&root);
        if let Ok(Some(mut session)) = store.get_chat_session(&session_id) {
            session.updated_at = now_iso();
            if let Some(ref m) = model {
                if !m.provider.is_empty() {
                    session.model_provider = m.provider.clone();
                }
                if !m.id.is_empty() {
                    session.model_id = m.id.clone();
                }
            }
            let _ = store.upsert_chat_session(&session);
        }

        Ok(outcome)
    })
    .await
    .map_err(|e| format!("Pi 后台任务异常：{e}"))?
}

/// Deletes a Pi session in SQLite metadata and runtime JSONL storage.
#[tauri::command]
async fn pi_session_delete(root: String, session_id: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = SqliteStore::from_root(&root);
        let _ = store.delete_chat_session(&session_id);

        let response = pi::supervisor().request(
            serde_json::json!({
                "type": "session_delete",
                "sessionId": session_id,
                "workspaceRoot": root,
            }),
            std::time::Duration::from_secs(30),
        );
        check_ok(response, "删除 Pi 会话失败")
    })
    .await
    .map_err(|e| format!("Pi 后台任务异常：{e}"))?
}

/// Aborts an in-flight prompt on the given session.
#[tauri::command]
async fn pi_session_cancel(session_id: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let response = pi::supervisor().request(
            serde_json::json!({ "type": "session_cancel", "sessionId": session_id }),
            std::time::Duration::from_secs(30),
        );
        check_ok(response, "取消 Pi 会话失败")
    })
    .await
    .map_err(|e| format!("Pi 后台任务异常：{e}"))?
}

/// Compacts a Pi session.
#[tauri::command]
async fn pi_session_compact(root: String, session_id: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let response = pi::supervisor().request(
            serde_json::json!({
                "type": "session_compact",
                "sessionId": session_id,
                "workspaceRoot": root,
            }),
            std::time::Duration::from_secs(60),
        );
        check_ok(response, "压缩 Pi 会话失败")
    })
    .await
    .map_err(|e| format!("Pi 后台任务异常：{e}"))?
}

/// Forks an existing Pi session.
#[tauri::command]
async fn pi_session_fork(root: String, session_id: String, title: Option<String>) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut body = serde_json::json!({
            "type": "session_fork",
            "sessionId": session_id,
            "workspaceRoot": root,
        });
        if let Some(ref t) = title {
            body["title"] = serde_json::json!(t);
        }
        let response = pi::supervisor().request(body, std::time::Duration::from_secs(30))?;
        if response.get("ok").and_then(serde_json::Value::as_bool) == Some(true) {
            if let Some(summary) = response.get("output") {
                if let Some(forked_id) = summary.get("sessionId").and_then(serde_json::Value::as_str) {
                    let store = SqliteStore::from_root(&root);
                    let now = now_iso();
                    let title_str = summary.get("title").and_then(serde_json::Value::as_str).unwrap_or(title.as_deref().unwrap_or("分叉会话"));
                    let model_provider = summary.pointer("/model/provider").and_then(serde_json::Value::as_str).unwrap_or("anthropic");
                    let model_id = summary.pointer("/model/id").and_then(serde_json::Value::as_str).unwrap_or("claude-sonnet-4-5");
                    let _ = store.upsert_chat_session(&llm_wiki_core::store::ChatSessionRecord {
                        id: forked_id.to_string(),
                        workspace_id: root.clone(),
                        title: title_str.to_string(),
                        model_provider: model_provider.to_string(),
                        model_id: model_id.to_string(),
                        created_at: now.clone(),
                        updated_at: now,
                        archived: false,
                        pinned: false,
                    });
                }
            }
            Ok(response)
        } else {
            Err(extract_error_message(&response, "分叉 Pi 会话失败"))
        }
    })
    .await
    .map_err(|e| format!("Pi 后台任务异常：{e}"))?
}

/// Updates session metadata in SQLite.
#[tauri::command]
fn pi_session_update_meta(
    root: String,
    session_id: String,
    title: Option<String>,
    pinned: Option<bool>,
    archived: Option<bool>,
) -> Result<llm_wiki_core::store::ChatSessionRecord, String> {
    let store = SqliteStore::from_root(&root);
    let mut session = store
        .get_chat_session(&session_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Session {session_id} not found"))?;

    if let Some(t) = title {
        session.title = t;
    }
    if let Some(p) = pinned {
        session.pinned = p;
    }
    if let Some(a) = archived {
        session.archived = a;
    }
    session.updated_at = now_iso();

    store.upsert_chat_session(&session).map_err(|e| e.to_string())?;
    Ok(session)
}

fn extract_error_message(response: &serde_json::Value, fallback: &str) -> String {
    response
        .pointer("/error/message")
        .and_then(serde_json::Value::as_str)
        .unwrap_or(fallback)
        .to_string()
}

fn check_ok(response: Result<serde_json::Value, String>, fallback: &str) -> Result<serde_json::Value, String> {
    let response = response?;
    if response.get("ok").and_then(serde_json::Value::as_bool) == Some(true) {
        Ok(response)
    } else {
        Err(extract_error_message(&response, fallback))
    }
}

fn now_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = now.as_secs();
    let millis = now.subsec_millis();
    let days = secs / 86400;
    let remainder = secs % 86400;
    let hour = remainder / 3600;
    let minute = (remainder % 3600) / 60;
    let second = remainder % 60;
    let d = days as i64 + 719468;
    let era = if d >= 0 { d } else { d - 146096 } / 146097;
    let doe = (d - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { y + 1 } else { y };
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z", year, month, day, hour, minute, second, millis)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PiEnvironmentInfo {
    node_version: Option<String>,
    pi_version: Option<String>,
    latest_version: Option<String>,
    has_update: bool,
    status: String,
    message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PiUpgradeResult {
    success: bool,
    message: String,
    output: String,
}

fn get_augmented_path() -> String {
    let mut paths = vec![
        "/opt/homebrew/bin".to_string(),
        "/usr/local/bin".to_string(),
        "/usr/bin".to_string(),
        "/bin".to_string(),
        "/usr/sbin".to_string(),
        "/sbin".to_string(),
    ];
    if let Ok(home) = env::var("HOME") {
        paths.push(format!("{home}/.npm-global/bin"));
        paths.push(format!("{home}/.nvm/current/bin"));
        paths.push(format!("{home}/.cargo/bin"));
    }
    if let Ok(existing) = env::var("PATH") {
        paths.push(existing);
    }
    paths.join(":")
}

fn run_command_in_path(cmd: &str, args: &[&str]) -> Result<String, String> {
    let output = std::process::Command::new(cmd)
        .args(args)
        .env("PATH", get_augmented_path())
        .output()
        .map_err(|e| format!("无法执行 {cmd}: {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let out = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !err.is_empty() {
            Err(err)
        } else if !out.is_empty() {
            Err(out)
        } else {
            Err(format!("{cmd} 执行返回错误码 {}", output.status))
        }
    }
}

/// Checks the local Node.js environment, installed Pi CLI version, and checks
/// npm registry for updates.
#[tauri::command]
async fn pi_environment_check() -> Result<PiEnvironmentInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let node_version = run_command_in_path("node", &["--version"]).ok();
        let pi_version = run_command_in_path("pi", &["--version"]).ok();

        let latest_version = run_command_in_path("npm", &["view", "@earendil-works/pi-coding-agent", "version"]).ok()
            .or_else(|| run_command_in_path("npm", &["view", "@earendil-works/pi-ai", "version"]).ok());

        let mut has_update = false;
        if let (Some(cur), Some(latest)) = (&pi_version, &latest_version) {
            let clean_cur = cur.trim_start_matches('v').trim();
            let clean_lat = latest.trim_start_matches('v').trim();
            if !clean_cur.is_empty() && !clean_lat.is_empty() && clean_cur != clean_lat {
                has_update = true;
            }
        }

        let status = if pi_version.is_some() && node_version.is_some() {
            "ready".to_string()
        } else if node_version.is_some() {
            "pi_missing".to_string()
        } else {
            "node_missing".to_string()
        };

        let message = match (&pi_version, &node_version, &latest_version) {
            (Some(pv), Some(nv), Some(lv)) if has_update => {
                format!("Pi CLI {pv} (Node {nv}) · 发现新版本 {lv}")
            }
            (Some(pv), Some(nv), _) => {
                format!("Pi CLI {pv} (Node {nv}) · 已是最新版本")
            }
            (None, Some(nv), _) => {
                format!("Node {nv} 已就绪，未检测到全局 Pi CLI（可点击版本升级进行安装）")
            }
            _ => "未检测到 Node.js 环境，请先安装 Node.js (>= 22)".to_string(),
        };

        Ok(PiEnvironmentInfo {
            node_version,
            pi_version,
            latest_version,
            has_update,
            status,
            message,
        })
    })
    .await
    .map_err(|e| format!("Pi 检查异常：{e}"))?
}

/// Upgrades or installs global Pi CLI package.
#[tauri::command]
async fn pi_upgrade() -> Result<PiUpgradeResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let output = std::process::Command::new("npm")
            .args(&["install", "-g", "@earendil-works/pi-coding-agent@latest", "@earendil-works/pi-ai@latest"])
            .env("PATH", get_augmented_path())
            .output()
            .map_err(|e| format!("执行 npm install 升级失败: {e}"))?;

        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let full_out = if stderr.is_empty() { stdout.clone() } else { format!("{stdout}\n{stderr}").trim().to_string() };

        if output.status.success() {
            Ok(PiUpgradeResult {
                success: true,
                message: "Pi 升级成功！".into(),
                output: full_out,
            })
        } else {
            Err(format!("升级失败：{full_out}"))
        }
    })
    .await
    .map_err(|e| format!("Pi 升级任务异常：{e}"))?
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            pi::set_app(app.handle().clone());
            pi::kill_stale_dev_sidecars();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            workspace_current,
            workspace_open,
            workspace_create,
            workspace_rename,
            workspace_delete,
            workspace_status,
            documents_list,
            document_read,
            relations_list,
            relation_proposal_create,
            relation_proposal_approve,
            relation_proposal_reject,
            relation_proposal_delete,
            kb_stats,
            kb_config_get,
            kb_config_set_include,
            kb_config_set_exclude,
            document_search,
            index_run,
            draft_list,
            draft_get,
            draft_create,
            draft_apply,
            draft_reject,
            draft_delete,
            draft_delete_by_status,
            import_file,
            attachments_list,
            attachment_read,
            attachment_extract,
            pi_config_get,
            pi_config_set,
            pi_models_list,
            pi_session_new,
            pi_session_list,
            pi_session_get,
            pi_prompt,
            pi_session_delete,
            pi_session_cancel,
            pi_session_compact,
            pi_session_fork,
            pi_session_update_meta,
            pi_environment_check,
            pi_upgrade,
        ])
        .build(tauri::generate_context!())
        .expect("error while building LLM Wiki Desktop")
        .run(|_app, event| {
            if let tauri::RunEvent::Exit = event {
                pi::supervisor().shutdown();
            }
        });
}
