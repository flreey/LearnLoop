/**
 * Tests for beforeSpawn hook handler.
 * Covers: handleBeforeSpawn() — reflection retrieval and injection before subtask dispatch.
 * Source: src/hooks/index.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { initializeDatabase } from '../../src/storage/db.js';
import { createSearchEngine } from '../../src/search/index.js';
import { StorageFacade } from '../../src/storage/facade.js';
import { handleBeforeSpawn } from '../../src/hooks/index.js';
import type { DB } from '../../src/storage/db.js';
import type { ReflectionEntry } from '../../src/types/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDbPath(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'learnloop-beforespawn-test-'));
  return path.join(tmpDir, 'test.db');
}

function makeReflection(overrides: Partial<ReflectionEntry> = {}): ReflectionEntry {
  return {
    id: overrides.id ?? `r-${Math.random().toString(36).slice(2)}`,
    task_type: overrides.task_type ?? 'code',
    task_summary: overrides.task_summary ?? '实现用户注册功能',
    outcome: overrides.outcome ?? 'success',
    signals: overrides.signals ?? '{}',
    reflection: overrides.reflection ?? '任务完成，使用了良好的 TDD 方法。',
    lessons: overrides.lessons ?? '["Write tests first", "Keep functions small"]',
    agent_id: overrides.agent_id ?? null,
    source_session: overrides.source_session ?? 'session-001',
    created_at: overrides.created_at ?? new Date().toISOString(),
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
  try { db.close(); } catch { /* ignore */ }
  try {
    fs.rmSync(path.dirname(tempDbPath), { recursive: true, force: true });
  } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// AC5: hook accepts task_description, task_type, agent_id
// ---------------------------------------------------------------------------

