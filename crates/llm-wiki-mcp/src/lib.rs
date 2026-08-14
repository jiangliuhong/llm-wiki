//! MCP Host Bridge — JSONL stdio server.
//!
//! Reads `HostRequest` envelopes (one per line) from stdin, dispatches each
//! `ToolCall` to the corresponding `SqliteStore` method, and writes `HostEvent`
//! envelopes (one per line) to stdout. The server respects the `McpScope`
//! permission model: tools not allowed by the scope are rejected before
//! dispatch.
//!
//! Protocol: LF-delimited JSONL. Each line is an `Envelope<HostRequest>` (in)
//! or `Envelope<HostEvent>` (out), as defined in `llm-wiki-protocol`.
//!
//! Per architecture-v1.md §11.4-§11.5.

use std::collections::HashMap;
use std::io::{self, BufRead, Write};

use llm_wiki_core::store::{ListFilesOptions, SqliteStore};
use llm_wiki_core::WorkspaceManifest;
use llm_wiki_protocol::{Envelope, HostEvent, HostRequest};
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Scope (unchanged permission model)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct McpScope {
    pub workspace_ids: Vec<String>,
    pub all_workspaces: bool,
    pub read_only: bool,
    pub allow_drafts: bool,
    pub allow_apply: bool,
    pub allow_paths: Vec<String>,
}

impl McpScope {
    pub fn validate(&self) -> Result<(), String> {
        if self.workspace_ids.is_empty() && !self.all_workspaces {
            return Err("MCP requires --workspace or --all-workspaces".to_owned());
        }
        if self.read_only && (self.allow_drafts || self.allow_apply) {
            return Err("read-only scope cannot enable draft or apply permissions".to_owned());
        }
        if self.allow_apply && self.allow_paths.is_empty() {
            return Err("allow-apply requires at least one allow-path".to_owned());
        }
        Ok(())
    }
}

pub const READ_ONLY_TOOLS: &[&str] = &[
    "workspace_list",
    "workspace_get",
    "document_list",
    "document_search",
    "document_read",
    "document_relations",
    "document_neighborhood",
    "index_status",
];

pub fn is_tool_allowed(scope: &McpScope, tool: &str) -> bool {
    if READ_ONLY_TOOLS.contains(&tool) {
        return true;
    }
    if tool == "document_draft_create" || tool == "document_draft_get" {
        return scope.allow_drafts || scope.allow_apply;
    }
    if tool == "document_draft_apply" {
        return scope.allow_apply;
    }
    false
}

// ---------------------------------------------------------------------------
// Host Bridge server
// ---------------------------------------------------------------------------

/// A workspace resolved for the bridge: its manifest id maps to a root path.
#[derive(Debug, Clone)]
pub struct WorkspaceEntry {
    pub id: String,
    pub root: std::path::PathBuf,
}

