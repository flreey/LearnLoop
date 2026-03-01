import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

export type DB = InstanceType<typeof Database>;

const MEMORIES_DDL = `
CREATE TABLE IF NOT EXISTS memories (
  id              TEXT PRIMARY KEY NOT NULL,
  type            TEXT NOT NULL,
  content         TEXT NOT NULL,
  subject         TEXT NOT NULL,
  confidence      REAL NOT NULL DEFAULT 0.5,
  importance      REAL NOT NULL DEFAULT 0.5,
  source_session  TEXT NOT NULL,
  access_count    INTEGER NOT NULL DEFAULT 0,
  last_accessed_at TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
)`;

const REFLECTIONS_DDL = `
CREATE TABLE IF NOT EXISTS reflections (
  id            TEXT PRIMARY KEY NOT NULL,
  task_type     TEXT NOT NULL,
  task_summary  TEXT NOT NULL,
  outcome       TEXT NOT NULL,
  signals       TEXT NOT NULL,
  reflection    TEXT NOT NULL,
  lessons       TEXT NOT NULL,
  agent_id      TEXT,
  source_session TEXT,
  created_at    TEXT NOT NULL
)`;

const SESSION_STATES_DDL = `
CREATE TABLE IF NOT EXISTS session_states (
  session_key       TEXT PRIMARY KEY NOT NULL,
  extracted         INTEGER NOT NULL DEFAULT 0,
  conversation_hash TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
)`;

const MEMORY_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_memories_subject ON memories (subject)',
  'CREATE INDEX IF NOT EXISTS idx_memories_type ON memories (type)',
  'CREATE INDEX IF NOT EXISTS idx_memories_subject_type ON memories (subject, type)',
  'CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories (importance)',
  'CREATE INDEX IF NOT EXISTS idx_memories_updated_at ON memories (updated_at)',
];

const REFLECTION_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_reflections_task_type ON reflections (task_type)',
  'CREATE INDEX IF NOT EXISTS idx_reflections_agent_id ON reflections (agent_id)',
  'CREATE INDEX IF NOT EXISTS idx_reflections_outcome ON reflections (outcome)',
  'CREATE INDEX IF NOT EXISTS idx_reflections_created_at ON reflections (created_at)',
];

const SESSION_STATE_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_session_states_extracted ON session_states (extracted)',
];

/**
 * Initialize (or open) the SQLite database at the given path.
 * The directory is created recursively if it does not exist.
 * All tables and indexes are created via IF NOT EXISTS DDL.
 */
export function initializeDatabase(dbPath: string): DB {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath);

  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL');

  db.exec(MEMORIES_DDL);
  db.exec(REFLECTIONS_DDL);
  db.exec(SESSION_STATES_DDL);

  for (const idx of MEMORY_INDEXES) {
    db.exec(idx);
  }
  for (const idx of REFLECTION_INDEXES) {
    db.exec(idx);
  }
  for (const idx of SESSION_STATE_INDEXES) {
    db.exec(idx);
  }

  return db;
}
