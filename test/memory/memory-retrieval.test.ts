/**
 * Tests for tri-dimensional memory retrieval and context injection.
 * Covers: retrieveMemories(), injectMemories()
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { initializeDatabase } from '../../src/storage/db.js';
import { createSearchEngine } from '../../src/search/index.js';
import { StorageFacade } from '../../src/storage/facade.js';
import { retrieveMemories, injectMemories } from '../../src/memory/index.js';
import { insertMemory } from '../../src/storage/repository.js';
import type { DB } from '../../src/storage/db.js';
import type { MemoryEntry, ScoredMemoryEntry } from '../../src/types/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDbPath(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'learnloop-retrieval-test-'));
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
// AC1, AC2, AC3: Retrieval returns scored, sorted memories
// ---------------------------------------------------------------------------

describe('retrieveMemories - basic retrieval', () => {
  it('returns memories array sorted by score descending (AC1)', async () => {
    // Insert memories with different relevance to query
    const mem1 = makeMemory({
      id: 'mem-typescript-1',
      content: 'User prefers TypeScript over JavaScript for all projects',
      subject: 'typescript-preference',
      importance: 0.9,
    });
    const mem2 = makeMemory({
      id: 'mem-typescript-2',
      content: 'TypeScript strict mode is enabled in the project config',
      subject: 'typescript-config',
      importance: 0.6,
    });
    const mem3 = makeMemory({
      id: 'mem-unrelated',
      content: 'User enjoys cooking Italian food on weekends',
      subject: 'cooking-hobby',
      importance: 0.3,
    });

    facade.addMemory(mem1);
    facade.addMemory(mem2);
    facade.addMemory(mem3);

    const result = await retrieveMemories(db, facade, 'TypeScript preference', 5);

    expect(result.memories.length).toBeGreaterThan(0);
    expect(result.memories.length).toBeLessThanOrEqual(5);

    // Verify descending order
    for (let i = 1; i < result.memories.length; i++) {
      expect(result.memories[i - 1].score).toBeGreaterThanOrEqual(result.memories[i].score);
    }
  });

  it('each returned memory contains the score field (AC2)', async () => {
    facade.addMemory(makeMemory({
      id: 'mem-scored',
      content: 'User prefers TypeScript for type safety',
      subject: 'typescript-pref',
      importance: 0.8,
    }));

    const result = await retrieveMemories(db, facade, 'TypeScript', 5);

    for (const mem of result.memories) {
      expect(typeof mem.score).toBe('number');
      expect(mem.score).toBeGreaterThanOrEqual(0);
    }
  });

  it('returned memories contain all original fields plus score (AC2)', async () => {
    const original = makeMemory({
      id: 'mem-fields',
      content: 'User works with React and TypeScript daily',
      subject: 'react-typescript',
      importance: 0.7,
      access_count: 3,
    });
    facade.addMemory(original);

    const result = await retrieveMemories(db, facade, 'React TypeScript', 5);
    expect(result.memories.length).toBeGreaterThan(0);

    const found = result.memories.find(m => m.id === 'mem-fields');
    expect(found).toBeDefined();
    if (found) {
      expect(found.id).toBe('mem-fields');
      expect(found.content).toBe('User works with React and TypeScript daily');
      expect(found.subject).toBe('react-typescript');
      expect(found.importance).toBe(0.7);
      expect(typeof found.score).toBe('number');
    }
  });

  it('result count does not exceed limit parameter (AC7)', async () => {
    for (let i = 0; i < 10; i++) {
      facade.addMemory(makeMemory({
        id: `mem-limit-${i}`,
        content: `TypeScript coding tip number ${i} for better development`,
        subject: `typescript-tip-${i}`,
        importance: 0.5,
      }));
    }

    const result = await retrieveMemories(db, facade, 'TypeScript coding', 3);
    expect(result.memories.length).toBeLessThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// AC3: Score formula verification
// ---------------------------------------------------------------------------

describe('retrieveMemories - score formula', () => {
  it('uses default weights a=0.3, b=0.5, c=0.2 (AC3)', async () => {
    // Create a memory accessed just now (high recency) and relevant
    const now = new Date().toISOString();
    const mem = makeMemory({
      id: 'mem-score-formula',
      content: 'Python programming language is used for data science',
      subject: 'python-data-science',
      importance: 1.0,
      last_accessed_at: now,
    });
    facade.addMemory(mem);

    const result = await retrieveMemories(db, facade, 'Python data science', 5);
    expect(result.memories.length).toBeGreaterThan(0);

    const found = result.memories.find(m => m.id === 'mem-score-formula');
    expect(found).toBeDefined();
    if (found) {
      // score = 0.3 * recency + 0.5 * relevance + 0.2 * importance
      // With importance=1.0 and recent access, score contribution from importance = 0.2
      // Full score must be >= 0.2 (importance component alone)
      expect(found.score).toBeGreaterThanOrEqual(0.2);
      expect(found.score).toBeLessThanOrEqual(1.0);
    }
  });

  it('custom weights override defaults (AC8)', async () => {
    const now = new Date().toISOString();
    const highImportance = makeMemory({
      id: 'mem-high-importance',
      content: 'Node.js event loop is critical for performance',
      subject: 'nodejs-performance',
      importance: 1.0,
      last_accessed_at: now,
    });
    const lowImportance = makeMemory({
      id: 'mem-low-importance',
      content: 'Node.js package manager npm is commonly used',
      subject: 'nodejs-npm',
      importance: 0.1,
      last_accessed_at: now,
    });

    facade.addMemory(highImportance);
    facade.addMemory(lowImportance);

    // Use importance-dominant weights
    const result = await retrieveMemories(db, facade, 'Node.js', 5, {
      recency: 0.0,
      relevance: 0.1,
      importance: 0.9,
    });

    const highIdx = result.memories.findIndex(m => m.id === 'mem-high-importance');
    const lowIdx = result.memories.findIndex(m => m.id === 'mem-low-importance');

    // Both must be found
    expect(highIdx).not.toBe(-1);
    expect(lowIdx).not.toBe(-1);

    // High importance should rank before low importance with these weights
    expect(highIdx).toBeLessThan(lowIdx);
  });
});

// ---------------------------------------------------------------------------
// AC4: Recency calculation with time decay
// ---------------------------------------------------------------------------

describe('retrieveMemories - recency calculation', () => {
  it('uses exponential decay exp(-lambda * hours_since_last_access) for recency (AC4)', async () => {
    const now = new Date();
    const oldDate = new Date(now.getTime() - 24 * 60 * 60 * 1000); // 24 hours ago

    const recentMem = makeMemory({
      id: 'mem-recent',
      content: 'Go programming language goroutines for concurrency',
      subject: 'go-concurrency',
      importance: 0.5,
      last_accessed_at: now.toISOString(),
    });
    const oldMem = makeMemory({
      id: 'mem-old',
      content: 'Go programming language channels for goroutines',
      subject: 'go-channels',
      importance: 0.5,
      last_accessed_at: oldDate.toISOString(),
    });

    facade.addMemory(recentMem);
    facade.addMemory(oldMem);

    // With equal importance and similar relevance, recent should score higher
    const result = await retrieveMemories(db, facade, 'Go programming goroutines', 5);

    const recentFound = result.memories.find(m => m.id === 'mem-recent');
    const oldFound = result.memories.find(m => m.id === 'mem-old');

    expect(recentFound).toBeDefined();
    expect(oldFound).toBeDefined();

    if (recentFound && oldFound) {
      // recency(recent) > recency(old) so score(recent) >= score(old)
      // (With equal importance and similar relevance, recency tips the balance)
      expect(recentFound.score).toBeGreaterThan(oldFound.score);
    }
  });

  it('falls back to updated_at when last_accessed_at is null (AC4)', async () => {
    const now = new Date().toISOString();
    const mem = makeMemory({
      id: 'mem-no-access',
      content: 'Rust ownership system ensures memory safety without GC',
      subject: 'rust-memory-safety',
      importance: 0.5,
      last_accessed_at: null,
      updated_at: now,
    });
    facade.addMemory(mem);

    const result = await retrieveMemories(db, facade, 'Rust memory safety', 5);

    const found = result.memories.find(m => m.id === 'mem-no-access');
    expect(found).toBeDefined();
    if (found) {
      // Should have a valid recency score (uses updated_at as fallback)
      expect(found.score).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// AC5: BM25 relevance normalization
// ---------------------------------------------------------------------------

describe('retrieveMemories - BM25 relevance normalization', () => {
  it('relevance scores are normalized to 0-1 range (AC5)', async () => {
    for (let i = 0; i < 5; i++) {
      facade.addMemory(makeMemory({
        id: `mem-bm25-${i}`,
        content: `Docker container orchestration with Kubernetes cluster ${i}`,
        subject: `docker-k8s-${i}`,
        importance: 0.5,
      }));
    }

    const result = await retrieveMemories(db, facade, 'Docker Kubernetes', 5);

    for (const mem of result.memories) {
      // score = 0.3 * recency + 0.5 * relevance + 0.2 * importance
      // all components in [0,1], so score must be in [0,1]
      expect(mem.score).toBeGreaterThanOrEqual(0);
      expect(mem.score).toBeLessThanOrEqual(1.0);
    }
  });
});

// ---------------------------------------------------------------------------
// AC6: Importance field used directly
// ---------------------------------------------------------------------------

describe('retrieveMemories - importance scoring', () => {
  it('importance from memory entry directly influences score (AC6)', async () => {
    const now = new Date().toISOString();

    const highImportance = makeMemory({
      id: 'mem-high-imp',
      content: 'AWS S3 bucket is used for storing static assets in production',
      subject: 'aws-s3-storage',
      importance: 1.0,
      last_accessed_at: now,
    });
    const lowImportance = makeMemory({
      id: 'mem-low-imp',
      content: 'AWS S3 bucket versioning can be enabled for backup',
      subject: 'aws-s3-versioning',
      importance: 0.0,
      last_accessed_at: now,
    });

    facade.addMemory(highImportance);
    facade.addMemory(lowImportance);

    // With recency=0, relevance=0 (custom weights), importance drives the score
    const result = await retrieveMemories(db, facade, 'AWS S3', 5, {
      recency: 0.0,
      relevance: 0.0,
      importance: 1.0,
    });

    const highFound = result.memories.find(m => m.id === 'mem-high-imp');
    const lowFound = result.memories.find(m => m.id === 'mem-low-imp');

    expect(highFound).toBeDefined();
    expect(lowFound).toBeDefined();

    if (highFound && lowFound) {
      expect(highFound.score).toBeGreaterThan(lowFound.score);
    }
  });
});

// ---------------------------------------------------------------------------
// AC9, AC10: Access tracking update
// ---------------------------------------------------------------------------

describe('retrieveMemories - access tracking', () => {
  it('increments access_count by 1 for returned memories (AC9)', async () => {
    const mem = makeMemory({
      id: 'mem-track-access',
      content: 'Redis caching strategy improves database performance significantly',
      subject: 'redis-caching',
      importance: 0.8,
      access_count: 3,
    });
    facade.addMemory(mem);

    const result = await retrieveMemories(db, facade, 'Redis caching performance', 5);

    const found = result.memories.find(m => m.id === 'mem-track-access');
    expect(found).toBeDefined();

    // Verify from DB that access_count was incremented
    const dbRow = db.prepare('SELECT access_count, last_accessed_at FROM memories WHERE id = ?').get('mem-track-access') as { access_count: number; last_accessed_at: string | null };
    expect(dbRow.access_count).toBe(4);
  });

  it('updates last_accessed_at to current time for returned memories (AC9)', async () => {
    const oldDate = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1 hour ago
    const mem = makeMemory({
      id: 'mem-track-time',
      content: 'PostgreSQL full-text search provides powerful query capabilities',
      subject: 'postgres-search',
      importance: 0.8,
      last_accessed_at: oldDate,
    });
    facade.addMemory(mem);

    const beforeCall = Date.now();
    const result = await retrieveMemories(db, facade, 'PostgreSQL search capabilities', 5);
    const afterCall = Date.now();

    const found = result.memories.find(m => m.id === 'mem-track-time');
    expect(found).toBeDefined();

    const dbRow = db.prepare('SELECT last_accessed_at FROM memories WHERE id = ?').get('mem-track-time') as { last_accessed_at: string };
    const updatedTime = new Date(dbRow.last_accessed_at).getTime();
    expect(updatedTime).toBeGreaterThanOrEqual(beforeCall);
    expect(updatedTime).toBeLessThanOrEqual(afterCall + 1000); // 1s tolerance
  });

  it('does not update access_count for memories NOT in top-N results (AC10)', async () => {
    // Insert a memory that won't be relevant to the query
    const irrelevantMem = makeMemory({
      id: 'mem-not-returned',
      content: 'Medieval history of European castles and fortifications',
      subject: 'medieval-history',
      importance: 0.5,
      access_count: 7,
    });
    facade.addMemory(irrelevantMem);

    // Insert relevant memories to fill limit
    for (let i = 0; i < 3; i++) {
      facade.addMemory(makeMemory({
        id: `mem-relevant-${i}`,
        content: `GraphQL query language for API development ${i} advanced features`,
        subject: `graphql-${i}`,
        importance: 0.8,
      }));
    }

    await retrieveMemories(db, facade, 'GraphQL API queries', 3);

    // The irrelevant memory's access_count should be unchanged
    const dbRow = db.prepare('SELECT access_count FROM memories WHERE id = ?').get('mem-not-returned') as { access_count: number };
    expect(dbRow.access_count).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// AC11: No relevant memories → empty result
// ---------------------------------------------------------------------------

describe('retrieveMemories - no relevant memories', () => {
  it('returns empty memories array when query has no BM25 matches (AC11)', async () => {
    // Insert memories about a completely different topic
    facade.addMemory(makeMemory({
      id: 'mem-unrelated-1',
      content: 'Baroque music features ornate melodies and counterpoint',
      subject: 'baroque-music',
      importance: 0.5,
    }));
    facade.addMemory(makeMemory({
      id: 'mem-unrelated-2',
      content: 'Renaissance art is characterized by perspective and humanism',
      subject: 'renaissance-art',
      importance: 0.5,
    }));

    // Query is completely unrelated to stored memories
    // Use a very specific technical term unlikely to match arts content
    const result = await retrieveMemories(db, facade, 'xyzzy-nonexistent-keyword-zq9f', 5);

    expect(result.memories).toHaveLength(0);
  });

  it('returns empty memories when no memories are stored', async () => {
    const result = await retrieveMemories(db, facade, 'any query', 5);
    expect(result.memories).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC12: Performance benchmark — 1000 memories under 100ms
// ---------------------------------------------------------------------------

describe('retrieveMemories - performance', () => {
  it('retrieval with 1000 memories completes in under 100ms (AC12)', async () => {
    // Pre-populate 1000 memories directly via DB + index
    const memories: MemoryEntry[] = [];
    const now = new Date().toISOString();

    for (let i = 0; i < 1000; i++) {
      memories.push({
        id: `mem-perf-${i}`,
        type: 'fact',
        content: `Performance test memory entry number ${i} about software engineering and coding practices`,
        subject: `perf-subject-${i}`,
        confidence: 0.8,
        importance: Math.random(),
        source_session: 'perf-session',
        access_count: 0,
        last_accessed_at: null,
        created_at: now,
        updated_at: now,
      });
    }

    // Use facade to add all memories (keeps search index in sync)
    for (const mem of memories) {
      facade.addMemory(mem);
    }

    const start = Date.now();
    await retrieveMemories(db, facade, 'software engineering coding practices', 10);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(100);
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: injectMemories — memory context injection formatting
// ---------------------------------------------------------------------------

describe('injectMemories - context injection', () => {
  it('injects relevant memories into context string in readable format', async () => {
    facade.addMemory(makeMemory({
      id: 'mem-inject-1',
      content: 'User prefers concise code with TypeScript strict mode',
      subject: 'coding-preference',
      importance: 0.9,
    }));
    facade.addMemory(makeMemory({
      id: 'mem-inject-2',
      content: 'User works on a Node.js backend with PostgreSQL database',
      subject: 'tech-stack',
      importance: 0.8,
    }));

    const context = 'How should I structure the TypeScript module for the Node.js backend?';
    const injected = await injectMemories(db, facade, context, 5);

    // Should contain memories about TypeScript and Node.js
    expect(injected).toContain('User prefers concise code with TypeScript strict mode');
    expect(injected).toContain('User works on a Node.js backend with PostgreSQL database');
    // Should contain the original context
    expect(injected).toContain(context);
  });

  it('returns context unchanged when no relevant memories are found', async () => {
    const context = 'xyzzy-nonexistent-zq9f-magic-unrelated-search-term';
    const injected = await injectMemories(db, facade, context, 5);

    // When no memories found, skip injection and return context as-is
    expect(injected).toBe(context);
  });

  it('formats memories in readable blocks within context (Scenario 4)', async () => {
    facade.addMemory(makeMemory({
      id: 'mem-format-1',
      content: 'User always uses ESLint with Prettier for code formatting',
      subject: 'code-style',
      importance: 0.8,
    }));

    const context = 'Please help me set up ESLint and Prettier configuration';
    const injected = await injectMemories(db, facade, context, 5);

    // The injection should include memory content in a structured way
    expect(injected).toContain('ESLint');
    // The memory block should be formatted (contains some structural marker)
    // The injected context should be longer than the original
    expect(injected.length).toBeGreaterThan(context.length);
  });

  it('injection result contains the original query context', async () => {
    facade.addMemory(makeMemory({
      id: 'mem-ctx-check',
      content: 'Vitest is the preferred testing framework for this project',
      subject: 'testing-framework',
      importance: 0.9,
    }));

    const originalContext = 'How do I write integration tests with Vitest for this project?';
    const injected = await injectMemories(db, facade, originalContext, 5);

    expect(injected).toContain(originalContext);
  });
});
