// BM25 search engine wrapper (minisearch integration)

import MiniSearch from 'minisearch';
import type { DB } from '../storage/db.js';
import type { MemoryEntry, ReflectionEntry } from '../types/index.js';

// ---------------------------------------------------------------------------
// CJK tokenizer
// ---------------------------------------------------------------------------

/**
 * Tokenize text supporting both Latin (word-boundary split) and CJK
 * (character-level split). CJK characters are split individually so that
 * MiniSearch can index and search them without a dictionary.
 *
 * Strategy: split on whitespace/punctuation for Latin text; for each resulting
 * token, if it contains CJK codepoints, further split into individual chars.
 */
function cjkTokenize(text: string): string[] {
  const tokens: string[] = [];
  // Split on whitespace and common punctuation first
  const parts = text.split(/[\s\p{P}]+/u).filter(Boolean);
  for (const part of parts) {
    if (/[\u3000-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF\u4E00-\u9FFF]/u.test(part)) {
      // Contains CJK — split into individual characters
      for (const ch of part) {
        if (ch.trim()) tokens.push(ch);
      }
    } else {
      tokens.push(part);
    }
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Document types for MiniSearch
// ---------------------------------------------------------------------------

interface MemoryDoc {
  id: string;
  content: string;
  subject: string;
}

interface ReflectionDoc {
  id: string;
  task_type: string;
  task_summary: string;
  reflection: string;
}

// ---------------------------------------------------------------------------
// Search result type
// ---------------------------------------------------------------------------

export interface SearchResult {
  id: string;
  score: number;
}

// ---------------------------------------------------------------------------
// SearchEngine class
// ---------------------------------------------------------------------------

export class SearchEngine {
  private memoryIndex: MiniSearch<MemoryDoc>;
  private reflectionIndex: MiniSearch<ReflectionDoc>;

  constructor() {
    this.memoryIndex = new MiniSearch<MemoryDoc>({
      idField: 'id',
      fields: ['content', 'subject'],
      storeFields: [],
      tokenize: cjkTokenize,
      searchOptions: {
        boost: { content: 2, subject: 1 },
        fuzzy: 0.2,
        prefix: true,
      },
    });

    this.reflectionIndex = new MiniSearch<ReflectionDoc>({
      idField: 'id',
      fields: ['task_type', 'task_summary', 'reflection'],
      storeFields: [],
      tokenize: cjkTokenize,
      searchOptions: {
        boost: { task_type: 3, task_summary: 2, reflection: 1 },
        fuzzy: 0.2,
        prefix: true,
      },
    });
  }

  // -------------------------------------------------------------------------
  // Memory index operations
  // -------------------------------------------------------------------------

  addMemory(memory: MemoryEntry): void {
    const doc: MemoryDoc = {
      id: memory.id,
      content: memory.content,
      subject: memory.subject,
    };
    this.memoryIndex.add(doc);
  }

  addAllMemories(memories: MemoryEntry[]): void {
    const docs: MemoryDoc[] = memories.map(m => ({
      id: m.id,
      content: m.content,
      subject: m.subject,
    }));
    this.memoryIndex.addAll(docs);
  }

  updateMemory(memory: MemoryEntry): void {
    const doc: MemoryDoc = {
      id: memory.id,
      content: memory.content,
      subject: memory.subject,
    };
    this.memoryIndex.replace(doc);
  }

  removeMemory(id: string): void {
    this.memoryIndex.discard(id);
  }

  searchMemories(query: string): SearchResult[] {
    try {
      const raw = this.memoryIndex.search(query);
      return raw.map(r => ({ id: String(r.id), score: r.score }));
    } catch {
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // Reflection index operations
  // -------------------------------------------------------------------------

  addReflection(reflection: ReflectionEntry): void {
    const doc: ReflectionDoc = {
      id: reflection.id,
      task_type: reflection.task_type,
      task_summary: reflection.task_summary,
      reflection: reflection.reflection,
    };
    this.reflectionIndex.add(doc);
  }

  addAllReflections(reflections: ReflectionEntry[]): void {
    const docs: ReflectionDoc[] = reflections.map(r => ({
      id: r.id,
      task_type: r.task_type,
      task_summary: r.task_summary,
      reflection: r.reflection,
    }));
    this.reflectionIndex.addAll(docs);
  }

  updateReflection(reflection: ReflectionEntry): void {
    const doc: ReflectionDoc = {
      id: reflection.id,
      task_type: reflection.task_type,
      task_summary: reflection.task_summary,
      reflection: reflection.reflection,
    };
    this.reflectionIndex.replace(doc);
  }

  removeReflection(id: string): void {
    this.reflectionIndex.discard(id);
  }

  searchReflections(query: string): SearchResult[] {
    try {
      const raw = this.reflectionIndex.search(query);
      return raw.map(r => ({ id: String(r.id), score: r.score }));
    } catch {
      return [];
    }
  }
}

// ---------------------------------------------------------------------------
// Factory: createSearchEngine — rebuilds index from DB on initialization (AC10)
// ---------------------------------------------------------------------------

/**
 * Create a SearchEngine and populate its indexes from the current database
 * contents. This implements AC10: the index is rebuilt from DB on init.
 */
export function createSearchEngine(db: DB): SearchEngine {
  const engine = new SearchEngine();

  // Load all memories from DB
  const memories = db.prepare('SELECT id, content, subject FROM memories').all() as Array<{
    id: string;
    content: string;
    subject: string;
  }>;
  if (memories.length > 0) {
    engine.addAllMemories(
      memories.map(m => ({
        id: m.id,
        content: m.content,
        subject: m.subject,
        // Provide minimal required MemoryEntry fields (unused by search index)
        type: 'fact' as const,
        confidence: 0,
        importance: 0,
        source_session: '',
        access_count: 0,
        last_accessed_at: null,
        created_at: '',
        updated_at: '',
      })),
    );
  }

  // Load all reflections from DB
  const reflections = db
    .prepare('SELECT id, task_type, task_summary, reflection FROM reflections')
    .all() as Array<{
    id: string;
    task_type: string;
    task_summary: string;
    reflection: string;
  }>;
  if (reflections.length > 0) {
    engine.addAllReflections(
      reflections.map(r => ({
        id: r.id,
        task_type: r.task_type,
        task_summary: r.task_summary,
        reflection: r.reflection,
        // Minimal required ReflectionEntry fields (unused by search index)
        outcome: 'success' as const,
        signals: '[]',
        lessons: '[]',
        agent_id: null,
        source_session: null,
        created_at: '',
      })),
    );
  }

  return engine;
}
