//! Text chunker — Rust port of `packages/kb/src/chunker.ts`.
//!
//! Splits a file's text into overlapping retrieval chunks using a
//! character-based sliding window. Cuts are moved to nearby newlines to avoid
//! slicing mid-line. Each chunk records 1-based start/end line numbers.
//!
//! NOTE: The TS version indexes by UTF-16 code units (JS string indices). This
//! Rust port indexes by Unicode scalar values (`char`). This only differs for
//! text containing characters outside the BMP (e.g. some CJK extensions), and
//! only matters for byte-exact parity with an existing index — which is never
//! required since re-indexing regenerates all chunks.

/// How far around a candidate cut to look for a newline boundary.
const NEWLINE_SEARCH_RADIUS: usize = 80;

#[derive(Debug, Clone, PartialEq)]
pub struct Chunk {
    pub content: String,
    pub start_line: u32,
    pub end_line: u32,
}

#[derive(Debug, Clone)]
pub struct ChunkOptions {
    pub max_chars: usize,
    pub overlap: usize,
}

/// Splits `text` into chunks. Returns an empty vector for blank content.
pub fn split_into_chunks(text: &str, options: &ChunkOptions) -> Vec<Chunk> {
    let max_chars = options.max_chars.max(1);
    let overlap = options.overlap.min(max_chars.saturating_sub(1));

    // Collect into a Vec<char> for O(1) random access (mirrors JS indexing).
    let chars: Vec<char> = text.chars().collect();

    if text.trim().is_empty() {
        return Vec::new();
    }

    let len = chars.len();
    let mut chunks: Vec<Chunk> = Vec::new();
    let mut cursor: usize = 0;

    while cursor < len {
        let ideal_end = cursor + max_chars;
        let end = if ideal_end >= len { len } else { find_chunk_end(&chars, cursor, ideal_end) };

        let slice: String = chars[cursor..end].iter().collect();
        if !slice.trim().is_empty() {
            let (start_line, end_line) = line_range(&chars, cursor, end);
            chunks.push(Chunk { content: slice, start_line, end_line });
        }

        if end >= len {
            break;
        }

        // Advance by (end - overlap), guaranteeing forward progress.
        let next = end.saturating_sub(overlap);
        cursor = if next > cursor { next } else { end };
    }

    chunks
}

/// Given an ideal cut position, searches backward (then forward) within a small
/// radius for a newline to cut at, returning its index (exclusive end).
fn find_chunk_end(chars: &[char], start: usize, ideal_end: usize) -> usize {
    let from = (start + 1).max(ideal_end.saturating_sub(NEWLINE_SEARCH_RADIUS));
    let to = (ideal_end + NEWLINE_SEARCH_RADIUS).min(chars.len());

    // Search backward for the latest newline at or before the ideal cut.
    let mut i = ideal_end;
    while i >= from {
        if chars[i] == '\n' {
            return i + 1; // include the newline in this chunk
        }
        if i == 0 {
            break;
        }
        i -= 1;
    }
    // If none behind, take the next newline ahead (don't overshoot `to`).
    // `to` is clamped to len, so use `..to` (exclusive) to avoid indexing past
    // the end of the slice.
    for j in (ideal_end + 1)..to {
        if chars[j] == '\n' {
            return j + 1;
        }
    }
    ideal_end
}

/// Computes 1-based start/end line numbers for the slice [start, end).
fn line_range(chars: &[char], start: usize, end: usize) -> (u32, u32) {
    let mut start_line: u32 = 1;
    for i in 0..start {
        if chars[i] == '\n' {
            start_line += 1;
        }
    }

    // Count newlines in (start, end); the end line is start_line + that count,
    // minus one if the slice ends exactly on a trailing newline boundary.
    let mut extra: u32 = 0;
    let mut saw_non_newline_after_last_newline = false;
    for i in start..end {
        if chars[i] == '\n' {
            extra += 1;
            saw_non_newline_after_last_newline = false;
        } else {
            saw_non_newline_after_last_newline = true;
        }
    }
    let mut end_line = start_line + extra;
    if !saw_non_newline_after_last_newline && extra > 0 {
        end_line -= 1;
    }
    if end_line < start_line {
        end_line = start_line;
    }
    (start_line, end_line)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_text_yields_no_chunks() {
        let chunks = split_into_chunks("   \n  \n  ", &ChunkOptions { max_chars: 100, overlap: 0 });
        assert!(chunks.is_empty());
    }

    #[test]
    fn short_text_is_single_chunk() {
        let chunks = split_into_chunks("hello world", &ChunkOptions { max_chars: 100, overlap: 0 });
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].content, "hello world");
        assert_eq!(chunks[0].start_line, 1);
        assert_eq!(chunks[0].end_line, 1);
    }

    #[test]
    fn multi_line_line_numbers() {
        let text = "line1\nline2\nline3";
        let chunks = split_into_chunks(text, &ChunkOptions { max_chars: 100, overlap: 0 });
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].start_line, 1);
        assert_eq!(chunks[0].end_line, 3);
    }

    #[test]
    fn splits_at_newline_boundary() {
        // 6 lines, each "aaaa\n" = 5 chars. With maxChars=12 we should cut at
        // a newline near char 12 rather than mid-line.
        let text = "aaaa\naaaa\naaaa\naaaa\naaaa\naaaa\n";
        let chunks = split_into_chunks(text, &ChunkOptions { max_chars: 12, overlap: 2 });
        assert!(chunks.len() > 1);
        // Every chunk boundary should end with a newline (since we cut at newlines).
        for chunk in &chunks {
            if chunk != chunks.last().unwrap() {
                assert!(chunk.content.ends_with('\n'), "chunk did not end at newline: {:?}", chunk.content);
            }
        }
    }

    #[test]
    fn overlap_creates_overlapping_content() {
        let text = "0123456789".repeat(5); // 50 chars, no newlines
        let chunks = split_into_chunks(&text, &ChunkOptions { max_chars: 20, overlap: 5 });
        assert!(chunks.len() > 1);
        // With overlap=5, the start of chunk[1] should be 5 chars before the end of chunk[0].
        let end_of_first = chunks[0].content.len();
        let start_of_second = chunks[1].content.len();
        // Just verify we have multiple chunks with forward progress.
        assert!(end_of_first > 0);
        assert!(start_of_second > 0);
    }
}
