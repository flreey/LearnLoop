/**
 * LLM client wrapper for memory extraction and reflection generation.
 * Handles silent degradation on failure + markdown code fence stripping.
 *
 * NOTE: cyberbub proxy does not reliably pass system messages to Claude.
 * All prompts are sent as a single user message to ensure instruction following.
 */

import type { Message, MemoryType, OutcomeType, TaskSignals } from '../types/index.js';

// ---------------------------------------------------------------------------
// Utility: strip markdown code fences from LLM response
// ---------------------------------------------------------------------------

/**
 * Strip markdown code fences from LLM response content.
 * Handles:
 *   - Plain JSON (returned as-is)
 *   - ```json ... ``` wrapped
 *   - ``` ... ``` wrapped
 *   - Content with trailing natural-language text after the fence
 */
export function stripCodeFences(content: string): string {
  const trimmed = content.trim();
  const match = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (match) {
    return match[1].trim();
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RawMemoryEntry {
  type: MemoryType;
  content: string;
  subject: string;
  confidence: number;
  importance: number;
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

function buildExtractionPrompt(history: Message[]): string {
  const lines = history.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n');
  // Keep conversation excerpt concise for cost target < $0.002
  const conversationExcerpt = lines.slice(0, 3000);

  return `You are a memory extraction assistant. Analyze the conversation below and extract memorable information.

IMPORTANT: You MUST respond with ONLY a raw JSON object. No explanation, no markdown, no code fences, no commentary. Just the JSON.

Return a JSON object with a "memories" key containing an array of memory entries. Each entry must have:
- type: "preference" | "fact" | "entity" | "episode"
- content: string (the memorable information)
- subject: string (short kebab-case identifier for the topic/entity)
- confidence: number 0-1 (how certain you are)
- importance: number 0-1 (how important to remember)

If nothing memorable, return {"memories": []}.

Example: {"memories": [{"type": "preference", "content": "User prefers dark mode", "subject": "ui-theme", "confidence": 0.9, "importance": 0.7}]}

Types:
- preference: user likes/dislikes, settings, style preferences
- fact: factual information about the user or world
- entity: people, places, organizations mentioned
- episode: specific events or interactions that occurred

Conversation:
${conversationExcerpt}

Respond with ONLY the JSON object:`;
}

// ---------------------------------------------------------------------------
// LLM call
// ---------------------------------------------------------------------------

/**
 * Call LLM to extract memories from conversation history.
 * Returns parsed memory entries. On any failure, returns empty array (silent degradation).
 */
export async function callLLM(history: Message[]): Promise<RawMemoryEntry[]> {
  if (history.length === 0) {
    return [];
  }

  try {
    // OpenClaw proxy endpoint — uses OPENCLAW_API_KEY or OPENAI_API_KEY env var
    const apiKey = process.env['OPENCLAW_API_KEY'] ?? process.env['OPENAI_API_KEY'] ?? '';
    const baseUrl = process.env['OPENCLAW_API_BASE'] ?? 'https://api.openai.com/v1';

    if (!apiKey) {
      // No API key configured — silent degradation
      return [];
    }

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: process.env['OPENCLAW_LLM_MODEL'] ?? 'gpt-4o-mini',
        messages: [
          { role: 'user', content: buildExtractionPrompt(history) },
        ],
        temperature: 0.1,
        max_tokens: 1000,
      }),
    });

    if (!response.ok) {
      // HTTP error — silent degradation
      return [];
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      return [];
    }

    return parseMemoryResponse(content);
  } catch {
    // Network error, parse error, or any exception — silent degradation
    return [];
  }
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

function isValidMemoryType(t: unknown): t is MemoryType {
  return t === 'preference' || t === 'fact' || t === 'entity' || t === 'episode';
}

function clamp(n: unknown): number {
  const v = typeof n === 'number' ? n : parseFloat(String(n));
  if (!isFinite(v)) return 0.5;
  return Math.max(0, Math.min(1, v));
}

/**
 * Parse LLM response content into RawMemoryEntry[].
 * Returns empty array on any parse error.
 * Handles markdown code fences wrapping JSON.
 */
export function parseMemoryResponse(content: string): RawMemoryEntry[] {
  try {
    const stripped = stripCodeFences(content);
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripped);
    } catch {
      return [];
    }

    // Support both array directly or object with "memories" key
    let arr: unknown[];
    if (Array.isArray(parsed)) {
      arr = parsed;
    } else if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'memories' in parsed &&
      Array.isArray((parsed as Record<string, unknown>)['memories'])
    ) {
      arr = (parsed as Record<string, unknown>)['memories'] as unknown[];
    } else {
      return [];
    }

    const results: RawMemoryEntry[] = [];
    for (const item of arr) {
      if (item === null || typeof item !== 'object') continue;
      const entry = item as Record<string, unknown>;

      if (!isValidMemoryType(entry['type'])) continue;
      if (typeof entry['content'] !== 'string' || entry['content'].trim() === '') continue;
      if (typeof entry['subject'] !== 'string' || entry['subject'].trim() === '') continue;

      results.push({
        type: entry['type'],
        content: entry['content'].trim(),
        subject: entry['subject'].trim(),
        confidence: clamp(entry['confidence'] ?? 0.7),
        importance: clamp(entry['importance'] ?? 0.5),
      });
    }

    return results;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Reflection LLM types
