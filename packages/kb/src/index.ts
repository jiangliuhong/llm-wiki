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
  RelationDirection,
  RelationSourceKind,
  RelationProposalStatus,
  RelationTypeDefinition,
  RelationEvidence,
  DocumentRelation,
  DocumentGraphNode,
  DocumentNeighborhood,
  RelationProposal,
  RelationDiagnostic,
  GraphSearchContext,
  IndexMetadata,
} from "./types.js";
export { EXPECTED_SCHEMA_VERSION } from "./types.js";

// Config
export { DEFAULT_KB_CONFIG, getDefaultKbConfig, assertKbConfig, mergeKbConfig } from "./config.js";

// DB connection / init
export {
  openDatabase,
  closeConnection,
  withReadonlyDb,
  resolveDbPath,
  KB_DIR_NAME,
  DB_FILE_NAME,
  type KbConnection,
  type OpenOptions,
} from "./db/connection.js";
export { ensureKbDir, initSchema } from "./db/init.js";
export { TABLE_NAMES } from "./db/schema.js";

// Scanning / chunking / embedding
export {
  scanFiles,
  scanFilesDetailed,
  languageFromExtension,
  SUPPORTED_EXTENSIONS,
  type ScannedFile,
  type ScanResult,
} from "./scanner.js";
export { splitIntoChunks, type Chunk, type ChunkOptions } from "./chunker.js";
export { generateEmbedding, float32ToBytes } from "./embedding.js";
export {
  computeConfigHash,
  writeIndexMetadata,
  readIndexMetadata,
  type IndexMetadataInput,
} from "./metadata.js";

// Indexing / search / reading
export { indexFiles, type IndexRunOptions } from "./indexer.js";
export {
  searchKnowledgeBase,
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  type SearchRunOptions,
} from "./search.js";
export { getKbStats, listFiles, getFileDetail, getFileContent, getChunkDetail } from "./reader.js";
export {
  getDocumentRelations,
  getDocumentNeighborhood,
  createRelationProposals,
  listRelationProposals,
  approveRelationProposal,
  rejectRelationProposal,
  listRelationDiagnostics,
  getGraphSearchContext,
  type GetRelationsOptions,
  type RelationProposalInput,
  type RelationProposalFile,
} from "./graph.js";
