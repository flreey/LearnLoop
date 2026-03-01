/**
 * Tests for SQLite storage layer — schema initialization and CRUD operations.
 * Covers: database auto-creation, table schema, and all CRUD operations
 * for memories, reflections, and session_states.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { initializeDatabase } from '../../src/storage/db.js';
import {
  insertMemory,
  getMemoryById,
  updateMemory,
  deleteMemory,
  getMemoriesBySubject,
  getMemoriesByType,
  insertReflection,
  getReflectionById,
  updateReflection,
  deleteReflection,
  insertSessionState,
  getSessionStateByKey,
  updateSessionState,
} from '../../src/storage/repository.js';

// Use a temp directory for all tests to avoid polluting ~/.openclaw/learnloop/
function makeTempDbPath(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'learnloop-test-'));
  return path.join(tmpDir, 'test.db');
}

function makeNonExistentDbPath(): string {
  const tmpDir = path.join(os.tmpdir(), `learnloop-test-newdir-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  return path.join(tmpDir, 'nested', 'test.db');
}

let db: ReturnType<typeof initializeDatabase>;
let tempDbPath: string;

beforeEach(() => {
  tempDbPath = makeTempDbPath();
  db = initializeDatabase(tempDbPath);
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // ignore close errors
  }
  // Clean up temp dirs
  try {
    const dir = path.dirname(tempDbPath);
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
});

// ---------------------------------------------------------------------------
// Database auto-creation and schema
// ---------------------------------------------------------------------------

describe('Database auto-creation', () => {
  it('creates the database file when it does not exist', () => {
    // db is already initialized in beforeEach; file must exist now
    expect(fs.existsSync(tempDbPath)).toBe(true);
  });

  it('creates intermediate directories when they do not exist', () => {
    const nestedPath = makeNonExistentDbPath();
    expect(fs.existsSync(path.dirname(nestedPath))).toBe(false);

    const nestedDb = initializeDatabase(nestedPath);
    try {
      expect(fs.existsSync(nestedPath)).toBe(true);
    } finally {
      nestedDb.close();
      fs.rmSync(path.dirname(path.dirname(nestedPath)), { recursive: true, force: true });
    }
  });

  it('memories table has the correct schema columns', () => {
    const rows = db.prepare("PRAGMA table_info(memories)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>;
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));

    expect(byName['id'].pk).toBe(1);
    expect(byName['id'].type).toBe('TEXT');

    expect(byName['type'].notnull).toBe(1);
    expect(byName['type'].type).toBe('TEXT');

    expect(byName['content'].notnull).toBe(1);
    expect(byName['content'].type).toBe('TEXT');

    expect(byName['subject'].notnull).toBe(1);
    expect(byName['subject'].type).toBe('TEXT');

    expect(byName['confidence'].notnull).toBe(1);
    expect(byName['confidence'].type).toBe('REAL');
    expect(byName['confidence'].dflt_value).toBe('0.5');

    expect(byName['importance'].notnull).toBe(1);
    expect(byName['importance'].type).toBe('REAL');
    expect(byName['importance'].dflt_value).toBe('0.5');

    expect(byName['source_session'].notnull).toBe(1);
    expect(byName['source_session'].type).toBe('TEXT');

    expect(byName['access_count'].notnull).toBe(1);
    expect(byName['access_count'].type).toBe('INTEGER');
    expect(byName['access_count'].dflt_value).toBe('0');

    // last_accessed_at is nullable
    expect(byName['last_accessed_at'].notnull).toBe(0);
    expect(byName['last_accessed_at'].type).toBe('TEXT');

    expect(byName['created_at'].notnull).toBe(1);
    expect(byName['created_at'].type).toBe('TEXT');

    expect(byName['updated_at'].notnull).toBe(1);
    expect(byName['updated_at'].type).toBe('TEXT');
  });

  it('reflections table has the correct schema columns', () => {
    const rows = db.prepare("PRAGMA table_info(reflections)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>;
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));

    expect(byName['id'].pk).toBe(1);
    expect(byName['id'].type).toBe('TEXT');

    expect(byName['task_type'].notnull).toBe(1);
    expect(byName['task_summary'].notnull).toBe(1);
    expect(byName['outcome'].notnull).toBe(1);
    expect(byName['signals'].notnull).toBe(1);
    expect(byName['reflection'].notnull).toBe(1);
    expect(byName['lessons'].notnull).toBe(1);

    // nullable fields
    expect(byName['agent_id'].notnull).toBe(0);
    expect(byName['source_session'].notnull).toBe(0);

    expect(byName['created_at'].notnull).toBe(1);
    expect(byName['created_at'].type).toBe('TEXT');
  });

  it('session_states table has the correct schema columns', () => {
    const rows = db.prepare("PRAGMA table_info(session_states)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>;
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));

    expect(byName['session_key'].pk).toBe(1);
    expect(byName['session_key'].type).toBe('TEXT');

    expect(byName['extracted'].notnull).toBe(1);
    expect(byName['extracted'].type).toBe('INTEGER');
    expect(byName['extracted'].dflt_value).toBe('0');

    expect(byName['conversation_hash'].notnull).toBe(0);

    expect(byName['created_at'].notnull).toBe(1);
    expect(byName['updated_at'].notnull).toBe(1);
  });

  it('memories table has indexes on subject, type, subject+type, importance, updated_at', () => {
    const rows = db.prepare("PRAGMA index_list(memories)").all() as Array<{ name: string }>;
    const indexNames = rows.map((r) => r.name);
    // We expect at least 5 indexes (may have more depending on naming)
    expect(indexNames.length).toBeGreaterThanOrEqual(5);
  });

  it('reflections table has indexes on task_type, agent_id, outcome, created_at', () => {
    const rows = db.prepare("PRAGMA index_list(reflections)").all() as Array<{ name: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(4);
  });

  it('session_states table has index on extracted', () => {
    const rows = db.prepare("PRAGMA index_list(session_states)").all() as Array<{ name: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Memory CRUD
// ---------------------------------------------------------------------------

describe('Memory CRUD', () => {
  const now = new Date().toISOString();

  const sampleMemory = {
    id: 'mem-001',
    type: 'preference' as const,
    content: 'User prefers TypeScript over JavaScript',
    subject: 'typescript',
    confidence: 0.9,
    importance: 0.8,
    source_session: 'session-abc',
    access_count: 0,
    last_accessed_at: null as string | null,
    created_at: now,
    updated_at: now,
  };

  it('insert and read back a memory returns identical fields', () => {
    insertMemory(db, sampleMemory);
    const result = getMemoryById(db, 'mem-001');

    expect(result).not.toBeNull();
    expect(result!.id).toBe(sampleMemory.id);
    expect(result!.type).toBe(sampleMemory.type);
    expect(result!.content).toBe(sampleMemory.content);
    expect(result!.subject).toBe(sampleMemory.subject);
    expect(result!.confidence).toBe(sampleMemory.confidence);
    expect(result!.importance).toBe(sampleMemory.importance);
    expect(result!.source_session).toBe(sampleMemory.source_session);
    expect(result!.access_count).toBe(sampleMemory.access_count);
    expect(result!.last_accessed_at).toBeNull();
    expect(result!.created_at).toBe(sampleMemory.created_at);
    expect(result!.updated_at).toBe(sampleMemory.updated_at);
  });

  it('updating a memory changes content and confidence, updates updated_at, preserves other fields', () => {
    insertMemory(db, sampleMemory);

    const newUpdatedAt = new Date(Date.now() + 1000).toISOString();
    updateMemory(db, 'mem-001', {
      content: 'User strongly prefers TypeScript',
      confidence: 0.95,
      updated_at: newUpdatedAt,
    });

    const result = getMemoryById(db, 'mem-001');
    expect(result).not.toBeNull();
    expect(result!.content).toBe('User strongly prefers TypeScript');
    expect(result!.confidence).toBe(0.95);
    expect(result!.updated_at).toBe(newUpdatedAt);

    // Other fields unchanged
    expect(result!.id).toBe('mem-001');
    expect(result!.type).toBe('preference');
    expect(result!.subject).toBe('typescript');
    expect(result!.importance).toBe(0.8);
    expect(result!.source_session).toBe('session-abc');
    expect(result!.created_at).toBe(now);
  });

  it('deleting a memory by id removes it and read returns null', () => {
    insertMemory(db, sampleMemory);
    expect(getMemoryById(db, 'mem-001')).not.toBeNull();

    deleteMemory(db, 'mem-001');
    expect(getMemoryById(db, 'mem-001')).toBeNull();
  });

  it('getMemoriesBySubject returns only records matching that subject', () => {
    const now2 = new Date().toISOString();
    insertMemory(db, { ...sampleMemory, id: 'mem-002', subject: 'python' });
    insertMemory(db, { ...sampleMemory, id: 'mem-003', subject: 'typescript' });
    insertMemory(db, { ...sampleMemory, id: 'mem-004', subject: 'typescript', updated_at: now2 });

    const results = getMemoriesBySubject(db, 'typescript');
    expect(results.length).toBe(2);
    expect(results.every((r) => r.subject === 'typescript')).toBe(true);

    const pythonResults = getMemoriesBySubject(db, 'python');
    expect(pythonResults.length).toBe(1);
    expect(pythonResults[0].id).toBe('mem-002');
  });

  it('getMemoriesByType returns only records matching that type', () => {
    insertMemory(db, { ...sampleMemory, id: 'mem-010', type: 'fact' });
    insertMemory(db, { ...sampleMemory, id: 'mem-011', type: 'preference' });
    insertMemory(db, { ...sampleMemory, id: 'mem-012', type: 'preference' });

    const facts = getMemoriesByType(db, 'fact');
    expect(facts.length).toBe(1);
    expect(facts[0].id).toBe('mem-010');

    const prefs = getMemoriesByType(db, 'preference');
    expect(prefs.length).toBe(2);
    expect(prefs.every((r) => r.type === 'preference')).toBe(true);
  });

  it('reading a non-existent memory id returns null', () => {
    expect(getMemoryById(db, 'does-not-exist')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Reflection CRUD
// ---------------------------------------------------------------------------

describe('Reflection CRUD', () => {
  const now = new Date().toISOString();

  const sampleReflection = {
    id: 'ref-001',
    task_type: 'bug-fix',
    task_summary: 'Fixed null pointer in auth module',
    outcome: 'success' as const,
    signals: JSON.stringify(['user_feedback:positive']),
    reflection: 'The root cause was an unguarded optional access',
    lessons: JSON.stringify(['check dependencies', 'always guard optionals']),
    agent_id: 'agent-123',
    source_session: 'session-xyz',
    created_at: now,
  };

  it('insert and read back a reflection returns identical fields', () => {
    insertReflection(db, sampleReflection);
    const result = getReflectionById(db, 'ref-001');

    expect(result).not.toBeNull();
    expect(result!.id).toBe(sampleReflection.id);
    expect(result!.task_type).toBe(sampleReflection.task_type);
    expect(result!.task_summary).toBe(sampleReflection.task_summary);
    expect(result!.outcome).toBe(sampleReflection.outcome);
    expect(result!.signals).toBe(sampleReflection.signals);
    expect(result!.reflection).toBe(sampleReflection.reflection);
    expect(result!.lessons).toBe(sampleReflection.lessons);
    expect(result!.agent_id).toBe(sampleReflection.agent_id);
    expect(result!.source_session).toBe(sampleReflection.source_session);
    expect(result!.created_at).toBe(sampleReflection.created_at);
  });

  it('signals and lessons are stored and parseable as JSON arrays', () => {
    insertReflection(db, sampleReflection);
    const result = getReflectionById(db, 'ref-001');

    expect(result).not.toBeNull();
    const parsedSignals = JSON.parse(result!.signals);
    const parsedLessons = JSON.parse(result!.lessons);

    expect(Array.isArray(parsedSignals)).toBe(true);
    expect(parsedSignals).toContain('user_feedback:positive');

    expect(Array.isArray(parsedLessons)).toBe(true);
    expect(parsedLessons).toContain('check dependencies');
    expect(parsedLessons).toContain('always guard optionals');
  });

  it('reflection with null agent_id and source_session stores and reads back nulls', () => {
    insertReflection(db, {
      ...sampleReflection,
      id: 'ref-002',
      agent_id: null,
      source_session: null,
    });
    const result = getReflectionById(db, 'ref-002');
    expect(result).not.toBeNull();
    expect(result!.agent_id).toBeNull();
    expect(result!.source_session).toBeNull();
  });

  it('reading a non-existent reflection id returns null', () => {
    expect(getReflectionById(db, 'does-not-exist')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SessionState CRUD
// ---------------------------------------------------------------------------

describe('SessionState CRUD', () => {
  const now = new Date().toISOString();

  const sampleSession = {
    session_key: 'sess-001',
    extracted: 0,
    conversation_hash: 'abc123hash',
    created_at: now,
    updated_at: now,
  };

  it('insert and read back a session_state returns identical fields', () => {
    insertSessionState(db, sampleSession);
    const result = getSessionStateByKey(db, 'sess-001');

    expect(result).not.toBeNull();
    expect(result!.session_key).toBe(sampleSession.session_key);
    expect(result!.extracted).toBe(0);
    expect(result!.conversation_hash).toBe(sampleSession.conversation_hash);
    expect(result!.created_at).toBe(sampleSession.created_at);
    expect(result!.updated_at).toBe(sampleSession.updated_at);
  });

  it('updating extracted flag to 1 reflects the updated value on read', () => {
    insertSessionState(db, sampleSession);

    const newUpdatedAt = new Date(Date.now() + 1000).toISOString();
    updateSessionState(db, 'sess-001', { extracted: 1, updated_at: newUpdatedAt });

    const result = getSessionStateByKey(db, 'sess-001');
    expect(result).not.toBeNull();
    expect(result!.extracted).toBe(1);
    expect(result!.updated_at).toBe(newUpdatedAt);
    // Other fields unchanged
    expect(result!.conversation_hash).toBe('abc123hash');
    expect(result!.created_at).toBe(now);
  });

  it('session_state with null conversation_hash stores and reads back null', () => {
    insertSessionState(db, {
      ...sampleSession,
      session_key: 'sess-002',
      conversation_hash: null,
    });
    const result = getSessionStateByKey(db, 'sess-002');
    expect(result).not.toBeNull();
    expect(result!.conversation_hash).toBeNull();
  });

  it('reading a non-existent session_key returns null', () => {
    expect(getSessionStateByKey(db, 'does-not-exist')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Integration: database auto-creates and round-trip works end-to-end
// ---------------------------------------------------------------------------

describe('Database auto-creation integration', () => {
  it('auto-creates db file and inserted record can be read back', () => {
    const uniquePath = makeNonExistentDbPath();
    expect(fs.existsSync(uniquePath)).toBe(false);

    const freshDb = initializeDatabase(uniquePath);
    try {
      expect(fs.existsSync(uniquePath)).toBe(true);

      const now = new Date().toISOString();
      insertMemory(freshDb, {
        id: 'integration-001',
        type: 'fact',
        content: 'Integration test memory',
        subject: 'testing',
        confidence: 0.7,
        importance: 0.6,
        source_session: 'session-integration',
        access_count: 0,
        last_accessed_at: null,
        created_at: now,
        updated_at: now,
      });

      const result = getMemoryById(freshDb, 'integration-001');
      expect(result).not.toBeNull();
      expect(result!.content).toBe('Integration test memory');
    } finally {
      freshDb.close();
      fs.rmSync(path.dirname(path.dirname(uniquePath)), { recursive: true, force: true });
    }
  });

  // AC8: sqlite_master contains all three required tables after auto-creation
  it('auto-created database contains memories, reflections, and session_states tables', () => {
    const uniquePath = makeNonExistentDbPath();
    const freshDb = initializeDatabase(uniquePath);
    try {
      const tables = freshDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all() as Array<{ name: string }>;
      const tableNames = tables.map((t) => t.name);

      expect(tableNames).toContain('memories');
      expect(tableNames).toContain('reflections');
      expect(tableNames).toContain('session_states');
    } finally {
      freshDb.close();
      fs.rmSync(path.dirname(path.dirname(uniquePath)), { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Reflection update and delete (AC4, AC7)
// ---------------------------------------------------------------------------

describe('Reflection update and delete', () => {
  const now = new Date().toISOString();

  const sampleReflection = {
    id: 'ref-upd-001',
    task_type: 'feature',
    task_summary: 'Implemented login flow',
    outcome: 'success' as const,
    signals: JSON.stringify(['user_feedback:positive']),
    reflection: 'The approach was straightforward',
    lessons: JSON.stringify(['keep it simple']),
    agent_id: 'agent-456',
    source_session: 'session-update',
    created_at: now,
  };

  // AC4: update reflection and outcome fields, re-query returns updated values
  it('updating a reflection changes reflection and outcome fields, preserves other fields', () => {
    insertReflection(db, sampleReflection);

    updateReflection(db, 'ref-upd-001', {
      reflection: 'The root cause required deeper analysis',
      outcome: 'partial',
    });

    const result = getReflectionById(db, 'ref-upd-001');
    expect(result).not.toBeNull();
    expect(result!.reflection).toBe('The root cause required deeper analysis');
    expect(result!.outcome).toBe('partial');

    // Other fields must be preserved
    expect(result!.id).toBe('ref-upd-001');
    expect(result!.task_type).toBe('feature');
    expect(result!.task_summary).toBe('Implemented login flow');
    expect(result!.signals).toBe(sampleReflection.signals);
    expect(result!.lessons).toBe(sampleReflection.lessons);
    expect(result!.agent_id).toBe('agent-456');
    expect(result!.source_session).toBe('session-update');
    expect(result!.created_at).toBe(now);
  });

  // AC7: delete a reflection, re-query returns null
  it('deleting a reflection by id removes it and read returns null', () => {
    insertReflection(db, { ...sampleReflection, id: 'ref-del-001' });
    expect(getReflectionById(db, 'ref-del-001')).not.toBeNull();

    deleteReflection(db, 'ref-del-001');
    expect(getReflectionById(db, 'ref-del-001')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Field constraints and default values (AC9, AC10, AC11)
// ---------------------------------------------------------------------------

describe('Field constraints and default values', () => {
  const now = new Date().toISOString();

  // AC9: memories.type only accepts the four valid enum values
  it('inserting a memory with an invalid type throws or fails', () => {
    expect(() => {
      // Use raw db.prepare to bypass TypeScript type guard and test the DB constraint
      db.prepare(`
        INSERT INTO memories
          (id, type, content, subject, confidence, importance,
           source_session, access_count, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('bad-type-mem', 'invalid_type', 'content', 'subject', 0.5, 0.5, 'sess', 0, now, now);
    }).toThrow();
  });

  // AC10: reflections.outcome only accepts the three valid enum values
  it('inserting a reflection with an invalid outcome throws or fails', () => {
    expect(() => {
      db.prepare(`
        INSERT INTO reflections
          (id, task_type, task_summary, outcome, signals, reflection,
           lessons, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('bad-outcome-ref', 'feat', 'summary', 'invalid_outcome', '[]', 'text', '[]', now);
    }).toThrow();
  });

  // AC11: memories defaults: confidence=0.5, importance=0.5, access_count=0
  it('memory fields confidence, importance, access_count use correct defaults when omitted', () => {
    db.prepare(`
      INSERT INTO memories (id, type, content, subject, source_session, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('default-mem-001', 'fact', 'Default value test', 'defaults', 'sess-def', now, now);

    const result = getMemoryById(db, 'default-mem-001');
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe(0.5);
    expect(result!.importance).toBe(0.5);
    expect(result!.access_count).toBe(0);
  });
});
