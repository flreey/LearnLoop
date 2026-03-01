/**
 * Tests for BM25 search engine wrapper (MiniSearch integration).
 * Covers: memory search, reflection search, CJK tokenization,
 * index sync on CRUD, latency constraint, and empty result handling.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { initializeDatabase } from '../../src/storage/db.js';
import {
  insertMemory,
  insertReflection,
  StorageFacade,
} from '../../src/storage/index.js';
import {
  SearchEngine,
  createSearchEngine,
} from '../../src/search/index.js';
import type { MemoryEntry, ReflectionEntry } from '../../src/types/index.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeTempDbPath(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'learnloop-search-test-'));
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
    source_session: 'session-test',
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
// AC10: Index rebuilt from DB on init — using createSearchEngine (factory)
// ---------------------------------------------------------------------------

describe('Search engine initialization from database', () => {
  it('rebuilds the index from existing database records on init so existing records are searchable', () => {
    const dbPath = makeTempDbPath();
    const db = initializeDatabase(dbPath);

    // Insert 100 memories before creating the search engine
    for (let i = 0; i < 99; i++) {
      insertMemory(db, makeMemory({ id: `mem-init-${i}`, content: `generic content number ${i}` }));
    }
    insertMemory(db, makeMemory({
      id: 'mem-init-target',
      content: 'unique initialization keyword xyzzyquux',
      subject: 'init-target',
    }));

    // Create search engine AFTER inserting records (AC10: rebuilt from DB on init)
    const engine = createSearchEngine(db);

    const results = engine.searchMemories('xyzzyquux');
    expect(results.map(r => r.id)).toContain('mem-init-target');

    db.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// AC1: Searching by keyword present in one record's content returns that record
// ---------------------------------------------------------------------------

describe('Memory text search', () => {
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

  it('AC1: searching for a keyword in a memory content returns that memory id', () => {
    // Insert 100 memories, only one has the unique keyword
    for (let i = 0; i < 99; i++) {
      const mem = makeMemory({ id: `mem-ac1-${i}`, content: `unrelated filler text number ${i}` });
      insertMemory(db, mem);
      engine.addMemory(mem);
    }

    const target = makeMemory({
      id: 'mem-ac1-target',
      content: 'configuration management with ansible playbooks',
      subject: 'devops',
    });
    insertMemory(db, target);
    engine.addMemory(target);

    const results = engine.searchMemories('ansible');
    expect(results.map(r => r.id)).toContain('mem-ac1-target');
  });

  // AC2: After adding a new memory via the storage facade, searching finds it
  // without requiring a full re-index. The facade is the ONLY call — if the
  // storage layer fails to sync the index, this assertion fails.
  it('AC2: newly added memory is searchable immediately without re-indexing', () => {
    const mem = makeMemory({
      id: 'mem-ac2-new',
      content: 'freshly added memory with term flurblewhump',
      subject: 'test',
    });
    // Only the facade is called — NOT insertMemory + engine.addMemory separately.
    storage.addMemory(mem);

    const results = engine.searchMemories('flurblewhump');
    expect(results.map(r => r.id)).toContain('mem-ac2-new');
  });

  // AC3: After updating content via the storage facade, old term no longer
  // matches and new term does. Only the facade is called — this proves the
  // storage layer actually wires the index update, not just the engine alone.
  it('AC3: after updating memory content, old term no longer matches and new term does', () => {
    const now = new Date().toISOString();
    const original = makeMemory({
      id: 'mem-ac3',
      // Use terms that are very different to avoid fuzzy-matching after update
      content: 'deploy script fix zephyrblueterm',
      subject: 'cicd',
    });
    // Insert via facade to keep DB + index in sync from the start
    storage.addMemory(original);

    // Verify old term is findable
    expect(engine.searchMemories('zephyrblueterm').map(r => r.id)).toContain('mem-ac3');

    // Update via facade ONLY — facade must sync both DB and engine.
    storage.updateMemory('mem-ac3', { content: 'CI pipeline optimization crimsonredterm', updated_at: now });

    // Old term must NOT be found
    expect(engine.searchMemories('zephyrblueterm').map(r => r.id)).not.toContain('mem-ac3');

    // New term MUST be found
    expect(engine.searchMemories('crimsonredterm').map(r => r.id)).toContain('mem-ac3');
  });

  // AC4: After deleting via the storage facade, searching the old term no longer returns the record.
  // Only the facade is called — if the storage layer fails to sync the index, the assertion fails.
  it('AC4: after deleting a memory, searching for its content term no longer returns it', () => {
    const mem = makeMemory({
      id: 'mem-ac4',
      content: 'ephemeral content with uniquedeletedterm',
      subject: 'delete-test',
    });
    // Add via facade to keep DB + index in sync from the start
    storage.addMemory(mem);

    // Verify it's findable
    expect(engine.searchMemories('uniquedeletedterm').map(r => r.id)).toContain('mem-ac4');

    // Delete via facade ONLY — facade must sync both DB and engine.
    storage.deleteMemory('mem-ac4');

    // Must NOT be found after deletion
    expect(engine.searchMemories('uniquedeletedterm').map(r => r.id)).not.toContain('mem-ac4');
  });

  // AC5: Searching for a Chinese term returns the matching memory
  it('AC5: searching for Chinese term "偏好" returns memories containing it', () => {
    const chineseMem = makeMemory({
      id: 'mem-ac5-cn',
      content: '用户偏好中文沟通方式',
      subject: 'user-preference',
    });
    insertMemory(db, chineseMem);
    engine.addMemory(chineseMem);

    // Add some noise
    const noiseMem = makeMemory({
      id: 'mem-ac5-noise',
      content: 'user prefers English communication style',
      subject: 'user-pref-en',
    });
    insertMemory(db, noiseMem);
    engine.addMemory(noiseMem);

    const results = engine.searchMemories('偏好');
    expect(results.map(r => r.id)).toContain('mem-ac5-cn');
  });

  // AC7: Results sorted by BM25 relevance (highest first)
  it('AC7: search results are sorted by BM25 relevance score descending', () => {
    // High relevance: term appears multiple times
    const highRel = makeMemory({
      id: 'mem-ac7-high',
      content: 'kubernetes kubernetes kubernetes deployment cluster node pod',
      subject: 'k8s-high',
    });
    // Low relevance: term appears once
    const lowRel = makeMemory({
      id: 'mem-ac7-low',
      content: 'kubernetes is mentioned once here along with many other unrelated words that dilute relevance',
      subject: 'k8s-low',
    });

    insertMemory(db, highRel);
    engine.addMemory(highRel);
    insertMemory(db, lowRel);
    engine.addMemory(lowRel);

    const results = engine.searchMemories('kubernetes');
    expect(results.length).toBeGreaterThanOrEqual(2);

    // Verify scores are non-increasing (sorted desc)
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }

    // High-relevance result should appear before low-relevance
    const highIdx = results.findIndex(r => r.id === 'mem-ac7-high');
    const lowIdx = results.findIndex(r => r.id === 'mem-ac7-low');
    expect(highIdx).toBeLessThan(lowIdx);
  });

  // AC9: No matching records returns empty result set
  it('AC9: searching with a query that matches no records returns empty array', () => {
    const mem = makeMemory({ id: 'mem-ac9', content: 'some ordinary content here' });
    insertMemory(db, mem);
    engine.addMemory(mem);

    const results = engine.searchMemories('zzzznonexistentterm9999');
    expect(results).toEqual([]);
  });

  afterEach(() => {
    try { db.close(); } catch { /* ignore */ }
    try { fs.rmSync(path.dirname(tempDbPath), { recursive: true, force: true }); } catch { /* ignore */ }
  });
});

