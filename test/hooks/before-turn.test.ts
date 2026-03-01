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
import { insertSessionState, getMemoriesBySubject } from '../../src/storage/repository.js';
import { handleBeforeTurn } from '../../src/hooks/index.js';
import * as memoryModule from '../../src/memory/index.js';
import * as llmModule from '../../src/llm/index.js';
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

// ---------------------------------------------------------------------------
// TASK-BE-1.4 End-to-End Pipeline Integration Tests
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// AC1: Async extraction non-blocking + DB write after async completion
// ---------------------------------------------------------------------------

describe('E2E pipeline - async extraction writes to DB after completion (AC1)', () => {
  it('async extraction completes and persists extracted memories to DB', async () => {
    // Mock LLM to return specific memories without real API call
    vi.spyOn(llmModule, 'callLLM').mockResolvedValue([
      {
        type: 'preference',
        content: 'User prefers TypeScript over JavaScript',
        subject: 'language-preference',
        confidence: 0.9,
        importance: 0.8,
      },
      {
        type: 'fact',
        content: 'User is a senior software engineer',
        subject: 'user-role',
        confidence: 0.95,
        importance: 0.7,
      },
    ]);

    const beforeCall = Date.now();

    // Call beforeTurn — extraction should be triggered asynchronously
    const result = await handleBeforeTurn(db, facade, {
      session_key: 'session-current',
      conversation_context: 'discussing TypeScript preferences',
      previous_session_key: 'session-prev-ac1',
      previous_conversation_history: [
        { role: 'user', content: 'I prefer TypeScript for all my projects.' },
        { role: 'assistant', content: 'TypeScript is excellent for type safety.' },
      ],
    });

    // extraction_triggered = true (non-blocking)
    expect(result.extraction_triggered).toBe(true);

    // Wait for async extraction to complete
    await new Promise(resolve => setTimeout(resolve, 100));

    // Verify memories were actually written to DB
    const langPref = getMemoriesBySubject(db, 'language-preference');
    const userRole = getMemoriesBySubject(db, 'user-role');

    expect(langPref.length).toBe(1);
    expect(langPref[0].content).toBe('User prefers TypeScript over JavaScript');
    expect(langPref[0].type).toBe('preference');

    expect(userRole.length).toBe(1);
    expect(userRole[0].content).toBe('User is a senior software engineer');
    expect(userRole[0].type).toBe('fact');
  });
});

// ---------------------------------------------------------------------------
// AC2: Number of inserted memories matches LLM-returned array count (no conflicts)
// ---------------------------------------------------------------------------

describe('E2E pipeline - extracted memory count matches LLM response (AC2)', () => {
  it('inserts exactly N memories when LLM returns N entries with no subject conflicts', async () => {
    const llmMemories = [
      { type: 'preference' as const, content: 'User prefers vim keybindings', subject: 'editor-keybindings', confidence: 0.9, importance: 0.7 },
      { type: 'fact' as const, content: 'User works at a startup', subject: 'user-employer', confidence: 0.8, importance: 0.6 },
      { type: 'entity' as const, content: 'Alice is the project manager', subject: 'person-alice', confidence: 0.95, importance: 0.75 },
    ];

    vi.spyOn(llmModule, 'callLLM').mockResolvedValue(llmMemories);

    await handleBeforeTurn(db, facade, {
      session_key: 'session-current',
      conversation_context: 'team discussion',
      previous_session_key: 'session-prev-ac2',
      previous_conversation_history: [
        { role: 'user', content: 'Alice from the team mentioned we use vim.' },
      ],
    });

    // Wait for async extraction
    await new Promise(resolve => setTimeout(resolve, 100));

    // Count total memories in DB — should be exactly 3 (no conflicts)
    const allMemories = db.prepare('SELECT * FROM memories').all() as MemoryEntry[];
    expect(allMemories.length).toBe(llmMemories.length);

    // Verify each extracted memory subject exists
    for (const llmMem of llmMemories) {
      const stored = getMemoriesBySubject(db, llmMem.subject);
      expect(stored.length).toBe(1);
      expect(stored[0].content).toBe(llmMem.content);
    }
  });
});

