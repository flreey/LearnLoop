/**
 * Memory extraction, conflict detection, retrieval, and injection.
 * Implements: extractMemories, detectAndUpsert, lazyExtractionCheck,
 *             retrieveMemories, injectMemories
 *
 * retrieveMemories uses hybrid search (BM25 + vector) for better semantic recall.
 * Vector search degrades silently to pure BM25 if model is not ready.
 */

import { randomUUID } from 'crypto';
import type { DB } from '../storage/db.js';
import type { StorageFacade } from '../storage/facade.js';
import { getMemoriesBySubject, getSessionStateByKey, updateMemory } from '../storage/repository.js';
import type {
  MemoryEntry,
  MemoryType,
  Message,
  RetrievalWeights,
  ScoredMemoryEntry,
  SessionState,
} from '../types/index.js';
import { callLLM, type RawMemoryEntry } from '../llm/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UpsertResult {
  action: 'insert' | 'update';
  target_id: string | null;
}

export interface ExtractionResult {
  extracted: MemoryEntry[];
  conflicts_resolved: number;
}

export interface LazyExtractionCheckResult {
  should_extract: boolean;
  session_key: string | null;
}

// Partial memory input used for detectAndUpsert (without storage metadata)
export type NewMemoryInput = {
  type: MemoryType;
  content: string;
  subject: string;
  confidence: number;
  importance: number;
};

// ---------------------------------------------------------------------------
// Lazy Extraction Eligibility Check
// ---------------------------------------------------------------------------

/**
 * Determines whether the previous session's conversation history needs memory extraction.
 * Implements the lazy-extraction-check algorithm from design spec.
 *
 * Steps:
 * 1. If previous_session_key is null → should_extract = false
 * 2. Query session_states WHERE session_key = previous_session_key
 * 3. If no record found → should_extract = true (new session, not yet processed)
 * 4. If record found AND extracted = 0 → should_extract = true
 * 5. If record found AND extracted = 1 → should_extract = false
 */
export function lazyExtractionCheck(
  db: DB,
  previousSessionKey: string | null,
): LazyExtractionCheckResult {
  // Step 1: null key → no extraction needed
  if (previousSessionKey === null) {
    return { should_extract: false, session_key: null };
  }

  // Step 2: query session_states
  const record: SessionState | null = getSessionStateByKey(db, previousSessionKey);

  // Step 3: no record found → should extract (not yet processed)
  if (record === null) {
    return { should_extract: true, session_key: previousSessionKey };
  }

  // Step 4/5: check extracted flag
  const shouldExtract = record.extracted === 0;
  return { should_extract: shouldExtract, session_key: previousSessionKey };
}

// ---------------------------------------------------------------------------
// Conflict Detection and Upsert
// ---------------------------------------------------------------------------

/**
 * Detects conflict between new_memory and existing memories, then performs upsert.
 * Implements the memory-conflict-detection algorithm from design spec.
 *
 * Steps:
 * 1. Query existing memories WHERE subject = new_memory.subject
 * 2. If no existing → action = 'insert'
 * 3. If existing found, filter to same type
 *    3a. If same subject + same type → action = 'update'
 *    3b. Update fields: content, confidence, importance, updated_at (preserve the rest)
 * 4. If no same-type match but same subject exists → action = 'insert'
 */
export function detectAndUpsert(
  db: DB,
  facade: StorageFacade,
  sessionKey: string,
  newMemory: NewMemoryInput,
): UpsertResult {
  // Step 1: query existing memories for this subject
  const existing: MemoryEntry[] = getMemoriesBySubject(db, newMemory.subject);

  // Step 2: no existing memories for this subject → insert
  if (existing.length === 0) {
    const now = new Date().toISOString();
    const entry: MemoryEntry = {
      id: randomUUID(),
      type: newMemory.type,
      content: newMemory.content,
      subject: newMemory.subject,
      confidence: newMemory.confidence,
      importance: newMemory.importance,
      source_session: sessionKey,
      access_count: 0,
      last_accessed_at: null,
      created_at: now,
      updated_at: now,
    };
    facade.addMemory(entry);
    return { action: 'insert', target_id: null };
  }

  // Step 3: check for same type match
  const sameTypeMatch = existing.find(m => m.type === newMemory.type);

  if (sameTypeMatch) {
    // Step 3a/3b: same subject + same type → update (preserve id, created_at, source_session, access_count)
    const updatedAt = new Date().toISOString();
    facade.updateMemory(sameTypeMatch.id, {
      content: newMemory.content,
      confidence: newMemory.confidence,
      importance: newMemory.importance,
      updated_at: updatedAt,
    });
    return { action: 'update', target_id: sameTypeMatch.id };
  }

  // Step 4: same subject exists but different type → insert
  const now = new Date().toISOString();
  const entry: MemoryEntry = {
    id: randomUUID(),
    type: newMemory.type,
    content: newMemory.content,
    subject: newMemory.subject,
    confidence: newMemory.confidence,
    importance: newMemory.importance,
    source_session: sessionKey,
    access_count: 0,
    last_accessed_at: null,
    created_at: now,
    updated_at: now,
  };
  facade.addMemory(entry);
  return { action: 'insert', target_id: null };
}

