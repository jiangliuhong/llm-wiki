//! Versioned JSONL contracts for CLI, Pi Host Bridge and MCP boundaries.

use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: &str = "1";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Envelope<T> {
    #[serde(rename = "protocolVersion")]
    pub protocol_version: String,
    pub id: String,
    #[serde(flatten)]
    pub payload: T,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HostRequest {
    ToolCall {
        session_id: String,
        workspace_id: String,
        tool: String,
        input: serde_json::Value,
    },
    Cancel {
        session_id: String,
    },
    Ping,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HostEvent {
    ToolResult { ok: bool, output: serde_json::Value },
    TextDelta { text: String },
    Error { code: String, message: String },
    Pong,
}

pub fn encode<T: Serialize>(
    id: impl Into<String>,
    payload: T,
) -> Result<String, serde_json::Error> {
    serde_json::to_string(&Envelope {
        protocol_version: PROTOCOL_VERSION.to_owned(),
        id: id.into(),
        payload,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_call_is_stable_jsonl() {
        let line = encode(
            "req-1",
            HostRequest::ToolCall {
                session_id: "session-1".into(),
                workspace_id: "workspace-1".into(),
                tool: "document_search".into(),
                input: serde_json::json!({ "query": "graph" }),
            },
        )
        .unwrap();
        assert!(line.contains("\"protocolVersion\":\"1\""));
        assert!(line.contains("\"document_search\""));
    }
}