// ---------------------------------------------------------------------------
// AC6: Searching reflections by task_summary keyword returns matching ids
// ---------------------------------------------------------------------------

describe('Reflection text search', () => {
  let db: ReturnType<typeof initializeDatabase>;
  let engine: SearchEngine;
  let tempDbPath: string;

  beforeEach(() => {
    tempDbPath = makeTempDbPath();
    db = initializeDatabase(tempDbPath);
    engine = createSearchEngine(db);
  });

  it('AC6: searching reflections by keyword in task_summary returns matching reflection ids', () => {
    const ref = makeReflection({
      id: 'ref-ac6-target',
      task_summary: 'database migration script deployment uniquerefterm',
      reflection: 'Learned to always backup before migration',
    });
    const noiseRef = makeReflection({
      id: 'ref-ac6-noise',
      task_summary: 'frontend styling improvements',
      reflection: 'CSS modules improved the experience',
    });

    insertReflection(db, ref);
    engine.addReflection(ref);
    insertReflection(db, noiseRef);
    engine.addReflection(noiseRef);

    const results = engine.searchReflections('uniquerefterm');
    expect(results.map(r => r.id)).toContain('ref-ac6-target');
    expect(results.map(r => r.id)).not.toContain('ref-ac6-noise');
  });

  it('searching reflections by keyword in reflection field returns matching reflection ids', () => {
    const ref = makeReflection({
      id: 'ref-field-test',
      task_summary: 'generic task summary',
      reflection: 'discovered that caching drastically improves latency uniquereflectionterm',
    });

    insertReflection(db, ref);
    engine.addReflection(ref);

    const results = engine.searchReflections('uniquereflectionterm');
    expect(results.map(r => r.id)).toContain('ref-field-test');
  });

  afterEach(() => {
    try { db.close(); } catch { /* ignore */ }
    try { fs.rmSync(path.dirname(tempDbPath), { recursive: true, force: true }); } catch { /* ignore */ }
  });
});

// ---------------------------------------------------------------------------
// AC8: Search latency < 100ms for 1000 indexed records
// ---------------------------------------------------------------------------

describe('Search latency constraint', () => {
  it('AC8: searching across 1000 indexed memory records completes in under 100ms', () => {
    const dbPath = makeTempDbPath();
    const db = initializeDatabase(dbPath);

    // Insert 1000 records
    const memories: MemoryEntry[] = [];
    for (let i = 0; i < 1000; i++) {
      const mem = makeMemory({
        id: `mem-perf-${i}`,
        content: `performance test content entry number ${i} with some varied words category${i % 10} group${i % 50}`,
        subject: `subject-${i % 20}`,
      });
      memories.push(mem);
    }

    // Bulk insert into DB
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

    // createSearchEngine should rebuild from DB (AC10)
    const engine = createSearchEngine(db);

    // Measure search latency
    const start = Date.now();
    const results = engine.searchMemories('category5');
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(100);
    // Sanity: there are results (entries contain category5)
    expect(results.length).toBeGreaterThan(0);

    db.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });
});
