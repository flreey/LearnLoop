/**
 * OpenClaw plugin hook handlers.
 * Implements: handleBeforeTurn — lazy extraction trigger + memory context injection.
 *             handleAfterTask — reflection generation orchestration and persistence.
 */

import { randomUUID } from 'crypto';
import type { DB } from '../storage/db.js';
import type { StorageFacade } from '../storage/facade.js';
import { lazyExtractionCheck, extractMemories, retrieveMemories } from '../memory/index.js';
import { insertSessionState, updateSessionState } from '../storage/repository.js';
import { getConfig } from '../config/index.js';
import { generateReflection, retrieveReflections } from '../reflection/index.js';
import type { MemoryEntry, Message, TaskSignals, ReflectionEntry, ScoredReflectionEntry } from '../types/index.js';

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

export interface AfterTaskInput {
  session_key: string;
  task_type: string;
  task_summary: string;
  conversation_history: Message[];
  signals: TaskSignals;
  agent_id: string | null;
}

export interface AfterTaskResult {
  reflection_id: string | null;
  outcome: string | null;
}

export interface BeforeSpawnInput {
  task_description: string;
  task_type: string;
  agent_id: string | null;
}

export interface BeforeSpawnResult {
  augmented_task_description: string;
  injected_reflections: ScoredReflectionEntry[];
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

// ---------------------------------------------------------------------------
// handleAfterTask
// ---------------------------------------------------------------------------

/**
 * afterTask hook handler.
 *
 * Responsibilities:
 *   1. Resolve task completion signals into a single outcome via resolveOutcome().
 *   2. Invoke generateReflection() asynchronously (fire-and-forget) to generate
 *      a structured reflection entry via LLM.
 *   3. Persist the generated reflection to the SQLite reflections table.
 *   4. Return reflection_id and outcome immediately (non-blocking).
 *      On LLM failure, return reflection_id=null, outcome=null.
 *
 * Design refs:
 *   - endpoints[hook-after-task]
 *   - business_rules[reflection-generation-on-task-complete]
 *   - constraints[non-blocking-reflection]
 *   - constraints[silent-degradation]
 */
export function handleAfterTask(
  _db: DB,
  facade: StorageFacade,
  input: AfterTaskInput,
): Promise<AfterTaskResult> {
  // Fire-and-forget: launch reflection generation asynchronously and return
  // { reflection_id: null, outcome: null } immediately to the caller.
  // The caller is never blocked by LLM or persistence latency.
  // See constraints[non-blocking-reflection].

  // Non-awaited inner async task — runs concurrently, result is discarded
  generateReflection(
    input.task_type,
    input.task_summary,
    input.conversation_history,
    input.signals,
  ).then((raw) => {
    if (raw === null) return;

    // Persist the generated reflection to SQLite
    const id = randomUUID();
    const now = new Date().toISOString();

    const entry: ReflectionEntry = {
      id,
      task_type: raw.task_type,
      task_summary: raw.task_summary,
      outcome: raw.outcome,
      signals: JSON.stringify(input.signals),
      reflection: raw.reflection,
      lessons: JSON.stringify(raw.lessons),
      agent_id: input.agent_id,
      source_session: input.session_key,
      created_at: now,
    };

    facade.addReflection(entry);
  }).catch(() => {
    // Silent degradation — swallow all errors, never re-throw
  });

  // Return immediately with null sentinel — caller is not blocked
  return Promise.resolve({ reflection_id: null, outcome: null });
}

// ---------------------------------------------------------------------------
// handleBeforeSpawn
// ---------------------------------------------------------------------------

/**
 * beforeSpawn hook handler.
 *
 * Responsibilities:
 *   1. Synchronously retrieve relevant reflections via BM25 search using
 *      task_type and task_description as the query.
 *   2. If matching reflections found, append them to the task_description.
 *   3. Return augmented_task_description (original + injected reflections)
 *      and injected_reflections array.
 *   4. If no matching reflections, return original task_description unchanged
 *      and empty injected_reflections array.
 *
 * Spawn MUST await this hook before proceeding — injection is synchronous
 * (retrieval happens within the await, not fire-and-forget).
 *
 * Design refs:
 *   - endpoints[hook-before-spawn]
 *   - business_rules[reflection-injection-on-spawn]
 *   - constraints[retrieval-latency]
 */
export async function handleBeforeSpawn(
  db: DB,
  facade: StorageFacade,
  input: BeforeSpawnInput,
): Promise<BeforeSpawnResult> {
  const config = getConfig();
  const limit = config.retrieval.reflectionInjectionLimit;

  // Retrieve relevant reflections via BM25 (synchronous — must complete before return)
  const matchedReflections = retrieveReflections(
    db,
    facade,
    input.task_type,
    input.task_description,
    limit,
  );

  // Skip injection if no matches (skip_if_empty per design spec)
  if (matchedReflections.length === 0) {
    return {
      augmented_task_description: input.task_description,
      injected_reflections: [],
    };
  }

  // Format injected reflection block
  const reflectionLines = matchedReflections.map((r, idx) => {
    return `[${idx + 1}] [${r.task_type}] ${r.task_summary} (${r.outcome}): ${r.reflection}`;
  });

  const reflectionBlock = [
    '--- Relevant Past Reflections ---',
    ...reflectionLines,
    '--- End of Reflections ---',
  ].join('\n');

  const augmentedDescription = `${input.task_description}\n\n${reflectionBlock}`;

  return {
    augmented_task_description: augmentedDescription,
    injected_reflections: matchedReflections,
  };
}
