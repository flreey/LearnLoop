/**
 * Tests for beforeTurn hook handler.
 * Covers: handleBeforeTurn() — lazy extraction trigger, memory retrieval injection,
 *         silent degradation, and result shape.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { initializeDatabase } from '../../src/storage/db.js';
import { createSearchEngine } from '../../src/search/index.js';
import { StorageFacade } from '../../src/storage/facade.js';
import { insertSessionState } from '../../src/storage/repository.js';
import { handleBeforeTurn } from '../../src/hooks/index.js';
import * as memoryModule from '../../src/memory/index.js';
import type { DB } from '../../src/storage/db.js';
import type { MemoryEntry, Message } from '../../src/types/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDbPath(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'learnloop-hooks-test-'));
  return path.join(tmpDir, 'test.db');
}

function makeMemory(overrides: Partial<MemoryEntry> & { id: string }): MemoryEntry {
  const now = new Date().toISOString();
  return {
    type: 'fact',
    content: 'default content about TypeScript',
    subject: 'typescript',
    confidence: 0.8,
    importance: 0.7,
    source_session: 'session-source',
    access_count: 0,
    last_accessed_at: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function makeSessionHistory(): Message[] {
  return [
    { role: 'user', content: 'Tell me about TypeScript.' },
    { role: 'assistant', content: 'TypeScript is a superset of JavaScript...' },
  ];
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let db: DB;
let tempDbPath: string;
let facade: StorageFacade;

beforeEach(() => {
  tempDbPath = makeTempDbPath();
  db = initializeDatabase(tempDbPath);
  const engine = createSearchEngine(db);
  facade = new StorageFacade(db, engine);
});

afterEach(() => {
  vi.restoreAllMocks();
  try { db.close(); } catch { /* ignore */ }
  try {
    fs.rmSync(path.dirname(tempDbPath), { recursive: true, force: true });
  } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// AC1: Return shape — injected_memories and extraction_triggered
// ---------------------------------------------------------------------------

describe('handleBeforeTurn - return shape', () => {
  it('returns object with injected_memories array and extraction_triggered boolean (AC1)', async () => {
    const result = await handleBeforeTurn(db, facade, {
      session_key: 'session-current',
      conversation_context: 'discussing TypeScript project structure',
      previous_session_key: null,
      previous_conversation_history: null,
    });

    expect(result).toHaveProperty('injected_memories');
    expect(result).toHaveProperty('extraction_triggered');
    expect(Array.isArray(result.injected_memories)).toBe(true);
    expect(typeof result.extraction_triggered).toBe('boolean');
  });

  it('each memory entry in injected_memories contains id, type, content, subject, importance (AC9)', async () => {
    // Add a memory relevant to the query
    facade.addMemory(makeMemory({
      id: 'mem-shape-check',
      content: 'TypeScript strict mode improves code quality',
      subject: 'typescript-strict',
      importance: 0.8,
    }));

    const result = await handleBeforeTurn(db, facade, {
      session_key: 'session-current',
      conversation_context: 'TypeScript strict mode configuration',
      previous_session_key: null,
      previous_conversation_history: null,
    });

    for (const mem of result.injected_memories) {
      expect(mem).toHaveProperty('id');
      expect(mem).toHaveProperty('type');
      expect(mem).toHaveProperty('content');
      expect(mem).toHaveProperty('subject');
      expect(mem).toHaveProperty('importance');
      expect(typeof mem.id).toBe('string');
      expect(typeof mem.type).toBe('string');
      expect(typeof mem.content).toBe('string');
      expect(typeof mem.subject).toBe('string');
      expect(typeof mem.importance).toBe('number');
    }
  });
});

// ---------------------------------------------------------------------------
// AC2: previous_session_key non-null + not extracted → extraction_triggered = true
// ---------------------------------------------------------------------------

