/**
 * Reflection generation, signal resolution, retrieval, and injection.
 * Implements: resolveOutcome(), generateReflection()
 */

import type { OutcomeType, TaskSignals, Message } from '../types/index.js';
import { callReflectionLLM } from '../llm/index.js';
import type { RawReflectionEntry } from '../llm/index.js';

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
