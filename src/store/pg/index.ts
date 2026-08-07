import type { Db } from "../../db/types.js";
import type { MemoryStore } from "../types.js";
import {
  applyEnhancement,
  deferEnhancement,
  findEnhancementBacklog,
  findLiveByContentHash,
  insertRaw,
  recordEnhancementAttempt,
  restore,
  softDelete,
  touchUsage,
} from "./memories.js";
import { searchLexical } from "./lexical.js";
import { searchSemantic } from "./semantic.js";
import { searchByTag } from "./tags.js";

/** The real `MemoryStore`. All SQL lives in this directory and nowhere else (DD-032). */
export function createPgStore(db: Db): MemoryStore {
  return {
    findLiveByContentHash: (contentHash) => findLiveByContentHash(db, contentHash),
    insertRaw: (memory) => insertRaw(db, memory),
    applyEnhancement: (id, enhancement) => applyEnhancement(db, id, enhancement),
    searchLexical: (query, options) => searchLexical(db, query, options),
    searchSemantic: (vector, options) => searchSemantic(db, vector, options),
    searchByTag: (tags, match, limit) => searchByTag(db, tags, match, limit),
    touchUsage: (ids) => touchUsage(db, ids),
    softDelete: (id) => softDelete(db, id),
    restore: (id) => restore(db, id),
    findEnhancementBacklog: (limit, maxAttempts) => findEnhancementBacklog(db, limit, maxAttempts),
    recordEnhancementAttempt: (id) => recordEnhancementAttempt(db, id),
    deferEnhancement: (id) => deferEnhancement(db, id),
  };
}
