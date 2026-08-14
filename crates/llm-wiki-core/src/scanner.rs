//! File scanner — Rust port of `packages/kb/src/scanner.ts`.
//!
//! Recursively walks every directory in `include` (relative to the project
//! root), keeping only supported text file types, skipping `exclude` directory
//! names anywhere in the tree, and normalizing all paths to POSIX style.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

/// File extensions that are indexed (code, markup, config, text).
pub const SUPPORTED_EXTENSIONS: &[&str] = &[
    ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".md", ".mdx", ".json", ".txt", ".yml", ".yaml",
];

/// A discovered file ready for indexing.
#[derive(Debug, Clone)]
pub struct ScannedFile {
    /// Repo-relative path, POSIX-normalized (e.g. `wiki/guide.md`).
    pub rel_path: String,
    /// Absolute filesystem path.
    pub abs_path: PathBuf,
    /// Inferred language tag (derived from extension).
    pub language: String,
}

/// Detailed scan outcome used by the indexer to make stale cleanup safe.
#[derive(Debug, Clone, Default)]
pub struct ScanResult {
    pub files: Vec<ScannedFile>,
    /// Include roots whose contents could not be scanned completely.
    pub unavailable_roots: Vec<String>,
}

/// Maps a file extension to a coarse language tag. Mirrors `languageFromExtension`.
pub fn language_from_extension(ext: &str) -> &'static str {
    match ext.to_lowercase().as_str() {
        ".md" | ".mdx" => "markdown",
        ".ts" | ".tsx" => "typescript",
        ".js" | ".mjs" | ".cjs" | ".jsx" => "javascript",
        ".json" => "json",
        ".yml" | ".yaml" => "yaml",
        ".txt" => "text",
        _ => "other",
    }
}

/// Options controlling which directories to scan and which to skip.
#[derive(Debug, Clone)]
pub struct ScanOptions {
    pub project_root: PathBuf,
    pub include: Vec<String>,
    pub exclude: Vec<String>,
}

/// Scans `include` directories and returns all indexable files.
pub fn scan_files(options: &ScanOptions) -> Vec<ScannedFile> {
    scan_files_detailed(options).files
}

/// Scans files and reports roots that were missing or only partially readable.
/// Callers performing destructive stale cleanup should skip that cleanup when
/// this list is non-empty.
pub fn scan_files_detailed(options: &ScanOptions) -> ScanResult {
    let exclude_set: HashSet<String> = options.exclude.iter().cloned().collect();
    let supported_ext: HashSet<&'static str> = SUPPORTED_EXTENSIONS.iter().copied().collect();
    let mut results: Vec<ScannedFile> = Vec::new();
    let mut unavailable_roots: Vec<String> = Vec::new();

    for root in &options.include {
        let abs_root = options.project_root.join(root);
        let is_dir = fs::metadata(&abs_root).map(|m| m.is_dir()).unwrap_or(false);
        if !is_dir {
            unavailable_roots.push(root.clone());
            continue;
        }
        if !walk(&abs_root, &options.project_root, &exclude_set, &supported_ext, &mut results) {
            unavailable_roots.push(root.clone());
        }
    }

    // Stable, deterministic order for reproducible indexes.
    results.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    ScanResult { files: results, unavailable_roots }
}

/// Returns `false` if the directory could not be read completely.
fn walk(
    dir_abs: &Path,
    project_root: &Path,
    exclude_set: &HashSet<String>,
    supported_ext: &HashSet<&'static str>,
    out: &mut Vec<ScannedFile>,
) -> bool {
    let entries = match fs::read_dir(dir_abs) {
        Ok(e) => e,
        Err(_) => return false,
    };

    let mut complete = true;
    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => {
                complete = false;
                continue;
            }
        };
        let name = entry.file_name();
        let name_str = match name.to_str() {
            Some(s) => s,
            None => continue,
        };

        // Skip excluded directory names anywhere in the tree.
        if exclude_set.contains(name_str) {
            continue;
        }
        // Skip hidden entries (leading dot), e.g. `.DS_Store`, `.git`.
        if name_str.starts_with('.') {
            continue;
        }

        let abs = entry.path();
        let file_type = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => {
                complete = false;
                continue;
            }
        };
        if file_type.is_dir() {
            if !walk(&abs, project_root, exclude_set, supported_ext, out) {
                complete = false;
            }
            continue;
        }
        if !file_type.is_file() {
            continue;
        }

        let ext = extension_lower(name_str);
        if !supported_ext.contains(ext.as_str()) {
            continue;
        }

        let rel_path = match abs.strip_prefix(project_root) {
            Ok(rel) => to_posix(rel),
            Err(_) => to_posix(&abs),
        };
        out.push(ScannedFile {
            rel_path,
            abs_path: abs,
            language: language_from_extension(&ext).to_owned(),
        });
    }
    complete
}

/// Returns the lowercase extension including the leading dot, or empty string.
fn extension_lower(name: &str) -> String {
    match name.rfind('.') {
        Some(idx) => name[idx..].to_lowercase(),
        None => String::new(),
    }
}

/// Normalizes a path to forward-slash POSIX style.
pub fn to_posix(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn unique_temp_dir() -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let nonce = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "llm-wiki-scan-{}-{}-{}",
            std::process::id(),
            nonce,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn scans_supported_files_and_skips_excluded() {
        let root = unique_temp_dir();
        fs::create_dir_all(root.join("wiki")).unwrap();
        fs::create_dir_all(root.join("node_modules")).unwrap();
        fs::write(root.join("wiki/a.md"), "# A").unwrap();
        fs::write(root.join("wiki/b.ts"), "const x = 1;").unwrap();
        fs::write(root.join("wiki/hidden.txt"), "hidden").unwrap();
        // .txt is supported but the file is hidden (leading dot) — actually
        // "hidden.txt" does not start with a dot. Let's test the exclude rule
        // with node_modules instead:
        fs::write(root.join("node_modules/lib.md"), "# lib").unwrap();

        let result = scan_files_detailed(&ScanOptions {
            project_root: root.clone(),
            include: vec!["wiki".into()],
            exclude: vec!["node_modules".into()],
        });
        let paths: Vec<&str> = result.files.iter().map(|f| f.rel_path.as_str()).collect();
        assert!(paths.contains(&"wiki/a.md"));
        assert!(paths.contains(&"wiki/b.ts"));
        // node_modules is excluded
        assert!(!paths.iter().any(|p| p.contains("node_modules")));
    }

    #[test]
    fn reports_unavailable_roots() {
        let root = unique_temp_dir();
        let result = scan_files_detailed(&ScanOptions {
            project_root: root,
            include: vec!["nonexistent".into()],
            exclude: vec![],
        });
        assert_eq!(result.files.len(), 0);
        assert_eq!(result.unavailable_roots, vec!["nonexistent"]);
    }

    #[test]
    fn language_detection() {
        assert_eq!(language_from_extension(".md"), "markdown");
        assert_eq!(language_from_extension(".MDX"), "markdown");
        assert_eq!(language_from_extension(".ts"), "typescript");
        assert_eq!(language_from_extension(".json"), "json");
        assert_eq!(language_from_extension(".unknown"), "other");
    }
}
