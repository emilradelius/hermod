/**
 * Storage: one interface (Storage in src/types.ts), three adapters, one conformance suite
 * (test/runtime/storage-conformance.ts).
 */
export { createMemoryStorage, type MemoryStorageOptions } from "./memory.js";
export {
  createSqliteStorage,
  ftsQuery,
  type SqliteDatabase,
  type SqliteStatement,
  type SqliteStorageOptions,
} from "./sqlite.js";
export { SQLITE_DEFAULT_PREFIX, SQLITE_MIGRATIONS, validateSqlitePrefix } from "./sqlite-schema.js";
export {
  AGENT_DEFAULTS,
  buildSnippet,
  DEFAULT_CLAIM_LIMIT,
  DEFAULT_SEARCH_LIMIT,
  foldWord,
  MAX_QUERY_TERMS,
  searchTerms,
  SNIPPET_MARKS,
  StorageError,
  type StorageOptions,
} from "./common.js";