// ---------------------------------------------------------------------------
// AC3: Conflict upsert — same subject+type updates existing, id/created_at preserved
// ---------------------------------------------------------------------------

describe('E2E pipeline - conflict upsert: same subject+type updates existing entry (AC3)', () => {
  it('updates existing memory when LLM extracts same subject and type, preserving id and created_at', async () => {
    // Pre-insert an existing memory
    const createdAt = new Date(Date.now() - 10000).toISOString();
    const existingMemory: MemoryEntry = {
      id: 'existing-lang-pref-001',
      type: 'preference',
      content: 'User prefers JavaScript',
      subject: 'user-lang',
      confidence: 0.6,
      importance: 0.5,
      source_session: 'old-session',
      access_count: 2,
      last_accessed_at: null,
      created_at: createdAt,
      updated_at: createdAt,
    };
    facade.addMemory(existingMemory);

    // LLM extracts conflicting memory (same subject, same type)
    vi.spyOn(llmModule, 'callLLM').mockResolvedValue([
      {
        type: 'preference',
        content: 'User prefers TypeScript over JavaScript',
        subject: 'user-lang',
        confidence: 0.95,
        importance: 0.9,
      },
    ]);

    await handleBeforeTurn(db, facade, {
      session_key: 'session-current',
      conversation_context: 'language preferences',
      previous_session_key: 'session-prev-ac3',
      previous_conversation_history: [
        { role: 'user', content: 'Actually I switched to TypeScript.' },
      ],
    });

    // Wait for async extraction to complete
    await new Promise(resolve => setTimeout(resolve, 100));

    // Only one record for this subject+type (no duplicate)
    const stored = getMemoriesBySubject(db, 'user-lang');
    const prefRecords = stored.filter(m => m.type === 'preference');
    expect(prefRecords.length).toBe(1);

    // Content, confidence, importance updated
    expect(prefRecords[0].content).toBe('User prefers TypeScript over JavaScript');
    expect(prefRecords[0].confidence).toBe(0.95);
    expect(prefRecords[0].importance).toBe(0.9);
    // updated_at is more recent than created_at
    expect(new Date(prefRecords[0].updated_at).getTime()).toBeGreaterThanOrEqual(
      new Date(createdAt).getTime()
    );

    // id and created_at preserved
    expect(prefRecords[0].id).toBe('existing-lang-pref-001');
    expect(prefRecords[0].created_at).toBe(createdAt);
  });
});

// ---------------------------------------------------------------------------
// AC4: Same subject, different type → independent insert (no overwrite)
// ---------------------------------------------------------------------------

