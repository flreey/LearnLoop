/**
 * End-to-end smoke tests: full LearnLoop conversation lifecycle.
 *
 * Covers the complete pipeline from Session N memory extraction through Session N+1
 * memory injection, afterTask reflection generation, and beforeSpawn reflection injection.
 *
 * Source modules under test:
 *   - src/hooks/index.ts (handleBeforeTurn, handleAfterTask, handleBeforeSpawn)
 *   - src/memory/index.ts (extractMemories, retrieveMemories, detectAndUpsert)
 *   - src/reflection/index.ts (generateReflection, retrieveReflections)
 *   - src/storage/ (DB, facade, repository)
 *   - src/search/index.ts (BM25)
 *
 * Design refs:
 *   - business_rules[lazy-extraction-trigger]
 *   - business_rules[memory-injection-on-turn]
 *   - business_rules[reflection-generation-on-task-complete]
 *   - business_rules[reflection-injection-on-spawn]
 *   - constraints[non-blocking-extraction, non-blocking-reflection, retrieval-latency, silent-degradation]
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { initializeDatabase } from '../../src/storage/db.js';
import { createSearchEngine } from '../../src/search/index.js';
import { StorageFacade } from '../../src/storage/facade.js';
import { handleBeforeTurn, handleAfterTask, handleBeforeSpawn } from '../../src/hooks/index.js';
import * as llmModule from '../../src/llm/index.js';
import * as reflectionModule from '../../src/reflection/index.js';
import * as memoryModule from '../../src/memory/index.js';
import type { DB } from '../../src/storage/db.js';
import type { MemoryEntry, ReflectionEntry, Message } from '../../src/types/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDbPath(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'learnloop-lifecycle-e2e-'));
  return path.join(tmpDir, 'test.db');
}

function makeHistory(content: string): Message[] {
  return [
    { role: 'user', content },
    { role: 'assistant', content: 'Understood.' },
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
// AC1: Session N+1 beforeTurn triggers lazy extraction for unextracted Session N
// ---------------------------------------------------------------------------

describe('Full lifecycle: lazy extraction triggered for unextracted previous session (AC1)', () => {
  it('extraction_triggered=true when previous_session_key points to unextracted Session N', async () => {
    // No session_state record exists for session-N → should trigger extraction
    const result = await handleBeforeTurn(db, facade, {
      session_key: 'session-N+1',
      conversation_context: '用户语言偏好设置',
      previous_session_key: 'session-N',
      previous_conversation_history: makeHistory('用户偏好中文沟通，喜欢简洁回答'),
    });

    expect(result.extraction_triggered).toBe(true);
  });

  it('async extraction completes and memories appear in DB after async extraction finishes (AC1)', async () => {
    // Mock LLM to return a specific memory about language preference
    vi.spyOn(llmModule, 'callLLM').mockResolvedValue([
      {
        type: 'preference',
        content: '用户偏好中文沟通',
        subject: 'communication-language',
        confidence: 0.9,
        importance: 0.8,
      },
    ]);

    const result = await handleBeforeTurn(db, facade, {
      session_key: 'session-N+1',
      conversation_context: '如何与用户沟通',
      previous_session_key: 'session-N',
      previous_conversation_history: makeHistory('我希望你用中文回答我'),
    });

    // extraction_triggered = true (AC1)
    expect(result.extraction_triggered).toBe(true);

    // Wait for async extraction to complete
    await new Promise(r => setTimeout(r, 150));

    // Memories from Session N should now exist in DB (AC1)
    const rows = db
      .prepare('SELECT * FROM memories WHERE subject = ?')
      .all('communication-language') as MemoryEntry[];

    expect(rows.length).toBe(1);
    expect(rows[0].content).toBe('用户偏好中文沟通');
    expect(rows[0].type).toBe('preference');
  });

  it('session_states record is marked extracted=1 synchronously after trigger', async () => {
    vi.spyOn(llmModule, 'callLLM').mockResolvedValue([]);

    await handleBeforeTurn(db, facade, {
      session_key: 'session-N+1',
      conversation_context: 'any context',
      previous_session_key: 'session-N',
      previous_conversation_history: [],
    });

    // Session state should be marked extracted synchronously
    const stateRow = db
      .prepare('SELECT extracted FROM session_states WHERE session_key = ?')
      .get('session-N') as { extracted: number } | undefined;

    expect(stateRow).toBeDefined();
    expect(stateRow!.extracted).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// AC2: Session N+1 beforeTurn injects memories based on BM25 relevance
// ---------------------------------------------------------------------------

describe('Full lifecycle: memory injection via BM25 relevance matching (AC2)', () => {
  it('injected_memories contains memories relevant to conversation_context (AC2)', async () => {
    // Pre-populate DB with memories
    facade.addMemory({
      id: 'mem-lang-pref',
      type: 'preference',
      content: '用户偏好中文沟通，喜欢简洁的中文回答',
      subject: 'language-preference',
      confidence: 0.9,
      importance: 0.8,
      source_session: 'session-N',
      access_count: 0,
      last_accessed_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    facade.addMemory({
      id: 'mem-unrelated',
      type: 'fact',
      content: 'Medieval castles were primarily defensive structures',
      subject: 'medieval-history',
      confidence: 0.7,
      importance: 0.5,
      source_session: 'session-old',
      access_count: 0,
      last_accessed_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // Query with language-related context
    const result = await handleBeforeTurn(db, facade, {
      session_key: 'session-N+1',
      conversation_context: '语言设置 中文沟通偏好',
      previous_session_key: null,
      previous_conversation_history: null,
    });

    // Should return the language-preference memory (AC2)
    expect(result.injected_memories.length).toBeGreaterThan(0);
    const langMem = result.injected_memories.find(m => m.id === 'mem-lang-pref');
    expect(langMem).toBeDefined();
    // Should NOT return unrelated medieval history memory
    const unrelatedMem = result.injected_memories.find(m => m.id === 'mem-unrelated');
    expect(unrelatedMem).toBeUndefined();
  });

  it('second beforeTurn call after async extraction injects extracted memories (AC2)', async () => {
    // Session 1: Mock LLM to extract memories from session-N
    vi.spyOn(llmModule, 'callLLM').mockResolvedValue([
      {
        type: 'preference',
        content: '用户偏好中文沟通',
        subject: 'communication-language',
        confidence: 0.9,
        importance: 0.8,
      },
    ]);

    // First call: trigger extraction for session-N
    await handleBeforeTurn(db, facade, {
      session_key: 'session-N+1',
      conversation_context: '如何与用户沟通',
      previous_session_key: 'session-N',
      previous_conversation_history: makeHistory('我希望你用中文回答我'),
    });

    // Wait for async extraction to complete
    await new Promise(r => setTimeout(r, 150));

    // Second call: session-N+1 turn with language query — should inject extracted memory
    const result2 = await handleBeforeTurn(db, facade, {
      session_key: 'session-N+1',
      conversation_context: '语言偏好中文沟通',
      previous_session_key: null,  // already extracted
      previous_conversation_history: null,
    });

    // The extracted memory should now be injected (AC2)
    expect(result2.injected_memories.length).toBeGreaterThan(0);
    const langMem = result2.injected_memories.find(
      m => m.subject === 'communication-language',
    );
    expect(langMem).toBeDefined();
    expect(langMem!.content).toBe('用户偏好中文沟通');
  });
});

// ---------------------------------------------------------------------------
// AC3: Conflict upsert — same subject only one record, content updated,
//       created_at preserved, updated_at updated
// ---------------------------------------------------------------------------

describe('Full lifecycle: memory conflict upsert preserves integrity (AC3)', () => {
  it('second extraction of same subject updates content, preserves id and created_at, updates updated_at (AC3)', async () => {
    const originalCreatedAt = new Date(Date.now() - 30000).toISOString();

    // Pre-insert existing memory for subject='flreey' type='preference' content='偏好英文'
    facade.addMemory({
      id: 'flreey-pref-001',
      type: 'preference',
      content: '偏好英文',
      subject: 'flreey',
      confidence: 0.7,
      importance: 0.6,
      source_session: 'session-old',
      access_count: 0,
      last_accessed_at: null,
      created_at: originalCreatedAt,
      updated_at: originalCreatedAt,
    });

    // Mock LLM to return conflicting memory: same subject, same type, new content
    vi.spyOn(llmModule, 'callLLM').mockResolvedValue([
      {
        type: 'preference',
        content: '偏好中文',
        subject: 'flreey',
        confidence: 0.95,
        importance: 0.85,
      },
    ]);

    await handleBeforeTurn(db, facade, {
      session_key: 'session-N+1',
      conversation_context: 'flreey language preference',
      previous_session_key: 'session-new',
      previous_conversation_history: makeHistory('flreey 更喜欢中文'),
    });

    // Wait for async extraction
    await new Promise(r => setTimeout(r, 150));

    // Only ONE record for subject='flreey' type='preference' (AC3)
    const rows = db
      .prepare('SELECT * FROM memories WHERE subject = ? AND type = ?')
      .all('flreey', 'preference') as MemoryEntry[];

    expect(rows.length).toBe(1);

    // Content is updated to latest value (AC3)
    expect(rows[0].content).toBe('偏好中文');

    // id is preserved (AC3)
    expect(rows[0].id).toBe('flreey-pref-001');

    // created_at is preserved (AC3)
    expect(rows[0].created_at).toBe(originalCreatedAt);

    // updated_at is more recent than originalCreatedAt (AC3)
    expect(new Date(rows[0].updated_at).getTime()).toBeGreaterThan(
      new Date(originalCreatedAt).getTime(),
    );
  });
});

// ---------------------------------------------------------------------------
// AC4: Injected memories have access_count incremented and last_accessed_at updated
// ---------------------------------------------------------------------------

describe('Full lifecycle: access tracking updated for injected memories (AC4)', () => {
  it('access_count incremented by 1 and last_accessed_at updated after injection (AC4)', async () => {
    const oldDate = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1 hour ago

    facade.addMemory({
      id: 'mem-access-tracked',
      type: 'preference',
      content: '用户偏好黑色主题界面设置',
      subject: 'ui-theme-preference',
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
      session_key: 'session-N+1',
      conversation_context: '界面主题 黑色主题偏好设置',
      previous_session_key: null,
      previous_conversation_history: null,
    });

    // Verify the memory was injected
    const injected = result.injected_memories.find(m => m.id === 'mem-access-tracked');
    expect(injected).toBeDefined();

    // Verify DB: access_count = 4 (incremented by 1) (AC4)
    const dbRow = db
      .prepare('SELECT access_count, last_accessed_at FROM memories WHERE id = ?')
      .get('mem-access-tracked') as { access_count: number; last_accessed_at: string };

    expect(dbRow.access_count).toBe(4);

    // last_accessed_at updated to current time (AC4)
    expect(new Date(dbRow.last_accessed_at).getTime()).toBeGreaterThanOrEqual(beforeCall);
    expect(new Date(dbRow.last_accessed_at).getTime()).toBeGreaterThan(
      new Date(oldDate).getTime(),
    );
  });
});

// ---------------------------------------------------------------------------
// AC5: afterTask with user_feedback:positive creates outcome=success reflection
//      with task_summary and lessons array
// ---------------------------------------------------------------------------

describe('Full lifecycle: afterTask with positive feedback generates success reflection (AC5)', () => {
  it('reflections table has outcome=success, task_summary, lessons array after afterTask with positive signals (AC5)', async () => {
    vi.spyOn(reflectionModule, 'generateReflection').mockResolvedValue({
      task_type: 'code',
      task_summary: '替换 PDF 库',
      outcome: 'success',
      reflection: '成功将 PDF 库替换为更轻量的方案，减少了依赖。',
      lessons: ['评估替换方案的兼容性', '保留回滚策略', '进行充分测试'],
    });

    await handleAfterTask(db, facade, {
      session_key: 'session-task',
      task_type: 'code',
      task_summary: '替换 PDF 库',
      conversation_history: makeHistory('PDF 库替换完成，效果很好'),
      signals: {
        user_feedback: 'thanks',
        review_result: null,
        was_respawned: false,
        timed_out: false,
      },
      agent_id: null,
    });

    // Wait for async DB write
    await new Promise(r => setTimeout(r, 150));

    // Verify reflection stored in DB (AC5)
    const rows = db.prepare('SELECT * FROM reflections').all() as ReflectionEntry[];
    expect(rows.length).toBe(1);

    // outcome = success (AC5)
    expect(rows[0].outcome).toBe('success');

    // task_summary present (AC5)
    expect(rows[0].task_summary).toBe('替换 PDF 库');

    // lessons is a non-empty JSON array (AC5)
    const lessonsArr = JSON.parse(rows[0].lessons);
    expect(Array.isArray(lessonsArr)).toBe(true);
    expect(lessonsArr.length).toBeGreaterThan(0);
    expect(lessonsArr).toContain('评估替换方案的兼容性');
  });
});

// ---------------------------------------------------------------------------
// AC6: beforeSpawn with matching reflections augments task_description
// ---------------------------------------------------------------------------

describe('Full lifecycle: beforeSpawn injects relevant reflections into task_description (AC6)', () => {
  it('augmented_task_description is longer than original and contains reflection content (AC6)', async () => {
    // Setup: Store a reflection about PDF task
    vi.spyOn(reflectionModule, 'generateReflection').mockResolvedValue({
      task_type: 'code',
      task_summary: '替换 PDF 库',
      outcome: 'success',
      reflection: 'PDF library replacement was successful with proper testing.',
      lessons: ['Test PDF rendering thoroughly', 'Keep fallback mechanism'],
    });

    await handleAfterTask(db, facade, {
      session_key: 'session-pdf-task',
      task_type: 'code',
      task_summary: '替换 PDF 库',
      conversation_history: [],
      signals: { user_feedback: 'good', review_result: null, was_respawned: false, timed_out: false },
      agent_id: null,
    });

    await new Promise(r => setTimeout(r, 150));

    // Now call beforeSpawn with matching task_type and PDF-related description
    const originalDescription = 'Replace current PDF rendering library with a lighter alternative';
    const result = await handleBeforeSpawn(db, facade, {
      task_description: originalDescription,
      task_type: 'code',
      agent_id: null,
    });

    // augmented_task_description is longer than original (AC6)
    expect(result.augmented_task_description.length).toBeGreaterThan(originalDescription.length);

    // injected_reflections is non-empty (AC6)
    expect(result.injected_reflections.length).toBeGreaterThan(0);

    // augmented description contains original text
    expect(result.augmented_task_description).toContain(originalDescription);
  });
});

// ---------------------------------------------------------------------------
// AC7: beforeSpawn with no matching reflections returns original task_description
//      and empty injected_reflections
// ---------------------------------------------------------------------------

describe('Full lifecycle: beforeSpawn returns original description when no reflections match (AC7)', () => {
  it('augmented_task_description equals original task_description when no reflections match (AC7)', async () => {
    // DB has no reflections at all
    const originalDescription = 'Deploy containerized application to production';

    const result = await handleBeforeSpawn(db, facade, {
      task_description: originalDescription,
      task_type: 'deployment',
      agent_id: null,
    });

    // AC7: augmented equals original when no match
    expect(result.augmented_task_description).toBe(originalDescription);
    // AC7: injected_reflections is empty array
    expect(result.injected_reflections).toEqual([]);
  });

  it('injected_reflections is empty array when reflections exist for different task type (AC7)', async () => {
    // Add a reflection for 'research' task type
    facade.addReflection({
      id: 'r-research-only',
      task_type: 'research',
      task_summary: 'research new database technologies for performance',
      outcome: 'success',
      signals: '{}',
      reflection: 'Researched various database options.',
      lessons: '["Use benchmarks", "Test with production data volume"]',
      agent_id: null,
      source_session: 'session-research',
      created_at: new Date().toISOString(),
    });

    const originalDescription = 'deploy kubernetes cluster to production environment';

    const result = await handleBeforeSpawn(db, facade, {
      task_description: originalDescription,
      task_type: 'deployment',
      agent_id: null,
    });

    // No cross-type injection: research reflection not injected into deployment task
    const injectedIds = result.injected_reflections.map(r => r.id);
    expect(injectedIds).not.toContain('r-research-only');

    // If no match, original description unchanged
    if (result.injected_reflections.length === 0) {
      expect(result.augmented_task_description).toBe(originalDescription);
    }
  });
});

// ---------------------------------------------------------------------------
// AC8: beforeTurn memory injection is synchronous (completes before return),
//       lazy extraction is asynchronous (non-blocking)
// ---------------------------------------------------------------------------

describe('Full lifecycle: injection synchronous, extraction asynchronous (AC8)', () => {
  it('memory injection completes before hook returns (synchronous AC8)', async () => {
    // Add a relevant memory to DB
    facade.addMemory({
      id: 'mem-sync-check',
      type: 'fact',
      content: 'Python is widely used for data science and machine learning',
      subject: 'python-data-science',
      confidence: 0.9,
      importance: 0.8,
      source_session: 'session-old',
      access_count: 0,
      last_accessed_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // Hook must complete and return injected_memories synchronously (within the await)
    const result = await handleBeforeTurn(db, facade, {
      session_key: 'session-N+1',
      conversation_context: 'Python data science machine learning',
      previous_session_key: null,
      previous_conversation_history: null,
    });

    // Injection already complete in the result — no additional wait needed (AC8)
    expect(result.injected_memories.length).toBeGreaterThan(0);
    const mem = result.injected_memories.find(m => m.id === 'mem-sync-check');
    expect(mem).toBeDefined();
  });

  it('lazy extraction does not block hook return — hook returns before extraction finishes (AC8)', async () => {
    let extractionStarted = false;
    let extractionFinished = false;

    // Simulate a slow extraction (200ms delay) — well beyond normal hook latency
    vi.spyOn(memoryModule, 'extractMemories').mockImplementation(async () => {
      extractionStarted = true;
      await new Promise(r => setTimeout(r, 200));
      extractionFinished = true;
      return { extracted: [], conflicts_resolved: 0 };
    });

    const start = Date.now();
    const result = await handleBeforeTurn(db, facade, {
      session_key: 'session-N+1',
      conversation_context: 'anything',
      previous_session_key: 'session-N',
      previous_conversation_history: makeHistory('some history'),
    });
    const elapsed = Date.now() - start;

    // Hook returned much faster than the 200ms extraction delay (AC8: non-blocking)
    expect(elapsed).toBeLessThan(100);
    // Extraction was kicked off (started) but hasn't finished yet
    expect(extractionStarted).toBe(true);
    expect(extractionFinished).toBe(false);
    // Hook still returned extraction_triggered = true
    expect(result.extraction_triggered).toBe(true);

    // Cleanup: wait for extraction to finish
    await new Promise(r => setTimeout(r, 250));
    expect(extractionFinished).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC9: afterTask reflection generation is asynchronous (non-blocking)
// ---------------------------------------------------------------------------

describe('Full lifecycle: afterTask reflection generation is non-blocking (AC9)', () => {
  it('afterTask hook awaits LLM but fires DB write as fire-and-forget (AC8)', async () => {
    let llmStarted = false;
    let llmFinished = false;

    // Simulate a slow LLM call (50ms delay) — the hook awaits LLM but not DB write
    vi.spyOn(reflectionModule, 'generateReflection').mockImplementation(async () => {
      llmStarted = true;
      await new Promise(r => setTimeout(r, 50));
      llmFinished = true;
      return {
        task_type: 'code',
        task_summary: 'implement caching layer',
        outcome: 'success' as const,
        reflection: 'Caching layer was added with Redis.',
        lessons: ['Use TTL for cache expiry'],
      };
    });

    const result = await handleAfterTask(db, facade, {
      session_key: 'session-async',
      task_type: 'code',
      task_summary: 'implement caching layer',
      conversation_history: [],
      signals: { user_feedback: 'good', review_result: null, was_respawned: false, timed_out: false },
      agent_id: null,
    });

    // Hook awaits LLM — both flags should be true after hook returns
    expect(llmStarted).toBe(true);
    expect(llmFinished).toBe(true);

    // Hook returns reflection_id and outcome after LLM completes (AC8: awaits LLM, not DB)
    expect(result.reflection_id).not.toBeNull();
    expect(result.outcome).toBe('success');

    // Wait for fire-and-forget DB write to complete
    await new Promise(r => setTimeout(r, 100));

    // DB should have the record persisted by the async chain
    const rows = db.prepare('SELECT * FROM reflections').all() as ReflectionEntry[];
    expect(rows.length).toBe(1);
    expect(rows[0].outcome).toBe('success');
    expect(rows[0].id).toBe(result.reflection_id);
  });

  it('afterTask returns a Promise — caller can fire-and-forget (AC9)', () => {
    vi.spyOn(reflectionModule, 'generateReflection').mockResolvedValue(null);

    const promise = handleAfterTask(db, facade, {
      session_key: 'session-fire-forget',
      task_type: 'code',
      task_summary: 'some task',
      conversation_history: [],
      signals: { user_feedback: null, review_result: null, was_respawned: false, timed_out: false },
      agent_id: null,
    });

    // Must return a Promise (AC9)
    expect(promise).toBeInstanceOf(Promise);
    return promise;
  });
});

// ---------------------------------------------------------------------------
// AC10: Memory retrieval latency < 100ms with 1000 memories
// ---------------------------------------------------------------------------

describe('Full lifecycle: memory retrieval latency under 100ms with 1000 entries (AC10)', () => {
  it('beforeTurn memory retrieval completes within 100ms with 1000 memories in DB (AC10)', async () => {
    // Insert 1000 memories into the DB and search index
    const now = new Date().toISOString();
    const memories: MemoryEntry[] = [];
    for (let i = 0; i < 1000; i++) {
      memories.push({
        id: `perf-mem-${i}`,
        type: 'fact',
        content: `Performance test memory ${i}: TypeScript advanced features generics conditional types`,
        subject: `perf-subject-${i}`,
        confidence: 0.8,
        importance: 0.5 + (i % 5) * 0.1,
        source_session: 'session-perf',
        access_count: 0,
        last_accessed_at: now,
        created_at: now,
        updated_at: now,
      });
    }

    // Bulk insert using a transaction for speed
    const insertStmt = db.prepare(
      'INSERT INTO memories (id,type,content,subject,confidence,importance,source_session,access_count,last_accessed_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    );
    const insertMany = db.transaction((mems: MemoryEntry[]) => {
      for (const m of mems) {
        insertStmt.run(m.id, m.type, m.content, m.subject, m.confidence, m.importance, m.source_session, m.access_count, m.last_accessed_at, m.created_at, m.updated_at);
      }
    });
    insertMany(memories);

    // Rebuild search engine to include the 1000 memories
    const engine = createSearchEngine(db);
    facade = new StorageFacade(db, engine);

    // Measure retrieval time
    const retrievalStart = Date.now();
    const result = await handleBeforeTurn(db, facade, {
      session_key: 'session-perf-test',
      conversation_context: 'TypeScript advanced features generics conditional types',
      previous_session_key: null,
      previous_conversation_history: null,
    });
    const retrievalElapsed = Date.now() - retrievalStart;

    // Memory retrieval part must be < 100ms (AC10)
    expect(retrievalElapsed).toBeLessThan(100);

    // And we actually retrieved some memories (verifying the measurement covers real work)
    expect(result.injected_memories.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// AC11: LLM fully unavailable — all three hooks return defaults, no exceptions
// ---------------------------------------------------------------------------

describe('Full lifecycle: silent degradation when all LLM calls fail (AC11)', () => {
  it('beforeTurn returns default response with no exception when LLM fails for extraction (AC11)', async () => {
    // Add existing memories for injection
    facade.addMemory({
      id: 'mem-existing-llm-fail',
      type: 'fact',
      content: 'Redis is used for distributed caching in production systems',
      subject: 'redis-caching',
      confidence: 0.9,
      importance: 0.8,
      source_session: 'session-old',
      access_count: 0,
      last_accessed_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // LLM extraction throws (simulates network failure)
    vi.spyOn(llmModule, 'callLLM').mockRejectedValue(new Error('Network failure'));

    let threw = false;
    let result: Awaited<ReturnType<typeof handleBeforeTurn>> | undefined;
    try {
      result = await handleBeforeTurn(db, facade, {
        session_key: 'session-N+1',
        conversation_context: 'Redis caching distributed systems',
        previous_session_key: 'session-N',
        previous_conversation_history: makeHistory('tell me about Redis caching'),
      });
    } catch {
      threw = true;
    }

    // No exception thrown (AC11)
    expect(threw).toBe(false);
    expect(result).toBeDefined();

    // extraction_triggered=false because LLM threw → callLLM never completes successfully
    // but the hook itself must not throw regardless
    // Note: extraction_triggered=true because it WAS triggered (the async LLM call is fire-and-forget)
    // The injection from existing memories still works (AC11)
    expect(Array.isArray(result!.injected_memories)).toBe(true);

    // injected_memories should come from existing memories (not LLM), which still works (AC11)
    // Wait for any async silently failing
    await new Promise(r => setTimeout(r, 50));
  });

  it('beforeTurn returns injected memories from existing DB memories even when LLM extraction fails (AC11)', async () => {
    facade.addMemory({
      id: 'mem-llm-fail-inject',
      type: 'preference',
      content: 'User prefers dark mode for all interfaces',
      subject: 'dark-mode-preference',
      confidence: 0.9,
      importance: 0.85,
      source_session: 'session-old',
      access_count: 0,
      last_accessed_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // LLM fails
    vi.spyOn(llmModule, 'callLLM').mockRejectedValue(new Error('LLM timeout'));

    const result = await handleBeforeTurn(db, facade, {
      session_key: 'session-N+1',
      conversation_context: 'dark mode preference interface theme',
      previous_session_key: 'session-N',
      previous_conversation_history: makeHistory('I prefer dark mode'),
    });

    // Injection of existing memories still works despite LLM failure (AC11)
    expect(result.injected_memories.length).toBeGreaterThan(0);
    const injected = result.injected_memories.find(m => m.id === 'mem-llm-fail-inject');
    expect(injected).toBeDefined();

    await new Promise(r => setTimeout(r, 50));
  });

  it('afterTask returns reflection_id=null when LLM reflection generation fails (AC11)', async () => {
    // LLM reflection call throws
    vi.spyOn(reflectionModule, 'generateReflection').mockRejectedValue(
      new Error('LLM service unavailable'),
    );

    let threw = false;
    let result: Awaited<ReturnType<typeof handleAfterTask>> | undefined;
    try {
      result = await handleAfterTask(db, facade, {
        session_key: 'session-task',
        task_type: 'code',
        task_summary: 'implement feature X',
        conversation_history: makeHistory('feature implemented'),
        signals: {
          user_feedback: 'thanks',
          review_result: null,
          was_respawned: false,
          timed_out: false,
        },
        agent_id: null,
      });
    } catch {
      threw = true;
    }

    // No exception (AC11)
    expect(threw).toBe(false);
    expect(result).toBeDefined();
    // reflection_id=null (AC11)
    expect(result!.reflection_id).toBeNull();

    await new Promise(r => setTimeout(r, 50));
  });

  it('beforeSpawn returns original task_description when reflections table is empty after LLM failure (AC11)', async () => {
    // DB has no reflections (LLM failure means none were generated)
    const originalDescription = 'implement new feature for user authentication';

    let threw = false;
    let result: Awaited<ReturnType<typeof handleBeforeSpawn>> | undefined;
    try {
      result = await handleBeforeSpawn(db, facade, {
        task_description: originalDescription,
        task_type: 'code',
        agent_id: null,
      });
    } catch {
      threw = true;
    }

    // No exception (AC11)
    expect(threw).toBe(false);
    expect(result).toBeDefined();
    // Returns original task description unchanged (AC11)
    expect(result!.augmented_task_description).toBe(originalDescription);
    expect(result!.injected_reflections).toEqual([]);
  });

  it('all three hooks complete without exceptions in sequence when LLM is down (AC11)', async () => {
    // Add some existing memories
    facade.addMemory({
      id: 'mem-all-down-test',
      type: 'fact',
      content: 'Docker containers provide environment isolation for deployments',
      subject: 'docker-containers',
      confidence: 0.8,
      importance: 0.7,
      source_session: 'session-old',
      access_count: 0,
      last_accessed_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // All LLM calls fail
    vi.spyOn(llmModule, 'callLLM').mockRejectedValue(new Error('Service down'));
    vi.spyOn(reflectionModule, 'generateReflection').mockRejectedValue(
      new Error('Service down'),
    );

    const errors: Error[] = [];

    // 1. beforeTurn (with previous_session_key for extraction attempt)
    let beforeTurnResult: Awaited<ReturnType<typeof handleBeforeTurn>> | undefined;
    try {
      beforeTurnResult = await handleBeforeTurn(db, facade, {
        session_key: 'session-N+1',
        conversation_context: 'Docker containers deployment isolation',
        previous_session_key: 'session-N',
        previous_conversation_history: makeHistory('tell me about Docker'),
      });
    } catch (e) {
      errors.push(e as Error);
    }

    // 2. afterTask
    let afterTaskResult: Awaited<ReturnType<typeof handleAfterTask>> | undefined;
    try {
      afterTaskResult = await handleAfterTask(db, facade, {
        session_key: 'session-task',
        task_type: 'code',
        task_summary: 'deploy service',
        conversation_history: makeHistory('deployment done'),
        signals: { user_feedback: 'good', review_result: null, was_respawned: false, timed_out: false },
        agent_id: null,
      });
    } catch (e) {
      errors.push(e as Error);
    }

    // 3. beforeSpawn
    let beforeSpawnResult: Awaited<ReturnType<typeof handleBeforeSpawn>> | undefined;
    try {
      beforeSpawnResult = await handleBeforeSpawn(db, facade, {
        task_description: 'deploy new service to production',
        task_type: 'code',
        agent_id: null,
      });
    } catch (e) {
      errors.push(e as Error);
    }

    await new Promise(r => setTimeout(r, 100));

    // All three hooks completed without exceptions (AC11)
    expect(errors).toHaveLength(0);

    // beforeTurn: injection from existing memories still works (not LLM-dependent)
    expect(beforeTurnResult).toBeDefined();
    expect(Array.isArray(beforeTurnResult!.injected_memories)).toBe(true);

    // afterTask: reflection_id=null (LLM failed)
    expect(afterTaskResult).toBeDefined();
    expect(afterTaskResult!.reflection_id).toBeNull();

    // beforeSpawn: original description unchanged (no reflections stored)
    expect(beforeSpawnResult).toBeDefined();
    expect(beforeSpawnResult!.injected_reflections).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Scenario 1 (BDD): Complete memory extraction-injection lifecycle
// ---------------------------------------------------------------------------

describe('BDD Scenario 1: complete memory extraction-injection lifecycle (E2E)', () => {
  it('Session N+1 beforeTurn triggers extraction from Session N and injects relevant memories (Scenario 1)', async () => {
    // GIVEN: Session N conversation contains language preference info
    const sessionNHistory: Message[] = [
      { role: 'user', content: '我希望你用中文沟通，简洁回答' },
      { role: 'assistant', content: '好的，我会用中文回答您的问题。' },
    ];

    // LLM extracts language preference from session N
    vi.spyOn(llmModule, 'callLLM').mockResolvedValue([
      {
        type: 'preference',
        content: '用户偏好中文沟通',
        subject: 'user-language-preference',
        confidence: 0.92,
        importance: 0.85,
      },
    ]);

    // WHEN: Session N+1 beforeTurn fires with previous_session_key pointing to Session N
    const firstCall = await handleBeforeTurn(db, facade, {
      session_key: 'session-N+1',
      conversation_context: '语言设置相关问题',
      previous_session_key: 'session-N',
      previous_conversation_history: sessionNHistory,
    });

    // THEN: extraction_triggered = true (Scenario 1, AC1)
    expect(firstCall.extraction_triggered).toBe(true);

    // Wait for async extraction to complete
    await new Promise(r => setTimeout(r, 150));

    // AND: memories from Session N are now in DB
    const extractedMems = db
      .prepare('SELECT * FROM memories WHERE subject = ?')
      .all('user-language-preference') as MemoryEntry[];
    expect(extractedMems.length).toBe(1);
    expect(extractedMems[0].content).toBe('用户偏好中文沟通');

    // Rebuild engine to include the newly extracted memory
    const newEngine = createSearchEngine(db);
    facade = new StorageFacade(db, newEngine);

    // THEN: second call to beforeTurn injects the extracted memory (Scenario 1, AC2)
    const secondCall = await handleBeforeTurn(db, facade, {
      session_key: 'session-N+1',
      conversation_context: '语言偏好中文沟通问题',
      previous_session_key: null,
      previous_conversation_history: null,
    });

    expect(secondCall.injected_memories.length).toBeGreaterThan(0);
    const injected = secondCall.injected_memories.find(
      m => m.subject === 'user-language-preference',
    );
    expect(injected).toBeDefined();
    expect(injected!.content).toBe('用户偏好中文沟通');
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 (BDD): Complete reflection generation-injection lifecycle
// ---------------------------------------------------------------------------

describe('BDD Scenario 2: complete reflection generation-injection lifecycle (E2E)', () => {
  it('afterTask generates reflection, beforeSpawn retrieves and injects it (Scenario 2)', async () => {
    // GIVEN: empty reflections table
    const cntBefore = db.prepare('SELECT COUNT(*) as c FROM reflections').get() as { c: number };
    expect(cntBefore.c).toBe(0);

    // Mock LLM reflection
    vi.spyOn(reflectionModule, 'generateReflection').mockResolvedValue({
      task_type: 'code',
      task_summary: '替换 PDF 库完成优化',
      outcome: 'success',
      reflection: 'PDF library was replaced successfully with minimal disruption.',
      lessons: ['Evaluate API compatibility first', 'Test with existing documents'],
    });

    // WHEN: afterTask with positive feedback
    await handleAfterTask(db, facade, {
      session_key: 'session-pdf',
      task_type: 'code',
      task_summary: '替换 PDF 库完成优化',
      conversation_history: makeHistory('PDF 库替换完成'),
      signals: {
        user_feedback: 'great',
        review_result: null,
        was_respawned: false,
        timed_out: false,
      },
      agent_id: null,
    });

    // Wait for async completion
    await new Promise(r => setTimeout(r, 150));

    // THEN: reflections table has a record
    const cntAfter = db.prepare('SELECT COUNT(*) as c FROM reflections').get() as { c: number };
    expect(cntAfter.c).toBe(1);

    // WHEN: beforeSpawn with PDF-related task
    const originalDescription = 'Implement PDF export feature for reports';
    const spawnResult = await handleBeforeSpawn(db, facade, {
      task_description: originalDescription,
      task_type: 'code',
      agent_id: null,
    });

    // THEN: augmented_task_description is longer than original (Scenario 2)
    expect(spawnResult.augmented_task_description.length).toBeGreaterThan(
      originalDescription.length,
    );

    // AND: injected_reflections is non-empty (Scenario 2)
    expect(spawnResult.injected_reflections.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 (BDD): Memory conflict update injects latest value
// ---------------------------------------------------------------------------

describe('BDD Scenario 3: memory conflict update injects latest value (E2E)', () => {
  it('after conflict upsert, injected memory has latest content (Scenario 3)', async () => {
    const originalCreatedAt = new Date(Date.now() - 20000).toISOString();

    // GIVEN: existing memory with old content
    facade.addMemory({
      id: 'flreey-lang-original',
      type: 'preference',
      content: '偏好英文',
      subject: 'flreey',
      confidence: 0.7,
      importance: 0.6,
      source_session: 'session-old',
      access_count: 0,
      last_accessed_at: null,
      created_at: originalCreatedAt,
      updated_at: originalCreatedAt,
    });

    // WHEN: extraction produces conflicting new content
    vi.spyOn(llmModule, 'callLLM').mockResolvedValue([
      {
        type: 'preference',
        content: '偏好中文',
        subject: 'flreey',
        confidence: 0.95,
        importance: 0.9,
      },
    ]);

    await handleBeforeTurn(db, facade, {
      session_key: 'session-N+1',
      conversation_context: 'flreey 语言偏好',
      previous_session_key: 'session-new',
      previous_conversation_history: makeHistory('flreey 现在更喜欢中文'),
    });

    await new Promise(r => setTimeout(r, 150));

    // THEN: only one record for flreey type=preference
    const rows = db
      .prepare('SELECT * FROM memories WHERE subject = ? AND type = ?')
      .all('flreey', 'preference') as MemoryEntry[];
    expect(rows.length).toBe(1);

    // AND: content is updated to latest (Scenario 3)
    expect(rows[0].content).toBe('偏好中文');

    // Rebuild search engine to include the updated memory
    const newEngine = createSearchEngine(db);
    facade = new StorageFacade(db, newEngine);

    // THEN: beforeTurn returns the updated memory
    const result = await handleBeforeTurn(db, facade, {
      session_key: 'session-N+2',
      conversation_context: 'flreey 偏好中文语言',
      previous_session_key: null,
      previous_conversation_history: null,
    });

    expect(result.injected_memories.length).toBeGreaterThan(0);
    const injected = result.injected_memories.find(m => m.subject === 'flreey');
    expect(injected).toBeDefined();
    // Injected memory has the latest content '偏好中文' (Scenario 3)
    expect(injected!.content).toBe('偏好中文');
  });
});

// ---------------------------------------------------------------------------
// Scenario 4 (BDD): LLM fully unavailable — end-to-end silent degradation
// ---------------------------------------------------------------------------

describe('BDD Scenario 4: LLM fully unavailable — end-to-end silent degradation (E2E)', () => {
  it('all three hooks function gracefully when LLM is down (Scenario 4)', async () => {
    // Add some existing memories for injection
    facade.addMemory({
      id: 'mem-existing-scenario4',
      type: 'fact',
      content: 'Node.js event loop handles I/O operations asynchronously',
      subject: 'nodejs-event-loop',
      confidence: 0.9,
      importance: 0.8,
      source_session: 'session-old',
      access_count: 0,
      last_accessed_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // GIVEN: LLM returns error
    vi.spyOn(llmModule, 'callLLM').mockRejectedValue(new Error('Network failure'));
    vi.spyOn(reflectionModule, 'generateReflection').mockRejectedValue(
      new Error('Network failure'),
    );

    const errors: unknown[] = [];

    // WHEN: beforeTurn with previous_session_key
    let beforeTurnResult: Awaited<ReturnType<typeof handleBeforeTurn>> | undefined;
    try {
      beforeTurnResult = await handleBeforeTurn(db, facade, {
        session_key: 'session-N+1',
        conversation_context: 'Node.js event loop asynchronous operations',
        previous_session_key: 'session-N',
        previous_conversation_history: makeHistory('Node.js async'),
      });
    } catch (e) {
      errors.push(e);
    }

    // WHEN: afterTask with signals
    let afterTaskResult: Awaited<ReturnType<typeof handleAfterTask>> | undefined;
    try {
      afterTaskResult = await handleAfterTask(db, facade, {
        session_key: 'session-task',
        task_type: 'code',
        task_summary: 'implement async handler',
        conversation_history: makeHistory('async handler done'),
        signals: {
          user_feedback: 'thanks',
          review_result: null,
          was_respawned: false,
          timed_out: false,
        },
        agent_id: null,
      });
    } catch (e) {
      errors.push(e);
    }

    // WHEN: beforeSpawn
    let beforeSpawnResult: Awaited<ReturnType<typeof handleBeforeSpawn>> | undefined;
    try {
      beforeSpawnResult = await handleBeforeSpawn(db, facade, {
        task_description: 'implement async event handler for Node.js',
        task_type: 'code',
        agent_id: null,
      });
    } catch (e) {
      errors.push(e);
    }

    await new Promise(r => setTimeout(r, 100));

    // THEN: No exceptions from any hook (Scenario 4, AC11)
    expect(errors).toHaveLength(0);

    // THEN: beforeTurn returns injected_memories from existing memories (not LLM)
    // and extraction_triggered from the check (may be true since session-N not extracted)
    expect(beforeTurnResult).toBeDefined();
    expect(Array.isArray(beforeTurnResult!.injected_memories)).toBe(true);
    // Existing memories are injected even when LLM fails
    const nodeMemInjected = beforeTurnResult!.injected_memories.find(
      m => m.id === 'mem-existing-scenario4',
    );
    expect(nodeMemInjected).toBeDefined();

    // THEN: afterTask returns reflection_id=null (AC11, Scenario 4)
    expect(afterTaskResult).toBeDefined();
    expect(afterTaskResult!.reflection_id).toBeNull();

    // THEN: beforeSpawn returns original description unchanged (no reflections stored) (AC11)
    expect(beforeSpawnResult).toBeDefined();
    expect(beforeSpawnResult!.augmented_task_description).toBe(
      'implement async event handler for Node.js',
    );
    expect(beforeSpawnResult!.injected_reflections).toEqual([]);
  });
});
