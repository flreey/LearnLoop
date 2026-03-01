/**
 * BDD Scenario: 1000 条记忆下检索延迟达标
 * GIVEN memories 表中预置 1000 条记忆条目
 * WHEN 调用 beforeTurn 进行 memory retrieval
 * THEN hook 返回耗时中 memory retrieval 部分 < 100ms
 *
 * Task: TASK-BE-3.2
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { initializeDatabase } from '../../src/storage/db.js';
import { createSearchEngine } from '../../src/search/index.js';
import { StorageFacade } from '../../src/storage/facade.js';
import { retrieveMemories } from '../../src/memory/index.js';
import { handleBeforeTurn } from '../../src/hooks/index.js';
import type { DB } from '../../src/storage/db.js';
import type { MemoryEntry } from '../../src/types/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDbPath(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'learnloop-latency-test-'));
  return path.join(tmpDir, 'test.db');
}

const MEMORY_TYPES: MemoryEntry['type'][] = ['preference', 'fact', 'entity', 'episode'];

const SUBJECTS = [
  'typescript', 'javascript', 'python', 'rust', 'golang', 'java', 'csharp',
  'react', 'vue', 'angular', 'nextjs', 'nodejs', 'express', 'fastapi',
  'postgresql', 'mysql', 'sqlite', 'redis', 'mongodb', 'elasticsearch',
  'docker', 'kubernetes', 'terraform', 'ansible', 'aws', 'gcp', 'azure',
  'git', 'github', 'linux', 'macos', 'testing', 'debugging', 'performance',
  'security', 'architecture', 'design-patterns', 'refactoring', 'code-review',
];

const CONTENTS = [
  'prefers strict mode for better type safety',
  'uses functional programming patterns extensively',
  'prefers immutable data structures',
  'follows test-driven development practices',
  'uses microservices architecture for scalability',
  'prefers monorepo for code organization',
  'uses CI/CD pipelines for automated deployments',
  'prefers declarative configuration over imperative',
  'uses containerization for consistent environments',
  'follows SOLID principles in object-oriented design',
  'prefers async/await over callback patterns',
  'uses type inference to reduce boilerplate',
  'prefers composition over inheritance',
  'uses dependency injection for testability',
  'follows clean architecture boundaries',
  'uses event-driven patterns for decoupling',
  'prefers flat file structures for clarity',
  'uses semantic versioning for releases',
  'follows conventional commits specification',
  'prefers code reviews for knowledge sharing',
];

function insertBulkMemories(db: DB, facade: StorageFacade, count: number): void {
  // Use a transaction for bulk insert performance
  const insertMany = db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const subjectBase = SUBJECTS[i % SUBJECTS.length];
      const subject = `${subjectBase}-${Math.floor(i / SUBJECTS.length)}`;
      const content = `${subjectBase} ${CONTENTS[i % CONTENTS.length]} (entry ${i})`;
      const type = MEMORY_TYPES[i % MEMORY_TYPES.length];
      const now = new Date(Date.now() - i * 60 * 1000).toISOString(); // stagger timestamps

      const entry: MemoryEntry = {
        id: randomUUID(),
        type,
        content,
        subject,
        confidence: 0.5 + (i % 5) * 0.1,
        importance: 0.3 + (i % 7) * 0.1,
        source_session: `session-bulk-${Math.floor(i / 100)}`,
        access_count: i % 10,
        last_accessed_at: i % 3 === 0 ? now : null,
        created_at: now,
        updated_at: now,
      };

      // Insert directly to DB (bypass facade's search index for bulk performance)
      db.prepare(`
        INSERT INTO memories (id, type, content, subject, confidence, importance,
          source_session, access_count, last_accessed_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        entry.id, entry.type, entry.content, entry.subject,
        entry.confidence, entry.importance, entry.source_session,
        entry.access_count, entry.last_accessed_at,
        entry.created_at, entry.updated_at,
      );
    }
  });

  insertMany();
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
});

afterEach(() => {
  try { db.close(); } catch { /* ignore */ }
  try {
    fs.rmSync(path.dirname(tempDbPath), { recursive: true, force: true });
  } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// BDD Scenario 1: 1000 条记忆下检索延迟达标
// ---------------------------------------------------------------------------

describe('BDD TASK-BE-3.2: 1000 条记忆下检索延迟达标', () => {
  it('memory retrieval part of beforeTurn completes in < 100ms with 1000 memories', async () => {
    // GIVEN: Insert 1000 memory entries into the database
    insertBulkMemories(db, facade, 1000);

    // Verify we actually have 1000 rows
    const count = (db.prepare('SELECT COUNT(*) as cnt FROM memories').get() as { cnt: number }).cnt;
    expect(count).toBe(1000);

    // Rebuild the search engine index from the populated DB (simulates real startup)
    const engine = createSearchEngine(db);
    facade = new StorageFacade(db, engine);

    // WHEN: Call retrieveMemories directly to isolate the memory retrieval latency
    // (handleBeforeTurn also includes lazy extraction check overhead, so we time retrieveMemories directly)
    const query = 'typescript strict mode type safety';

    const start = performance.now();
    const result = await retrieveMemories(db, facade, query, 10);
    const elapsed = performance.now() - start;

    // THEN: retrieval latency < 100ms
    expect(elapsed).toBeLessThan(100);

    // Sanity: result is valid
    expect(result).toBeDefined();
    expect(Array.isArray(result.memories)).toBe(true);
  });

  it('handleBeforeTurn total call (including retrieval) completes in < 100ms with 1000 memories', async () => {
    // GIVEN: Insert 1000 memory entries
    insertBulkMemories(db, facade, 1000);

    const count = (db.prepare('SELECT COUNT(*) as cnt FROM memories').get() as { cnt: number }).cnt;
    expect(count).toBe(1000);

    // Rebuild index from DB
    const engine = createSearchEngine(db);
    facade = new StorageFacade(db, engine);

    // WHEN: Call handleBeforeTurn (no previous session → no extraction overhead)
    const start = performance.now();
    const result = await handleBeforeTurn(db, facade, {
      session_key: 'session-latency-test',
      conversation_context: 'typescript strict mode type safety configuration',
      previous_session_key: null,
      previous_conversation_history: null,
    });
    const elapsed = performance.now() - start;

    // THEN: total hook elapsed time < 100ms
    expect(elapsed).toBeLessThan(100);

    // Result shape is valid
    expect(result).toBeDefined();
    expect(Array.isArray(result.injected_memories)).toBe(true);
    expect(result.extraction_triggered).toBe(false);
  });
});