// ---------------------------------------------------------------------------
// Extract Memories (main entry point)
// ---------------------------------------------------------------------------

/**
 * Extracts memories from conversation history via LLM, persists them with
 * conflict detection (upsert). Returns extracted memories and conflicts_resolved count.
 *
 * - LLM call failure → silent degradation (return empty result, no throw)
 * - Empty conversation or empty LLM response → return empty result
 */
export async function extractMemories(
  db: DB,
  facade: StorageFacade,
  sessionKey: string,
  conversationHistory: Message[],
): Promise<ExtractionResult> {
  // Empty conversation → nothing to extract
  if (conversationHistory.length === 0) {
    return { extracted: [], conflicts_resolved: 0 };
  }

  let rawMemories: RawMemoryEntry[];
  try {
    // LLM call — silent degradation on failure
    rawMemories = await callLLM(conversationHistory);
  } catch {
    // Defensive catch (callLLM should never throw, but handle just in case)
    rawMemories = [];
  }

  if (rawMemories.length === 0) {
    return { extracted: [], conflicts_resolved: 0 };
  }

  // Process each raw memory through conflict detection + upsert
  const extracted: MemoryEntry[] = [];
  let conflictsResolved = 0;

  for (const raw of rawMemories) {
    try {
      const result = detectAndUpsert(db, facade, sessionKey, raw);

      if (result.action === 'update') {
        conflictsResolved++;
        // Retrieve the updated entry from storage
        const updated = getMemoriesBySubject(db, raw.subject).find(
          m => m.type === raw.type,
        );
        if (updated) extracted.push(updated);
      } else {
        // Insert: retrieve the newly inserted entry by subject + type
        // (content match is avoided to prevent normalization mismatches)
        const inserted = getMemoriesBySubject(db, raw.subject).find(
          m => m.type === raw.type,
        );
        if (inserted) extracted.push(inserted);
      }
    } catch {
      // Silent degradation per memory — skip this entry on error
      continue;
    }
  }

  return { extracted, conflicts_resolved: conflictsResolved };
}

// ---------------------------------------------------------------------------
// Tri-Dimensional Memory Retrieval
// ---------------------------------------------------------------------------

/**
 * Default retrieval configuration matching design spec seed data.
 */
const DEFAULT_WEIGHTS: RetrievalWeights = {
  recency: 0.3,
  relevance: 0.5,
  importance: 0.2,
};
const DEFAULT_DECAY_LAMBDA = 0.01;

export interface RetrievalResult {
  memories: ScoredMemoryEntry[];
}

/**
 * Compute exponential recency score.
 * recency = exp(-lambda * hours_since_last_access)
 * Falls back to updated_at when last_accessed_at is null.
 */
function computeRecency(memory: MemoryEntry, lambda: number, now: Date): number {
  const referenceTime = memory.last_accessed_at ?? memory.updated_at;
  const referenceMs = new Date(referenceTime).getTime();
  const hoursSince = (now.getTime() - referenceMs) / (1000 * 60 * 60);
  return Math.exp(-lambda * Math.max(0, hoursSince));
}

/**
 * Normalize BM25 raw scores from MiniSearch to [0, 1] range.
 * MiniSearch scores have no fixed upper bound; we divide by the maximum score.
 * If max score is 0 (no results), returns empty map.
 */
function normalizeRelevanceScores(
  searchResults: Array<{ id: string; score: number }>,
): Map<string, number> {
  if (searchResults.length === 0) return new Map();

  const maxScore = Math.max(...searchResults.map(r => r.score));
  const normalized = new Map<string, number>();

  for (const r of searchResults) {
    normalized.set(r.id, maxScore > 0 ? r.score / maxScore : 0);
  }

  return normalized;
}

/**
 * Normalize vector similarity scores (already in [-1, 1] for cosine) to [0, 1].
 * We use (score + 1) / 2 to shift from [-1,1] to [0,1].
 * Then re-normalize by max to keep relative ordering.
 */
function normalizeVectorScores(
  searchResults: Array<{ id: string; score: number }>,
): Map<string, number> {
  if (searchResults.length === 0) return new Map();

  const normalized = new Map<string, number>();
  const maxScore = Math.max(...searchResults.map(r => r.score));

  for (const r of searchResults) {
    // Cosine similarity is in [-1, 1]; normalize to [0, 1] then scale by max
    const shifted = (r.score + 1) / 2;
    const maxShifted = (maxScore + 1) / 2;
    normalized.set(r.id, maxShifted > 0 ? shifted / maxShifted : 0);
  }

  return normalized;
}

/**
 * Hybrid relevance score combining BM25 and vector search.
 * hybrid_relevance = 0.3 * bm25_score + 0.7 * vector_score
 * If vector search is unavailable, falls back to pure BM25 (vector_score = 0, rescaled).
 */
