/**
 * Memory extraction, conflict detection, retrieval, and injection.
 * Implements: extractMemories, detectAndUpsert, lazyExtractionCheck
 */

import { randomUUID } from 'crypto';
import type { DB } from '../storage/db.js';
import type { StorageFacade } from '../storage/facade.js';
import { getMemoriesBySubject, getSessionStateByKey } from '../storage/repository.js';
import type { MemoryEntry, MemoryType, Message, SessionState } from '../types/index.js';
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
 * - Empty conversation or empty LLM response ��� return empty result
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
