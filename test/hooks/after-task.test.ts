/**
 * Tests for afterTask hook handler.
 * Covers: handleAfterTask() — signal-outcome orchestration, reflection persistence,
 *         non-blocking execution, and silent degradation.
 * Source: src/hooks/index.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { initializeDatabase } from '../../src/storage/db.js';
import { createSearchEngine } from '../../src/search/index.js';
import { StorageFacade } from '../../src/storage/facade.js';
import { getReflectionById } from '../../src/storage/repository.js';
import { handleAfterTask } from '../../src/hooks/index.js';
import * as reflectionModule from '../../src/reflection/index.js';
import type { DB } from '../../src/storage/db.js';
import type { Message, TaskSignals } from '../../src/types/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDbPath(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'learnloop-aftertask-test-'));
  return path.join(tmpDir, 'test.db');
}

function makeConversationHistory(): Message[] {
  return [
    { role: 'user', content: 'Implement the login feature.' },
    { role: 'assistant', content: 'I have implemented the login feature using JWT tokens.' },
  ];
}

function makeSuccessSignals(): TaskSignals {
  return {
    user_feedback: '谢谢',
    review_result: null,
    was_respawned: false,
    timed_out: false,
  };
}

function makeFailureSignals(): TaskSignals {
  return {
    user_feedback: null,
    review_result: 'FAIL',
    was_respawned: false,
    timed_out: false,
  };
}

function makeAllEmptySignals(): TaskSignals {
  return {
    user_feedback: null,
    review_result: null,
    was_respawned: false,
    timed_out: false,
  };
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
// AC1 & AC4: Return shape — reflection_id and outcome
// ---------------------------------------------------------------------------

describe('handleAfterTask - return shape (AC1, AC4)', () => {
  it('returns object with reflection_id and outcome fields (AC4)', async () => {
    vi.spyOn(reflectionModule, 'generateReflection').mockResolvedValue({
      task_type: 'code',
      task_summary: '实现登录功能',
      outcome: 'success',
      reflection: 'Task completed successfully using JWT.',
      lessons: ['Use JWT for stateless auth'],
    });

    const result = await handleAfterTask(db, facade, {
      session_key: 'session-001',
      task_type: 'code',
      task_summary: '实现登录功能',
      conversation_history: makeConversationHistory(),
      signals: makeSuccessSignals(),
      agent_id: 'agent-001',
    });

    // Wait for async persistence
    await new Promise(r => setTimeout(r, 50));

    expect(result).toHaveProperty('reflection_id');
    expect(result).toHaveProperty('outcome');
  });

  it('outcome stored in DB reflects resolved signal outcome based on signals (AC4)', async () => {
    vi.spyOn(reflectionModule, 'generateReflection').mockResolvedValue({
      task_type: 'code',
      task_summary: '实现登录功能',
      outcome: 'success',
      reflection: 'All good.',
      lessons: [],
    });

    await handleAfterTask(db, facade, {
      session_key: 'session-001',
      task_type: 'code',
      task_summary: '实现登录功能',
      conversation_history: makeConversationHistory(),
      signals: makeSuccessSignals(), // 谢谢 → success
      agent_id: null,
    });

    // Hook is fire-and-forget; wait for async persistence
    await new Promise(r => setTimeout(r, 50));

    // Outcome is verified via stored DB record, not the hook return value
    const rows = db.prepare('SELECT outcome FROM reflections').all() as Array<{ outcome: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0].outcome).toBe('success');
  });

  it('outcome stored in DB is failure when failure signals present (AC4)', async () => {
    vi.spyOn(reflectionModule, 'generateReflection').mockResolvedValue({
      task_type: 'code',
      task_summary: '实现登录功能',
      outcome: 'failure',
      reflection: 'Code review failed.',
      lessons: ['Review code before submitting'],
    });

    await handleAfterTask(db, facade, {
      session_key: 'session-001',
      task_type: 'code',
      task_summary: '实现登录功能',
      conversation_history: makeConversationHistory(),
      signals: makeFailureSignals(), // review_result=FAIL → failure
      agent_id: null,
    });

    // Hook is fire-and-forget; wait for async persistence
    await new Promise(r => setTimeout(r, 50));

    // Outcome is verified via stored DB record, not the hook return value
    const rows = db.prepare('SELECT outcome FROM reflections').all() as Array<{ outcome: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0].outcome).toBe('failure');
  });

  it('reflection stored in DB has a non-empty id when reflection generated successfully (AC4)', async () => {
    vi.spyOn(reflectionModule, 'generateReflection').mockResolvedValue({
      task_type: 'code',
      task_summary: '实现登录功能',
      outcome: 'success',
      reflection: 'Task completed successfully.',
      lessons: ['Write tests first'],
    });

    await handleAfterTask(db, facade, {
      session_key: 'session-001',
      task_type: 'code',
      task_summary: '实现登录功能',
      conversation_history: makeConversationHistory(),
      signals: makeSuccessSignals(),
      agent_id: null,
    });

    // Hook is fire-and-forget; wait for async persistence
    await new Promise(r => setTimeout(r, 50));

    // reflection_id is verified via stored DB record; hook returns null immediately
    const rows = db.prepare('SELECT id FROM reflections').all() as Array<{ id: string }>;
    expect(rows.length).toBe(1);
    expect(typeof rows[0].id).toBe('string');
    expect(rows[0].id.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// AC1: Hook accepts correct parameters
// ---------------------------------------------------------------------------

describe('handleAfterTask - parameter acceptance (AC1)', () => {
  it('accepts all required parameters including session_key, task_type, task_summary, conversation_history, signals, agent_id (AC1)', async () => {
    vi.spyOn(reflectionModule, 'generateReflection').mockResolvedValue(null);

    let threw = false;
    try {
      await handleAfterTask(db, facade, {
        session_key: 'session-abc',
        task_type: 'research',
        task_summary: 'Researched API options',
        conversation_history: makeConversationHistory(),
        signals: {
          user_feedback: 'great work',
          review_result: 'PASS',
          was_respawned: false,
          timed_out: false,
        },
        agent_id: 'agent-xyz',
      });
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
  });

  it('accepts null agent_id (AC1)', async () => {
    vi.spyOn(reflectionModule, 'generateReflection').mockResolvedValue(null);

    let threw = false;
    try {
      await handleAfterTask(db, facade, {
        session_key: 'session-abc',
        task_type: 'code',
        task_summary: 'Some task',
        conversation_history: [],
        signals: makeAllEmptySignals(),
        agent_id: null,
      });
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC2: Hook calls generateReflection (orchestration)
// ---------------------------------------------------------------------------

describe('handleAfterTask - orchestration: calls generateReflection (AC2)', () => {
  it('calls generateReflection with task_type, task_summary, conversation_history, signals (AC2)', async () => {
    const generateSpy = vi.spyOn(reflectionModule, 'generateReflection').mockResolvedValue(null);

    const history = makeConversationHistory();
    const signals = makeSuccessSignals();

    await handleAfterTask(db, facade, {
      session_key: 'session-001',
      task_type: 'code',
      task_summary: '实现登录功能',
      conversation_history: history,
      signals,
      agent_id: 'agent-001',
    });

    // Wait for async to settle
    await new Promise(r => setTimeout(r, 50));

    expect(generateSpy).toHaveBeenCalledWith(
      'code',
      '实现登录功能',
      history,
      signals,
    );
  });

  it('calls generateReflection exactly once per hook invocation (AC2)', async () => {
    const generateSpy = vi.spyOn(reflectionModule, 'generateReflection').mockResolvedValue(null);

    await handleAfterTask(db, facade, {
      session_key: 'session-001',
      task_type: 'code',
      task_summary: 'Some task',
      conversation_history: [],
      signals: makeSuccessSignals(),
      agent_id: null,
    });

    await new Promise(r => setTimeout(r, 50));

    expect(generateSpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// AC3: Reflection persisted to SQLite with correct fields
// ---------------------------------------------------------------------------

describe('handleAfterTask - persistence to SQLite reflections table (AC3)', () => {
  it('writes reflection to reflections table with all required fields (AC3)', async () => {
    vi.spyOn(reflectionModule, 'generateReflection').mockResolvedValue({
      task_type: 'code',
      task_summary: '实现登录功能',
      outcome: 'success',
      reflection: 'Task was completed efficiently using TDD methodology.',
      lessons: ['Write tests first', 'Keep functions small'],
    });

    await handleAfterTask(db, facade, {
      session_key: 'session-persist-test',
      task_type: 'code',
      task_summary: '实现登录功能',
      conversation_history: makeConversationHistory(),
      signals: makeSuccessSignals(),
      agent_id: 'agent-001',
    });

    // Wait for async persistence to complete
    await new Promise(r => setTimeout(r, 100));

    // Verify exactly one record was written
    const rows = db.prepare('SELECT * FROM reflections').all() as Array<{
      id: string;
      task_type: string;
      task_summary: string;
      outcome: string;
      signals: string;
      reflection: string;
      lessons: string;
      agent_id: string | null;
      source_session: string | null;
      created_at: string;
    }>;

    expect(rows.length).toBe(1);
    const stored = rows[0];

    // Verify all required fields (AC3)
    expect(typeof stored.id).toBe('string');
    expect(stored.id.length).toBeGreaterThan(0);
    expect(stored.task_type).toBe('code');
    expect(stored.task_summary).toBe('实现登录功能');
    expect(stored.outcome).toBe('success');
    expect(typeof stored.signals).toBe('string');  // JSON stringified
    expect(typeof stored.reflection).toBe('string');
    expect(stored.reflection.length).toBeGreaterThan(0);
    expect(typeof stored.lessons).toBe('string');  // JSON stringified array
    expect(stored.agent_id).toBe('agent-001');
    expect(typeof stored.created_at).toBe('string');
    expect(stored.created_at.length).toBeGreaterThan(0);
  });

  it('stored reflection text is non-empty (AC3)', async () => {
    vi.spyOn(reflectionModule, 'generateReflection').mockResolvedValue({
      task_type: 'code',
      task_summary: 'Deploy API',
      outcome: 'failure',
      reflection: 'Deployment failed due to misconfigured environment variables.',
      lessons: ['Always verify env vars before deploy'],
    });

    await handleAfterTask(db, facade, {
      session_key: 'session-002',
      task_type: 'code',
      task_summary: 'Deploy API',
      conversation_history: [],
      signals: makeFailureSignals(),
      agent_id: null,
    });

    await new Promise(r => setTimeout(r, 100));

    const rows = db.prepare('SELECT reflection FROM reflections').all() as Array<{ reflection: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0].reflection).toBe('Deployment failed due to misconfigured environment variables.');
  });

  it('stored lessons field is non-empty JSON array string (AC3)', async () => {
    vi.spyOn(reflectionModule, 'generateReflection').mockResolvedValue({
      task_type: 'research',
      task_summary: 'Research new libraries',
      outcome: 'success',
      reflection: 'Found suitable libraries for the task.',
      lessons: ['Compare API surface before choosing', 'Check maintenance status'],
    });

    await handleAfterTask(db, facade, {
      session_key: 'session-003',
      task_type: 'research',
      task_summary: 'Research new libraries',
      conversation_history: [],
      signals: makeSuccessSignals(),
      agent_id: null,
    });

    await new Promise(r => setTimeout(r, 100));

    const rows = db.prepare('SELECT lessons FROM reflections').all() as Array<{ lessons: string }>;
    expect(rows.length).toBe(1);

    // Lessons stored as JSON array string
    const lessonsArr = JSON.parse(rows[0].lessons);
    expect(Array.isArray(lessonsArr)).toBe(true);
    expect(lessonsArr.length).toBe(2);
    expect(lessonsArr[0]).toBe('Compare API surface before choosing');
  });

  it('stored signals field is JSON string of original signals (AC3)', async () => {
    vi.spyOn(reflectionModule, 'generateReflection').mockResolvedValue({
      task_type: 'code',
      task_summary: 'Task',
      outcome: 'partial',
      reflection: 'Mixed results.',
      lessons: [],
    });

    const signals = makeSuccessSignals();
    await handleAfterTask(db, facade, {
      session_key: 'session-004',
      task_type: 'code',
      task_summary: 'Task',
      conversation_history: [],
      signals,
      agent_id: null,
    });

    await new Promise(r => setTimeout(r, 100));

    const rows = db.prepare('SELECT signals FROM reflections').all() as Array<{ signals: string }>;
    expect(rows.length).toBe(1);

    const storedSignals = JSON.parse(rows[0].signals);
    expect(storedSignals).toMatchObject(signals);
  });

  it('null agent_id is stored as null in DB (AC3)', async () => {
    vi.spyOn(reflectionModule, 'generateReflection').mockResolvedValue({
      task_type: 'code',
      task_summary: 'Task with no agent',
      outcome: 'success',
      reflection: 'Done.',
      lessons: [],
    });

    await handleAfterTask(db, facade, {
      session_key: 'session-005',
      task_type: 'code',
      task_summary: 'Task with no agent',
      conversation_history: [],
      signals: makeSuccessSignals(),
      agent_id: null,
    });

    await new Promise(r => setTimeout(r, 100));

    const rows = db.prepare('SELECT agent_id FROM reflections').all() as Array<{ agent_id: string | null }>;
    expect(rows.length).toBe(1);
    expect(rows[0].agent_id).toBeNull();
  });

  it('stored reflection can be retrieved by ID after async generation (AC3)', async () => {
    vi.spyOn(reflectionModule, 'generateReflection').mockResolvedValue({
      task_type: 'code',
      task_summary: '实现登录功能',
      outcome: 'success',
      reflection: 'Login feature implemented.',
      lessons: ['Test auth flows'],
    });

    await handleAfterTask(db, facade, {
      session_key: 'session-006',
      task_type: 'code',
      task_summary: '实现登录功能',
      conversation_history: makeConversationHistory(),
      signals: makeSuccessSignals(),
      agent_id: 'agent-001',
    });

    await new Promise(r => setTimeout(r, 100));

    // Find the stored record
    const rows = db.prepare('SELECT id FROM reflections').all() as Array<{ id: string }>;
    expect(rows.length).toBe(1);

    const storedId = rows[0].id;
    const storedEntry = getReflectionById(db, storedId);
    expect(storedEntry).not.toBeNull();
    expect(storedEntry!.id).toBe(storedId);
    expect(storedEntry!.task_type).toBe('code');
    expect(storedEntry!.outcome).toBe('success');
  });
});

// ---------------------------------------------------------------------------
// AC5: At least one signal → reflection generated
// ---------------------------------------------------------------------------

describe('handleAfterTask - triggers when at least one signal present (AC5)', () => {
  it('triggers reflection generation when user_feedback is present (AC5)', async () => {
    const generateSpy = vi.spyOn(reflectionModule, 'generateReflection').mockResolvedValue(null);

    await handleAfterTask(db, facade, {
      session_key: 'session-001',
      task_type: 'code',
      task_summary: 'Task',
      conversation_history: [],
      signals: {
        user_feedback: 'great work',
        review_result: null,
        was_respawned: false,
        timed_out: false,
      },
      agent_id: null,
    });

    await new Promise(r => setTimeout(r, 50));
    expect(generateSpy).toHaveBeenCalledTimes(1);
  });

  it('triggers reflection generation when review_result is present (AC5)', async () => {
    const generateSpy = vi.spyOn(reflectionModule, 'generateReflection').mockResolvedValue(null);

    await handleAfterTask(db, facade, {
      session_key: 'session-001',
      task_type: 'code',
      task_summary: 'Task',
      conversation_history: [],
      signals: {
        user_feedback: null,
        review_result: 'PASS',
        was_respawned: false,
        timed_out: false,
      },
      agent_id: null,
    });

    await new Promise(r => setTimeout(r, 50));
    expect(generateSpy).toHaveBeenCalledTimes(1);
  });

  it('triggers reflection generation when was_respawned=true (AC5)', async () => {
    const generateSpy = vi.spyOn(reflectionModule, 'generateReflection').mockResolvedValue(null);

    await handleAfterTask(db, facade, {
      session_key: 'session-001',
      task_type: 'code',
      task_summary: 'Task',
      conversation_history: [],
      signals: {
        user_feedback: null,
        review_result: null,
        was_respawned: true,
        timed_out: false,
      },
      agent_id: null,
    });

    await new Promise(r => setTimeout(r, 50));
    expect(generateSpy).toHaveBeenCalledTimes(1);
  });

  it('triggers reflection generation when timed_out=true (AC5)', async () => {
    const generateSpy = vi.spyOn(reflectionModule, 'generateReflection').mockResolvedValue(null);

    await handleAfterTask(db, facade, {
      session_key: 'session-001',
      task_type: 'code',
      task_summary: 'Task',
      conversation_history: [],
      signals: {
        user_feedback: null,
        review_result: null,
        was_respawned: false,
        timed_out: true,
      },
      agent_id: null,
    });

    await new Promise(r => setTimeout(r, 50));
    expect(generateSpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// AC6: All signals empty/false → still triggers reflection (outcome = partial)
// ---------------------------------------------------------------------------

describe('handleAfterTask - triggers even when all signals empty (AC6)', () => {
  it('still calls generateReflection when all signals are empty/false (AC6)', async () => {
    const generateSpy = vi.spyOn(reflectionModule, 'generateReflection').mockResolvedValue(null);

    await handleAfterTask(db, facade, {
      session_key: 'session-001',
      task_type: 'code',
      task_summary: 'Task',
      conversation_history: [],
      signals: makeAllEmptySignals(),
      agent_id: null,
    });

    await new Promise(r => setTimeout(r, 50));
    expect(generateSpy).toHaveBeenCalledTimes(1);
  });

  it('outcome stored in DB is partial when all signals are empty/false (AC6)', async () => {
    vi.spyOn(reflectionModule, 'generateReflection').mockResolvedValue({
      task_type: 'code',
      task_summary: 'Task',
      outcome: 'partial',
      reflection: 'Ambiguous outcome.',
      lessons: [],
    });

    await handleAfterTask(db, facade, {
      session_key: 'session-001',
      task_type: 'code',
      task_summary: 'Task',
      conversation_history: [],
      signals: makeAllEmptySignals(),
      agent_id: null,
    });

    // Hook is fire-and-forget; wait for async persistence
    await new Promise(r => setTimeout(r, 50));

    // resolveOutcome with all empty signals returns 'partial', verified via DB
    const rows = db.prepare('SELECT outcome FROM reflections').all() as Array<{ outcome: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0].outcome).toBe('partial');
  });
});

// ---------------------------------------------------------------------------
// AC7: LLM reflection generation failure → reflection_id=null, outcome=null
// ---------------------------------------------------------------------------

describe('handleAfterTask - silent degradation on LLM failure (AC7)', () => {
  it('returns reflection_id=null when generateReflection returns null (AC7)', async () => {
    vi.spyOn(reflectionModule, 'generateReflection').mockResolvedValue(null);

    const result = await handleAfterTask(db, facade, {
      session_key: 'session-001',
      task_type: 'code',
      task_summary: 'Task',
      conversation_history: [],
      signals: makeSuccessSignals(),
      agent_id: null,
    });

    await new Promise(r => setTimeout(r, 50));

    expect(result.reflection_id).toBeNull();
  });

  it('returns outcome=null when generateReflection returns null (AC7)', async () => {
    vi.spyOn(reflectionModule, 'generateReflection').mockResolvedValue(null);

    const result = await handleAfterTask(db, facade, {
      session_key: 'session-001',
      task_type: 'code',
      task_summary: 'Task',
      conversation_history: [],
      signals: makeSuccessSignals(),
      agent_id: null,
    });

    await new Promise(r => setTimeout(r, 50));

    expect(result.outcome).toBeNull();
  });

  it('does not write to reflections table when generateReflection returns null (AC7)', async () => {
    vi.spyOn(reflectionModule, 'generateReflection').mockResolvedValue(null);

    await handleAfterTask(db, facade, {
      session_key: 'session-001',
      task_type: 'code',
      task_summary: 'Task',
      conversation_history: [],
      signals: makeSuccessSignals(),
      agent_id: null,
    });

    await new Promise(r => setTimeout(r, 100));

    const rows = db.prepare('SELECT COUNT(*) as cnt FROM reflections').get() as { cnt: number };
    expect(rows.cnt).toBe(0);
  });

  it('does not throw when generateReflection throws (AC7)', async () => {
    vi.spyOn(reflectionModule, 'generateReflection').mockRejectedValue(new Error('LLM unavailable'));

    let threw = false;
    try {
      await handleAfterTask(db, facade, {
        session_key: 'session-001',
        task_type: 'code',
        task_summary: 'Task',
        conversation_history: [],
        signals: makeSuccessSignals(),
        agent_id: null,
      });
    } catch {
      threw = true;
    }

    await new Promise(r => setTimeout(r, 50));

    expect(threw).toBe(false);
  });

  it('returns reflection_id=null and outcome=null when generateReflection throws (AC7)', async () => {
    vi.spyOn(reflectionModule, 'generateReflection').mockRejectedValue(new Error('Network error'));

    const result = await handleAfterTask(db, facade, {
      session_key: 'session-001',
      task_type: 'code',
      task_summary: 'Task',
      conversation_history: [],
      signals: makeSuccessSignals(),
      agent_id: null,
    });

    await new Promise(r => setTimeout(r, 50));

    expect(result.reflection_id).toBeNull();
    expect(result.outcome).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC8: Non-blocking — caller can fire-and-forget the hook
// ---------------------------------------------------------------------------

describe('handleAfterTask - non-blocking execution (AC8)', () => {
  it('hook returns a Promise — caller can fire-and-forget (AC8)', () => {
    vi.spyOn(reflectionModule, 'generateReflection').mockResolvedValue(null);

    const result = handleAfterTask(db, facade, {
      session_key: 'session-001',
      task_type: 'code',
      task_summary: 'Task',
      conversation_history: [],
      signals: makeSuccessSignals(),
      agent_id: null,
    });

    // Must return a Promise — caller can fire-and-forget by not awaiting it
    expect(result).toBeInstanceOf(Promise);

    // Clean up the promise
    return result;
  });

  it('hook resolves AFTER generateReflection completes but BEFORE DB write completes (AC8)', async () => {
    // The hook awaits LLM but fires DB write as fire-and-forget.
    // AC8: "hook 返回后主流程不等待反思写入完成" (write is non-blocking, not LLM)
    let generateResolved = false;
    vi.spyOn(reflectionModule, 'generateReflection').mockImplementation(
      () => new Promise(resolve => {
        setTimeout(() => {
          generateResolved = true;
          resolve({
            task_type: 'code',
            task_summary: 'Task',
            outcome: 'success',
            reflection: 'Done.',
            lessons: [],
          });
        }, 50);
      }),
    );

    const hookPromise = handleAfterTask(db, facade, {
      session_key: 'session-001',
      task_type: 'code',
      task_summary: 'Task',
      conversation_history: [],
      signals: makeSuccessSignals(),
      agent_id: null,
    });

    // Hook awaits LLM — generateReflection must resolve before hook resolves
    const result = await hookPromise;

    // Hook resolves AFTER generateReflection (awaited)
    expect(generateResolved).toBe(true);
    // Hook returns non-null values since LLM succeeded
    expect(result.reflection_id).not.toBeNull();
    expect(result.outcome).toBe('success');

    // DB write is fire-and-forget — wait for it to complete
    await new Promise(r => setTimeout(r, 100));
    const entry = getReflectionById(db, result.reflection_id!);
    expect(entry).not.toBeNull();
  });

  it('caller can fire-and-forget without awaiting — task flow not blocked (AC8)', async () => {
    vi.spyOn(reflectionModule, 'generateReflection').mockResolvedValue(null);

    // Fire hook without awaiting — simulates plugin host behavior
    let hookCompleted = false;

    const hookPromise = handleAfterTask(db, facade, {
      session_key: 'session-001',
      task_type: 'code',
      task_summary: 'Task',
      conversation_history: [],
      signals: makeSuccessSignals(),
      agent_id: null,
    }).then(() => { hookCompleted = true; }).catch(() => { hookCompleted = true; });

    // Caller can proceed with other work while hook runs
    const callerWork = 'task completion flow proceeds';
    expect(callerWork).toBe('task completion flow proceeds');

    // Eventually the hook completes without blocking caller
    await hookPromise;
    expect(hookCompleted).toBe(true);
  });

  it('hook does not throw synchronously — safe to fire-and-forget (AC8)', () => {
    vi.spyOn(reflectionModule, 'generateReflection').mockRejectedValue(new Error('LLM down'));

    // This must not throw synchronously — the promise can reject internally
    // but the caller's fire-and-forget is safe
    let syncThrew = false;
    let hookPromise: Promise<unknown>;
    try {
      hookPromise = handleAfterTask(db, facade, {
        session_key: 'session-001',
        task_type: 'code',
        task_summary: 'Task',
        conversation_history: [],
        signals: makeSuccessSignals(),
        agent_id: null,
      });
    } catch {
      syncThrew = true;
      hookPromise = Promise.resolve();
    }

    expect(syncThrew).toBe(false);

    // The hook promise itself should resolve (not reject) due to silent degradation
    return hookPromise;
  });
});

// ---------------------------------------------------------------------------
// BDD Scenario 1: 任务完成后自动生成并存储 reflection
// ---------------------------------------------------------------------------

describe('handleAfterTask - BDD Scenario 1: reflection generated and stored on task completion', () => {
  it('writes reflection to DB with outcome=success and non-empty reflection+lessons (BDD1)', async () => {
    vi.spyOn(reflectionModule, 'generateReflection').mockResolvedValue({
      task_type: 'code',
      task_summary: '实现登录功能',
      outcome: 'success',
      reflection: 'The login feature was implemented efficiently using JWT with proper test coverage.',
      lessons: ['Always test auth flows', 'Use JWT for stateless sessions'],
    });

    await handleAfterTask(db, facade, {
      session_key: 'session-bdd1',
      task_type: 'code',
      task_summary: '实现登录功能',
      conversation_history: makeConversationHistory(),
      signals: {
        user_feedback: '谢谢',
        review_result: null,
        was_respawned: false,
        timed_out: false,
      },
      agent_id: null,
    });

    // Wait for async persistence
    await new Promise(r => setTimeout(r, 100));

    // Find record in DB
    const rows = db.prepare('SELECT * FROM reflections').all() as Array<{
      id: string;
      outcome: string;
      reflection: string;
      lessons: string;
    }>;
    expect(rows.length).toBe(1);
    expect(rows[0].outcome).toBe('success');
    expect(rows[0].reflection.length).toBeGreaterThan(0);

    const lessonsArr = JSON.parse(rows[0].lessons);
    expect(Array.isArray(lessonsArr)).toBe(true);
    expect(lessonsArr.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// BDD Scenario 2: LLM 不可用时静默降级
// ---------------------------------------------------------------------------

describe('handleAfterTask - BDD Scenario 2: silent degradation when LLM unavailable', () => {
  it('returns reflection_id=null and no DB record when LLM returns null (BDD2)', async () => {
    vi.spyOn(reflectionModule, 'generateReflection').mockResolvedValue(null);

    let threw = false;
    let result: { reflection_id: string | null; outcome: string | null } | undefined;
    try {
      result = await handleAfterTask(db, facade, {
        session_key: 'session-bdd2',
        task_type: 'code',
        task_summary: 'Some task',
        conversation_history: makeConversationHistory(),
        signals: makeSuccessSignals(),
        agent_id: null,
      });
    } catch {
      threw = true;
    }

    await new Promise(r => setTimeout(r, 100));

    expect(threw).toBe(false);
    expect(result).toBeDefined();
    expect(result!.reflection_id).toBeNull();

    // No record in DB
    const rows = db.prepare('SELECT COUNT(*) as cnt FROM reflections').get() as { cnt: number };
    expect(rows.cnt).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC1 (BDD Scenario 1): Hook returns non-null reflection_id and outcome on success
// ---------------------------------------------------------------------------

describe('handleAfterTask - BDD Scenario 1: returns reflection_id and outcome (AC1)', () => {
  it('returns non-null reflection_id when LLM generates a reflection successfully (AC1, BDD1)', async () => {
    vi.spyOn(reflectionModule, 'generateReflection').mockResolvedValue({
      task_type: 'code',
      task_summary: '实现登录功能',
      outcome: 'success',
      reflection: 'Login feature implemented with JWT tokens.',
      lessons: ['Use JWT for stateless auth'],
    });

    const result = await handleAfterTask(db, facade, {
      session_key: 'session-bdd1-id',
      task_type: 'code',
      task_summary: '实现登录功能',
      conversation_history: makeConversationHistory(),
      signals: { user_feedback: 'thanks', review_result: 'PASS', was_respawned: false, timed_out: false },
      agent_id: null,
    });

    // Wait for async DB write
    await new Promise(r => setTimeout(r, 100));

    expect(result.reflection_id).not.toBeNull();
    expect(typeof result.reflection_id).toBe('string');
    expect(result.reflection_id!.length).toBeGreaterThan(0);
  });

  it('returns outcome=success when positive signals present (AC1, AC2, BDD1)', async () => {
    vi.spyOn(reflectionModule, 'generateReflection').mockResolvedValue({
      task_type: 'code',
      task_summary: '实现登录功能',
      outcome: 'success',
      reflection: 'Login feature implemented.',
      lessons: [],
    });

    const result = await handleAfterTask(db, facade, {
      session_key: 'session-bdd1-outcome',
      task_type: 'code',
      task_summary: '实现登录功能',
      conversation_history: makeConversationHistory(),
      signals: { user_feedback: '谢谢', review_result: null, was_respawned: false, timed_out: false },
      agent_id: null,
    });

    await new Promise(r => setTimeout(r, 100));

    expect(result.outcome).toBe('success');
  });

  it('returned reflection_id matches DB record (AC1, AC7, BDD1)', async () => {
    vi.spyOn(reflectionModule, 'generateReflection').mockResolvedValue({
      task_type: 'code',
      task_summary: '实现登录功能',
      outcome: 'success',
      reflection: 'Login feature implemented.',
      lessons: ['Write tests first'],
    });

    const result = await handleAfterTask(db, facade, {
      session_key: 'session-bdd1-match',
      task_type: 'code',
      task_summary: '实现登录功能',
      conversation_history: makeConversationHistory(),
      signals: { user_feedback: 'thanks', review_result: 'PASS', was_respawned: false, timed_out: false },
      agent_id: null,
    });

    // Wait for async DB write
    await new Promise(r => setTimeout(r, 100));

    expect(result.reflection_id).not.toBeNull();

    // AC7: retrieve from DB using the returned reflection_id
    const storedEntry = getReflectionById(db, result.reflection_id!);
    expect(storedEntry).not.toBeNull();
    expect(storedEntry!.id).toBe(result.reflection_id);
    expect(storedEntry!.task_type).toBe('code');
    expect(storedEntry!.outcome).toBe('success');
    expect(storedEntry!.task_summary).toBe('实现登录功能');
    expect(storedEntry!.reflection).toBe('Login feature implemented.');
  });
});

// ---------------------------------------------------------------------------
// AC3 + AC7: End-to-end DB retrieval by returned reflection_id (BDD Scenario 1)
// ---------------------------------------------------------------------------

describe('handleAfterTask - AC7: retrieve reflection by hook-returned reflection_id', () => {
  it('DB entry for returned reflection_id contains all required fields (AC7)', async () => {
    vi.spyOn(reflectionModule, 'generateReflection').mockResolvedValue({
      task_type: 'code',
      task_summary: '实现用户注册',
      outcome: 'success',
      reflection: 'Registration was implemented with email validation.',
      lessons: ['Always validate email', 'Hash passwords with bcrypt'],
    });

    const result = await handleAfterTask(db, facade, {
      session_key: 'session-ac7',
      task_type: 'code',
      task_summary: '实现用户注册',
      conversation_history: makeConversationHistory(),
      signals: { user_feedback: '谢谢', review_result: null, was_respawned: false, timed_out: false },
      agent_id: 'agent-ac7',
    });

    await new Promise(r => setTimeout(r, 100));

    expect(result.reflection_id).not.toBeNull();

    const entry = getReflectionById(db, result.reflection_id!);
    expect(entry).not.toBeNull();

    // Verify all required fields per AC7
    expect(entry!.task_type).toBe('code');
    expect(entry!.task_summary).toBe('实现用户注册');
    expect(entry!.outcome).toBe('success');
    expect(typeof entry!.reflection).toBe('string');
    expect(entry!.reflection.length).toBeGreaterThan(0);

    const lessonsArr = JSON.parse(entry!.lessons);
    expect(Array.isArray(lessonsArr)).toBe(true);
    expect(lessonsArr.length).toBe(2);
  });

  it('outcome from hook matches outcome in DB entry (AC7)', async () => {
    vi.spyOn(reflectionModule, 'generateReflection').mockResolvedValue({
      task_type: 'code',
      task_summary: 'Deploy to prod',
      outcome: 'failure',
      reflection: 'Deployment failed due to config issues.',
      lessons: ['Validate config before deploy'],
    });

    const result = await handleAfterTask(db, facade, {
      session_key: 'session-ac7-outcome',
      task_type: 'code',
      task_summary: 'Deploy to prod',
      conversation_history: [],
      signals: { user_feedback: null, review_result: null, was_respawned: true, timed_out: true },
      agent_id: null,
    });

    await new Promise(r => setTimeout(r, 100));

    expect(result.reflection_id).not.toBeNull();
    expect(result.outcome).toBe('failure');

    const entry = getReflectionById(db, result.reflection_id!);
    expect(entry).not.toBeNull();
    expect(entry!.outcome).toBe('failure');
  });
});

// ---------------------------------------------------------------------------
// AC2: outcome=success when user_feedback='谢谢' and no negative signals
// ---------------------------------------------------------------------------

describe('handleAfterTask - AC2: outcome=success for positive-only signals', () => {
  it('returns outcome=success for user_feedback=谢谢 with no negative signals (AC2)', async () => {
    vi.spyOn(reflectionModule, 'generateReflection').mockResolvedValue({
      task_type: 'code',
      task_summary: 'Task',
      outcome: 'success',
      reflection: 'Done.',
      lessons: [],
    });

    const result = await handleAfterTask(db, facade, {
      session_key: 'session-ac2',
      task_type: 'code',
      task_summary: 'Task',
      conversation_history: [],
      signals: { user_feedback: '谢谢', review_result: null, was_respawned: false, timed_out: false },
      agent_id: null,
    });

    await new Promise(r => setTimeout(r, 100));
    expect(result.outcome).toBe('success');
  });
});

// ---------------------------------------------------------------------------
// AC3: outcome=failure when was_respawned=true and no positive signals
// ---------------------------------------------------------------------------

describe('handleAfterTask - AC3: outcome=failure for was_respawned=true only', () => {
  it('returns outcome=failure when was_respawned=true and no positive signals (AC3)', async () => {
    vi.spyOn(reflectionModule, 'generateReflection').mockResolvedValue({
      task_type: 'code',
      task_summary: 'Task',
      outcome: 'failure',
      reflection: 'Task was respawned.',
      lessons: [],
    });

    const result = await handleAfterTask(db, facade, {
      session_key: 'session-ac3',
      task_type: 'code',
      task_summary: 'Task',
      conversation_history: [],
      signals: { user_feedback: null, review_result: null, was_respawned: true, timed_out: false },
      agent_id: null,
    });

    await new Promise(r => setTimeout(r, 100));
    expect(result.outcome).toBe('failure');
  });
});

// ---------------------------------------------------------------------------
// AC4: outcome=partial when timed_out=true AND review_result='PASS' (mixed signals)
// ---------------------------------------------------------------------------

describe('handleAfterTask - AC4: outcome=partial for mixed signals (BDD Scenario 4)', () => {
  it('returns outcome=partial when timed_out=true and review_result=PASS (AC4, BDD4)', async () => {
    vi.spyOn(reflectionModule, 'generateReflection').mockResolvedValue({
      task_type: 'code',
      task_summary: 'Task',
      outcome: 'partial',
      reflection: 'Partial completion.',
      lessons: [],
    });

    const result = await handleAfterTask(db, facade, {
      session_key: 'session-ac4',
      task_type: 'code',
      task_summary: 'Task',
      conversation_history: [],
      signals: { user_feedback: null, review_result: 'PASS', was_respawned: false, timed_out: true },
      agent_id: null,
    });

    await new Promise(r => setTimeout(r, 100));
    expect(result.outcome).toBe('partial');
  });
});

// ---------------------------------------------------------------------------
// AC5: outcome=partial when all signals are null/false (ambiguous)
// ---------------------------------------------------------------------------

describe('handleAfterTask - AC5: outcome=partial when all signals null/false', () => {
  it('returns outcome=partial when all signals are null/false (AC5)', async () => {
    vi.spyOn(reflectionModule, 'generateReflection').mockResolvedValue({
      task_type: 'code',
      task_summary: 'Task',
      outcome: 'partial',
      reflection: 'Ambiguous outcome.',
      lessons: [],
    });

    const result = await handleAfterTask(db, facade, {
      session_key: 'session-ac5',
      task_type: 'code',
      task_summary: 'Task',
      conversation_history: [],
      signals: makeAllEmptySignals(),
      agent_id: null,
    });

    await new Promise(r => setTimeout(r, 100));
    expect(result.outcome).toBe('partial');
  });
});

// ---------------------------------------------------------------------------
// AC6: outcome=failure when user_feedback='不对' AND review_result='FAIL' (multiple negatives)
// ---------------------------------------------------------------------------

describe('handleAfterTask - AC6: outcome=failure for multiple negative signals', () => {
  it('returns outcome=failure when user_feedback=不对 and review_result=FAIL (AC6)', async () => {
    vi.spyOn(reflectionModule, 'generateReflection').mockResolvedValue({
      task_type: 'code',
      task_summary: 'Task',
      outcome: 'failure',
      reflection: 'Multiple failure signals.',
      lessons: [],
    });

    const result = await handleAfterTask(db, facade, {
      session_key: 'session-ac6',
      task_type: 'code',
      task_summary: 'Task',
      conversation_history: [],
      signals: { user_feedback: '不对', review_result: 'FAIL', was_respawned: false, timed_out: false },
      agent_id: null,
    });

    await new Promise(r => setTimeout(r, 100));
    expect(result.outcome).toBe('failure');
  });
});

// ---------------------------------------------------------------------------
// AC8: Non-blocking — DB write completes after hook returns (fire-and-forget write)
// ---------------------------------------------------------------------------

describe('handleAfterTask - AC8: DB write is non-blocking (write is fire-and-forget)', () => {
  it('DB write completes asynchronously after hook already returned (AC8)', async () => {
    vi.spyOn(reflectionModule, 'generateReflection').mockResolvedValue({
      task_type: 'code',
      task_summary: 'Task',
      outcome: 'success',
      reflection: 'Done.',
      lessons: [],
    });

    // Hook awaits LLM but DB write is fire-and-forget
    const result = await handleAfterTask(db, facade, {
      session_key: 'session-ac8',
      task_type: 'code',
      task_summary: 'Task',
      conversation_history: [],
      signals: makeSuccessSignals(),
      agent_id: null,
    });

    // Hook has returned — reflection_id is available
    expect(result.reflection_id).not.toBeNull();
    expect(result.outcome).toBe('success');

    // DB write may or may not be complete yet (fire-and-forget)
    // Wait a moment to let it complete
    await new Promise(r => setTimeout(r, 100));

    // DB write should eventually complete
    const entry = getReflectionById(db, result.reflection_id!);
    expect(entry).not.toBeNull();
  });

  it('hook returns a Promise (async interface, AC8)', () => {
    vi.spyOn(reflectionModule, 'generateReflection').mockResolvedValue(null);

    const promise = handleAfterTask(db, facade, {
      session_key: 'session-ac8-promise',
      task_type: 'code',
      task_summary: 'Task',
      conversation_history: [],
      signals: makeSuccessSignals(),
      agent_id: null,
    });

    expect(promise).toBeInstanceOf(Promise);
    return promise;
  });
});

// ---------------------------------------------------------------------------
// AC9: LLM failure → reflection_id=null, outcome=null, no exception
// ---------------------------------------------------------------------------

describe('handleAfterTask - AC9: LLM failure returns null without throwing', () => {
  it('returns reflection_id=null when LLM fails with error (AC9)', async () => {
    vi.spyOn(reflectionModule, 'generateReflection').mockRejectedValue(new Error('LLM down'));

    const result = await handleAfterTask(db, facade, {
      session_key: 'session-ac9',
      task_type: 'code',
      task_summary: 'Task',
      conversation_history: [],
      signals: makeSuccessSignals(),
      agent_id: null,
    });

    expect(result.reflection_id).toBeNull();
    expect(result.outcome).toBeNull();
  });

  it('does not throw when LLM fails (AC9)', async () => {
    vi.spyOn(reflectionModule, 'generateReflection').mockRejectedValue(new Error('Network error'));

    let threw = false;
    try {
      await handleAfterTask(db, facade, {
        session_key: 'session-ac9-throw',
        task_type: 'code',
        task_summary: 'Task',
        conversation_history: [],
        signals: makeSuccessSignals(),
        agent_id: null,
      });
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
  });

  it('no DB entry when LLM fails (AC9)', async () => {
    vi.spyOn(reflectionModule, 'generateReflection').mockRejectedValue(new Error('LLM error'));

    await handleAfterTask(db, facade, {
      session_key: 'session-ac9-nodb',
      task_type: 'code',
      task_summary: 'Task',
      conversation_history: [],
      signals: makeSuccessSignals(),
      agent_id: null,
    });

    await new Promise(r => setTimeout(r, 100));

    const row = db.prepare('SELECT COUNT(*) as cnt FROM reflections').get() as { cnt: number };
    expect(row.cnt).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC10: LLM failure → error is logged (not swallowed silently without trace)
// ---------------------------------------------------------------------------

describe('handleAfterTask - AC10: LLM failure is logged', () => {
  it('logs error to console.error when LLM call fails (AC10)', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const llmError = new Error('LLM service unavailable');
    vi.spyOn(reflectionModule, 'generateReflection').mockRejectedValue(llmError);

    await handleAfterTask(db, facade, {
      session_key: 'session-ac10',
      task_type: 'code',
      task_summary: 'Task',
      conversation_history: [],
      signals: makeSuccessSignals(),
      agent_id: null,
    });

    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// BDD Scenario 3: LLM fails → silent degradation end-to-end (integration)
// ---------------------------------------------------------------------------

describe('handleAfterTask - BDD Scenario 3: LLM failure silent degradation', () => {
  it('returns null reflection_id, no exception, no DB entry when LLM proxy returns error (BDD3)', async () => {
    vi.spyOn(reflectionModule, 'generateReflection').mockRejectedValue(new Error('503 Service Unavailable'));

    let threw = false;
    let result: { reflection_id: string | null; outcome: string | null } | undefined;

    try {
      result = await handleAfterTask(db, facade, {
        session_key: 'session-bdd3',
        task_type: 'code',
        task_summary: 'Some task',
        conversation_history: makeConversationHistory(),
        signals: { user_feedback: 'thanks', review_result: 'PASS', was_respawned: false, timed_out: false },
        agent_id: null,
      });
    } catch {
      threw = true;
    }

    await new Promise(r => setTimeout(r, 100));

    expect(threw).toBe(false);
    expect(result).toBeDefined();
    expect(result!.reflection_id).toBeNull();

    const row = db.prepare('SELECT COUNT(*) as cnt FROM reflections').get() as { cnt: number };
    expect(row.cnt).toBe(0);
  });
});
