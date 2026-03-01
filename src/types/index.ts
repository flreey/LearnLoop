// Shared TypeScript type definitions

export type MemoryType = 'preference' | 'fact' | 'entity' | 'episode';
export type OutcomeType = 'success' | 'failure' | 'partial';

export interface MemoryEntry {
  id: string;
  type: MemoryType;
  content: string;
  subject: string;
  confidence: number;
  importance: number;
  source_session: string;
  access_count: number;
  last_accessed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScoredMemoryEntry extends MemoryEntry {
  score: number;
}

export interface ReflectionEntry {
  id: string;
  task_type: string;
  task_summary: string;
  outcome: OutcomeType;
  signals: string;
  reflection: string;
  lessons: string;
  agent_id: string | null;
  source_session: string | null;
  created_at: string;
}

export interface ScoredReflectionEntry extends ReflectionEntry {
  score: number;
}

/**
 * Reflection entry as returned by the beforeSpawn hook injection result.
 * `lessons` is parsed from JSON string into a string array for consumer convenience.
 */
export interface InjectedReflectionEntry extends Omit<ScoredReflectionEntry, 'lessons'> {
  lessons: string[];
}

export interface SessionState {
  session_key: string;
  extracted: number;
  conversation_hash: string | null;
  created_at: string;
  updated_at: string;
}

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface TaskSignals {
  user_feedback: string | null;
  review_result: string | null;
  was_respawned: boolean;
  timed_out: boolean;
}

export interface RetrievalWeights {
  recency: number;
  relevance: number;
  importance: number;
}
