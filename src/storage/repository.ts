import type { DB } from './db.js';
import type { MemoryEntry, ReflectionEntry, SessionState } from '../types/index.js';

// ---------------------------------------------------------------------------
// Memory CRUD
// ---------------------------------------------------------------------------

export function insertMemory(db: DB, memory: MemoryEntry): void {
  db.prepare(`
    INSERT INTO memories
      (id, type, content, subject, confidence, importance,
       source_session, access_count, last_accessed_at, created_at, updated_at)
    VALUES
      (@id, @type, @content, @subject, @confidence, @importance,
       @source_session, @access_count, @last_accessed_at, @created_at, @updated_at)
  `).run(memory);
}

export function getMemoryById(db: DB, id: string): MemoryEntry | null {
  const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryEntry | undefined;
  return row ?? null;
}

export function updateMemory(
  db: DB,
  id: string,
  fields: Partial<Omit<MemoryEntry, 'id'>>,
): void {
  const entries = Object.entries(fields);
  if (entries.length === 0) return;

  const setClauses = entries.map(([key]) => `${key} = @${key}`).join(', ');
  db.prepare(`UPDATE memories SET ${setClauses} WHERE id = @id`).run({ ...fields, id });
}

export function deleteMemory(db: DB, id: string): void {
  db.prepare('DELETE FROM memories WHERE id = ?').run(id);
}

export function getMemoriesBySubject(db: DB, subject: string): MemoryEntry[] {
  return db.prepare('SELECT * FROM memories WHERE subject = ?').all(subject) as MemoryEntry[];
}

export function getMemoriesByType(db: DB, type: string): MemoryEntry[] {
  return db.prepare('SELECT * FROM memories WHERE type = ?').all(type) as MemoryEntry[];
}

// ---------------------------------------------------------------------------
// Reflection CRUD
// ---------------------------------------------------------------------------

export function insertReflection(db: DB, reflection: ReflectionEntry): void {
  db.prepare(`
    INSERT INTO reflections
      (id, task_type, task_summary, outcome, signals, reflection,
       lessons, agent_id, source_session, created_at)
    VALUES
      (@id, @task_type, @task_summary, @outcome, @signals, @reflection,
       @lessons, @agent_id, @source_session, @created_at)
  `).run(reflection);
}

export function getReflectionById(db: DB, id: string): ReflectionEntry | null {
  const row = db
    .prepare('SELECT * FROM reflections WHERE id = ?')
    .get(id) as ReflectionEntry | undefined;
  return row ?? null;
}

// ---------------------------------------------------------------------------
// SessionState CRUD
// ---------------------------------------------------------------------------

export function insertSessionState(db: DB, state: SessionState): void {
  db.prepare(`
    INSERT INTO session_states
      (session_key, extracted, conversation_hash, created_at, updated_at)
    VALUES
      (@session_key, @extracted, @conversation_hash, @created_at, @updated_at)
  `).run(state);
}

export function getSessionStateByKey(db: DB, sessionKey: string): SessionState | null {
  const row = db
    .prepare('SELECT * FROM session_states WHERE session_key = ?')
    .get(sessionKey) as SessionState | undefined;
  return row ?? null;
}

export function updateSessionState(
  db: DB,
  sessionKey: string,
  fields: Partial<Omit<SessionState, 'session_key'>>,
): void {
  const entries = Object.entries(fields);
  if (entries.length === 0) return;

  const setClauses = entries.map(([key]) => `${key} = @${key}`).join(', ');
  db
    .prepare(`UPDATE session_states SET ${setClauses} WHERE session_key = @session_key`)
    .run({ ...fields, session_key: sessionKey });
}
