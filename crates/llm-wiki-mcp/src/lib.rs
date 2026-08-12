//! MCP library boundary. The published product exposes this through
//! `llm-wiki mcp serve`; it does not ship a separate MCP executable.

use serde::{Deserialize, Serialize};

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

#[cfg(test)]
mod tests {
    use super::*;

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
}