describe('E2E pipeline - same subject+different type inserts independently (AC4)', () => {
  it('inserts new memory when subject matches but type differs, preserving existing entry', async () => {
    // Pre-insert a preference for 'python-usage'
    const existingMemory: MemoryEntry = {
      id: 'python-pref-001',
      type: 'preference',
      content: 'User prefers Python for scripting',
      subject: 'python-usage',
      confidence: 0.8,
      importance: 0.7,
      source_session: 'old-session',
      access_count: 0,
      last_accessed_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    facade.addMemory(existingMemory);

    // LLM extracts a 'fact' for same subject
    vi.spyOn(llmModule, 'callLLM').mockResolvedValue([
      {
        type: 'fact',
        content: 'Python is used for data processing pipelines',
        subject: 'python-usage',
        confidence: 0.9,
        importance: 0.8,
      },
    ]);

    await handleBeforeTurn(db, facade, {
      session_key: 'session-current',
      conversation_context: 'python programming',
      previous_session_key: 'session-prev-ac4',
      previous_conversation_history: [
        { role: 'user', content: 'We use Python for data pipelines.' },
      ],
    });

    await new Promise(resolve => setTimeout(resolve, 100));

    // Both records exist for 'python-usage'
    const stored = getMemoriesBySubject(db, 'python-usage');
    expect(stored.length).toBe(2);
    expect(stored.some(m => m.type === 'preference')).toBe(true);
    expect(stored.some(m => m.type === 'fact')).toBe(true);

    // Original preference entry unchanged
    const prefRecord = stored.find(m => m.type === 'preference');
    expect(prefRecord).toBeDefined();
    expect(prefRecord!.id).toBe('python-pref-001');
    expect(prefRecord!.content).toBe('User prefers Python for scripting');
  });
});

// ---------------------------------------------------------------------------
// AC5: injected_memories sorted by score descending, count ≤ limit (10)
// ---------------------------------------------------------------------------

describe('E2E pipeline - injected_memories ordering and limit (AC5)', () => {
  it('returns injected_memories sorted by tri-dimensional score descending', async () => {
    const now = new Date().toISOString();

    // Add memories with varied importance (and same recency) so ordering is predictable
    const memories: MemoryEntry[] = [
      {
        id: 'mem-sort-low',
        type: 'fact',
        content: 'TypeScript is a statically typed language',
        subject: 'typescript-typing',
        confidence: 0.8,
        importance: 0.2,
        source_session: 'session-old',
        access_count: 0,
        last_accessed_at: now,
        created_at: now,
        updated_at: now,
      },
      {
        id: 'mem-sort-high',
        type: 'fact',
        content: 'TypeScript strict mode enables comprehensive type checking',
        subject: 'typescript-strict',
        confidence: 0.9,
        importance: 0.9,
        source_session: 'session-old',
        access_count: 0,
        last_accessed_at: now,
        created_at: now,
        updated_at: now,
      },
      {
        id: 'mem-sort-mid',
        type: 'preference',
        content: 'TypeScript interfaces preferred over type aliases for objects',
        subject: 'typescript-interfaces',
        confidence: 0.85,
        importance: 0.6,
        source_session: 'session-old',
        access_count: 0,
        last_accessed_at: now,
        created_at: now,
        updated_at: now,
      },
    ];

    for (const mem of memories) {
      facade.addMemory(mem);
    }

    const result = await handleBeforeTurn(db, facade, {
      session_key: 'session-current',
      conversation_context: 'TypeScript strict mode and type checking',
      previous_session_key: null,
      previous_conversation_history: null,
    });

    // Guarantee at least 2 results so the ordering loop actually executes
    expect(result.injected_memories.length).toBeGreaterThanOrEqual(2);
    expect(result.injected_memories.length).toBeLessThanOrEqual(10);

    // Verify descending order — cast to ScoredMemoryEntry (retrieval always attaches score)
    const scored = result.injected_memories as import('../../src/types/index.js').ScoredMemoryEntry[];
    for (let i = 1; i < scored.length; i++) {
      expect(scored[i - 1].score).toBeGreaterThanOrEqual(scored[i].score);
    }
  });

  it('returns at most memory_injection_limit (10) memories when DB has more matches', async () => {
    const now = new Date().toISOString();

    // Insert 15 relevant memories
    for (let i = 0; i < 15; i++) {
      facade.addMemory({
        id: `mem-limit-e2e-${i}`,
        type: 'fact',
        content: `TypeScript advanced feature ${i}: generics and conditional types for type-safe code`,
        subject: `typescript-advanced-${i}`,
        confidence: 0.8,
        importance: 0.5 + i * 0.02,
        source_session: 'session-old',
        access_count: 0,
        last_accessed_at: now,
        created_at: now,
        updated_at: now,
      });
    }

    const result = await handleBeforeTurn(db, facade, {
      session_key: 'session-current',
      conversation_context: 'TypeScript generics and conditional types',
      previous_session_key: null,
      previous_conversation_history: null,
    });

    expect(result.injected_memories.length).toBeLessThanOrEqual(10);
  });
});

// ---------------------------------------------------------------------------
// AC6: Score formula uses default weights a=0.3, b=0.5, c=0.2, lambda=0.01
// ---------------------------------------------------------------------------

describe('E2E pipeline - score formula with default weights (AC6)', () => {
  it('score field on returned memories is within [0, 1] range using default weights', async () => {
    const now = new Date().toISOString();

    facade.addMemory({
      id: 'mem-score-check',
      type: 'fact',
      content: 'Rust ownership system ensures memory safety without garbage collection',
      subject: 'rust-memory-safety',
      confidence: 0.9,
      importance: 0.8,
      source_session: 'session-old',
      access_count: 0,
      last_accessed_at: now,
      created_at: now,
      updated_at: now,
    });

    const result = await handleBeforeTurn(db, facade, {
      session_key: 'session-current',
      conversation_context: 'Rust memory safety and ownership',
      previous_session_key: null,
      previous_conversation_history: null,
    });

    expect(result.injected_memories.length).toBeGreaterThan(0);

    // score = 0.3*recency + 0.5*relevance + 0.2*importance — all components in [0,1]
    const scoredAll = result.injected_memories as import('../../src/types/index.js').ScoredMemoryEntry[];
    for (const mem of scoredAll) {
      expect(mem.score).toBeGreaterThanOrEqual(0);
      expect(mem.score).toBeLessThanOrEqual(1.0);
    }

    // The high-importance memory (0.8) accessed recently should score at least 0.46
    // Lower bound: 0.3*recency(~1.0) + 0.5*relevance(>0) + 0.2*0.8 = 0.3 + 0 + 0.16 = 0.46
    const found = scoredAll.find(m => m.id === 'mem-score-check');
    expect(found).toBeDefined();
    expect(found!.score).toBeGreaterThanOrEqual(0.46);
  });

  it('weight formula ordering: high-importance old memory beats high-recency low-importance memory when c*Δimportance > a*Δrecency (AC6)', async () => {
    // Two memories with identical content → BM25 relevance is equal (both normalize to 1.0)
    // We vary recency and importance to distinguish the weight contributions.
    //
    // Memory A: accessed NOW    → recency ≈ exp(0) = 1.0,   importance = 0.1
    // Memory B: accessed 48h ago → recency ≈ exp(-0.01*48) ≈ 0.619, importance = 1.0
    //
    // With default weights a=0.3, b=0.5, c=0.2, equal relevance r=1.0:
    //   score_A = 0.3*1.0    + 0.5*1.0 + 0.2*0.1 = 0.300 + 0.500 + 0.020 = 0.820
    //   score_B = 0.3*0.619  + 0.5*1.0 + 0.2*1.0 = 0.186 + 0.500 + 0.200 = 0.886
    //
    // Therefore score_B > score_A — memory B ranks first despite being older.
    // If recency weight were 0.5 instead of 0.3 (wrong weights), score_A would win.

    const now = new Date().toISOString();
    const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

    facade.addMemory({
      id: 'mem-weight-highrecency',
      type: 'fact',
      content: 'Golang channels enable concurrent goroutine communication',
      subject: 'golang-channels-recency',
      confidence: 0.8,
      importance: 0.1,  // Low importance
      source_session: 'session-old',
      access_count: 0,
      last_accessed_at: now,   // Accessed NOW → recency ≈ 1.0
      created_at: now,
      updated_at: now,
    });

    facade.addMemory({
      id: 'mem-weight-highimportance',
      type: 'fact',
      content: 'Golang channels enable concurrent goroutine communication',
      subject: 'golang-channels-importance',
      confidence: 0.8,
      importance: 1.0,  // Max importance
      source_session: 'session-old',
      access_count: 0,
      last_accessed_at: fortyEightHoursAgo,  // 48h ago → recency ≈ 0.619
      created_at: fortyEightHoursAgo,
      updated_at: fortyEightHoursAgo,
    });

    const result = await handleBeforeTurn(db, facade, {
      session_key: 'session-current',
      conversation_context: 'Golang channels goroutine concurrent',
      previous_session_key: null,
      previous_conversation_history: null,
    });

    // Both memories must be returned
    const scored = result.injected_memories as import('../../src/types/index.js').ScoredMemoryEntry[];
    const memA = scored.find(m => m.id === 'mem-weight-highrecency');
    const memB = scored.find(m => m.id === 'mem-weight-highimportance');

    expect(memA).toBeDefined();
    expect(memB).toBeDefined();

    // With c=0.2, importance difference (1.0 - 0.1)*0.2 = 0.18
    // With a=0.3, recency difference (1.0 - 0.619)*0.3 ≈ 0.114
    // Importance gain (0.18) > recency loss (0.114) → high-importance B scores higher
    expect(memB!.score).toBeGreaterThan(memA!.score);

    // Sanity check: all scores in valid range
    for (const mem of scored) {
      expect(mem.score).toBeGreaterThanOrEqual(0);
      expect(mem.score).toBeLessThanOrEqual(1.0);
    }
  });
});

// ---------------------------------------------------------------------------
// AC7: Injected memories have access_count incremented, last_accessed_at updated
// ---------------------------------------------------------------------------

describe('E2E pipeline - access tracking on injected memories (AC7)', () => {
  it('increments access_count by 1 for memories returned in injected_memories', async () => {
    const now = new Date().toISOString();
    facade.addMemory({
      id: 'mem-track-e2e',
      type: 'fact',
      content: 'Redis is used for distributed caching in this architecture',
      subject: 'redis-architecture',
      confidence: 0.9,
      importance: 0.8,
      source_session: 'session-old',
      access_count: 5,
      last_accessed_at: null,
      created_at: now,
      updated_at: now,
    });

    const beforeCall = Date.now();
    const result = await handleBeforeTurn(db, facade, {
      session_key: 'session-current',
      conversation_context: 'Redis caching architecture distributed',
      previous_session_key: null,
      previous_conversation_history: null,
    });

    const injected = result.injected_memories.find(m => m.id === 'mem-track-e2e');
    expect(injected).toBeDefined();

    // Verify DB reflects incremented access_count
    const dbRow = db
      .prepare('SELECT access_count, last_accessed_at FROM memories WHERE id = ?')
      .get('mem-track-e2e') as { access_count: number; last_accessed_at: string };

    expect(dbRow.access_count).toBe(6);
    expect(new Date(dbRow.last_accessed_at).getTime()).toBeGreaterThanOrEqual(beforeCall);
  });

  it('last_accessed_at is updated to current time after injection', async () => {
    const oldDate = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2 hours ago
    facade.addMemory({
      id: 'mem-time-e2e',
      type: 'preference',
      content: 'PostgreSQL is preferred for relational data storage',
      subject: 'database-preference',
      confidence: 0.9,
      importance: 0.85,
      source_session: 'session-old',
      access_count: 0,
      last_accessed_at: oldDate,
      created_at: oldDate,
      updated_at: oldDate,
    });

    const beforeCall = Date.now();

    const result = await handleBeforeTurn(db, facade, {
      session_key: 'session-current',
      conversation_context: 'PostgreSQL relational database storage preference',
      previous_session_key: null,
      previous_conversation_history: null,
    });

    const injected = result.injected_memories.find(m => m.id === 'mem-time-e2e');
    expect(injected).toBeDefined();

    const dbRow = db
      .prepare('SELECT last_accessed_at FROM memories WHERE id = ?')
      .get('mem-time-e2e') as { last_accessed_at: string };

    expect(new Date(dbRow.last_accessed_at).getTime()).toBeGreaterThanOrEqual(beforeCall);
    expect(new Date(dbRow.last_accessed_at).getTime()).toBeGreaterThan(
      new Date(oldDate).getTime()
    );
  });
});

// ---------------------------------------------------------------------------
// AC8: Already extracted session does not re-trigger LLM extraction
// ---------------------------------------------------------------------------

describe('E2E pipeline - no duplicate extraction for already-extracted session (AC8)', () => {
  it('does not call LLM when previous_session_key is already marked extracted', async () => {
    const now = new Date().toISOString();
    insertSessionState(db, {
      session_key: 'session-already-done',
      extracted: 1,
      conversation_hash: null,
      created_at: now,
      updated_at: now,
    });

    const llmSpy = vi.spyOn(llmModule, 'callLLM');

    const result = await handleBeforeTurn(db, facade, {
      session_key: 'session-current',
      conversation_context: 'any context',
      previous_session_key: 'session-already-done',
      previous_conversation_history: [
        { role: 'user', content: 'Some historical message.' },
      ],
    });

    await new Promise(resolve => setTimeout(resolve, 50));

    expect(result.extraction_triggered).toBe(false);
    expect(llmSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC9: No previous session → skip extraction, perform injection only
// ---------------------------------------------------------------------------

describe('E2E pipeline - no previous session skips extraction, injects existing memories (AC9)', () => {
  it('skips extraction and injects relevant memories when previous_session_key is null', async () => {
    const now = new Date().toISOString();
    facade.addMemory({
      id: 'mem-inject-e2e',
      type: 'fact',
      content: 'GraphQL mutations allow data modification with type safety',
      subject: 'graphql-mutations',
      confidence: 0.9,
      importance: 0.8,
      source_session: 'session-old',
      access_count: 0,
      last_accessed_at: now,
      created_at: now,
      updated_at: now,
    });

    const llmSpy = vi.spyOn(llmModule, 'callLLM');

    const result = await handleBeforeTurn(db, facade, {
      session_key: 'session-current',
      conversation_context: 'GraphQL mutations and type safety',
      previous_session_key: null,
      previous_conversation_history: null,
    });

    // No extraction triggered, LLM never called
    expect(result.extraction_triggered).toBe(false);
    expect(llmSpy).not.toHaveBeenCalled();

    // But injection still works
    expect(result.injected_memories.length).toBeGreaterThan(0);
    const injected = result.injected_memories.find(m => m.id === 'mem-inject-e2e');
    expect(injected).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// AC10: No matching memories → empty injected_memories, no error
// ---------------------------------------------------------------------------

describe('E2E pipeline - no matching memories returns empty array (AC10)', () => {
  it('returns empty injected_memories and extraction_triggered=false when no memories match', async () => {
    // DB is empty (no memories)
    const result = await handleBeforeTurn(db, facade, {
      session_key: 'session-current',
      conversation_context: 'TypeScript project setup',
      previous_session_key: null,
      previous_conversation_history: null,
    });

    expect(result.injected_memories).toHaveLength(0);
    expect(result.extraction_triggered).toBe(false);
  });

  it('returns empty injected_memories when memories exist but none match the query', async () => {
    facade.addMemory({
      id: 'mem-unrelated-e2e',
      type: 'fact',
      content: 'Medieval European castles were built for defensive purposes',
      subject: 'medieval-history',
      confidence: 0.8,
      importance: 0.5,
      source_session: 'session-old',
      access_count: 0,
      last_accessed_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const result = await handleBeforeTurn(db, facade, {
      session_key: 'session-current',
      // Deliberately unrelated query that won't match medieval history content
      conversation_context: 'xyzzy-nonexistent-keyword-unique-nonce-zq9f',
      previous_session_key: null,
      previous_conversation_history: null,
    });

    expect(result.injected_memories).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// BDD Scenario 2 (E2E): Conflict memory updated, not duplicated
// ---------------------------------------------------------------------------

describe('E2E BDD - Scenario 2: conflict memory upserted not duplicated', () => {
  it('after extraction with conflict, only one record exists for same subject+type', async () => {
    // Pre-insert memory with subject='user-lang' type='preference'
    const createdAt = new Date(Date.now() - 20000).toISOString();
    facade.addMemory({
      id: 'user-lang-pref-original',
      type: 'preference',
      content: 'User prefers JavaScript',
      subject: 'user-lang',
      confidence: 0.7,
      importance: 0.6,
      source_session: 'session-old',
      access_count: 0,
      last_accessed_at: null,
      created_at: createdAt,
      updated_at: createdAt,
    });

    // LLM extracts a conflicting new preference for same subject
    vi.spyOn(llmModule, 'callLLM').mockResolvedValue([
      {
        type: 'preference',
        content: 'User prefers TypeScript for all new projects',
        subject: 'user-lang',
        confidence: 0.95,
        importance: 0.9,
      },
    ]);

    await handleBeforeTurn(db, facade, {
      session_key: 'session-current',
      conversation_context: 'discussing preferred programming language',
      previous_session_key: 'session-prev-bdd2',
      previous_conversation_history: [
        { role: 'user', content: 'I switched to TypeScript for all new projects.' },
      ],
    });

    // Wait for async extraction
    await new Promise(resolve => setTimeout(resolve, 100));

    // Only 1 record for subject='user-lang', type='preference'
    const stored = getMemoriesBySubject(db, 'user-lang');
    const prefRecords = stored.filter(m => m.type === 'preference');
    expect(prefRecords.length).toBe(1);

    // Content updated
    expect(prefRecords[0].content).toBe('User prefers TypeScript for all new projects');
  });
});

// ---------------------------------------------------------------------------
// BDD Scenario 3 (E2E): LLM extraction failure — injection still works
// ---------------------------------------------------------------------------

describe('E2E BDD - Scenario 3: LLM failure does not prevent memory injection', () => {
  it('injection still returns relevant memories even when LLM extraction throws', async () => {
    const now = new Date().toISOString();
    facade.addMemory({
      id: 'mem-bdd3-e2e',
      type: 'preference',
      content: 'User prefers functional programming patterns in TypeScript',
      subject: 'fp-preference',
      confidence: 0.9,
      importance: 0.85,
      source_session: 'session-old',
      access_count: 0,
      last_accessed_at: now,
      created_at: now,
      updated_at: now,
    });

    // LLM throws an error during extraction
    vi.spyOn(llmModule, 'callLLM').mockRejectedValue(new Error('LLM API timeout'));

    let threw = false;
    let result: Awaited<ReturnType<typeof handleBeforeTurn>> | undefined;
    try {
      result = await handleBeforeTurn(db, facade, {
        session_key: 'session-current',
        conversation_context: 'functional programming TypeScript patterns',
        previous_session_key: 'session-prev-bdd3',
        previous_conversation_history: [
          { role: 'user', content: 'Tell me about functional patterns.' },
        ],
      });
    } catch {
      threw = true;
    }

    // Must not throw
    expect(threw).toBe(false);
    expect(result).toBeDefined();
    expect(result!.extraction_triggered).toBe(true);

    // Injection must still return memories
    expect(result!.injected_memories.length).toBeGreaterThan(0);
    const injected = result!.injected_memories.find(m => m.id === 'mem-bdd3-e2e');
    expect(injected).toBeDefined();

    // Allow async failure to propagate
    await new Promise(resolve => setTimeout(resolve, 50));
  });
});

// ---------------------------------------------------------------------------
// BDD Scenario 5 (E2E): access_count and last_accessed_at updated after injection
// ---------------------------------------------------------------------------

describe('E2E BDD - Scenario 5: access tracking verified in DB after injection', () => {
  it('access_count increases from 3 to 4 and last_accessed_at is updated for injected memory', async () => {
    const oldDate = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1 hour ago
    facade.addMemory({
      id: 'mem-bdd5-e2e',
      type: 'fact',
      content: 'Kubernetes pod autoscaling uses HorizontalPodAutoscaler resources',
      subject: 'k8s-autoscaling',
      confidence: 0.9,
      importance: 0.8,
      source_session: 'session-old',
      access_count: 3,
      last_accessed_at: oldDate,
      created_at: oldDate,
      updated_at: oldDate,
    });

    const beforeCall = Date.now();

    const result = await handleBeforeTurn(db, facade, {
      session_key: 'session-current',
      conversation_context: 'Kubernetes autoscaling HorizontalPodAutoscaler configuration',
      previous_session_key: null,
      previous_conversation_history: null,
    });

    // Memory A should be in the injected list
    const injected = result.injected_memories.find(m => m.id === 'mem-bdd5-e2e');
    expect(injected).toBeDefined();

    // Verify DB: access_count = 4, last_accessed_at >= beforeCall
    const dbRow = db
      .prepare('SELECT access_count, last_accessed_at FROM memories WHERE id = ?')
      .get('mem-bdd5-e2e') as { access_count: number; last_accessed_at: string };

    expect(dbRow.access_count).toBe(4);
    expect(new Date(dbRow.last_accessed_at).getTime()).toBeGreaterThanOrEqual(beforeCall);
    expect(new Date(dbRow.last_accessed_at).getTime()).toBeGreaterThan(
      new Date(oldDate).getTime()
    );
  });
});