/// Runs the JSONL stdio server loop. Blocks until stdin is closed or an
/// unrecoverable I/O error occurs.
///
/// Each workspace in `workspaces` becomes available to tool calls via its
/// manifest id. The `scope` controls which tools are permitted.
pub fn serve(
    scope: &McpScope,
    workspaces: &[WorkspaceEntry],
    stdin: &mut dyn BufRead,
    stdout: &mut dyn Write,
) -> io::Result<()> {
    let roots: HashMap<String, &std::path::Path> = workspaces
        .iter()
        .map(|w| (w.id.clone(), w.root.as_path()))
        .collect();

    let mut line = String::new();
    loop {
        line.clear();
        let n = stdin.read_line(&mut line)?;
        if n == 0 {
            break; // EOF
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let envelope: Envelope<HostRequest> = match serde_json::from_str(trimmed) {
            Ok(env) => env,
            Err(e) => {
                // Malformed input — we don't have an id to echo back, so use a
                // synthetic one.
                let err = HostEvent::Error {
                    code: "PROTOCOL_PARSE_ERROR".into(),
                    message: e.to_string(),
                };
                writeln!(stdout, "{}", llm_wiki_protocol::encode("parse-error", err).unwrap())?;
                stdout.flush()?;
                continue;
            }
        };

        let event = handle_request(&envelope, scope, &roots);
        let response = llm_wiki_protocol::encode(&envelope.id, event).unwrap();
        writeln!(stdout, "{response}")?;
        stdout.flush()?;
    }
    Ok(())
}

/// Dispatches a single `HostRequest` to the appropriate tool implementation.
fn handle_request(
    envelope: &Envelope<HostRequest>,
    scope: &McpScope,
    roots: &HashMap<String, &std::path::Path>,
) -> HostEvent {
    match &envelope.payload {
        HostRequest::Ping => HostEvent::Pong,
        HostRequest::Cancel { .. } => HostEvent::Error {
            code: "NOT_SUPPORTED".into(),
            message: "cancel is not yet implemented".into(),
        },
        HostRequest::ToolCall { workspace_id, tool, input, .. } => {
            dispatch_tool_call(scope, roots, workspace_id, tool, input.clone())
        }
    }
}

/// Resolves the workspace root, checks permissions, and dispatches.
fn dispatch_tool_call(
    scope: &McpScope,
    roots: &HashMap<String, &std::path::Path>,
    workspace_id: &str,
    tool: &str,
    input: serde_json::Value,
) -> HostEvent {
    // Permission check first.
    if !is_tool_allowed(scope, tool) {
        return HostEvent::Error {
            code: "TOOL_NOT_ALLOWED".into(),
            message: format!("tool '{tool}' is not permitted in the current scope"),
        };
    }

    // Resolve workspace root.
    let root = match roots.get(workspace_id) {
        Some(r) => *r,
        None => {
            return HostEvent::Error {
                code: "WORKSPACE_NOT_FOUND".into(),
                message: format!("workspace '{workspace_id}' is not registered"),
            };
        }
    };

    let store = SqliteStore::from_root(root);
    match dispatch_tool(&store, root, tool, input) {
        Ok(output) => HostEvent::ToolResult { ok: true, output },
        Err(message) => HostEvent::ToolResult {
            ok: false,
            output: serde_json::json!({ "error": message }),
        },
    }
}

/// Executes a single tool against the store. Returns a JSON output or an error
/// message string.
fn dispatch_tool(
    store: &SqliteStore,
    root: &std::path::Path,
    tool: &str,
    input: serde_json::Value,
) -> Result<serde_json::Value, String> {
    match tool {
        "workspace_get" => {
            let manifest = WorkspaceManifest::load_from_root(root).map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(&manifest).map_err(|e| e.to_string())?)
        }

        "index_status" => {
            let stats = store.stats().map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(&stats).map_err(|e| e.to_string())?)
        }

        "document_list" => {
            let page = input.get("page").and_then(|v| v.as_i64());
            let page_size = input.get("pageSize").and_then(|v| v.as_i64());
            let q = input.get("q").and_then(|v| v.as_str()).map(|s| s.to_owned());
            let result = store
                .list_files(ListFilesOptions { page, page_size, q })
                .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(&result).map_err(|e| e.to_string())?)
        }

        "document_search" => {
            let query = input
                .get("query")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "missing 'query' parameter".to_string())?;
            let limit = input.get("limit").and_then(|v| v.as_u64()).map(|l| l as usize);
            let hits = store.search(query, limit).map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(&hits).map_err(|e| e.to_string())?)
        }

        "document_read" => {
            let file_id = input
                .get("fileId")
                .and_then(|v| v.as_i64())
                .ok_or_else(|| "missing 'fileId' parameter".to_string())?;
            let content = store.file_content(file_id).map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(&content).map_err(|e| e.to_string())?)
        }

        "document_relations" => {
            let proposals = store.relation_proposals(None).map_err(|e| e.to_string())?;
            let published = store.all_relations().map_err(|e| e.to_string())?;
            Ok(serde_json::json!({ "proposals": proposals, "published": published }))
        }

        "document_neighborhood" => {
            // V1: return all relations (no single-doc neighborhood query yet).
            let published = store.all_relations().map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(&published).map_err(|e| e.to_string())?)
        }

        "document_draft_get" => {
            let draft_id = input
                .get("draftId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "missing 'draftId' parameter".to_string())?;
            let draft = store.get_draft(draft_id).map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(&draft).map_err(|e| e.to_string())?)
        }

        "document_draft_create" => {
            let workspace_id = input
                .get("workspaceId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "missing 'workspaceId' parameter".to_string())?
                .to_owned();
            let target_path = input
                .get("targetPath")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "missing 'targetPath' parameter".to_string())?
                .to_owned();
            let operation_type = input
                .get("operationType")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "missing 'operationType' parameter".to_string())?
                .to_owned();
            let generated_content = input
                .get("generatedContent")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "missing 'generatedContent' parameter".to_string())?
                .to_owned();
            let base_document_hash = input
                .get("baseDocumentHash")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_owned();
            let citations: Vec<String> = input
                .get("sourceCitations")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default();
            let section_slug = input
                .get("sectionSlug")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_owned();
            let created_by = input
                .get("createdBy")
                .and_then(|v| v.as_str())
                .unwrap_or("mcp")
                .to_owned();

            let draft = store
                .create_draft(&llm_wiki_core::store::DraftCreateInput {
                    workspace_id,
                    target_path,
                    operation_type,
                    base_document_hash,
                    generated_content,
                    source_citations: citations,
                    section_slug,
                    created_by,
                })
                .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(&draft).map_err(|e| e.to_string())?)
        }

        "document_draft_apply" => {
            let draft_id = input
                .get("draftId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "missing 'draftId' parameter".to_string())?;
            let result = store.apply_draft(draft_id, root, "mcp").map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(&result).map_err(|e| e.to_string())?)
        }

        "workspace_list" => {
            // Return the registered workspace manifest(s).
            let manifest = WorkspaceManifest::load_from_root(root).map_err(|e| e.to_string())?;
            Ok(serde_json::json!({ "workspaces": [manifest] }))
        }

        other => Err(format!("unknown tool: {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn scope() -> McpScope {
        McpScope {
            workspace_ids: vec!["w1".into()],
            all_workspaces: false,
            read_only: true,
            allow_drafts: false,
            allow_apply: false,
            allow_paths: vec![],
        }
    }

    #[test]
    fn scope_requires_explicit_workspace() {
        let mut value = scope();
        value.workspace_ids.clear();
        assert!(value.validate().is_err());
    }

    #[test]
    fn read_only_scope_rejects_writes() {
        assert!(is_tool_allowed(&scope(), "document_search"));
        assert!(!is_tool_allowed(&scope(), "document_draft_apply"));
    }

    #[test]
    fn serve_responds_to_ping() {
        let scope = scope();
        let workspaces = vec![];
        let input = format!(
            r#"{{"protocolVersion":"1","id":"ping-1","type":"ping"}}"#
        ) + "\n";
        let mut stdin = Cursor::new(input.into_bytes());
        let mut stdout = Vec::new();
        serve(&scope, &workspaces, &mut stdin, &mut &mut stdout).unwrap();

        let output = String::from_utf8(stdout).unwrap();
        assert!(output.contains("pong"), "expected pong in output: {output}");
        assert!(output.contains("ping-1"));
    }

    #[test]
    fn serve_rejects_disallowed_tool() {
        let scope = scope(); // read-only
        let workspaces = vec![WorkspaceEntry {
            id: "w1".into(),
            root: std::path::PathBuf::from("/tmp"),
        }];
        let input =
            r#"{"protocolVersion":"1","id":"req-1","type":"tool_call","session_id":"s1","workspace_id":"w1","tool":"document_draft_apply","input":{}}"#.to_owned()
            + "\n";
        let mut stdin = Cursor::new(input.into_bytes());
        let mut stdout = Vec::new();
        serve(&scope, &workspaces, &mut stdin, &mut &mut stdout).unwrap();

        let output = String::from_utf8(stdout).unwrap();
        assert!(
            output.contains("TOOL_NOT_ALLOWED"),
            "expected TOOL_NOT_ALLOWED in output: {output}"
        );
    }

    #[test]
    fn serve_reports_unknown_workspace() {
        let scope = scope();
        let workspaces = vec![WorkspaceEntry {
            id: "w1".into(),
            root: std::path::PathBuf::from("/tmp"),
        }];
        let input =
            r#"{"protocolVersion":"1","id":"req-1","type":"tool_call","session_id":"s1","workspace_id":"nonexistent","tool":"document_search","input":{"query":"test"}}"#.to_owned()
            + "\n";
        let mut stdin = Cursor::new(input.into_bytes());
        let mut stdout = Vec::new();
        serve(&scope, &workspaces, &mut stdin, &mut &mut stdout).unwrap();

        let output = String::from_utf8(stdout).unwrap();
        assert!(
            output.contains("WORKSPACE_NOT_FOUND"),
            "expected WORKSPACE_NOT_FOUND in output: {output}"
        );
    }

    #[test]
    fn serve_handles_malformed_json() {
        let scope = scope();
        let input = "not valid json\n";
        let mut stdin = Cursor::new(input.as_bytes().to_vec());
        let mut stdout = Vec::new();
        serve(&scope, &[], &mut stdin, &mut &mut stdout).unwrap();

        let output = String::from_utf8(stdout).unwrap();
        assert!(output.contains("PROTOCOL_PARSE_ERROR"));
    }
}
