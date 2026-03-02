/**
 * Storage facade: wraps raw repository CRUD operations and keeps the
 * SearchEngine index in sync automatically.  Tests for AC-2, AC-3, and AC-4
 * must call these methods — NOT the raw repository functions — so that the
 * integration between the storage layer and the search index is verified.
 *
 * Also handles async embedding generation: on addMemory/updateMemory, generates
 * a vector embedding and stores it in both DB and in-memory vector index.
 * Embedding failures degrade silently — core functionality is unaffected.
 */

import type { DB } from './db.js';
import type { SearchEngine, SearchResult } from '../search/index.js';
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
    // Async: generate and store embedding (fire-and-forget, silent degradation)
    // Only fires if model is already loaded — does not trigger lazy init
    this._generateAndStoreEmbedding(memory.id, `${memory.subject} ${memory.content}`).catch(() => {});
  }

  updateMemory(id: string, fields: Partial<Omit<MemoryEntry, 'id'>>): void {
    repoUpdateMemory(this.db, id, fields);
    // Re-read the full record from DB so the engine always reflects the
    // authoritative stored state (not just the partial diff).
    const updated = getMemoryById(this.db, id);
    if (updated) {
      this.engine.updateMemory(updated);
      // Regenerate embedding if content or subject changed (only if model ready)
      if (fields.content !== undefined || fields.subject !== undefined) {
        this._generateAndStoreEmbedding(id, `${updated.subject} ${updated.content}`).catch(() => {});
      }
    }
  }

  deleteMemory(id: string): void {
    repoDeleteMemory(this.db, id);
    this.engine.removeMemory(id);
  }

  // ---- Search operations --------------------------------------------------

  searchMemories(query: string): SearchResult[] {
    return this.engine.searchMemories(query);
  }

  searchReflections(query: string): SearchResult[] {
    return this.engine.searchReflections(query);
  }

  /**
   * Generate embedding for a query text.
   * Returns null immediately if model not ready (no blocking init).
   */
  async embedText(text: string): Promise<Float32Array | null> {
    return this.engine.embedText(text);
  }

  /**
   * Returns true if the embedding model is ready for inference.
   */
  get isEmbeddingReady(): boolean {
    return this.engine.isEmbeddingReady;
  }

  /**
   * Vector search over in-memory embedding index.
   * Returns results sorted by cosine similarity descending.
   */
  searchMemoriesByVector(queryEmbedding: Float32Array, limit: number): SearchResult[] {
    return this.engine.searchMemoriesByVector(queryEmbedding, limit);
  }

  // ---- Reflection operations ----------------------------------------------

  addReflection(reflection: ReflectionEntry): void {
    repoInsertReflection(this.db, reflection);
    this.engine.addReflection(reflection);
  }

  // ---- Embedding lifecycle ------------------------------------------------

  /**
   * Initialize the embedding model. Should be called explicitly at startup.
   * Does NOT block core functionality if it fails (silent degradation).
   */
  async initEmbedding(): Promise<void> {
    return this.engine.initEmbedding();
  }

  /**
   * Backfill embeddings for memories that don't have one yet.
   * Should be called after initEmbedding() succeeds.
   * Runs asynchronously and silently degrades on failure.
   */
  async backfillEmbeddings(): Promise<void> {
    if (!this.isEmbeddingReady) {
      console.info('[LearnLoop] Embedding model not ready, skipping backfill.');
      return;
    }

    try {
      // Find memories without embeddings
      const rows = this.db
        .prepare('SELECT id, subject, content FROM memories WHERE embedding IS NULL')
        .all() as Array<{ id: string; subject: string; content: string }>;

      if (rows.length === 0) return;

      console.info(`[LearnLoop] Backfilling embeddings for ${rows.length} memories...`);

      for (const row of rows) {
        await this._generateAndStoreEmbedding(row.id, `${row.subject} ${row.content}`);
      }

      console.info('[LearnLoop] Embedding backfill complete.');
    } catch (err) {
      console.warn('[LearnLoop] Embedding backfill failed:', (err as Error).message);
    }
  }

  // ---- Private helpers ----------------------------------------------------

  /**
   * Generate embedding for text and store in DB + vector index.
   * Returns immediately (no-op) if model not ready.
   * Silent degradation — does nothing if model fails.
   */
  private async _generateAndStoreEmbedding(id: string, text: string): Promise<void> {
    try {
      const embedding = await this.engine.embedText(text);
      if (!embedding) return; // model not ready or failed — silent no-op

      // Store as Buffer in SQLite
      const buf = Buffer.from(embedding.buffer);
      this.db.prepare('UPDATE memories SET embedding = ? WHERE id = ?').run(buf, id);

      // Update in-memory vector index
      this.engine.setEmbedding(id, embedding);
    } catch (err) {
      // Silent degradation — embedding failure must not affect core functionality
      console.warn('[LearnLoop] Failed to generate/store embedding:', (err as Error).message);
    }
  }
}
