/**
 * Reflection generation, signal resolution, retrieval, and injection.
 * Implements: resolveOutcome(), generateReflection(), retrieveReflections()
 */

import type { OutcomeType, TaskSignals, Message, ScoredReflectionEntry, ReflectionEntry } from '../types/index.js';
import { callReflectionLLM } from '../llm/index.js';
import type { RawReflectionEntry } from '../llm/index.js';
import type { DB } from '../storage/db.js';
import type { StorageFacade } from '../storage/facade.js';

// ---------------------------------------------------------------------------
// Signal patterns (from design: seed_data.signal_patterns)
// ---------------------------------------------------------------------------

const POSITIVE_FEEDBACK_KEYWORDS = ['谢谢', 'thanks', 'good', 'great', 'perfect', 'nice'];
const NEGATIVE_FEEDBACK_KEYWORDS = ['不对', '重来', 'wrong', 'redo', 'fix', '错'];

// ---------------------------------------------------------------------------
// resolveOutcome — signal-outcome resolution algorithm
// ---------------------------------------------------------------------------

/**
 * Resolves potentially conflicting task completion signals into a single
 * outcome classification for reflection generation.
 *
 * Design ref: algorithms[signal-outcome-resolution]
 */
export function resolveOutcome(signals: TaskSignals): OutcomeType {
  let failureSignals = 0;
  let successSignals = 0;

  // Step 2: timed_out
  if (signals.timed_out) {
    failureSignals += 1;
  }

  // Step 3: was_respawned
  if (signals.was_respawned) {
    failureSignals += 1;
  }

  // Step 4: review_result FAIL
  if (signals.review_result === 'FAIL') {
    failureSignals += 1;
  }

  // Step 5: review_result PASS
  if (signals.review_result === 'PASS') {
    successSignals += 1;
  }

  // Steps 6 & 7: user_feedback keyword matching
  if (signals.user_feedback && signals.user_feedback.length > 0) {
    const feedback = signals.user_feedback;
    const hasPositive = POSITIVE_FEEDBACK_KEYWORDS.some(kw =>
      feedback.toLowerCase().includes(kw.toLowerCase()),
    );
    const hasNegative = NEGATIVE_FEEDBACK_KEYWORDS.some(kw =>
      feedback.toLowerCase().includes(kw.toLowerCase()),
    );

    if (hasPositive) {
      successSignals += 1;
    }
    if (hasNegative) {
      failureSignals += 1;
    }
  }

  // Steps 8-11: classify
  if (failureSignals > 0 && successSignals > 0) {
    return 'partial';
  }
  if (failureSignals > 0 && successSignals === 0) {
    return 'failure';
  }
  if (successSignals > 0 && failureSignals === 0) {
    return 'success';
  }
  // Both are 0 → ambiguous
  return 'partial';
}

// ---------------------------------------------------------------------------
// generateReflection — LLM reflection generation function
// ---------------------------------------------------------------------------

/**
 * Async function: sends task context and signals to LLM for reflection generation.
 * Returns null on LLM failure (silent degradation).
 *
 * Design refs:
 *   - endpoints[internal-generate-reflection]
 *   - constraints[silent-degradation]
 *   - constraints[non-blocking-reflection]
 *   - integrations[llm-reflection-generation]
 */
export async function generateReflection(
  task_type: string,
  task_summary: string,
  conversation_history: Message[],
  signals: TaskSignals,
): Promise<RawReflectionEntry | null> {
  try {
    const outcome = resolveOutcome(signals);
    const result = await callReflectionLLM(task_type, task_summary, conversation_history, signals, outcome);
    return result;
  } catch {
    // Silent degradation — never throw
    return null;
  }
}

// ---------------------------------------------------------------------------
// retrieveReflections — BM25 retrieval by task_type and task_summary
// ---------------------------------------------------------------------------

/**
 * Internal function: BM25 search over reflections by task_type and task_summary.
 *
 * Combines task_type and task_summary into a single query string, performs
 * BM25 search via the SearchEngine, loads full ReflectionEntry records from
 * the DB for matched IDs, attaches BM25 scores, sorts descending, and slices
 * to the requested limit.
 *
 * Design refs:
 *   - endpoints[internal-retrieve-reflections]
 *   - constraints[retrieval-latency]
 *
 * @param db       SQLite database handle
 * @param facade   StorageFacade providing BM25 search access
 * @param task_type   Task type string for search query
 * @param task_summary Task summary string for search query
 * @param limit    Maximum number of results to return
 * @returns Scored reflection entries sorted by relevance descending
 */
export function retrieveReflections(
  db: DB,
  facade: StorageFacade,
  task_type: string,
  task_summary: string,
  limit: number,
): ScoredReflectionEntry[] {
  // Combine task_type and task_summary into a single BM25 query.
  // The SearchEngine's reflectionIndex is built on [task_summary, reflection]
  // fields. We also want to match on task_type. Concatenate both so MiniSearch
  // will tokenize and score across the full query.
  const query = `${task_type} ${task_summary}`.trim();

  if (!query) {
    return [];
  }

  // BM25 search via the facade (delegates to SearchEngine.searchReflections)
  const searchResults = facade.searchReflections(query);

  if (searchResults.length === 0) {
    return [];
  }

  // Build a score map for O(1) lookup
  const scoreMap = new Map<string, number>();
  for (const r of searchResults) {
    scoreMap.set(r.id, r.score);
  }

  // Load full ReflectionEntry records from DB for matched IDs
  const matchedIds = [...scoreMap.keys()];
  const placeholders = matchedIds.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT * FROM reflections WHERE id IN (${placeholders})`)
    .all(matchedIds) as ReflectionEntry[];

  if (rows.length === 0) {
    return [];
  }

  // Attach scores and sort descending
  const scored: ScoredReflectionEntry[] = rows.map(row => ({
    ...row,
    score: scoreMap.get(row.id) ?? 0,
  }));

  scored.sort((a, b) => b.score - a.score);

  // Apply limit
  return scored.slice(0, limit);
}
