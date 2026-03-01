/**
 * LLM client wrapper for GPT-4o-mini calls via OpenClaw proxy.
 * Handles memory extraction prompts and silent degradation on failure.
 */

import type { Message, MemoryType } from '../types/index.js';

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

const EXTRACTION_SYSTEM_PROMPT = `You are a memory extraction assistant. Analyze the conversation and extract memorable information.

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
- episode: specific events or interactions that occurred`;

function buildExtractionUserContent(history: Message[]): string {
  const lines = history.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n');
  // Keep prompt concise for cost target < $0.002
  return `Extract memories from this conversation:\n\n${lines.slice(0, 3000)}`;
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
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
          { role: 'user', content: buildExtractionUserContent(history) },
        ],
        temperature: 0.1,
        response_format: { type: 'json_object' },
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
 */
export function parseMemoryResponse(content: string): RawMemoryEntry[] {
  try {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
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
