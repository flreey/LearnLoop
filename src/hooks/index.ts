/**
 * OpenClaw plugin hook handlers.
 * Implements: handleBeforeTurn — lazy extraction trigger + memory context injection.
 */

import type { DB } from '../storage/db.js';
import type { StorageFacade } from '../storage/facade.js';
import { lazyExtractionCheck, extractMemories, retrieveMemories } from '../memory/index.js';
import { insertSessionState, updateSessionState } from '../storage/repository.js';
import { getConfig } from '../config/index.js';
import type { MemoryEntry, Message } from '../types/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BeforeTurnInput {
  session_key: string;
  conversation_context: string;
  previous_session_key: string | null;
  previous_conversation_history: Message[] | null;
}

export interface BeforeTurnResult {
  injected_memories: MemoryEntry[];
  extraction_triggered: boolean;
}

// ---------------------------------------------------------------------------
// handleBeforeTurn
// ---------------------------------------------------------------------------

/**
 * beforeTurn hook handler.
 *
 * Responsibilities:
 *   1. Check whether the previous session needs lazy memory extraction.
 *      If yes, mark the session as extracted and fire the extraction async
 *      (non-blocking). Silent degradation on failure.
 *   2. Synchronously execute tri-dimensional retrieval with conversation_context
 *      as the query and inject top-N memories into the result.
 *      Silent degradation on retrieval failure → empty array.
 *
 * Design refs:
 *   - business_rules[lazy-extraction-trigger]
 *   - business_rules[memory-injection-on-turn]
 *   - constraints[synchronous-injection]
 *   - endpoints[hook-before-turn]
 */
export async function handleBeforeTurn(
  db: DB,
  facade: StorageFacade,
  input: BeforeTurnInput,
): Promise<BeforeTurnResult> {
  const config = getConfig();
  const limit = config.retrieval.memoryInjectionLimit;

  // -------------------------------------------------------------------------
  // Step 1: Lazy extraction check (non-blocking async)
  // -------------------------------------------------------------------------

  let extractionTriggered = false;

  const checkResult = lazyExtractionCheck(db, input.previous_session_key);

  if (checkResult.should_extract && checkResult.session_key !== null) {
    extractionTriggered = true;
    const sessionKey = checkResult.session_key;
    const history = input.previous_conversation_history ?? [];

    // Mark session as extracted synchronously to avoid duplicate extraction
    // on concurrent hook calls. Upsert: insert if new, update if existing.
    const now = new Date().toISOString();
    const existingRecord = db
      .prepare('SELECT session_key FROM session_states WHERE session_key = ?')
      .get(sessionKey);

    if (existingRecord) {
      updateSessionState(db, sessionKey, { extracted: 1, updated_at: now });
    } else {
      insertSessionState(db, {
        session_key: sessionKey,
        extracted: 1,
        conversation_hash: null,
        created_at: now,
        updated_at: now,
      });
    }

    // Fire extraction asynchronously — do NOT await
    extractMemories(db, facade, sessionKey, history).catch(() => {
      // Silent degradation: log nothing, swallow error
    });
  }

  // -------------------------------------------------------------------------
  // Step 2: Synchronous tri-dimensional retrieval + injection
  // -------------------------------------------------------------------------

  let injectedMemories: MemoryEntry[] = [];

  try {
    const retrievalResult = await retrieveMemories(
      db,
      facade,
      input.conversation_context,
      limit,
    );
    injectedMemories = retrievalResult.memories;
  } catch {
    // Silent degradation: retrieval failure → empty injection
    injectedMemories = [];
  }

  return {
    injected_memories: injectedMemories,
    extraction_triggered: extractionTriggered,
  };
}
