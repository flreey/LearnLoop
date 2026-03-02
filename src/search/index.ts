// BM25 search engine wrapper (minisearch integration) + local vector embedding

import MiniSearch from 'minisearch';
import type { DB } from '../storage/db.js';
import type { MemoryEntry, ReflectionEntry } from '../types/index.js';

// ---------------------------------------------------------------------------
// CJK tokenizer
// ---------------------------------------------------------------------------

/**
 * Tokenize text supporting both Latin (word-boundary split) and CJK
 * (character-level split). CJK characters are split individually so that
 * MiniSearch can index and search them without a dictionary.
 *
 * Strategy: split on whitespace/punctuation for Latin text; for each resulting
 * token, if it contains CJK codepoints, further split into individual chars.
 */
function cjkTokenize(text: string): string[] {
  const tokens: string[] = [];
  // Split on whitespace and common punctuation first
  const parts = text.split(/[\s\p{P}]+/u).filter(Boolean);
  for (const part of parts) {
    if (/[\u3000-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF\u4E00-\u9FFF]/u.test(part)) {
      // Contains CJK — split into individual characters
      for (const ch of part) {
        if (ch.trim()) tokens.push(ch);
      }
    } else {
      tokens.push(part);
    }
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Document types for MiniSearch
// ---------------------------------------------------------------------------

interface MemoryDoc {
  id: string;
  content: string;
  subject: string;
}

interface ReflectionDoc {
  id: string;
  task_type: string;
  task_summary: string;
  reflection: string;
}

// ---------------------------------------------------------------------------
// Search result type
// ---------------------------------------------------------------------------

export interface SearchResult {
  id: string;
  score: number;
}

// ---------------------------------------------------------------------------
// EmbeddingEngine — lazy-loaded local model for vector embeddings
// ---------------------------------------------------------------------------

/**
 * Wraps @huggingface/transformers pipeline for generating 384-dim embeddings.
 * Model: Xenova/paraphrase-multilingual-MiniLM-L12-v2 (~140MB, cached after first load).
 *
 * IMPORTANT: init() must be called explicitly (e.g., at startup or during backfill).
 * The embedText() method does NOT trigger init() — it returns null immediately if not ready.
 * This prevents retrieval path timeouts when the model is loading or unavailable.
 */
export class EmbeddingEngine {
  private pipeline: ((text: string, options?: Record<string, unknown>) => Promise<{ data: Float32Array }>) | null = null;
  private loading: Promise<void> | null = null;
  private _failed = false;

  /**
   * Initialize the embedding pipeline.
   * Must be called explicitly — NOT triggered by embedText().
   * On failure, sets failed=true for silent degradation.
   */
  async init(): Promise<void> {
    if (this.pipeline !== null || this._failed) return;
    if (this.loading) {
      await this.loading;
      return;
    }

    this.loading = (async () => {
      try {
        // Dynamic import so startup doesn't load the heavy model unless needed
        const { pipeline, env } = await import('@huggingface/transformers');
        // Allow local cache usage
        env.allowLocalModels = true;
        const pipe = await pipeline('feature-extraction', 'Xenova/paraphrase-multilingual-MiniLM-L12-v2', {
          dtype: 'fp32',
        });
        // Store as typed function — actual type from transformers is complex, we cast
        this.pipeline = pipe as unknown as (text: string, options?: Record<string, unknown>) => Promise<{ data: Float32Array }>;
      } catch (err) {
        console.warn('[LearnLoop] EmbeddingEngine: model load failed, vector search disabled:', (err as Error).message);
        this._failed = true;
      }
    })();

    await this.loading;
  }

  /**
   * Returns true if the embedding model is ready to use.
   */
  get isReady(): boolean {
    return this.pipeline !== null && !this._failed;
  }

  /**
   * Returns true if the model has failed to load.
   */
  get failed(): boolean {
    return this._failed;
  }

  /**
   * Generate a 384-dim embedding for the given text.
   * Returns null immediately if model is not ready (does NOT trigger init).
   * Silent degradation — callers should handle null gracefully.
   */
  async embedText(text: string): Promise<Float32Array | null> {
    // Never trigger model load from the retrieval hot path
    if (!this.isReady) return null;

    try {
      const output = await this.pipeline!(text, { pooling: 'mean', normalize: true });
      // output.data is the flat Float32Array of the pooled embedding
      return output.data instanceof Float32Array ? output.data : new Float32Array(output.data);
    } catch (err) {
      console.warn('[LearnLoop] EmbeddingEngine: embedText failed:', (err as Error).message);
      return null;
    }
  }
}

// Singleton embedding engine shared across SearchEngine instances
const globalEmbeddingEngine = new EmbeddingEngine();

// ---------------------------------------------------------------------------
// Cosine similarity
// ---------------------------------------------------------------------------

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ---------------------------------------------------------------------------
// SearchEngine class
// ---------------------------------------------------------------------------

export class SearchEngine {
  private memoryIndex: MiniSearch<MemoryDoc>;
  private reflectionIndex: MiniSearch<ReflectionDoc>;

  // In-memory vector index: memoryId -> embedding Float32Array
  private vectorIndex: Map<string, Float32Array> = new Map();

  // Embedding engine (shared singleton or injected for testing)
  private embeddingEngine: EmbeddingEngine;

  constructor(embeddingEngine?: EmbeddingEngine) {
    this.embeddingEngine = embeddingEngine ?? globalEmbeddingEngine;

    this.memoryIndex = new MiniSearch<MemoryDoc>({
      idField: 'id',
      fields: ['content', 'subject'],
      storeFields: [],
      tokenize: cjkTokenize,
      searchOptions: {
        boost: { content: 2, subject: 1 },
        fuzzy: 0.2,
        prefix: true,
      },
    });

    this.reflectionIndex = new MiniSearch<ReflectionDoc>({
      idField: 'id',
      fields: ['task_type', 'task_summary', 'reflection'],
      storeFields: [],
      tokenize: cjkTokenize,
      searchOptions: {
        boost: { task_type: 3, task_summary: 2, reflection: 1 },
        fuzzy: 0.2,
        prefix: true,
      },
    });
  }

  // -------------------------------------------------------------------------
  // Memory index operations
  // -------------------------------------------------------------------------

  addMemory(memory: MemoryEntry): void {
    const doc: MemoryDoc = {
      id: memory.id,
      content: memory.content,
      subject: memory.subject,
    };
    this.memoryIndex.add(doc);
  }

  addAllMemories(memories: MemoryEntry[]): void {
    const docs: MemoryDoc[] = memories.map(m => ({
      id: m.id,
      content: m.content,
      subject: m.subject,
    }));
    this.memoryIndex.addAll(docs);
  }

  updateMemory(memory: MemoryEntry): void {
    const doc: MemoryDoc = {
      id: memory.id,
      content: memory.content,
      subject: memory.subject,
    };
    this.memoryIndex.replace(doc);
  }

  removeMemory(id: string): void {
    this.memoryIndex.discard(id);
    this.vectorIndex.delete(id);
  }

  searchMemories(query: string): SearchResult[] {
    try {
      const raw = this.memoryIndex.search(query);
      return raw.map(r => ({ id: String(r.id), score: r.score }));
    } catch {
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // Vector index operations
  // -------------------------------------------------------------------------

  /**
   * Store a pre-computed embedding in the in-memory vector index.
   */
  setEmbedding(id: string, embedding: Float32Array): void {
    this.vectorIndex.set(id, embedding);
  }

  /**
   * Load embeddings from DB into the in-memory vector index.
   * Reads all rows with non-null embedding BLOB.
   */
  loadEmbeddingsFromDB(db: DB): void {
    try {
      const rows = db
        .prepare('SELECT id, embedding FROM memories WHERE embedding IS NOT NULL')
        .all() as Array<{ id: string; embedding: Buffer }>;

      for (const row of rows) {
        if (row.embedding) {
          const embedding = new Float32Array(
            row.embedding.buffer,
            row.embedding.byteOffset,
            row.embedding.byteLength / 4,
          );
          this.vectorIndex.set(row.id, embedding);
        }
      }
    } catch (err) {
      console.warn('[LearnLoop] SearchEngine: failed to load embeddings from DB:', (err as Error).message);
    }
  }

  /**
   * Generate embedding for text using the embedding engine.
   * Returns null immediately if model is not ready (no blocking init).
   */
  async embedText(text: string): Promise<Float32Array | null> {
    return this.embeddingEngine.embedText(text);
  }

  /**
   * Trigger explicit init of the embedding model.
   * Should be called at startup, NOT during retrieval.
   */
  async initEmbedding(): Promise<void> {
    await this.embeddingEngine.init();
  }

  /**
   * Returns true if the embedding engine is ready to produce embeddings.
   */
  get isEmbeddingReady(): boolean {
    return this.embeddingEngine.isReady;
  }

  /**
   * Pure vector search: compute cosine similarity against all indexed embeddings.
   * Returns results sorted by descending similarity.
   * Linear scan — efficient for <=2000 entries.
   */
  searchMemoriesByVector(queryEmbedding: Float32Array, limit: number): SearchResult[] {
    if (this.vectorIndex.size === 0) return [];

    const results: SearchResult[] = [];
    for (const [id, embedding] of this.vectorIndex) {
      const score = cosineSimilarity(queryEmbedding, embedding);
      results.push({ id, score });
    }

    // Sort descending by score
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  // -------------------------------------------------------------------------
  // Reflection index operations
  // -------------------------------------------------------------------------

  addReflection(reflection: ReflectionEntry): void {
    const doc: ReflectionDoc = {
      id: reflection.id,
      task_type: reflection.task_type,
      task_summary: reflection.task_summary,
      reflection: reflection.reflection,
    };
    this.reflectionIndex.add(doc);
  }

  addAllReflections(reflections: ReflectionEntry[]): void {
    const docs: ReflectionDoc[] = reflections.map(r => ({
      id: r.id,
      task_type: r.task_type,
      task_summary: r.task_summary,
      reflection: r.reflection,
    }));
    this.reflectionIndex.addAll(docs);
  }

  updateReflection(reflection: ReflectionEntry): void {
    const doc: ReflectionDoc = {
      id: reflection.id,
      task_type: reflection.task_type,
      task_summary: reflection.task_summary,
      reflection: reflection.reflection,
    };
    this.reflectionIndex.replace(doc);
  }

  removeReflection(id: string): void {
    this.reflectionIndex.discard(id);
  }

  searchReflections(query: string): SearchResult[] {
    try {
      const raw = this.reflectionIndex.search(query);
      return raw.map(r => ({ id: String(r.id), score: r.score }));
    } catch {
      return [];
    }
  }
}

// ---------------------------------------------------------------------------
// Factory: createSearchEngine — rebuilds index from DB on initialization (AC10)
// ---------------------------------------------------------------------------

/**
 * Create a SearchEngine and populate its indexes from the current database
 * contents. This implements AC10: the index is rebuilt from DB on init.
 * Also loads pre-existing embeddings from DB into the in-memory vector index.
 */
export function createSearchEngine(db: DB): SearchEngine {
  const engine = new SearchEngine();

  // Load all memories from DB
  const memories = db.prepare('SELECT id, content, subject FROM memories').all() as Array<{
    id: string;
    content: string;
    subject: string;
  }>;
  if (memories.length > 0) {
    engine.addAllMemories(
      memories.map(m => ({
        id: m.id,
        content: m.content,
        subject: m.subject,
        // Provide minimal required MemoryEntry fields (unused by search index)
        type: 'fact' as const,
        confidence: 0,
        importance: 0,
        source_session: '',
        access_count: 0,
        last_accessed_at: null,
        created_at: '',
        updated_at: '',
      })),
    );
  }

  // Load all reflections from DB
  const reflections = db
    .prepare('SELECT id, task_type, task_summary, reflection FROM reflections')
    .all() as Array<{
    id: string;
    task_type: string;
    task_summary: string;
    reflection: string;
  }>;
  if (reflections.length > 0) {
    engine.addAllReflections(
      reflections.map(r => ({
        id: r.id,
        task_type: r.task_type,
        task_summary: r.task_summary,
        reflection: r.reflection,
        // Minimal required ReflectionEntry fields (unused by search index)
        outcome: 'success' as const,
        signals: '[]',
        lessons: '[]',
        agent_id: null,
        source_session: null,
        created_at: '',
      })),
    );
  }

  // Load pre-existing embeddings into vector index (synchronous, from DB BLOB)
  engine.loadEmbeddingsFromDB(db);

  return engine;
}

// Export singleton embedding engine for external use (e.g., backfill)
export { globalEmbeddingEngine };
