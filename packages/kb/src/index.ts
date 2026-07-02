/**
 * Public surface of the `@llm-wiki/kb` knowledge-base engine.
 *
 * Consumed by the CLI commands (`packages/cli`) and the Next.js API routes
 * (`apps/web`). Everything below is implementation-agnostic — callers pass a
 * project root and a resolved {@link KbConfig}.
 */

// Types
export type {
  KbConfig,
  IndexStats,
  KbFileRecord,
  KbFileSummary,
  KbChunk,
  KbFileDetail,
  KbFileContent,
  KbLanguageStat,
  KbRootStat,
  KbStats,
  SearchSource,
  SearchHit,
  SearchResult,
  ListFilesOptions,
  KbFileListPage,
} from "./types.js";

// Config
export { DEFAULT_KB_CONFIG, getDefaultKbConfig, assertKbConfig, mergeKbConfig } from "./config.js";

// DB connection / init
export {
  openDatabase,
  closeConnection,
  withReadonlyDb,
  KB_DIR_NAME,
  DB_FILE_NAME,
  type KbConnection,
  type OpenOptions,
} from "./db/connection.js";
export { ensureKbDir, initSchema } from "./db/init.js";

// Scanning / chunking / embedding
export {
  scanFiles,
  languageFromExtension,
  SUPPORTED_EXTENSIONS,
  type ScannedFile,
} from "./scanner.js";
export { splitIntoChunks, type Chunk, type ChunkOptions } from "./chunker.js";
export { generateEmbedding, float32ToBytes } from "./embedding.js";

// Indexing / search / reading
export { indexFiles, type IndexRunOptions } from "./indexer.js";
export { searchKnowledgeBase, DEFAULT_SEARCH_LIMIT, type SearchRunOptions } from "./search.js";
export { getKbStats, listFiles, getFileDetail, getFileContent, getChunkDetail } from "./reader.js";
