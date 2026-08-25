import { createHash } from "node:crypto";

/**
 * Deterministic local "fake" embedding.
 *
 * Ported from the reference system's `generateEmbedding`:
 *   1. For each of `dimensions` (1536) dimension slots, compute
 *      SHA-256(`${index}:${text}`).
 *   2. Map the digest bytes into a float in [-1, 1].
 *   3. L2-normalize the whole vector.
 *   4. Return a `Float32Array`.
 *
 * This is NOT semantically meaningful — identical text always produces the
 * identical vector, which is enough for a deterministic KNN baseline. The
 * reference docs are explicit that only FTS provides reliable relevance today;
 * real embeddings can be swapped in by replacing this function (keeping the
 * `Float32Array` return type and `dimensions`).
 */

/** Reads up to 4 bytes of a digest as a big-endian uint32. */
function digestToUint32(digest: Buffer, offset: number): number {
  const b0 = digest[offset] ?? 0;
  const b1 = digest[(offset + 1) % digest.length] ?? 0;
  const b2 = digest[(offset + 2) % digest.length] ?? 0;
  const b3 = digest[(offset + 3) % digest.length] ?? 0;
  // (result >>> 0) keeps it an unsigned 32-bit integer.
  return (((b0 * 256 + b1) * 256 + b2) * 256 + b3) >>> 0;
}

/**
 * Generates a deterministic embedding vector for `text`.
 *
 * @param text        The text to embed.
 * @param dimensions  Vector length (must match the `vec_chunks` schema).
 * @returns A unit-length `Float32Array` of length `dimensions`.
 */
export function generateEmbedding(text: string, dimensions: number): Float32Array {
  const vec = new Float32Array(dimensions);

  for (let i = 0; i < dimensions; i++) {
    // Per-dimension hash: salt the text with the dimension index so each slot
    // gets an independent value.
    const hash = createHash("sha256").update(`${i}:${text}`, "utf8").digest();
    // Map a uint32 in [0, 2^32) to [-1, 1].
    const u = digestToUint32(hash, 0);
    vec[i] = u / 0x80000000 - 1; // 0x80000000 = 2^31
  }

  // L2-normalize so cosine similarity is well-defined.
  let sumSq = 0;
  for (let i = 0; i < dimensions; i++) {
    const v = vec[i] ?? 0;
    sumSq += v * v;
  }
  const norm = Math.sqrt(sumSq);
  if (norm > 0) {
    for (let i = 0; i < dimensions; i++) {
      vec[i] = (vec[i] ?? 0) / norm;
    }
  }
  return vec;
}

/**
 * Packs a Float32Array into a byte buffer for sqlite-vec storage / MATCH input.
 * sqlite-vec expects little-endian float32 values.
 */
export function float32ToBytes(vec: Float32Array): Uint8Array {
  const buffer = new ArrayBuffer(vec.byteLength);
  new Float32Array(buffer).set(vec);
  return new Uint8Array(buffer);
}
