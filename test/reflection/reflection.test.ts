/**
 * Tests for signal-outcome resolution algorithm and LLM reflection generation.
 * Covers: resolveOutcome(), generateReflection()
 * Source: src/reflection/index.ts
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  resolveOutcome,
  generateReflection,
  retrieveReflections,
} from '../../src/reflection/index.js';
import * as llmModule from '../../src/llm/index.js';
import type { TaskSignals, Message } from '../../src/types/index.js';
import type { DB } from '../../src/storage/db.js';
import { initializeDatabase } from '../../src/storage/db.js';
import { createSearchEngine } from '../../src/search/index.js';
import { StorageFacade } from '../../src/storage/facade.js';

// ---------------------------------------------------------------------------
// resolveOutcome — signal-outcome resolution algorithm
// ---------------------------------------------------------------------------

describe('resolveOutcome - failure from negative signals only', () => {
  it('resolves to failure when timed_out=true and no positive signals (AC1)', () => {
    const signals: TaskSignals = {
      timed_out: true,
      was_respawned: false,
      review_result: null,
      user_feedback: null,
    };
    expect(resolveOutcome(signals)).toBe('failure');
  });

  it('resolves to failure when was_respawned=true and no positive signals (AC2)', () => {
    const signals: TaskSignals = {
      timed_out: false,
      was_respawned: true,
      review_result: null,
      user_feedback: null,
    };
    expect(resolveOutcome(signals)).toBe('failure');
  });

  it('resolves to failure when review_result=FAIL and no positive signals (AC3)', () => {
    const signals: TaskSignals = {
      timed_out: false,
      was_respawned: false,
      review_result: 'FAIL',
      user_feedback: null,
    };
    expect(resolveOutcome(signals)).toBe('failure');
  });

  it('resolves to failure when negative user_feedback "wrong" and no positive signals (AC6)', () => {
    const signals: TaskSignals = {
      timed_out: false,
      was_respawned: false,
      review_result: null,
      user_feedback: 'that is wrong',
    };
    expect(resolveOutcome(signals)).toBe('failure');
  });

  it('resolves to failure when negative user_feedback "redo" and no positive signals (AC6)', () => {
    const signals: TaskSignals = {
      timed_out: false,
      was_respawned: false,
      review_result: null,
      user_feedback: 'please redo this',
    };
    expect(resolveOutcome(signals)).toBe('failure');
  });

  it('resolves to failure when negative user_feedback "fix" and no positive signals (AC6)', () => {
    const signals: TaskSignals = {
      timed_out: false,
      was_respawned: false,
      review_result: null,
      user_feedback: 'please fix this',
    };
    expect(resolveOutcome(signals)).toBe('failure');
  });

  it('resolves to failure when negative user_feedback "不对" and no positive signals (AC6)', () => {
    const signals: TaskSignals = {
      timed_out: false,
      was_respawned: false,
      review_result: null,
      user_feedback: '不对，重新来',
    };
    expect(resolveOutcome(signals)).toBe('failure');
  });

  it('resolves to failure when negative user_feedback "重来" and no positive signals (AC6)', () => {
    const signals: TaskSignals = {
      timed_out: false,
      was_respawned: false,
      review_result: null,
      user_feedback: '重来一次',
    };
    expect(resolveOutcome(signals)).toBe('failure');
  });

  it('resolves to failure when negative user_feedback "错" and no positive signals (AC6)', () => {
    const signals: TaskSignals = {
      timed_out: false,
      was_respawned: false,
      review_result: null,
      user_feedback: '这个错了',
    };
    expect(resolveOutcome(signals)).toBe('failure');
  });

  it('resolves to failure when both timed_out and was_respawned are true (multiple failure signals)', () => {
    const signals: TaskSignals = {
      timed_out: true,
      was_respawned: true,
      review_result: null,
      user_feedback: null,
    };
    expect(resolveOutcome(signals)).toBe('failure');
  });
});

describe('resolveOutcome - success from positive signals only', () => {
  it('resolves to success when review_result=PASS and no negative signals (AC4)', () => {
    const signals: TaskSignals = {
      timed_out: false,
      was_respawned: false,
      review_result: 'PASS',
      user_feedback: null,
    };
    expect(resolveOutcome(signals)).toBe('success');
  });

  it('resolves to success when user_feedback matches "谢谢" and no negative signals (AC5)', () => {
    const signals: TaskSignals = {
      timed_out: false,
      was_respawned: false,
      review_result: null,
      user_feedback: '谢谢你的帮助',
    };
    expect(resolveOutcome(signals)).toBe('success');
  });

  it('resolves to success when user_feedback matches "thanks" and no negative signals (AC5)', () => {
    const signals: TaskSignals = {
      timed_out: false,
      was_respawned: false,
      review_result: null,
      user_feedback: 'thanks a lot',
    };
    expect(resolveOutcome(signals)).toBe('success');
  });

  it('resolves to success when user_feedback matches "good" and no negative signals (AC5)', () => {
    const signals: TaskSignals = {
      timed_out: false,
      was_respawned: false,
      review_result: null,
      user_feedback: 'good work',
    };
    expect(resolveOutcome(signals)).toBe('success');
  });

  it('resolves to success when user_feedback matches "great" and no negative signals (AC5)', () => {
    const signals: TaskSignals = {
      timed_out: false,
      was_respawned: false,
      review_result: null,
      user_feedback: 'that is great',
    };
    expect(resolveOutcome(signals)).toBe('success');
  });

  it('resolves to success when user_feedback matches "perfect" and no negative signals (AC5)', () => {
    const signals: TaskSignals = {
      timed_out: false,
      was_respawned: false,
      review_result: null,
      user_feedback: 'perfect solution',
    };
    expect(resolveOutcome(signals)).toBe('success');
  });

  it('resolves to success when user_feedback matches "nice" and no negative signals (AC5)', () => {
    const signals: TaskSignals = {
      timed_out: false,
      was_respawned: false,
      review_result: null,
      user_feedback: 'nice work',
    };
    expect(resolveOutcome(signals)).toBe('success');
  });
});

describe('resolveOutcome - partial when mixed or no signals', () => {
  it('resolves to partial when all signals are empty/false (AC8)', () => {
    const signals: TaskSignals = {
      timed_out: false,
      was_respawned: false,
      review_result: null,
      user_feedback: null,
    };
    expect(resolveOutcome(signals)).toBe('partial');
  });

  it('resolves to partial when user_feedback is an empty string', () => {
    const signals: TaskSignals = {
      timed_out: false,
      was_respawned: false,
      review_result: null,
      user_feedback: '',
    };
    expect(resolveOutcome(signals)).toBe('partial');
  });

  it('resolves to partial when positive and negative signals both present: review_result=PASS + timed_out=true (AC7)', () => {
    const signals: TaskSignals = {
      timed_out: true,
      was_respawned: false,
      review_result: 'PASS',
      user_feedback: null,
    };
    expect(resolveOutcome(signals)).toBe('partial');
  });

  it('resolves to partial when positive user_feedback + review_result=FAIL (AC7)', () => {
    const signals: TaskSignals = {
      timed_out: false,
      was_respawned: false,
      review_result: 'FAIL',
      user_feedback: 'thanks anyway',
    };
    expect(resolveOutcome(signals)).toBe('partial');
  });

  it('resolves to partial when positive user_feedback + was_respawned=true (AC7)', () => {
    const signals: TaskSignals = {
      timed_out: false,
      was_respawned: true,
      review_result: null,
      user_feedback: 'good try',
    };
    expect(resolveOutcome(signals)).toBe('partial');
  });

  it('resolves to partial when both positive and negative user_feedback keywords absent but both flags true', () => {
    // timed_out=true (failure) + review_result=PASS (success) → partial
    const signals: TaskSignals = {
      timed_out: true,
      was_respawned: false,
      review_result: 'PASS',
      user_feedback: 'good',
    };
    expect(resolveOutcome(signals)).toBe('partial');
  });
});

// ---------------------------------------------------------------------------
// generateReflection — LLM reflection generation function
// ---------------------------------------------------------------------------

describe('generateReflection - return shape', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns object with task_type, task_summary, outcome, reflection, lessons fields (AC9)', async () => {
    // Mock callReflectionLLM to avoid real API call
    vi.spyOn(llmModule, 'callReflectionLLM').mockResolvedValue({
      task_type: 'code',
      task_summary: 'Implement authentication module',
      outcome: 'success',
      reflection: 'The task was completed efficiently using TDD.',
      lessons: ['Write tests first', 'Keep functions small'],
    });

    const signals: TaskSignals = {
      timed_out: false,
      was_respawned: false,
      review_result: 'PASS',
      user_feedback: null,
    };

    const history: Message[] = [
      { role: 'user', content: 'Implement auth.' },
      { role: 'assistant', content: 'Done, used JWT.' },
    ];

    const result = await generateReflection('code', 'Implement authentication module', history, signals);

    expect(result).not.toBeNull();
    expect(result).toHaveProperty('task_type');
    expect(result).toHaveProperty('task_summary');
    expect(result).toHaveProperty('outcome');
    expect(result).toHaveProperty('reflection');
    expect(result).toHaveProperty('lessons');
    expect(typeof result!.task_type).toBe('string');
    expect(typeof result!.task_summary).toBe('string');
    expect(typeof result!.reflection).toBe('string');
    expect(Array.isArray(result!.lessons)).toBe(true);
  });

  it('outcome in result matches resolved signal outcome (AC9)', async () => {
    vi.spyOn(llmModule, 'callReflectionLLM').mockResolvedValue({
      task_type: 'research',
      task_summary: 'Research new API',
      outcome: 'failure',
      reflection: 'Task timed out before completing.',
      lessons: ['Set tighter scope'],
    });

    const signals: TaskSignals = {
      timed_out: true,
      was_respawned: false,
      review_result: null,
      user_feedback: null,
    };

    const result = await generateReflection('research', 'Research new API', [], signals);
    expect(result!.outcome).toBe('failure');
  });

  it('lessons field is an array of strings (AC9)', async () => {
    vi.spyOn(llmModule, 'callReflectionLLM').mockResolvedValue({
      task_type: 'deployment',
      task_summary: 'Deploy to production',
      outcome: 'success',
      reflection: 'Deployment went smoothly.',
      lessons: ['Always run smoke tests', 'Monitor for 15 minutes after deploy'],
    });

    const signals: TaskSignals = {
      timed_out: false,
      was_respawned: false,
      review_result: 'PASS',
      user_feedback: null,
    };

    const result = await generateReflection('deployment', 'Deploy to production', [], signals);
    expect(Array.isArray(result!.lessons)).toBe(true);
    for (const lesson of result!.lessons) {
      expect(typeof lesson).toBe('string');
    }
  });
});

describe('generateReflection - silent degradation on LLM failure (AC10)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null when LLM throws an error (AC10)', async () => {
    vi.spyOn(llmModule, 'callReflectionLLM').mockRejectedValue(new Error('LLM service unavailable'));

    const signals: TaskSignals = {
      timed_out: false,
      was_respawned: false,
      review_result: 'PASS',
      user_feedback: null,
    };

    const result = await generateReflection('code', 'Some task', [], signals);
    expect(result).toBeNull();
  });

  it('does not throw when LLM fails (AC10)', async () => {
    vi.spyOn(llmModule, 'callReflectionLLM').mockRejectedValue(new Error('Network error'));

    const signals: TaskSignals = {
      timed_out: false,
      was_respawned: false,
      review_result: null,
      user_feedback: 'thanks',
    };

    let threw = false;
    try {
      await generateReflection('code', 'Some task', [], signals);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });

  it('returns null when LLM returns null (AC10)', async () => {
    vi.spyOn(llmModule, 'callReflectionLLM').mockResolvedValue(null);

    const signals: TaskSignals = {
      timed_out: false,
      was_respawned: false,
      review_result: null,
      user_feedback: null,
    };

    const result = await generateReflection('code', 'Some task', [], signals);
    expect(result).toBeNull();
  });

  it('returns null when no API key configured (silent degradation)', async () => {
    // callReflectionLLM returns null when no API key (same degradation pattern as callLLM)
    vi.spyOn(llmModule, 'callReflectionLLM').mockResolvedValue(null);

    const signals: TaskSignals = {
      timed_out: false,
      was_respawned: false,
      review_result: 'FAIL',
      user_feedback: null,
    };

    const result = await generateReflection('code', 'Task', [], signals);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// retrieveReflections — BM25 retrieval by task_type and task_summary
// ---------------------------------------------------------------------------

describe('retrieveReflections - returns scored reflections ranked by BM25 (AC1, AC2)', () => {
  let db: DB;
  let tempDbPath: string;
  let facade: StorageFacade;

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'learnloop-retrieve-refl-'));
    tempDbPath = path.join(tmpDir, 'test.db');
    db = initializeDatabase(tempDbPath);
    const engine = createSearchEngine(db);
    facade = new StorageFacade(db, engine);
  });

  afterEach(() => {
    try { db.close(); } catch { /* ignore */ }
    try {
      fs.rmSync(path.dirname(tempDbPath), { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('returns reflections matching task_type and task_summary (AC1, AC2)', () => {
    // Insert reflections with code task_type
    const now = new Date().toISOString();
    facade.addReflection({
      id: 'r1',
      task_type: 'code',
      task_summary: '实现用户注册功能',
      outcome: 'success',
      signals: '{}',
      reflection: 'The registration was implemented with proper validation.',
      lessons: '[]',
      agent_id: null,
      source_session: 'session-1',
      created_at: now,
    });
    facade.addReflection({
      id: 'r2',
      task_type: 'code',
      task_summary: '实现登录功能',
      outcome: 'success',
      signals: '{}',
      reflection: 'Login was implemented using JWT tokens.',
      lessons: '[]',
      agent_id: null,
      source_session: 'session-2',
      created_at: now,
    });

    const result = retrieveReflections(db, facade, 'code', '实现注册', 10);
    expect(result.length).toBeGreaterThan(0);
    // The reflections should be from our test data
    const ids = result.map(r => r.id);
    expect(ids.some(id => id === 'r1' || id === 'r2')).toBe(true);
  });

  it('returns reflections sorted by BM25 score in descending order (AC1)', () => {
    const now = new Date().toISOString();
    facade.addReflection({
      id: 'r-match',
      task_type: 'code',
      task_summary: '实现用户注册功能',
      outcome: 'success',
      signals: '{}',
      reflection: '注册功能已完成',
      lessons: '[]',
      agent_id: null,
      source_session: 's1',
      created_at: now,
    });
    facade.addReflection({
      id: 'r-weak',
      task_type: 'research',
      task_summary: 'General research task',
      outcome: 'partial',
      signals: '{}',
      reflection: 'Some research done.',
      lessons: '[]',
      agent_id: null,
      source_session: 's2',
      created_at: now,
    });

    const result = retrieveReflections(db, facade, 'code', '实现注册', 10);
    // Scores must be in descending order
    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1].score).toBeGreaterThanOrEqual(result[i].score);
    }
  });

  it('respects the limit parameter (AC3)', () => {
    const now = new Date().toISOString();
    // Insert 5 reflections all matching "code"
    for (let i = 1; i <= 5; i++) {
      facade.addReflection({
        id: `r${i}`,
        task_type: 'code',
        task_summary: `实现功能 ${i}`,
        outcome: 'success',
        signals: '{}',
        reflection: `代码实现完成 ${i}`,
        lessons: '[]',
        agent_id: null,
        source_session: `session-${i}`,
        created_at: now,
      });
    }

    const result = retrieveReflections(db, facade, 'code', '实现功能', 3);
    expect(result.length).toBeLessThanOrEqual(3);
  });

  it('returns empty array when no reflections match (AC4)', () => {
    // Empty DB
    const result = retrieveReflections(db, facade, 'code', '实现注册', 10);
    expect(result).toEqual([]);
  });

  it('returns empty array when query does not match any reflection (AC4)', () => {
    const now = new Date().toISOString();
    facade.addReflection({
      id: 'r1',
      task_type: 'research',
      task_summary: 'Research paper analysis',
      outcome: 'success',
      signals: '{}',
      reflection: 'Paper was analyzed thoroughly.',
      lessons: '[]',
      agent_id: null,
      source_session: 's1',
      created_at: now,
    });

    // Query with completely unrelated terms
    const result = retrieveReflections(db, facade, 'xyz', 'completely unrelated query zzz', 10);
    expect(result).toEqual([]);
  });

  it('searches across both task_type and task_summary fields (AC2)', () => {
    const now = new Date().toISOString();
    // One reflection matches via task_summary only
    facade.addReflection({
      id: 'r-summary-match',
      task_type: 'general',
      task_summary: '实现用户认证',
      outcome: 'success',
      signals: '{}',
      reflection: 'Auth completed.',
      lessons: '[]',
      agent_id: null,
      source_session: 's1',
      created_at: now,
    });

    // Another matches via task_type only (task_type='code', reflection has no 'code' word)
    facade.addReflection({
      id: 'r-type-match',
      task_type: 'code',
      task_summary: '其他内容',
      outcome: 'success',
      signals: '{}',
      reflection: 'Task completed successfully.',
      lessons: '[]',
      agent_id: null,
      source_session: 's2',
      created_at: now,
    });

    // Search for "code" in task_type and "实现" in task_summary
    const result = retrieveReflections(db, facade, 'code', '实现', 10);
    // Should get some matches (at least the type-match from code task_type)
    expect(result.length).toBeGreaterThan(0);
  });

  it('returned entries have ScoredReflectionEntry shape with score field (AC1)', () => {
    const now = new Date().toISOString();
    facade.addReflection({
      id: 'r1',
      task_type: 'code',
      task_summary: '实现功能',
      outcome: 'success',
      signals: '{}',
      reflection: 'Done',
      lessons: '[]',
      agent_id: null,
      source_session: 's1',
      created_at: now,
    });

    const result = retrieveReflections(db, facade, 'code', '实现功能', 10);
    if (result.length > 0) {
      expect(result[0]).toHaveProperty('id');
      expect(result[0]).toHaveProperty('score');
      expect(result[0]).toHaveProperty('task_type');
      expect(result[0]).toHaveProperty('task_summary');
      expect(result[0]).toHaveProperty('reflection');
      expect(result[0]).toHaveProperty('outcome');
      expect(typeof result[0].score).toBe('number');
    }
  });
});

