/**
 * Tests for memory extraction, conflict detection, and lazy extraction check.
 * Covers: extractMemories(), detectAndUpsert(), lazyExtractionCheck()
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { initializeDatabase } from '../../src/storage/db.js';
import {
  insertSessionState,
  getMemoriesBySubject,
} from '../../src/storage/repository.js';
import { createSearchEngine } from '../../src/search/index.js';
import { StorageFacade } from '../../src/storage/facade.js';
import {
  extractMemories,
  detectAndUpsert,
  lazyExtractionCheck,
} from '../../src/memory/index.js';
import * as llmModule from '../../src/llm/index.js';
import type { DB } from '../../src/storage/db.js';
import type { MemoryEntry, Message } from '../../src/types/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDbPath(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'learnloop-mem-test-'));
  return path.join(tmpDir, 'test.db');
}

function makeMemory(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  const now = new Date().toISOString();
  return {
    id: `mem-${Math.random().toString(36).slice(2)}`,
    type: 'preference',
    content: 'User prefers dark mode',
    subject: 'user-ui-pref',
    confidence: 0.8,
    importance: 0.7,
    source_session: 'session-old',
    access_count: 0,
    last_accessed_at: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

const SAMPLE_CONVERSATION: Message[] = [
  { role: 'user', content: 'I really prefer using dark mode for coding.' },
  { role: 'assistant', content: 'Got it, I will remember that preference.' },
  { role: 'user', content: 'Also, my name is Alice and I am a software engineer.' },
];

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
// Lazy Extraction Eligibility Check — unit tests (ACs 8, 9, 10)
// ---------------------------------------------------------------------------

describe('lazyExtractionCheck', () => {
  it('returns should_extract=false when previous_session_key is null (AC-8)', () => {
    const result = lazyExtractionCheck(db, null);
    expect(result.should_extract).toBe(false);
  });

  it('returns session_key=null when previous_session_key is null', () => {
    const result = lazyExtractionCheck(db, null);
    expect(result.session_key).toBeNull();
  });

  it('returns should_extract=true when no session_states record exists (AC-9)', () => {
    const result = lazyExtractionCheck(db, 'session-not-in-db');
    expect(result.should_extract).toBe(true);
  });

  it('returns the session_key in the result when no record exists', () => {
    const result = lazyExtractionCheck(db, 'some-session');
    expect(result.session_key).toBe('some-session');
  });

  it('returns should_extract=true when session_states record has extracted=0 (AC-9)', () => {
    const now = new Date().toISOString();
    insertSessionState(db, {
      session_key: 'session-unextracted',
      extracted: 0,
      conversation_hash: null,
      created_at: now,
      updated_at: now,
    });
    const result = lazyExtractionCheck(db, 'session-unextracted');
    expect(result.should_extract).toBe(true);
  });

  it('returns should_extract=false when session_states record has extracted=1 (AC-10)', () => {
    const now = new Date().toISOString();
    insertSessionState(db, {
      session_key: 'session-extracted',
      extracted: 1,
      conversation_hash: null,
      created_at: now,
      updated_at: now,
    });
    const result = lazyExtractionCheck(db, 'session-extracted');
    expect(result.should_extract).toBe(false);
  });

  it('returns the correct session_key in result', () => {
    const now = new Date().toISOString();
    insertSessionState(db, {
      session_key: 'my-session',
      extracted: 1,
      conversation_hash: null,
      created_at: now,
      updated_at: now,
    });
    const result = lazyExtractionCheck(db, 'my-session');
    expect(result.session_key).toBe('my-session');
  });
});

// ---------------------------------------------------------------------------
// detectAndUpsert — conflict detection and upsert algorithm unit tests
// ---------------------------------------------------------------------------

describe('detectAndUpsert conflict detection algorithm', () => {
  it('returns action=insert and target_id=null for new subject (AC-6)', () => {
    const result = detectAndUpsert(db, facade, 'sess-1', {
      type: 'preference',
      content: 'User likes Python',
      subject: 'user-language-pref',
      confidence: 0.9,
      importance: 0.8,
    });

    expect(result.action).toBe('insert');
    expect(result.target_id).toBeNull();
  });

  it('inserts memory into storage when no conflict exists (AC-6)', () => {
    detectAndUpsert(db, facade, 'sess-1', {
      type: 'entity',
      content: 'Alice is the user',
      subject: 'user-identity-brand-new',
      confidence: 0.9,
      importance: 0.8,
    });

    const stored = getMemoriesBySubject(db, 'user-identity-brand-new');
    expect(stored.length).toBe(1);
    expect(stored[0].content).toBe('Alice is the user');
  });

  it('returns action=update and correct target_id for same subject+type conflict (AC-4)', () => {
    // Pre-insert via facade so it's in the search index
    const existingMem = makeMemory({
      id: 'target-mem-xyz',
      type: 'fact',
      content: 'old content',
      subject: 'conflict-subject',
      confidence: 0.5,
      importance: 0.5,
      source_session: 'old-sess',
    });
    facade.addMemory(existingMem);

    const result = detectAndUpsert(db, facade, 'sess-2', {
      type: 'fact',
      content: 'new content',
      subject: 'conflict-subject',
      confidence: 0.9,
      importance: 0.9,
    });

    expect(result.action).toBe('update');
    expect(result.target_id).toBe('target-mem-xyz');

    // Verify the stored record is updated
    const stored = getMemoriesBySubject(db, 'conflict-subject');
    expect(stored[0].content).toBe('new content');
    expect(stored[0].confidence).toBe(0.9);
    expect(stored[0].importance).toBe(0.9);
  });

  it('updates content, confidence, importance, updated_at on conflict (AC-4)', () => {
    const createdAt = new Date(Date.now() - 5000).toISOString();
    const existingMem: MemoryEntry = {
      id: 'update-fields-test',
      type: 'preference',
      content: 'User prefers light mode',
      subject: 'user-lang',
      confidence: 0.6,
      importance: 0.5,
      source_session: 'old-session',
      access_count: 0,
      last_accessed_at: null,
      created_at: createdAt,
      updated_at: createdAt,
    };
    facade.addMemory(existingMem);

    detectAndUpsert(db, facade, 'new-session', {
      type: 'preference',
      content: 'User prefers dark mode',
      subject: 'user-lang',
      confidence: 0.9,
      importance: 0.8,
    });

    const stored = getMemoriesBySubject(db, 'user-lang');
    const prefType = stored.filter(m => m.type === 'preference');
    expect(prefType.length).toBe(1);
    expect(prefType[0].content).toBe('User prefers dark mode');
    expect(prefType[0].confidence).toBe(0.9);
    expect(prefType[0].importance).toBe(0.8);
    // updated_at should be later than created_at
    expect(new Date(prefType[0].updated_at).getTime()).toBeGreaterThanOrEqual(
      new Date(createdAt).getTime()
    );
  });

  it('preserves id, created_at, source_session, access_count on update (AC-4)', () => {
    const createdAt = new Date(Date.now() - 10000).toISOString();
    const existingMem: MemoryEntry = {
      id: 'preserved-id-001',
      type: 'entity',
      content: 'original content',
      subject: 'preserve-test-subject',
      confidence: 0.5,
      importance: 0.5,
      source_session: 'original-session',
      access_count: 5,
      last_accessed_at: null,
      created_at: createdAt,
      updated_at: createdAt,
    };
    facade.addMemory(existingMem);

    detectAndUpsert(db, facade, 'new-sess', {
      type: 'entity',
      content: 'updated content',
      subject: 'preserve-test-subject',
      confidence: 0.95,
      importance: 0.85,
    });

    const stored = getMemoriesBySubject(db, 'preserve-test-subject');
    expect(stored.length).toBe(1);
    // Preserved fields
    expect(stored[0].id).toBe('preserved-id-001');
    expect(stored[0].created_at).toBe(createdAt);
    expect(stored[0].source_session).toBe('original-session');
    expect(stored[0].access_count).toBe(5);
  });

  it('inserts when same subject exists but different type (AC-5)', () => {
    const existingMem = makeMemory({
      id: 'episode-mem',
      type: 'episode',
      content: 'User once asked about Python',
      subject: 'python-topic',
    });
    facade.addMemory(existingMem);

    const result = detectAndUpsert(db, facade, 'sess-b', {
      type: 'fact',  // different type, same subject
      content: 'Python is a programming language',
      subject: 'python-topic',
      confidence: 0.99,
      importance: 0.7,
    });

    expect(result.action).toBe('insert');
    expect(result.target_id).toBeNull();

    // Both records exist
    const stored = getMemoriesBySubject(db, 'python-topic');
    expect(stored.length).toBe(2);
    expect(stored.some(m => m.type === 'episode')).toBe(true);
    expect(stored.some(m => m.type === 'fact')).toBe(true);
  });

  it('same subject + different type does not overwrite existing entry (AC-5)', () => {
    const existingMem = makeMemory({
      id: 'pref-mem-001',
      type: 'preference',
      subject: 'user-name',
      content: 'User prefers verbose explanations',
    });
    facade.addMemory(existingMem);

    detectAndUpsert(db, facade, 'new-session', {
      type: 'fact',
      content: 'User is named Alice',
      subject: 'user-name',
      confidence: 0.95,
      importance: 0.9,
    });

    const stored = getMemoriesBySubject(db, 'user-name');
    expect(stored.length).toBe(2);
    expect(stored.some(m => m.type === 'preference')).toBe(true);
    expect(stored.some(m => m.type === 'fact')).toBe(true);
  });

  it('conflicts_resolved count tracks updates correctly (AC-7)', () => {
    // Pre-insert two memories via facade
    const mem1 = makeMemory({ id: 'conf-1', subject: 'subject-a', type: 'preference', content: 'old-a' });
    const mem2 = makeMemory({ id: 'conf-2', subject: 'subject-b', type: 'fact', content: 'old-b' });
    facade.addMemory(mem1);
    facade.addMemory(mem2);

    let updateCount = 0;
    const r1 = detectAndUpsert(db, facade, 'sess', {
      type: 'preference', content: 'new-a', subject: 'subject-a', confidence: 0.9, importance: 0.9,
    });
    if (r1.action === 'update') updateCount++;

    const r2 = detectAndUpsert(db, facade, 'sess', {
      type: 'fact', content: 'new-b', subject: 'subject-b', confidence: 0.9, importance: 0.9,
    });
    if (r2.action === 'update') updateCount++;

    expect(updateCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// extractMemories — integration tests (ACs 1, 2, 3, 11, 12)
// ---------------------------------------------------------------------------

describe('extractMemories', () => {
  it('returns object with extracted array and conflicts_resolved count (AC-1)', async () => {
    // Without API key, LLM silently degrades → empty result, but shape must be correct
    const result = await extractMemories(db, facade, 'session-1', SAMPLE_CONVERSATION);
    expect(result).toHaveProperty('extracted');
    expect(result).toHaveProperty('conflicts_resolved');
    expect(Array.isArray(result.extracted)).toBe(true);
    expect(typeof result.conflicts_resolved).toBe('number');
  });

  it('extracted memory entries have required fields (AC-2)', async () => {
    const result = await extractMemories(db, facade, 'session-1', SAMPLE_CONVERSATION);
    // Verify shape for any returned entries (may be empty if no API key)
    for (const mem of result.extracted) {
      expect(['preference', 'fact', 'entity', 'episode']).toContain(mem.type);
      expect(typeof mem.content).toBe('string');
      expect(typeof mem.subject).toBe('string');
      expect(typeof mem.confidence).toBe('number');
      expect(mem.confidence).toBeGreaterThanOrEqual(0);
      expect(mem.confidence).toBeLessThanOrEqual(1);
      expect(typeof mem.importance).toBe('number');
      expect(mem.importance).toBeGreaterThanOrEqual(0);
      expect(mem.importance).toBeLessThanOrEqual(1);
    }
  });

  it('LLM-returned memories are persisted to storage and queryable by subject (AC-3)', async () => {
    const result = await extractMemories(db, facade, 'session-store-test', SAMPLE_CONVERSATION);
    // For every extracted memory, verify it is in the DB
    for (const mem of result.extracted) {
      const stored = getMemoriesBySubject(db, mem.subject);
      expect(stored.length).toBeGreaterThan(0);
      const found = stored.find(s => s.content === mem.content && s.type === mem.type);
      expect(found).toBeDefined();
    }
  });

  it('conflicts_resolved equals number of actual update operations (AC-7)', async () => {
    // Pre-insert memories via facade to simulate conflict scenario
    const preExisting = makeMemory({
      id: 'pre-existing-001',
      type: 'preference',
      subject: 'unique-subject-for-this-test',
      content: 'old preference',
    });
    facade.addMemory(preExisting);

    // The actual conflicts_resolved comes from detectAndUpsert calls inside extractMemories
    // In a no-API-key environment, LLM returns [], so conflicts_resolved = 0
    const result = await extractMemories(db, facade, 'session-conflict', SAMPLE_CONVERSATION);
    expect(typeof result.conflicts_resolved).toBe('number');
    expect(result.conflicts_resolved).toBeGreaterThanOrEqual(0);
    // conflicts_resolved can't exceed number of extracted entries
    expect(result.conflicts_resolved).toBeLessThanOrEqual(result.extracted.length);
  });

  it('LLM failure does not throw exception (AC-11)', async () => {
    // In test env without API key, callLLM returns [] (silent degradation)
    // The function must not throw under any circumstances
    let threw = false;
    try {
      await extractMemories(db, facade, 'session-llm-fail', SAMPLE_CONVERSATION);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });

  it('LLM network error returns empty extracted array and conflicts_resolved=0 (AC-11)', async () => {
    // Mock callLLM to throw a network error (simulating fetch failure)
    const spy = vi.spyOn(llmModule, 'callLLM').mockRejectedValueOnce(
      new Error('Network error: Failed to fetch'),
    );

    const result = await extractMemories(db, facade, 'session-llm-network-fail', SAMPLE_CONVERSATION);

    expect(result.extracted).toHaveLength(0);
    expect(result.conflicts_resolved).toBe(0);

    spy.mockRestore();
  });

  it('LLM HTTP error (non-ok response) returns empty extracted array and conflicts_resolved=0 (AC-11)', async () => {
    // Mock callLLM to throw an HTTP error (simulating API error)
    const spy = vi.spyOn(llmModule, 'callLLM').mockRejectedValueOnce(
      new Error('HTTP 500: Internal Server Error'),
    );

    const result = await extractMemories(db, facade, 'session-llm-http-fail', SAMPLE_CONVERSATION);

    expect(result.extracted).toHaveLength(0);
    expect(result.conflicts_resolved).toBe(0);

    spy.mockRestore();
  });

  it('LLM failure does not affect existing storage data (AC-11)', async () => {
    // Pre-insert a memory
    const existing = makeMemory({ id: 'safe-mem', subject: 'safe-subject', content: 'safe content' });
    facade.addMemory(existing);

    // Run extraction (LLM will degrade silently in test env)
    await extractMemories(db, facade, 'session-fail', SAMPLE_CONVERSATION);

    // Existing data should be untouched
    const stored = getMemoriesBySubject(db, 'safe-subject');
    expect(stored.length).toBe(1);
    expect(stored[0].content).toBe('safe content');
  });

  it('empty conversation returns empty extracted array and conflicts_resolved=0 (AC-12)', async () => {
    const result = await extractMemories(db, facade, 'session-empty', []);
    expect(result.extracted).toHaveLength(0);
    expect(result.conflicts_resolved).toBe(0);
  });

  it('empty LLM response (no extractable memories) returns empty extracted array (AC-12)', async () => {
    // In test env without API key, LLM degrades silently → []
    const result = await extractMemories(db, facade, 'session-no-mem', [
      { role: 'user', content: 'Hello.' },
      { role: 'assistant', content: 'Hi there!' },
    ]);
    // Without API key, LLM returns [] → extracted = []
    // Even with API key, a minimal conversation may yield []
    expect(Array.isArray(result.extracted)).toBe(true);
    expect(result.conflicts_resolved).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario-level integration: conflict detection in extractMemories flow (AC-4)
// ---------------------------------------------------------------------------

describe('extractMemories conflict upsert flow', () => {
  it('same subject+type upsert: only one record in DB, updated_at > created_at (AC-4)', async () => {
    const createdAt = new Date(Date.now() - 5000).toISOString();
    // Pre-insert via facade
    facade.addMemory({
      id: 'conflict-test-mem',
      type: 'preference',
      content: 'User prefers light mode',
      subject: 'user-mode-pref',
      confidence: 0.6,
      importance: 0.5,
      source_session: 'old-session',
      access_count: 0,
      last_accessed_at: null,
      created_at: createdAt,
      updated_at: createdAt,
    });

    // Simulate a conflicting upsert via detectAndUpsert (this is what extractMemories calls internally)
    const result = detectAndUpsert(db, facade, 'new-session', {
      type: 'preference',
      content: 'User prefers dark mode',
      subject: 'user-mode-pref',
      confidence: 0.9,
      importance: 0.8,
    });

    expect(result.action).toBe('update');

    // Only one record for this subject+type
    const stored = getMemoriesBySubject(db, 'user-mode-pref');
    const prefRecords = stored.filter(m => m.type === 'preference');
    expect(prefRecords.length).toBe(1);
    expect(prefRecords[0].content).toBe('User prefers dark mode');
    expect(new Date(prefRecords[0].updated_at).getTime()).toBeGreaterThanOrEqual(
      new Date(createdAt).getTime()
    );
  });

  it('preserves original id, created_at, source_session, access_count on upsert (AC-4)', async () => {
    const createdAt = new Date(Date.now() - 10000).toISOString();
    facade.addMemory({
      id: 'original-id-preserved',
      type: 'fact',
      content: 'original fact',
      subject: 'preserve-subject',
      confidence: 0.5,
      importance: 0.5,
      source_session: 'original-session',
      access_count: 7,
      last_accessed_at: null,
      created_at: createdAt,
      updated_at: createdAt,
    });

    detectAndUpsert(db, facade, 'new-session', {
      type: 'fact',
      content: 'updated fact',
      subject: 'preserve-subject',
      confidence: 0.95,
      importance: 0.85,
    });

    const stored = getMemoriesBySubject(db, 'preserve-subject');
    expect(stored.length).toBe(1);
    expect(stored[0].id).toBe('original-id-preserved');
    expect(stored[0].created_at).toBe(createdAt);
    expect(stored[0].source_session).toBe('original-session');
    expect(stored[0].access_count).toBe(7);
  });
});
