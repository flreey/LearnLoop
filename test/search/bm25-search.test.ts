/**
 * BDD Integration tests for TASK-BE-0.3: BM25 Search Engine
 *
 * Scenario 1: BM25 search returns relevant memories
 * Scenario 2: Search latency within budget for 1000 records
 * Scenario 3: Index stays in sync after record mutation
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { initializeDatabase } from '../../src/storage/db.js';
import { StorageFacade } from '../../src/storage/index.js';
import { SearchEngine, createSearchEngine } from '../../src/search/index.js';
import type { MemoryEntry } from '../../src/types/index.js';

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
