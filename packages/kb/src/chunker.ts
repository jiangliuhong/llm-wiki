/**
 * Text chunker.
 *
 * Splits a file's text into overlapping retrieval chunks. Ported from the
 * reference system's `splitIntoChunks`:
 *   - Target size is `maxChars` characters per chunk (char-based, not tokens).
 *   - Adjacent chunks overlap by `overlap` characters.
 *   - If a newline falls near the truncation point, the cut is moved to that
 *     newline to avoid slicing mid-line.
 *   - Empty / whitespace-only content yields no chunks.
 *   - Each chunk records its start/end 1-based line numbers in the source.
 *
 * (The reference docs note heading-aware splitting is a future improvement;
 * this implementation is the char/newline strategy as documented.)
 */

export interface ChunkOptions {
  maxChars: number;
  overlap: number;
}

export interface Chunk {
  content: string;
  startLine: number;
  endLine: number;
}

/** How far around a candidate cut to look for a newline boundary. */
const NEWLINE_SEARCH_RADIUS = 80;

/**
 * Splits `text` into chunks. Returns an empty array for blank content.
 */
export function splitIntoChunks(text: string, options: ChunkOptions): Chunk[] {
  const maxChars = Math.max(1, options.maxChars);
  const overlap = Math.min(Math.max(0, options.overlap), maxChars - 1);

  // Skip blank content entirely.
  if (text.trim().length === 0) {
    return [];
  }

  const chunks: Chunk[] = [];
  const len = text.length;

  let cursor = 0;
  while (cursor < len) {
    if (cursor > 0) {
      // The previous chunk already covered up to `end`; step back by `overlap`.
      // (cursor currently equals the previous end; adjust below.)
    }

    const idealEnd = cursor + maxChars;
    let end = idealEnd >= len ? len : findChunkEnd(text, cursor, idealEnd);

    const slice = text.slice(cursor, end);
    if (slice.trim().length > 0) {
      const { startLine, endLine } = lineRange(text, cursor, end);
      chunks.push({ content: slice, startLine, endLine });
    }

    if (end >= len) {
      break;
    }

    // Advance by (end - overlap), guaranteeing forward progress.
    const next = end - overlap;
    cursor = next > cursor ? next : end;
  }

  return chunks;
}

/**
 * Given an ideal cut position, searches backward (then forward) within a small
 * radius for a newline to cut at, returning its index (exclusive end). Falls
 * back to the ideal position if none is found.
 */
function findChunkEnd(text: string, start: number, idealEnd: number): number {
  const from = Math.max(start + 1, idealEnd - NEWLINE_SEARCH_RADIUS);
  const to = Math.min(text.length, idealEnd + NEWLINE_SEARCH_RADIUS);

  // Search backward for the latest newline at or before the ideal cut.
  for (let i = idealEnd; i >= from; i--) {
    if (text[i] === "\n") {
      return i + 1; // include the newline in this chunk
    }
  }
  // If none behind, take the next newline ahead (don't overshoot `to`).
  for (let i = idealEnd + 1; i <= to; i++) {
    if (text[i] === "\n") {
      return i + 1;
    }
  }
  return idealEnd;
}

/** Computes 1-based start/end line numbers for the slice [start, end). */
function lineRange(text: string, start: number, end: number): { startLine: number; endLine: number } {
  let startLine = 1;
  for (let i = 0; i < start; i++) {
    if (text[i] === "\n") startLine++;
  }

  // Count newlines in (start, end]; the end line is startLine + that count,
  // minus one if the slice ends exactly on a trailing newline boundary.
  let extra = 0;
  let sawNonNewlineAfterLastNewline = false;
  for (let i = start; i < end; i++) {
    if (text[i] === "\n") {
      extra++;
      sawNonNewlineAfterLastNewline = false;
    } else {
      sawNonNewlineAfterLastNewline = true;
    }
  }
  let endLine = startLine + extra;
  if (!sawNonNewlineAfterLastNewline && extra > 0) {
    // Slice ends on a newline; the newline opened a new line with no content.
    endLine -= 1;
  }
  if (endLine < startLine) endLine = startLine;
  return { startLine, endLine };
}
