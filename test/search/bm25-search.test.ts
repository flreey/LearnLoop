/**
 * BDD Integration tests for BM25 Search Engine
 *
 * Scenario 1: BM25 search returns relevant memories
 * Scenario 2: Search latency within budget for 1000 records
 * Scenario 3: Index stays in sync after record mutation
 *
 * TASK-BE-0.5 additions:
 * Scenario 4: AC1  — 5 memories, keyword search hits the right record
 * Scenario 5: AC2  — non-existent keyword returns empty result
 * Scenario 6: AC3  — Chinese content search
 * Scenario 7: AC4  — results sorted by BM25 score descending
 * Scenario 8: AC5  — 5 reflections, task_summary keyword search
 * Scenario 9: AC6  — 1000 memories search latency < 100ms
 * Scenario 10: AC7 — 1000 reflections search latency < 100ms
 * Scenario 11: AC8 — partial/substring match returns records
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { initializeDatabase } from '../../src/storage/db.js';
import { StorageFacade, insertMemory, insertReflection } from '../../src/storage/index.js';
import { SearchEngine, createSearchEngine } from '../../src/search/index.js';
import type { MemoryEntry, ReflectionEntry } from '../../src/types/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDbPath(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'learnloop-bdd-be03-'));
  return path.join(tmpDir, 'test.db');
}

function makeMemory(overrides: Partial<MemoryEntry> & { id: string }): MemoryEntry {
  const now = new Date().toISOString();
  return {
    type: 'fact',
    content: 'default content',
    subject: 'default-subject',
    confidence: 0.8,
    importance: 0.5,
    source_session: 'session-bdd',
    access_count: 0,
    last_accessed_at: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function makeReflection(overrides: Partial<ReflectionEntry> & { id: string }): ReflectionEntry {
  const now = new Date().toISOString();
  return {
    task_type: 'code',
    task_summary: 'default task summary',
    outcome: 'success',
    signals: '[]',
    reflection: 'default reflection content',
    lessons: '[]',
    agent_id: null,
    source_session: null,
    created_at: now,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Scenario 1: BM25 search returns relevant memories
// ---------------------------------------------------------------------------

describe('Scenario 1: BM25 search returns relevant memories', () => {
  let db: ReturnType<typeof initializeDatabase>;
  let engine: SearchEngine;
  let storage: StorageFacade;
  let tempDbPath: string;

  beforeEach(() => {
    tempDbPath = makeTempDbPath();
    db = initializeDatabase(tempDbPath);
    engine = createSearchEngine(db);
    storage = new StorageFacade(db, engine);
  });

  afterEach(() => {
    try { db.close(); } catch { /* ignore */ }
    try { fs.rmSync(path.dirname(tempDbPath), { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('given 10 memory records with varied content including one containing "用户偏好中文沟通", when searching "中文沟通", then the result set includes that memory and is non-empty and ordered by relevance', () => {
    // GIVEN: 10 memory records with varied content, one contains '用户偏好中文沟通'
    const targetId = 'mem-s1-target';
    for (let i = 0; i < 9; i++) {
      storage.addMemory(makeMemory({
        id: `mem-s1-noise-${i}`,
        content: `unrelated memory content entry ${i} about various topics`,
        subject: `subject-${i}`,
      }));
    }
    storage.addMemory(makeMemory({
      id: targetId,
      content: '用户偏好中文沟通方式，不喜欢英文',
      subject: 'user-preference',
    }));

    // WHEN: search with query '中文沟通'
    const results = engine.searchMemories('中文沟通');

    // THEN: result set includes the target memory
    expect(results.map(r => r.id)).toContain(targetId);

    // AND: result set is non-empty
    expect(results.length).toBeGreaterThan(0);

    // AND: ordered by relevance (scores descending)
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: Search latency within budget for 1000 records
// ---------------------------------------------------------------------------

describe('Scenario 2: Search latency within budget for 1000 records', () => {
  it('given 1000 memory records are indexed, when a search query is executed, then it completes in under 100ms', () => {
    const tempDbPath = makeTempDbPath();
    const db = initializeDatabase(tempDbPath);

    // GIVEN: 1000 memory records are indexed
    const memories: MemoryEntry[] = [];
    for (let i = 0; i < 1000; i++) {
      memories.push(makeMemory({
        id: `mem-s2-${i}`,
        content: `performance test content entry number ${i} with some varied words category${i % 10} group${i % 50}`,
        subject: `subject-${i % 20}`,
      }));
    }

    // Bulk insert into DB then create engine from DB (rebuilds index)
    const insertStmt = db.prepare(`
      INSERT INTO memories
        (id, type, content, subject, confidence, importance,
         source_session, access_count, last_accessed_at, created_at, updated_at)
      VALUES
        (@id, @type, @content, @subject, @confidence, @importance,
         @source_session, @access_count, @last_accessed_at, @created_at, @updated_at)
    `);
    const insertAll = db.transaction((mems: MemoryEntry[]) => {
      for (const m of mems) insertStmt.run(m);
    });
    insertAll(memories);

    const engine = createSearchEngine(db);

    // WHEN: a search query is executed
    const start = Date.now();
    const results = engine.searchMemories('category5');
    const elapsed = Date.now() - start;

    // THEN: completes in under 100ms
    expect(elapsed).toBeLessThan(100);

    // Sanity: results returned
    expect(results.length).toBeGreaterThan(0);

    db.close();
    fs.rmSync(path.dirname(tempDbPath), { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: Index stays in sync after record mutation
// ---------------------------------------------------------------------------

describe('Scenario 3: Index stays in sync after record mutation', () => {
  let db: ReturnType<typeof initializeDatabase>;
  let engine: SearchEngine;
  let storage: StorageFacade;
  let tempDbPath: string;

  beforeEach(() => {
    tempDbPath = makeTempDbPath();
    db = initializeDatabase(tempDbPath);
    engine = createSearchEngine(db);
    storage = new StorageFacade(db, engine);
  });

  afterEach(() => {
    try { db.close(); } catch { /* ignore */ }
    try { fs.rmSync(path.dirname(tempDbPath), { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('given a memory "deploy script fix" is indexed, when content updated to "CI pipeline optimization", then searching "deploy script" returns empty and "pipeline optimization" returns the updated memory', () => {
    const memId = 'mem-s3-sync';
    const now = new Date().toISOString();

    // GIVEN: A memory with content 'deploy script fix' is indexed
    storage.addMemory(makeMemory({
      id: memId,
      content: 'deploy script fix',
      subject: 'cicd',
    }));

    // Sanity: original content is searchable
    const beforeUpdate = engine.searchMemories('deploy');
    expect(beforeUpdate.map(r => r.id)).toContain(memId);

    // WHEN: memory content updated to 'CI pipeline optimization'
    storage.updateMemory(memId, {
      content: 'CI pipeline optimization',
      updated_at: now,
    });

    // AND a search for 'deploy script' is performed
    const deployResults = engine.searchMemories('deploy script');

    // THEN: search for 'deploy script' returns empty result (no match)
    expect(deployResults.map(r => r.id)).not.toContain(memId);

    // AND: search for 'pipeline optimization' returns the updated memory
    const pipelineResults = engine.searchMemories('pipeline optimization');
    expect(pipelineResults.map(r => r.id)).toContain(memId);
  });
});

// ---------------------------------------------------------------------------
// TASK-BE-0.5: AC1 — 5 memories keyword search returns the matching record
// ---------------------------------------------------------------------------

describe('AC1: 5 memories keyword search hits the right record', () => {
  let db: ReturnType<typeof initializeDatabase>;
  let engine: SearchEngine;
  let tempDbPath: string;

  beforeEach(() => {
    tempDbPath = makeTempDbPath();
    db = initializeDatabase(tempDbPath);
    engine = createSearchEngine(db);
  });

  afterEach(() => {
    try { db.close(); } catch { /* ignore */ }
    try { fs.rmSync(path.dirname(tempDbPath), { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('given 5 memories are inserted, searching for a keyword in one content returns that record', () => {
    // GIVEN: 5 memories with different content, one contains 'TypeScript 配置'
    const contents = [
      { id: 'ac1-mem-0', content: 'Python scripting for data analysis pipelines' },
      { id: 'ac1-mem-1', content: 'Docker container deployment best practices' },
      { id: 'ac1-mem-2', content: 'TypeScript 配置文件 tsconfig 设置' },
      { id: 'ac1-mem-3', content: 'Git branching strategy for teams' },
      { id: 'ac1-mem-4', content: 'PostgreSQL query optimization techniques' },
    ];

    for (const { id, content } of contents) {
      const mem = makeMemory({ id, content, subject: `subject-${id}` });
      insertMemory(db, mem);
      engine.addMemory(mem);
    }

    // WHEN: search by keyword 'TypeScript'
    const results = engine.searchMemories('TypeScript');

    // THEN: result list is non-empty and contains the matching record
    expect(results.length).toBeGreaterThan(0);
    expect(results.map(r => r.id)).toContain('ac1-mem-2');
  });
});

// ---------------------------------------------------------------------------
// TASK-BE-0.5: AC2 — non-existent keyword returns empty result
// ---------------------------------------------------------------------------

describe('AC2: non-existent keyword returns empty result', () => {
  let db: ReturnType<typeof initializeDatabase>;
  let engine: SearchEngine;
  let tempDbPath: string;

  beforeEach(() => {
    tempDbPath = makeTempDbPath();
    db = initializeDatabase(tempDbPath);
    engine = createSearchEngine(db);
  });

  afterEach(() => {
    try { db.close(); } catch { /* ignore */ }
    try { fs.rmSync(path.dirname(tempDbPath), { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('given 5 memories are inserted, searching for a keyword absent from all records returns empty list', () => {
    // GIVEN: 5 memories, none containing the search keyword
    for (let i = 0; i < 5; i++) {
      const mem = makeMemory({
        id: `ac2-mem-${i}`,
        content: `ordinary memory content about topic ${i}`,
        subject: `topic-${i}`,
      });
      insertMemory(db, mem);
      engine.addMemory(mem);
    }

    // WHEN: search for a keyword that does not exist in any record
    const results = engine.searchMemories('xyzzy_nonexistent_keyword_zxcvbnm');

    // THEN: empty result list
    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// TASK-BE-0.5: AC3 — Chinese content search
// ---------------------------------------------------------------------------

describe('AC3: Chinese content keyword search', () => {
  let db: ReturnType<typeof initializeDatabase>;
  let engine: SearchEngine;
  let tempDbPath: string;

  beforeEach(() => {
    tempDbPath = makeTempDbPath();
    db = initializeDatabase(tempDbPath);
    engine = createSearchEngine(db);
  });

  afterEach(() => {
    try { db.close(); } catch { /* ignore */ }
    try { fs.rmSync(path.dirname(tempDbPath), { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('given a memory with Chinese content "用户偏好中文沟通", searching "中文" returns that record', () => {
    // GIVEN: a memory with Chinese content
    const chineseMem = makeMemory({
      id: 'ac3-chinese-mem',
      content: '用户偏好中文沟通',
      subject: 'user-preference',
    });
    insertMemory(db, chineseMem);
    engine.addMemory(chineseMem);

    // Also add some English noise records
    for (let i = 0; i < 3; i++) {
      const noise = makeMemory({
        id: `ac3-noise-${i}`,
        content: `English only content number ${i}`,
        subject: `noise-${i}`,
      });
      insertMemory(db, noise);
      engine.addMemory(noise);
    }

    // WHEN: search by Chinese keyword '中文'
    const results = engine.searchMemories('中文');

    // THEN: result is non-empty and contains the Chinese record
    expect(results.length).toBeGreaterThan(0);
    expect(results.map(r => r.id)).toContain('ac3-chinese-mem');
  });
});

// ---------------------------------------------------------------------------
// TASK-BE-0.5: AC4 — Results sorted by BM25 score descending
// ---------------------------------------------------------------------------

describe('AC4: search results sorted by BM25 relevance descending', () => {
  let db: ReturnType<typeof initializeDatabase>;
  let engine: SearchEngine;
  let tempDbPath: string;

  beforeEach(() => {
    tempDbPath = makeTempDbPath();
    db = initializeDatabase(tempDbPath);
    engine = createSearchEngine(db);
  });

  afterEach(() => {
    try { db.close(); } catch { /* ignore */ }
    try { fs.rmSync(path.dirname(tempDbPath), { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('given multiple memories match a query, results are ordered with highest score first', () => {
    // GIVEN: two memories — one with high term frequency, one with low
    const highRelevance = makeMemory({
      id: 'ac4-high',
      content: 'rust rust rust rust systems programming language rust memory safety',
      subject: 'rust-heavy',
    });
    const lowRelevance = makeMemory({
      id: 'ac4-low',
      content: 'rust is one of many programming languages along with Go Python Java and others',
      subject: 'rust-light',
    });

    insertMemory(db, highRelevance);
    engine.addMemory(highRelevance);
    insertMemory(db, lowRelevance);
    engine.addMemory(lowRelevance);

    // WHEN: search for 'rust'
    const results = engine.searchMemories('rust');

    // THEN: at least 2 results, highest score first (score descending order)
    expect(results.length).toBeGreaterThanOrEqual(2);

    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }

    // AND: the high-relevance record appears before the low-relevance one
    const highIdx = results.findIndex(r => r.id === 'ac4-high');
    const lowIdx = results.findIndex(r => r.id === 'ac4-low');
    expect(highIdx).toBeLessThan(lowIdx);
  });
});

// ---------------------------------------------------------------------------
// TASK-BE-0.5: AC5 — 5 reflections, task_summary keyword search
// ---------------------------------------------------------------------------

describe('AC5: 5 reflections task_summary keyword search', () => {
  let db: ReturnType<typeof initializeDatabase>;
  let engine: SearchEngine;
  let tempDbPath: string;

  beforeEach(() => {
    tempDbPath = makeTempDbPath();
    db = initializeDatabase(tempDbPath);
    engine = createSearchEngine(db);
  });

  afterEach(() => {
    try { db.close(); } catch { /* ignore */ }
    try { fs.rmSync(path.dirname(tempDbPath), { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('given 5 reflections with different task_summaries, searching for a keyword returns the matching record', () => {
    // GIVEN: 5 reflections with different task_summary values, one contains 'Puppeteer'
    const summaries = [
      { id: 'ac5-ref-0', task_summary: 'Implement user authentication with JWT tokens' },
      { id: 'ac5-ref-1', task_summary: 'Fix CSS layout issues on mobile devices' },
      { id: 'ac5-ref-2', task_summary: 'Puppeteer E2E test automation for login flow' },
      { id: 'ac5-ref-3', task_summary: 'Database schema migration for new user fields' },
      { id: 'ac5-ref-4', task_summary: 'Optimize React rendering performance' },
    ];

    for (const { id, task_summary } of summaries) {
      const ref = makeReflection({ id, task_summary });
      insertReflection(db, ref);
      engine.addReflection(ref);
    }

    // WHEN: search by keyword 'Puppeteer'
    const results = engine.searchReflections('Puppeteer');

    // THEN: result list is non-empty and contains the matching record
    expect(results.length).toBeGreaterThan(0);
    expect(results.map(r => r.id)).toContain('ac5-ref-2');
  });
});

// ---------------------------------------------------------------------------
// TASK-BE-0.5: AC6 — 1000 memories search latency < 100ms
// ---------------------------------------------------------------------------

describe('AC6: 1000 memories search latency < 100ms', () => {
  it('given 1000 memories are indexed, a single search completes in under 100ms', () => {
    const tempDbPath = makeTempDbPath();
    const db = initializeDatabase(tempDbPath);

    // GIVEN: 1000 memory records inserted into DB
    const insertStmt = db.prepare(`
      INSERT INTO memories
        (id, type, content, subject, confidence, importance,
         source_session, access_count, last_accessed_at, created_at, updated_at)
      VALUES
        (@id, @type, @content, @subject, @confidence, @importance,
         @source_session, @access_count, @last_accessed_at, @created_at, @updated_at)
    `);
    const now = new Date().toISOString();
    const insertAll = db.transaction(() => {
      for (let i = 0; i < 1000; i++) {
        insertStmt.run({
          id: `ac6-mem-${i}`,
          type: 'fact',
          content: `memory content entry ${i} about technology topic${i % 20} category${i % 10}`,
          subject: `subject-${i % 30}`,
          confidence: 0.8,
          importance: 0.5,
          source_session: 'session-ac6',
          access_count: 0,
          last_accessed_at: null,
          created_at: now,
          updated_at: now,
        });
      }
    });
    insertAll();

    // Build the search index from DB (simulates production startup)
    const engine = createSearchEngine(db);

    // WHEN: execute a single search and measure elapsed time
    const start = Date.now();
    const results = engine.searchMemories('category5');
    const elapsed = Date.now() - start;

    // THEN: search completes in under 100ms
    expect(elapsed).toBeLessThan(100);

    // Sanity: results are returned (entries contain 'category5')
    expect(results.length).toBeGreaterThan(0);

    db.close();
    fs.rmSync(path.dirname(tempDbPath), { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// TASK-BE-0.5: AC7 — 1000 reflections search latency < 100ms
// ---------------------------------------------------------------------------

describe('AC7: 1000 reflections search latency < 100ms', () => {
  it('given 1000 reflections are indexed, a single search completes in under 100ms', () => {
    const tempDbPath = makeTempDbPath();
    const db = initializeDatabase(tempDbPath);

    // GIVEN: 1000 reflection records inserted into DB
    const insertStmt = db.prepare(`
      INSERT INTO reflections
        (id, task_type, task_summary, outcome, signals, reflection,
         lessons, agent_id, source_session, created_at)
      VALUES
        (@id, @task_type, @task_summary, @outcome, @signals, @reflection,
         @lessons, @agent_id, @source_session, @created_at)
    `);
    const now = new Date().toISOString();
    const insertAll = db.transaction(() => {
      for (let i = 0; i < 1000; i++) {
        insertStmt.run({
          id: `ac7-ref-${i}`,
          task_type: 'code',
          task_summary: `reflection task summary entry ${i} about workflow topic${i % 20} area${i % 10}`,
          outcome: 'success',
          signals: '[]',
          reflection: `reflection body for entry ${i} discussing lessons and improvements`,
          lessons: '[]',
          agent_id: null,
          source_session: null,
          created_at: now,
        });
      }
    });
    insertAll();

    // Build the search index from DB (simulates production startup)
    const engine = createSearchEngine(db);

    // WHEN: execute a single search and measure elapsed time
    const start = Date.now();
    const results = engine.searchReflections('area5');
    const elapsed = Date.now() - start;

    // THEN: search completes in under 100ms
    expect(elapsed).toBeLessThan(100);

    // Sanity: results are returned (reflections contain 'area5')
    expect(results.length).toBeGreaterThan(0);

    db.close();
    fs.rmSync(path.dirname(tempDbPath), { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// TASK-BE-0.5: AC8 — partial/substring match returns records
// ---------------------------------------------------------------------------

describe('AC8: partial/substring match returns records containing that substring', () => {
  let db: ReturnType<typeof initializeDatabase>;
  let engine: SearchEngine;
  let tempDbPath: string;

  beforeEach(() => {
    tempDbPath = makeTempDbPath();
    db = initializeDatabase(tempDbPath);
    engine = createSearchEngine(db);
  });

  afterEach(() => {
    try { db.close(); } catch { /* ignore */ }
    try { fs.rmSync(path.dirname(tempDbPath), { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('given a memory content "TypeScript configuration", searching the substring "TypeScrip" returns that record', () => {
    // GIVEN: a memory with content that is a superset of the search term
    const mem = makeMemory({
      id: 'ac8-partial-mem',
      content: 'TypeScript configuration for monorepo projects',
      subject: 'typescript',
    });
    insertMemory(db, mem);
    engine.addMemory(mem);

    // Also add noise
    const noise = makeMemory({
      id: 'ac8-noise',
      content: 'JavaScript configuration is different',
      subject: 'javascript',
    });
    insertMemory(db, noise);
    engine.addMemory(noise);

    // WHEN: search for a prefix substring of a word in the content
    const results = engine.searchMemories('TypeScrip');

    // THEN: the record whose content contains 'TypeScript' (prefix match) is returned
    expect(results.length).toBeGreaterThan(0);
    expect(results.map(r => r.id)).toContain('ac8-partial-mem');
  });

  it('given a memory content "database schema migration", searching "migrat" (prefix) returns that record', () => {
    // GIVEN: a memory whose content contains 'migration'
    const mem = makeMemory({
      id: 'ac8-migration-mem',
      content: 'database schema migration for new user fields',
      subject: 'database',
    });
    insertMemory(db, mem);
    engine.addMemory(mem);

    // WHEN: search for a prefix of 'migration'
    const results = engine.searchMemories('migrat');

    // THEN: the record is returned (prefix: true in MiniSearch config)
    expect(results.length).toBeGreaterThan(0);
    expect(results.map(r => r.id)).toContain('ac8-migration-mem');
  });
});