function computeHybridRelevance(
  id: string,
  bm25Map: Map<string, number>,
  vectorMap: Map<string, number>,
  hasVector: boolean,
): number {
  const bm25 = bm25Map.get(id) ?? 0;
  const vector = vectorMap.get(id) ?? 0;

  if (!hasVector) {
    // Pure BM25 fallback
    return bm25;
  }

  return 0.3 * bm25 + 0.7 * vector;
}

/**
 * Tri-dimensional memory retrieval combining:
 *   score = a * recency + b * relevance + c * importance
 *
 * relevance is now hybrid: 0.3 * BM25 + 0.7 * vector (when vector available).
 * Falls back to pure BM25 if vector search fails.
 *
 * Candidate set: union of BM25 matches + top-K vector matches.
 * If BM25 returns 0 results AND vector search is available, uses vector-only candidates.
 *
 * @param db        SQLite database handle
 * @param facade    StorageFacade for index access (provides BM25 + vector search)
 * @param query     Search query string
 * @param limit     Maximum number of memories to return
 * @param weights   Optional custom weights (overrides defaults)
 * @param lambda    Optional time decay lambda (overrides default 0.01)
 */
export async function retrieveMemories(
  db: DB,
  facade: StorageFacade,
  query: string,
  limit: number,
  weights?: Partial<RetrievalWeights>,
  lambda?: number,
): Promise<RetrievalResult> {
  const w: RetrievalWeights = {
    recency: weights?.recency ?? DEFAULT_WEIGHTS.recency,
    relevance: weights?.relevance ?? DEFAULT_WEIGHTS.relevance,
    importance: weights?.importance ?? DEFAULT_WEIGHTS.importance,
  };
  const decayLambda = lambda ?? DEFAULT_DECAY_LAMBDA;

  // Step 1: BM25 search
  const bm25Results = facade.searchMemories(query);

  // Step 2: Vector search — only attempted if embedding model is ready (no blocking init)
  let vectorResults: Array<{ id: string; score: number }> = [];
  let hasVector = false;

  if (facade.isEmbeddingReady) {
    try {
      const queryEmbedding = await facade.embedText(query);
      if (queryEmbedding) {
        vectorResults = facade.searchMemoriesByVector(queryEmbedding, limit * 3);
        hasVector = vectorResults.length > 0;
      }
    } catch {
      // Silent degradation — vector search failure does not affect BM25 results
      hasVector = false;
    }
  }

  // Step 3: Build candidate set (union of BM25 + vector matches)
  const candidateIds = new Set<string>();

  for (const r of bm25Results) candidateIds.add(r.id);
  for (const r of vectorResults) candidateIds.add(r.id);

  // If no candidates at all, return empty
  if (candidateIds.size === 0) {
    return { memories: [] };
  }

  // Step 4: Normalize scores
  const bm25Map = normalizeRelevanceScores(bm25Results);
  const vectorMap = normalizeVectorScores(vectorResults);

  // Step 5: Load full memory entries for all candidates
  const idList = [...candidateIds];
  const placeholders = idList.map(() => '?').join(',');
  const allMemories = db
    .prepare(`SELECT * FROM memories WHERE id IN (${placeholders})`)
    .all(idList) as MemoryEntry[];

  if (allMemories.length === 0) {
    return { memories: [] };
  }

  // Step 6: Compute scores
  const now = new Date();
  const scored: ScoredMemoryEntry[] = allMemories.map(mem => {
    const recency = computeRecency(mem, decayLambda, now);
    const relevance = computeHybridRelevance(mem.id, bm25Map, vectorMap, hasVector);
    const importance = mem.importance;
    const score = w.recency * recency + w.relevance * relevance + w.importance * importance;

    return { ...mem, score };
  });

  // Step 7: Sort descending by score
  scored.sort((a, b) => b.score - a.score);

  // Step 8: Take top-N
  const topN = scored.slice(0, limit);

  // Step 9: Update access tracking for returned memories
  const accessedAt = new Date().toISOString();
  for (const mem of topN) {
    updateMemory(db, mem.id, {
      access_count: mem.access_count + 1,
      last_accessed_at: accessedAt,
    });
  }

  return { memories: topN };
}

// ---------------------------------------------------------------------------
// Memory Context Injection
// ---------------------------------------------------------------------------

/**
 * Retrieve relevant memories and inject them into the context string.
 *
 * - Executes tri-dimensional retrieval with context as query
 * - If no memories found, returns context unchanged (skip_if_empty)
 * - Otherwise prepends a formatted memory block to the context
 */
export async function injectMemories(
  db: DB,
  facade: StorageFacade,
  context: string,
  limit: number,
  weights?: Partial<RetrievalWeights>,
): Promise<string> {
  const result = await retrieveMemories(db, facade, context, limit, weights);

  if (result.memories.length === 0) {
    return context;
  }

  // Format memory block
  const memoryLines = result.memories.map((mem, idx) => {
    return `[${idx + 1}] (${mem.type}) ${mem.subject}: ${mem.content}`;
  });

  const memoryBlock = [
    '--- Relevant Memories ---',
    ...memoryLines,
    '--- End of Memories ---',
  ].join('\n');

  return `${memoryBlock}\n\n${context}`;
}