describe('handleBeforeTurn - lazy extraction trigger', () => {
  it('triggers extraction when previous_session_key exists and session is unextracted (AC2)', async () => {
    // No session_states record exists for 'session-prev' → should_extract = true
    const result = await handleBeforeTurn(db, facade, {
      session_key: 'session-current',
      conversation_context: 'any context',
      previous_session_key: 'session-prev',
      previous_conversation_history: makeSessionHistory(),
    });

    expect(result.extraction_triggered).toBe(true);
  });

  it('extraction runs asynchronously (non-blocking) — hook returns quickly (AC2)', async () => {
    // Spy on extractMemories to verify it is called but not awaited
    let extractStarted = false;
    let extractResolved = false;

    vi.spyOn(memoryModule, 'extractMemories').mockImplementation(async () => {
      extractStarted = true;
      // Simulate slow extraction
      await new Promise(resolve => setTimeout(resolve, 50));
      extractResolved = true;
      return { extracted: [], conflicts_resolved: 0 };
    });

    const start = Date.now();
    const result = await handleBeforeTurn(db, facade, {
      session_key: 'session-current',
      conversation_context: 'context',
      previous_session_key: 'session-prev',
      previous_conversation_history: makeSessionHistory(),
    });
    const elapsed = Date.now() - start;

    // Hook should return before the 50ms extraction completes
    expect(elapsed).toBeLessThan(50);
    expect(extractStarted).toBe(true);   // extraction was kicked off
    expect(extractResolved).toBe(false); // but hasn't finished yet
    expect(result.extraction_triggered).toBe(true);

    // Wait for async extraction to finish (cleanup)
    await new Promise(resolve => setTimeout(resolve, 60));
  });

  it('calls extractMemories with the previous session key and history (AC2)', async () => {
    const extractSpy = vi.spyOn(memoryModule, 'extractMemories').mockResolvedValue({
      extracted: [],
      conflicts_resolved: 0,
    });

    const history = makeSessionHistory();
    await handleBeforeTurn(db, facade, {
      session_key: 'session-current',
      conversation_context: 'any',
      previous_session_key: 'session-prev',
      previous_conversation_history: history,
    });

    // Wait for async fire-and-forget to settle
    await new Promise(resolve => setTimeout(resolve, 20));

    expect(extractSpy).toHaveBeenCalledWith(
      db,
      facade,
      'session-prev',
      history,
    );
  });

  // AC3: previous_session_key null → extraction_triggered = false
  it('returns extraction_triggered=false when previous_session_key is null (AC3)', async () => {
    const extractSpy = vi.spyOn(memoryModule, 'extractMemories').mockResolvedValue({
      extracted: [],
      conflicts_resolved: 0,
    });

    const result = await handleBeforeTurn(db, facade, {
      session_key: 'session-current',
      conversation_context: 'any context',
      previous_session_key: null,
      previous_conversation_history: null,
    });

    expect(result.extraction_triggered).toBe(false);
    expect(extractSpy).not.toHaveBeenCalled();
  });

  // AC4: already extracted → extraction_triggered = false
  it('returns extraction_triggered=false when previous session is already extracted (AC4)', async () => {
    const now = new Date().toISOString();
    // Insert a session_states record with extracted = 1
    insertSessionState(db, {
      session_key: 'session-already-extracted',
      extracted: 1,
      conversation_hash: null,
      created_at: now,
      updated_at: now,
    });

    const extractSpy = vi.spyOn(memoryModule, 'extractMemories').mockResolvedValue({
      extracted: [],
      conflicts_resolved: 0,
    });

    const result = await handleBeforeTurn(db, facade, {
      session_key: 'session-current',
      conversation_context: 'any context',
      previous_session_key: 'session-already-extracted',
      previous_conversation_history: makeSessionHistory(),
    });

    expect(result.extraction_triggered).toBe(false);
    expect(extractSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC5: Synchronous retrieval with conversation_context as query, top-N from config
// ---------------------------------------------------------------------------

describe('handleBeforeTurn - memory retrieval injection', () => {
  it('retrieves memories synchronously using conversation_context as query (AC5)', async () => {
    // Add relevant memories to DB
    facade.addMemory(makeMemory({
      id: 'mem-ts-1',
      content: 'TypeScript strict mode improves type safety in large projects',
      subject: 'typescript-strict',
      importance: 0.9,
    }));
    facade.addMemory(makeMemory({
      id: 'mem-ts-2',
      content: 'TypeScript project structure uses src directory convention',
      subject: 'typescript-project',
      importance: 0.7,
    }));

    const result = await handleBeforeTurn(db, facade, {
      session_key: 'session-current',
      conversation_context: 'TypeScript project structure and configuration',
      previous_session_key: null,
      previous_conversation_history: null,
    });

    expect(result.injected_memories.length).toBeGreaterThan(0);
    // Verify the memories relate to the TypeScript query
    const hasTypescriptMemory = result.injected_memories.some(
      m => m.subject.includes('typescript') || m.content.toLowerCase().includes('typescript'),
    );
    expect(hasTypescriptMemory).toBe(true);
  });

  it('respects memory_injection_limit from config (AC5)', async () => {
    // Add more memories than the default limit (10)
    for (let i = 0; i < 15; i++) {
      facade.addMemory(makeMemory({
        id: `mem-limit-${i}`,
        content: `TypeScript advanced feature number ${i} for type checking`,
        subject: `typescript-feature-${i}`,
        importance: 0.5 + i * 0.02,
      }));
    }

    const result = await handleBeforeTurn(db, facade, {
      session_key: 'session-current',
      conversation_context: 'TypeScript type checking features',
      previous_session_key: null,
      previous_conversation_history: null,
    });

    // Default config limit is 10
    expect(result.injected_memories.length).toBeLessThanOrEqual(10);
  });

  // AC6: empty retrieval → empty array
  it('returns empty injected_memories when no memories match the query (AC6)', async () => {
    // No memories in DB
    const result = await handleBeforeTurn(db, facade, {
      session_key: 'session-current',
      conversation_context: 'some conversation context with no matching memories',
      previous_session_key: null,
      previous_conversation_history: null,
    });

    expect(result.injected_memories).toHaveLength(0);
  });

  it('returns empty injected_memories when database has no memories at all (AC6)', async () => {
    const result = await handleBeforeTurn(db, facade, {
      session_key: 'session-current',
      conversation_context: 'TypeScript is great',
      previous_session_key: null,
      previous_conversation_history: null,
    });

    expect(result.injected_memories).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC7: Async extraction failure → silent degradation
// ---------------------------------------------------------------------------

describe('handleBeforeTurn - silent degradation on extraction failure', () => {
  it('does not throw when async extraction fails (AC7)', async () => {
    // Make extractMemories reject
    vi.spyOn(memoryModule, 'extractMemories').mockRejectedValue(new Error('LLM service unavailable'));

    // Add a relevant memory so injected_memories is non-empty
    facade.addMemory(makeMemory({
      id: 'mem-degr-1',
      content: 'TypeScript union types are powerful for type safety',
      subject: 'typescript-unions',
      importance: 0.8,
    }));

    let result: Awaited<ReturnType<typeof handleBeforeTurn>> | undefined;
    let threw = false;
    try {
      result = await handleBeforeTurn(db, facade, {
        session_key: 'session-current',
        conversation_context: 'TypeScript union types',
        previous_session_key: 'session-prev',
        previous_conversation_history: makeSessionHistory(),
      });
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(result).toBeDefined();
    expect(result!.extraction_triggered).toBe(true);

    // Give async extraction time to fail silently
    await new Promise(resolve => setTimeout(resolve, 20));
  });

  it('still returns injected_memories when extraction fails asynchronously (AC7)', async () => {
    vi.spyOn(memoryModule, 'extractMemories').mockRejectedValue(new Error('LLM unavailable'));

    facade.addMemory(makeMemory({
      id: 'mem-degr-2',
      content: 'TypeScript generics enable reusable type-safe code',
      subject: 'typescript-generics',
      importance: 0.85,
    }));

    const result = await handleBeforeTurn(db, facade, {
      session_key: 'session-current',
      conversation_context: 'TypeScript generics reusable',
      previous_session_key: 'session-prev',
      previous_conversation_history: makeSessionHistory(),
    });

    // injected_memories should still contain relevant memories
    expect(result.injected_memories.length).toBeGreaterThan(0);

    await new Promise(resolve => setTimeout(resolve, 20));
  });
});

// ---------------------------------------------------------------------------
// AC8: Retrieval failure → silent degradation, empty injected_memories
// ---------------------------------------------------------------------------

describe('handleBeforeTurn - silent degradation on retrieval failure', () => {
  it('does not throw when retrieval fails (AC8)', async () => {
    vi.spyOn(memoryModule, 'retrieveMemories').mockRejectedValue(new Error('DB error'));

    let threw = false;
    try {
      await handleBeforeTurn(db, facade, {
        session_key: 'session-current',
        conversation_context: 'any context',
        previous_session_key: null,
        previous_conversation_history: null,
      });
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
  });

  it('returns empty injected_memories array when retrieval fails (AC8)', async () => {
    vi.spyOn(memoryModule, 'retrieveMemories').mockRejectedValue(new Error('Search index error'));

    const result = await handleBeforeTurn(db, facade, {
      session_key: 'session-current',
      conversation_context: 'any context',
      previous_session_key: null,
      previous_conversation_history: null,
    });

    expect(result.injected_memories).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// BDD Scenario 1: Previous session triggers lazy extraction + memory injection
// ---------------------------------------------------------------------------

describe('handleBeforeTurn - BDD Scenario 1: trigger extraction and inject memories', () => {
  it('returns extraction_triggered=true and non-empty injected_memories, completes within 200ms', async () => {
    // Add relevant memories to DB
    facade.addMemory(makeMemory({
      id: 'mem-bdd1-1',
      content: 'TypeScript project structure uses src and test directories',
      subject: 'typescript-project-structure',
      importance: 0.85,
    }));

    // Mock extractMemories to avoid real LLM call
    vi.spyOn(memoryModule, 'extractMemories').mockResolvedValue({
      extracted: [],
      conflicts_resolved: 0,
    });

    const start = Date.now();
    const result = await handleBeforeTurn(db, facade, {
      session_key: 'session-current',
      conversation_context: '讨论 TypeScript 项目结构',
      previous_session_key: 'session-prev',
      previous_conversation_history: makeSessionHistory(),
    });
    const elapsed = Date.now() - start;

    expect(result.extraction_triggered).toBe(true);
    expect(result.injected_memories.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(200);
  });
});

// ---------------------------------------------------------------------------
// BDD Scenario 2: No previous session → only memory injection
// ---------------------------------------------------------------------------

describe('handleBeforeTurn - BDD Scenario 2: no previous session', () => {
  it('returns extraction_triggered=false and retrieves relevant memories', async () => {
    facade.addMemory(makeMemory({
      id: 'mem-bdd2-1',
      content: 'ESLint configuration should use eslint.config.js flat format',
      subject: 'eslint-config',
      importance: 0.8,
    }));

    const extractSpy = vi.spyOn(memoryModule, 'extractMemories').mockResolvedValue({
      extracted: [],
      conflicts_resolved: 0,
    });

    const result = await handleBeforeTurn(db, facade, {
      session_key: 'session-current',
      conversation_context: '如何配置 ESLint',
      previous_session_key: null,
      previous_conversation_history: null,
    });

    expect(result.extraction_triggered).toBe(false);
    expect(extractSpy).not.toHaveBeenCalled();
    // ESLint-related memories should be retrieved
    expect(result.injected_memories.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// BDD Scenario 3: LLM extraction fails, hook silently degrades
// ---------------------------------------------------------------------------

describe('handleBeforeTurn - BDD Scenario 3: LLM extraction failure silent degradation', () => {
  it('hook returns normally with injected_memories and extraction_triggered=true even when LLM fails', async () => {
    vi.spyOn(memoryModule, 'extractMemories').mockRejectedValue(new Error('LLM service unavailable'));

    facade.addMemory(makeMemory({
      id: 'mem-bdd3-1',
      content: 'TypeScript interfaces define contracts for type checking',
      subject: 'typescript-interfaces',
      importance: 0.9,
    }));

    let result: Awaited<ReturnType<typeof handleBeforeTurn>> | undefined;
    let threw = false;
    try {
      result = await handleBeforeTurn(db, facade, {
        session_key: 'session-current',
        conversation_context: 'TypeScript interfaces',
        previous_session_key: 'session-prev',
        previous_conversation_history: makeSessionHistory(),
      });
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(result!.extraction_triggered).toBe(true);
    expect(result!.injected_memories.length).toBeGreaterThan(0);

    // Wait for async failure to propagate silently
    await new Promise(resolve => setTimeout(resolve, 20));
  });
});

// ---------------------------------------------------------------------------
// BDD Scenario 4: No memories in DB → empty injected_memories
// ---------------------------------------------------------------------------

describe('handleBeforeTurn - BDD Scenario 4: no memories in DB', () => {
  it('returns empty injected_memories and does not throw when DB has no memories', async () => {
    let result: Awaited<ReturnType<typeof handleBeforeTurn>> | undefined;
    let threw = false;
    try {
      result = await handleBeforeTurn(db, facade, {
        session_key: 'session-current',
        conversation_context: 'TypeScript project configuration and setup',
        previous_session_key: null,
        previous_conversation_history: null,
      });
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(result!.injected_memories).toHaveLength(0);
  });
});
