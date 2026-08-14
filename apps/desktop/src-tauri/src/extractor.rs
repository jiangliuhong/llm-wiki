//! Text extraction from binary document formats (PDF, DOCX).
//!
//! Used by the file-import workflow: when a user imports a PDF or DOCX, the
//! raw file is copied to `attachments/` and then this module extracts plain
//! text so it can be previewed and turned into a wiki draft.
//!
//! Only text-based PDFs are supported (scanned/image-only PDFs would need OCR,
//! which is out of scope for V1). DOCX is fully supported via `docx-rs`.

use std::path::Path;

/// Extracts plain text from a document file, dispatching on the extension.
///
/// Supported formats:
/// - `.pdf` → text-layer extraction via `pdf-extract`
/// - `.docx` → paragraph extraction via `docx-rs`
///
/// Returns an error for unsupported formats or extraction failures. The
/// caller should fall back gracefully (show "unsupported" in the UI).
pub fn extract_text(path: &Path) -> Result<String, String> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();

    match ext.as_str() {
        "pdf" => extract_pdf(path),
        "docx" => extract_docx(path),
        other => Err(format!("unsupported file type: .{other} (only .pdf and .docx are supported)")),
    }
}

/// Returns true if the extension is a supported binary document format.
pub fn is_extractable(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()).map(|e| e.to_lowercase()).as_deref(),
        Some("pdf") | Some("docx")
    )
}

fn extract_pdf(path: &Path) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("cannot read PDF: {e}"))?;
    let text = pdf_extract::extract_text_from_mem(&bytes)
        .map_err(|e| format!("PDF extraction failed: {e}"))?;
    Ok(clean_extracted_text(&text))
}

fn extract_docx(path: &Path) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("cannot read DOCX: {e}"))?;
    let docx = docx_rs::read_docx(&bytes)
        .map_err(|e| format!("DOCX parsing failed: {e}"))?;

    // Walk Document → DocumentChild::Paragraph → ParagraphChild::Run → RunChild::Text
    let mut paragraphs = Vec::new();
    for child in &docx.document.children {
        if let docx_rs::DocumentChild::Paragraph(para) = child {
            let mut para_text = String::new();
            for pchild in para.children() {
                if let docx_rs::ParagraphChild::Run(run) = pchild {
                    for rchild in &run.children {
                        if let docx_rs::RunChild::Text(t) = rchild {
                            para_text.push_str(&t.text);
                        }
                    }
                }
            }
            if !para_text.trim().is_empty() {
                paragraphs.push(para_text);
            }
        }
    }
    Ok(clean_extracted_text(&paragraphs.join("\n\n")))
}

/// Normalizes extracted text: collapses excessive whitespace, trims trailing
/// spaces per line, removes form-feed characters.
fn clean_extracted_text(text: &str) -> String {
    let no_form_feeds = text.replace('\x0c', "\n\n");
    // Collapse 3+ consecutive newlines into 2.
    let mut result = String::with_capacity(no_form_feeds.len());
    let mut blank_run = 0;
    for line in no_form_feeds.lines() {
        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            blank_run += 1;
            if blank_run <= 2 {
                result.push('\n');
            }
        } else {
            blank_run = 0;
            result.push_str(trimmed);
            result.push('\n');
        }
    }
    result.trim().to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_extractable_detects_format() {
        assert!(is_extractable(Path::new("doc.pdf")));
        assert!(is_extractable(Path::new("doc.DOCX")));
        assert!(!is_extractable(Path::new("doc.md")));
        assert!(!is_extractable(Path::new("doc.txt")));
        assert!(!is_extractable(Path::new("doc")));
    }

    #[test]
    fn extract_unsupported_returns_error() {
        let result = extract_text(Path::new("test.json"));
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("unsupported"));
    }

    #[test]
    fn clean_text_collapses_whitespace() {
        let dirty = "Line 1   \n\n\n\n\nLine 2\x0c\n\n\n";
        let clean = clean_extracted_text(dirty);
        assert!(!clean.contains("\n\n\n"));
        assert!(!clean.contains('\x0c'));
        assert!(clean.contains("Line 1"));
        assert!(clean.contains("Line 2"));
    }
}