// ---------------------------------------------------------------------------

export interface RawReflectionEntry {
  task_type: string;
  task_summary: string;
  outcome: OutcomeType;
  reflection: string;
  lessons: string[];
}

// ---------------------------------------------------------------------------
// Reflection prompt construction
// ---------------------------------------------------------------------------

function buildReflectionPrompt(
  task_type: string,
  task_summary: string,
  history: Message[],
  signals: TaskSignals,
  outcome: OutcomeType,
): string {
  const historyStr = history
    .slice(-10)
    .map(m => `${m.role.toUpperCase()}: ${m.content}`)
    .join('\n');

  const signalsStr = JSON.stringify(signals);

  return `You are a reflection assistant using Reflexion methodology. Analyze the task context below and generate a structured reflection entry.

IMPORTANT: You MUST respond with ONLY a raw JSON object. No explanation, no markdown, no code fences, no commentary. Just the JSON.

Return a JSON object with these fields:
- task_type: "code" | "research" | "deployment" (classify the task)
- task_summary: string (concise one-sentence summary of what was done)
- outcome: "success" | "failure" | "partial" (use the resolved outcome provided)
- reflection: string (what happened, what worked, what didn't, Reflexion-style retrospective)
- lessons: array of strings (2-5 actionable lessons learned)

Keep reflection concise (2-4 sentences). Lessons should be specific and actionable.

Task Type: ${task_type}
Task Summary: ${task_summary}
Resolved Outcome: ${outcome}
Signals: ${signalsStr}

Recent Conversation:
${historyStr.slice(0, 2000)}

Respond with ONLY the JSON object:`;
}

// ---------------------------------------------------------------------------
// LLM call for reflection generation
// ---------------------------------------------------------------------------

/**
 * Call LLM to generate a reflection entry from task context.
 * Returns parsed reflection entry. On any failure, returns null (silent degradation).
 */
export async function callReflectionLLM(
  task_type: string,
  task_summary: string,
  history: Message[],
  signals: TaskSignals,
  outcome: OutcomeType,
): Promise<RawReflectionEntry | null> {
  try {
    const apiKey = process.env['OPENCLAW_API_KEY'] ?? process.env['OPENAI_API_KEY'] ?? '';
    const baseUrl = process.env['OPENCLAW_API_BASE'] ?? 'https://api.openai.com/v1';

    if (!apiKey) {
      // No API key configured — silent degradation
      return null;
    }

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: process.env['OPENCLAW_LLM_MODEL'] ?? 'gpt-4o-mini',
        messages: [
          { role: 'user', content: buildReflectionPrompt(task_type, task_summary, history, signals, outcome) },
        ],
        temperature: 0.3,
        max_tokens: 800,
      }),
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      return null;
    }

    return parseReflectionResponse(content);
  } catch {
    // Network error, parse error, or any exception — silent degradation
    return null;
  }
}

// ---------------------------------------------------------------------------
// Reflection response parsing
// ---------------------------------------------------------------------------

function isValidOutcome(o: unknown): o is OutcomeType {
  return o === 'success' || o === 'failure' || o === 'partial';
}

/**
 * Parse LLM response content into RawReflectionEntry.
 * Returns null on any parse error.
 * Handles markdown code fences wrapping JSON.
 */
export function parseReflectionResponse(content: string): RawReflectionEntry | null {
  try {
    const stripped = stripCodeFences(content);
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripped);
    } catch {
      return null;
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }

    const obj = parsed as Record<string, unknown>;

    if (typeof obj['task_type'] !== 'string' || obj['task_type'].trim() === '') return null;
    if (typeof obj['task_summary'] !== 'string' || obj['task_summary'].trim() === '') return null;
    if (!isValidOutcome(obj['outcome'])) return null;
    if (typeof obj['reflection'] !== 'string' || obj['reflection'].trim() === '') return null;

    const lessonsRaw = obj['lessons'];
    const lessons: string[] = [];
    if (Array.isArray(lessonsRaw)) {
      for (const l of lessonsRaw) {
        if (typeof l === 'string' && l.trim() !== '') {
          lessons.push(l.trim());
        }
      }
    }

    return {
      task_type: obj['task_type'].trim(),
      task_summary: obj['task_summary'].trim(),
      outcome: obj['outcome'],
      reflection: obj['reflection'].trim(),
      lessons,
    };
  } catch {
    return null;
  }
}
