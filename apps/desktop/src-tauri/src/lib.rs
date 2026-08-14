mod extractor;

use llm_wiki_core::indexer::{index_files, IndexRunOptions, KbConfig};
use llm_wiki_core::store::{ListFilesOptions, SqliteStore};
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
        .list_files(ListFilesOptions { page, page_size, q })
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

/// Triggers an incremental index pass on the workspace using the Rust indexer.
/// This is the desktop's native alternative to running `llm-wiki index` in a
/// terminal. Phase A: FTS-only (no vector embeddings).
#[tauri::command]
fn index_run(root: String, reset: Option<bool>) -> Result<llm_wiki_core::indexer::IndexStats, String> {
    let options = IndexRunOptions {
        project_root: PathBuf::from(&root),
        db_path: None,
        config: KbConfig::default(),
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

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            workspace_current,
            workspace_open,
            workspace_create,
            workspace_delete,
            workspace_status,
            documents_list,
            document_read,
            relations_list,
            kb_stats,
            document_search,
            index_run,
            draft_list,
            draft_get,
            draft_create,
            draft_apply,
            draft_reject,
            import_file,
            attachments_list,
            attachment_read,
            attachment_extract,
        ])
        .run(tauri::generate_context!())
        .expect("error while running LLM Wiki Desktop");
}
