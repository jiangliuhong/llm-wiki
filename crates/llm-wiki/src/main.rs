use llm_wiki_core::WorkspaceManifest;
use llm_wiki_mcp::{serve, McpScope, WorkspaceEntry};
use llm_wiki_protocol::PROTOCOL_VERSION;
use std::env;
use std::io;

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        Some("--version") | Some("-V") => {
            println!("llm-wiki {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        Some("doctor") => doctor(),
        Some("workspace") => workspace_command(&args[1..]),
        Some("mcp") => mcp_command(&args[1..]),
        _ => {
            print_help();
            Ok(())
        }
    };
    if let Err(error) = result {
        eprintln!("Error: {error}");
        std::process::exit(2);
    }
}

fn doctor() -> Result<(), String> {
    let cwd = env::current_dir().map_err(|error| error.to_string())?;
    let workspace = WorkspaceManifest::discover_from(&cwd)
        .map(|(_, manifest)| manifest.id)
        .ok();
    println!(
        "{}",
        serde_json::json!({
            "protocolVersion": PROTOCOL_VERSION,
            "ok": true,
            "data": { "runtime": "rust", "cwd": cwd, "workspaceId": workspace }
        })
    );
    Ok(())
}

fn workspace_command(args: &[String]) -> Result<(), String> {
    match args.first().map(String::as_str) {
        Some("current") => {
            let cwd = env::current_dir().map_err(|error| error.to_string())?;
            let (root, manifest) =
                WorkspaceManifest::discover_from(&cwd).map_err(|error| error.to_string())?;
            println!(
                "{}",
                serde_json::json!({
                    "protocolVersion": PROTOCOL_VERSION, "ok": true, "data": {
                        "id": manifest.id, "title": manifest.title, "root": root,
                        "resolvedBy": "cwd"
                    }
                })
            );
            Ok(())
        }
        _ => Err("usage: llm-wiki workspace current".to_owned()),
    }
}

fn mcp_command(args: &[String]) -> Result<(), String> {
    if args.first().map(String::as_str) != Some("serve") {
        return Err("usage: llm-wiki mcp serve --stdio --workspace <id> --workspace-root <path> [--read-only]".to_owned());
    }
    let mut scope = McpScope {
        workspace_ids: Vec::new(),
        all_workspaces: false,
        read_only: false,
        allow_drafts: false,
        allow_apply: false,
        allow_paths: Vec::new(),
    };
    // Pair each workspace id with a root path. When --all-workspaces is set,
    // resolve the workspace from CWD.
    let mut pending_workspace_root: Option<String> = None;
    let mut entries: Vec<WorkspaceEntry> = Vec::new();

    let mut index = 1;
    while index < args.len() {
        match args[index].as_str() {
            "--workspace" => {
                let value = args.get(index + 1).ok_or("--workspace requires a value")?;
                scope.workspace_ids.push(value.clone());
                // If a root was pending from a previous --workspace-root, pair it.
                if let Some(root) = pending_workspace_root.take() {
                    entries.push(WorkspaceEntry {
                        id: value.clone(),
                        root: root.into(),
                    });
                }
                index += 2;
            }
            "--workspace-root" => {
                let value = args.get(index + 1).ok_or("--workspace-root requires a value")?;
                // Pair with the last workspace id, or hold as pending.
                if let Some(last_id) = scope.workspace_ids.last() {
                    // Check if this id already has an entry (from --workspace-root before --workspace).
                    if entries.iter().any(|e| e.id == *last_id) {
                        pending_workspace_root = Some(value.clone());
                    } else {
                        entries.push(WorkspaceEntry {
                            id: last_id.clone(),
                            root: value.clone().into(),
                        });
                    }
                } else {
                    pending_workspace_root = Some(value.clone());
                }
                index += 2;
            }
            "--all-workspaces" => {
                scope.all_workspaces = true;
                index += 1;
            }
            "--read-only" => {
                scope.read_only = true;
                index += 1;
            }
            "--allow-drafts" => {
                scope.allow_drafts = true;
                index += 1;
            }
            "--allow-apply" => {
                scope.allow_apply = true;
                index += 1;
            }
            "--allow-path" => {
                let value = args.get(index + 1).ok_or("--allow-path requires a value")?;
                scope.allow_paths.push(value.clone());
                index += 2;
            }
            "--stdio" => index += 1,
            other => return Err(format!("unknown MCP option {other}")),
        }
    }
    scope.validate()?;

    // If --all-workspaces and no explicit roots, resolve from CWD.
    if scope.all_workspaces && entries.is_empty() {
        let cwd = env::current_dir().map_err(|e| e.to_string())?;
        if let Ok((root, manifest)) = WorkspaceManifest::discover_from(&cwd) {
            entries.push(WorkspaceEntry { id: manifest.id, root });
        }
    }

    eprintln!("llm-wiki MCP stdio server ready ({} workspace(s))", entries.len());

    let stdin = io::stdin();
    let stdout = io::stdout();
    serve(&scope, &entries, &mut stdin.lock(), &mut stdout.lock())
        .map_err(|e| format!("MCP server error: {e}"))?;

    Ok(())
}

fn print_help() {
    println!("llm-wiki — local-first knowledge workspace");
    println!("  llm-wiki doctor");
    println!("  llm-wiki workspace current");
    println!("  llm-wiki mcp serve --stdio --workspace <id> --read-only");
}