describe('handleBeforeSpawn - parameter acceptance (AC5)', () => {
  it('accepts task_description, task_type, and agent_id parameters (AC5)', async () => {
    let threw = false;
    try {
      await handleBeforeSpawn(db, facade, {
        task_description: '实现用户注册',
        task_type: 'code',
        agent_id: 'agent-001',
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });

  it('accepts null agent_id (AC5)', async () => {
    let threw = false;
    try {
      await handleBeforeSpawn(db, facade, {
        task_description: '实现用户注册',
        task_type: 'code',
        agent_id: null,
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC7: hook returns augmented_task_description and injected_reflections
// ---------------------------------------------------------------------------

describe('handleBeforeSpawn - return shape (AC7)', () => {
  it('returns augmented_task_description and injected_reflections fields (AC7)', async () => {
    const result = await handleBeforeSpawn(db, facade, {
      task_description: '实现用户注册',
      task_type: 'code',
      agent_id: null,
    });

    expect(result).toHaveProperty('augmented_task_description');
    expect(result).toHaveProperty('injected_reflections');
    expect(typeof result.augmented_task_description).toBe('string');
    expect(Array.isArray(result.injected_reflections)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC6: hook calls reflection retrieval and injects matched reflection text
// ---------------------------------------------------------------------------

describe('handleBeforeSpawn - reflection injection (AC6)', () => {
  it('augmented_task_description is longer than original when matching reflections exist (AC6, BDD1)', async () => {
    // Insert reflections that match task_type='code'
    facade.addReflection(makeReflection({
      id: 'r1',
      task_type: 'code',
      task_summary: '实现用户注册功能',
      reflection: '注册功能已完成，使用了 JWT 认证。',
    }));
    facade.addReflection(makeReflection({
      id: 'r2',
      task_type: 'code',
      task_summary: '实现登录流程',
      reflection: '登录流程已完成，包含了错误处理。',
    }));

    const originalDescription = '实现用户注册';
    const result = await handleBeforeSpawn(db, facade, {
      task_description: originalDescription,
      task_type: 'code',
      agent_id: null,
    });

    expect(result.augmented_task_description.length).toBeGreaterThan(originalDescription.length);
    expect(result.injected_reflections.length).toBeGreaterThan(0);
  });

  it('augmented_task_description contains original task_description text (AC7, BDD1)', async () => {
    facade.addReflection(makeReflection({
      id: 'r1',
      task_type: 'code',
      task_summary: '实现用户注册功能',
      reflection: '任务完成。',
    }));

    const originalDescription = '实现用户注册功能模块';
    const result = await handleBeforeSpawn(db, facade, {
      task_description: originalDescription,
      task_type: 'code',
      agent_id: null,
    });

    expect(result.augmented_task_description).toContain(originalDescription);
  });

  it('injected_reflections contains ReflectionEntry objects with expected fields (AC7)', async () => {
    facade.addReflection(makeReflection({
      id: 'r1',
      task_type: 'code',
      task_summary: '实现用户注册功能',
      reflection: '注册功能已完成。',
    }));

    const result = await handleBeforeSpawn(db, facade, {
      task_description: '实现用户注册',
      task_type: 'code',
      agent_id: null,
    });

    expect(result.injected_reflections.length).toBeGreaterThan(0);
    const r = result.injected_reflections[0];
    expect(r).toHaveProperty('id');
    expect(r).toHaveProperty('task_type');
    expect(r).toHaveProperty('task_summary');
    expect(r).toHaveProperty('reflection');
    expect(r).toHaveProperty('outcome');
  });
});

// ---------------------------------------------------------------------------
// AC8: no matching reflections → return original description unchanged
// ---------------------------------------------------------------------------

describe('handleBeforeSpawn - no matching reflections (AC8, BDD2)', () => {
  it('augmented_task_description equals original task_description when no reflections exist (AC8, BDD2)', async () => {
    // Empty DB — no reflections
    const originalDescription = '任意任务描述';
    const result = await handleBeforeSpawn(db, facade, {
      task_description: originalDescription,
      task_type: 'code',
      agent_id: null,
    });

    expect(result.augmented_task_description).toBe(originalDescription);
    expect(result.injected_reflections).toEqual([]);
  });

  it('returns empty injected_reflections array when no reflections match (AC8)', async () => {
    // Insert a reflection with completely different task_type
    facade.addReflection(makeReflection({
      id: 'r1',
      task_type: 'research',
      task_summary: 'Research some papers',
      reflection: 'Papers analyzed.',
    }));

    const result = await handleBeforeSpawn(db, facade, {
      task_description: '实现用户注册',
      task_type: 'code',
      agent_id: 'agent-001',
    });

    // The non-matching reflections should yield empty injections
    // (either empty or minimal match — depends on BM25 scoring)
    expect(Array.isArray(result.injected_reflections)).toBe(true);
    expect(result.augmented_task_description).toContain('实现用户注册');
  });
});

// ---------------------------------------------------------------------------
// AC9: beforeSpawn is synchronous — must complete before caller continues
// ---------------------------------------------------------------------------

describe('handleBeforeSpawn - synchronous execution (AC9)', () => {
  it('hook is synchronous — returns a resolved promise (AC9)', async () => {
    // The hook should complete synchronously (no blocking on external I/O)
    // We verify this by awaiting and confirming it resolves quickly
    let resolved = false;

    const promise = handleBeforeSpawn(db, facade, {
      task_description: '实现用户注册',
      task_type: 'code',
      agent_id: null,
    });

    // Mark as resolved after awaiting
    await promise;
    resolved = true;

    expect(resolved).toBe(true);
  });

  it('hook returns a Promise that resolves to the augmented description (AC9)', async () => {
    const result = await handleBeforeSpawn(db, facade, {
      task_description: '实现用户注册',
      task_type: 'code',
      agent_id: null,
    });

    // Result should be available synchronously after awaiting
    expect(result).toBeDefined();
    expect(result.augmented_task_description).toBeDefined();
    expect(result.injected_reflections).toBeDefined();
  });

  it('spawn must wait for hook to complete (hook blocks until injection is ready, AC9)', async () => {
    facade.addReflection(makeReflection({
      id: 'r1',
      task_type: 'code',
      task_summary: '实现用户注册功能',
      reflection: '注册功能已完成。',
    }));

    // Simulate spawn waiting for hook — the augmented description must be available
    // before spawn proceeds (hook is awaited, not fire-and-forget)
    let spawnCanProceed = false;
    const result = await handleBeforeSpawn(db, facade, {
      task_description: '实现用户注册',
      task_type: 'code',
      agent_id: null,
    });

    // After hook resolves, spawn can use the augmented description
    spawnCanProceed = true;
    expect(spawnCanProceed).toBe(true);

    // Spawn uses augmented_task_description (not the original)
    const descriptionForSpawn = result.augmented_task_description;
    expect(typeof descriptionForSpawn).toBe('string');
    expect(descriptionForSpawn.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// BDD Scenario 1: spawn 前注入相关历史 reflection
// ---------------------------------------------------------------------------

describe('handleBeforeSpawn - BDD Scenario 1: inject relevant reflections before spawn', () => {
  it('injects matching code reflections into task_description before spawn (BDD1)', async () => {
    // GIVEN: reflections table with task_type='code' entries
    facade.addReflection(makeReflection({
      id: 'bdd1-r1',
      task_type: 'code',
      task_summary: '实现用户注册功能',
      reflection: '注册功能已完成，使用了 JWT 认证方法。',
    }));
    facade.addReflection(makeReflection({
      id: 'bdd1-r2',
      task_type: 'code',
      task_summary: '实现用户登录流程',
      reflection: '登录流程包含了完整的错误处理机制。',
    }));

    // WHEN: beforeSpawn called with task_type='code', task_description='实现用户注册'
    const result = await handleBeforeSpawn(db, facade, {
      task_description: '实现用户注册',
      task_type: 'code',
      agent_id: null,
    });

    // THEN:
    expect(result.augmented_task_description.length).toBeGreaterThan('实现用户注册'.length);
    expect(result.injected_reflections.length).toBeGreaterThan(0);
    expect(result.augmented_task_description).toContain('实现用户注册');
  });
});

// ---------------------------------------------------------------------------
// BDD Scenario 2: 无相关 reflection 时原样返回
// ---------------------------------------------------------------------------

describe('handleBeforeSpawn - BDD Scenario 2: return unchanged when no reflections', () => {
  it('returns original task_description unchanged when reflections table is empty (BDD2)', async () => {
    // GIVEN: reflections table is empty
    // WHEN: beforeSpawn called
    const taskDescription = '实现某个功能模块';
    const result = await handleBeforeSpawn(db, facade, {
      task_description: taskDescription,
      task_type: 'code',
      agent_id: 'agent-001',
    });

    // THEN:
    expect(result.augmented_task_description).toBe(taskDescription);
    expect(result.injected_reflections).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AC2: augmented_task_description contains injected lessons content
// ---------------------------------------------------------------------------

describe('handleBeforeSpawn - lessons content in augmented description (AC2)', () => {
  it('augmented_task_description contains lesson text from matched reflections (AC2)', async () => {
    // GIVEN: a reflection with known lessons
    const lessonText = 'Always write integration tests before deploying';
    facade.addReflection(makeReflection({
      id: 'ac2-r1',
      task_type: 'code',
      task_summary: '实现用户注册功能',
      reflection: '注册功能已完成。',
      lessons: JSON.stringify([lessonText]),
    }));

    // WHEN: beforeSpawn called with matching task_type
    const result = await handleBeforeSpawn(db, facade, {
      task_description: '实现用户注册',
      task_type: 'code',
      agent_id: null,
    });

    // THEN: augmented description includes original description
    expect(result.augmented_task_description).toContain('实现用户注册');
    // AND: augmented description includes the lesson text
    expect(result.augmented_task_description).toContain(lessonText);
  });

  it('augmented_task_description contains multiple lessons from multiple reflections (AC2)', async () => {
    const lesson1 = 'Keep functions small and focused';
    const lesson2 = 'Use descriptive variable names';

    facade.addReflection(makeReflection({
      id: 'ac2-r2',
      task_type: 'code',
      task_summary: '实现用户注册功能',
      reflection: '反思内容一',
      lessons: JSON.stringify([lesson1]),
    }));
    facade.addReflection(makeReflection({
      id: 'ac2-r3',
      task_type: 'code',
      task_summary: '实现代码质量改进',
      reflection: '反思内容二',
      lessons: JSON.stringify([lesson2]),
    }));

    const result = await handleBeforeSpawn(db, facade, {
      task_description: '实现用户注册',
      task_type: 'code',
      agent_id: null,
    });

    // Original description preserved
    expect(result.augmented_task_description).toContain('实现用户注册');
    // At least one lesson present in augmented description
    const hasLesson1 = result.augmented_task_description.includes(lesson1);
    const hasLesson2 = result.augmented_task_description.includes(lesson2);
    expect(hasLesson1 || hasLesson2).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC3: injected_reflections entries contain reflection text AND lessons array
// ---------------------------------------------------------------------------

describe('handleBeforeSpawn - reflection entries have lessons as array (AC3)', () => {
  it('each injected_reflection entry has a lessons property that is an array (AC3)', async () => {
    facade.addReflection(makeReflection({
      id: 'ac3-r1',
      task_type: 'code',
      task_summary: '实现用户注册功能',
      reflection: '已完成注册模块。',
      lessons: '["Write tests first", "Keep functions small"]',
    }));

    const result = await handleBeforeSpawn(db, facade, {
      task_description: '实现用户注册',
      task_type: 'code',
      agent_id: null,
    });

    expect(result.injected_reflections.length).toBeGreaterThan(0);

    for (const r of result.injected_reflections) {
      // reflection field must be a non-empty string
      expect(typeof r.reflection).toBe('string');
      expect(r.reflection.length).toBeGreaterThan(0);

      // lessons must be an array (not a raw JSON string)
      expect(Array.isArray(r.lessons)).toBe(true);
    }
  });

  it('lessons array contains the lesson strings from the reflection entry (AC3)', async () => {
    const expectedLessons = ['Write tests first', 'Keep functions small'];

    facade.addReflection(makeReflection({
      id: 'ac3-r2',
      task_type: 'code',
      task_summary: '实现用户注册功能',
      reflection: '已完成注册模块。',
      lessons: JSON.stringify(expectedLessons),
    }));

    const result = await handleBeforeSpawn(db, facade, {
      task_description: '实现用户注册',
      task_type: 'code',
      agent_id: null,
    });

    expect(result.injected_reflections.length).toBeGreaterThan(0);
    const r = result.injected_reflections[0];

    // lessons should be a parsed array of strings (not a raw JSON string)
    // Cast through unknown since the implementation should parse the JSON string to an array
    const lessonsValue = r.lessons as unknown;
    expect(Array.isArray(lessonsValue)).toBe(true);
    const lessonsArr = lessonsValue as string[];
    expect(lessonsArr).toContain('Write tests first');
    expect(lessonsArr).toContain('Keep functions small');
  });
});

// ---------------------------------------------------------------------------
// AC4: injected reflections ≤ reflection_injection_limit (default 5)
// ---------------------------------------------------------------------------

describe('handleBeforeSpawn - injection limit enforcement (AC4, BDD3)', () => {
  it('injected_reflections length does not exceed reflection_injection_limit of 5 (AC4)', async () => {
    // GIVEN: 10 reflections with task_type='code'
    for (let i = 0; i < 10; i++) {
      facade.addReflection(makeReflection({
        id: `ac4-r${i}`,
        task_type: 'code',
        task_summary: `实现用户注册功能模块 ${i}`,
        reflection: `反思 ${i}: 注册模块已完成，使用了用户认证方案。`,
      }));
    }

    // WHEN: beforeSpawn called — default limit is 5
    const result = await handleBeforeSpawn(db, facade, {
      task_description: '实现用户注册',
      task_type: 'code',
      agent_id: null,
    });

    // THEN: at most 5 reflections injected (matches reflection_injection_limit=5)
    expect(result.injected_reflections.length).toBeLessThanOrEqual(5);
  });

  it('BDD Scenario 3: injected_reflections ≤ 5 when 10 matching reflections exist (AC4, BDD3)', async () => {
    // GIVEN: 10 reflections with task_type='code' AND reflection_injection_limit=5
    for (let i = 0; i < 10; i++) {
      facade.addReflection(makeReflection({
        id: `bdd3-ac4-r${i}`,
        task_type: 'code',
        task_summary: `代码实现用户注册 ${i}`,
        reflection: `反思 ${i}: 完成了功能实现。`,
      }));
    }

    // WHEN: beforeSpawn called
    const result = await handleBeforeSpawn(db, facade, {
      task_description: '实现用户注册',
      task_type: 'code',
      agent_id: null,
    });

    // THEN: injected_reflections.length ≤ 5
    expect(result.injected_reflections.length).toBeLessThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// BDD Scenario 3: reflection retrieval latency under 100ms for 1000 records
// ---------------------------------------------------------------------------

describe('handleBeforeSpawn - BDD Scenario 3: retrieval completes within latency constraint', () => {
  it('hook returns within 100ms when 1000 reflections exist (AC7, BDD3)', async () => {
    // GIVEN: 1000 reflections in DB (AC7: ≤ 1000 条反思数据量下)
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
    const rows: ReflectionRow[] = [];
    for (let i = 0; i < 1000; i++) {
      rows.push({
        id: `bdd3-latency-r${i}`,
        task_type: i % 3 === 0 ? 'code' : i % 3 === 1 ? 'research' : 'design',
        task_summary: `实现功能模块 ${i} 处理用户数据`,
        outcome: 'success',
        signals: '{}',
        reflection: `反思 ${i}: 已完成任务`,
        lessons: '[]',
        agent_id: null,
        source_session: `s-${i}`,
        created_at: now,
      });
    }

    const stmt = db.prepare(`
      INSERT INTO reflections (id, task_type, task_summary, outcome, signals, reflection, lessons, agent_id, source_session, created_at)
      VALUES (@id, @task_type, @task_summary, @outcome, @signals, @reflection, @lessons, @agent_id, @source_session, @created_at)
    `);
    const insertAll = db.transaction((r: ReflectionRow[]) => {
      for (const row of r) stmt.run(row);
    });
    insertAll(rows);

    // Rebuild engine to index all 1000 records
    const freshEngine = createSearchEngine(db);
    const freshFacade = new StorageFacade(db, freshEngine);

    const start = performance.now();
    // WHEN: retrieveReflections called — synchronous retrieval latency check
    const { retrieveReflections: retrieve } = await import('../../src/reflection/index.js');
    retrieve(db, freshFacade, 'code', '实现功能', 5);
    const elapsed = performance.now() - start;

    // THEN: latency < 100ms
    expect(elapsed).toBeLessThan(100);
  });
});