describe('retrieveReflections - latency constraint (AC10)', () => {
  let db: DB;
  let tempDbPath: string;
  let facade: StorageFacade;

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'learnloop-latency-test-'));
    tempDbPath = path.join(tmpDir, 'test.db');
    db = initializeDatabase(tempDbPath);
    const engine = createSearchEngine(db);
    facade = new StorageFacade(db, engine);
  });

  afterEach(() => {
    try { db.close(); } catch { /* ignore */ }
    try {
      fs.rmSync(path.dirname(tempDbPath), { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('completes retrieval in under 100ms for 500 reflections (AC10)', () => {
    const now = new Date().toISOString();
    type ReflectionRow = {
      id: string;
      task_type: string;
      task_summary: string;
      outcome: 'success' | 'failure' | 'partial';
      signals: string;
      reflection: string;
      lessons: string;
      agent_id: null;
      source_session: string;
      created_at: string;
    };
    const reflections: ReflectionRow[] = [];
    for (let i = 0; i < 500; i++) {
      reflections.push({
        id: `perf-r${i}`,
        task_type: i % 3 === 0 ? 'code' : i % 3 === 1 ? 'research' : 'design',
        task_summary: `实现功能模块 ${i} 用于处理用户数据`,
        outcome: 'success',
        signals: '{}',
        reflection: `反思记录 ${i}: 这个任务已经完成，发现了一些问题并解决了它们。`,
        lessons: '[]',
        agent_id: null,
        source_session: `session-${i}`,
        created_at: now,
      });
    }
    // Batch insert via DB directly to avoid per-entry index overhead during setup
    const stmt = db.prepare(`
      INSERT INTO reflections (id, task_type, task_summary, outcome, signals, reflection, lessons, agent_id, source_session, created_at)
      VALUES (@id, @task_type, @task_summary, @outcome, @signals, @reflection, @lessons, @agent_id, @source_session, @created_at)
    `);
    const insertMany = db.transaction((rows: ReflectionRow[]) => {
      for (const row of rows) stmt.run(row);
    });
    insertMany(reflections);

    // Rebuild the search engine from DB to include all 500 records
    const freshEngine = createSearchEngine(db);
    const freshFacade = new StorageFacade(db, freshEngine);

    const start = performance.now();
    retrieveReflections(db, freshFacade, 'code', '实现功能', 5);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(100);
  });
});

describe('generateReflection - async non-blocking (AC11)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a Promise (is async) (AC11)', () => {
    vi.spyOn(llmModule, 'callReflectionLLM').mockResolvedValue(null);

    const signals: TaskSignals = {
      timed_out: false,
      was_respawned: false,
      review_result: null,
      user_feedback: null,
    };

    const result = generateReflection('code', 'Task', [], signals);
    expect(result).toBeInstanceOf(Promise);
    // Clean up the promise
    return result;
  });

  it('caller can fire-and-forget without awaiting (non-blocking pattern, AC11)', async () => {
    let resolveDelay!: () => void;
    const delayPromise = new Promise<void>(res => { resolveDelay = res; });

    vi.spyOn(llmModule, 'callReflectionLLM').mockImplementation(async () => {
      await delayPromise;
      return {
        task_type: 'code',
        task_summary: 'Task',
        outcome: 'success' as const,
        reflection: 'All good.',
        lessons: [],
      };
    });

    const signals: TaskSignals = {
      timed_out: false,
      was_respawned: false,
      review_result: 'PASS',
      user_feedback: null,
    };

    // Fire without awaiting
    const promise = generateReflection('code', 'Task', [], signals);

    // Promise is pending (not yet resolved) — demonstrates async/non-blocking
    let settled = false;
    promise.then(() => { settled = true; }).catch(() => { settled = true; });

    // Yield the event loop once — promise should still be pending
    await new Promise(r => setTimeout(r, 0));
    expect(settled).toBe(false);

    // Now resolve the delay — promise should settle
    resolveDelay();
    await promise;
    expect(settled).toBe(true);
  });
});
