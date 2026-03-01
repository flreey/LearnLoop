/**
 * Storage facade: wraps raw repository CRUD operations and keeps the
 * SearchEngine index in sync automatically.  Tests for AC-2, AC-3, and AC-4
 * must call these methods — NOT the raw repository functions — so that the
 * integration between the storage layer and the search index is verified.
 */

import type { DB } from './db.js';
import type { SearchEngine } from '../search/index.js';
import type { MemoryEntry, ReflectionEntry } from '../types/index.js';
import {
  insertMemory as repoInsertMemory,
  updateMemory as repoUpdateMemory,
  deleteMemory as repoDeleteMemory,
  insertReflection as repoInsertReflection,
  getMemoryById,
} from './repository.js';

// ---------------------------------------------------------------------------
// StorageFacade — thin wrapper coupling DB writes to search-index updates
// ---------------------------------------------------------------------------

export class StorageFacade {
  constructor(
    private readonly db: DB,
    private readonly engine: SearchEngine,
  ) {}

  // ---- Memory operations --------------------------------------------------

  addMemory(memory: MemoryEntry): void {
    repoInsertMemory(this.db, memory);
    this.engine.addMemory(memory);
  }

  updateMemory(id: string, fields: Partial<Omit<MemoryEntry, 'id'>>): void {
    repoUpdateMemory(this.db, id, fields);
    // Re-read the full record from DB so the engine always reflects the
    // authoritative stored state (not just the partial diff).
    const updated = getMemoryById(this.db, id);
    if (updated) {
      this.engine.updateMemory(updated);
    }
  }

  deleteMemory(id: string): void {
    repoDeleteMemory(this.db, id);
    this.engine.removeMemory(id);
  }

  // ---- Reflection operations ----------------------------------------------

  addReflection(reflection: ReflectionEntry): void {
    repoInsertReflection(this.db, reflection);
    this.engine.addReflection(reflection);
  }
}
