/**
 * BDD Verification: TASK-BE-1.1
 * Scenarios for memory extraction, conflict detection, silent degradation, and lazy extraction.
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
  lazyExtractionCheck,
} from '../../src/memory/index.js';
import * as llmModule from '../../src/llm/index.js';
import type { DB } from '../../src/storage/db.js';
import type { MemoryEntry, Message } from '../../src/types/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDbPath(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'learnloop-bdd-test-'));
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
  vi.restoreAllMocks();
  try { db.close(); } catch { /* ignore */ }
  try {
    fs.rmSync(path.dirname(tempDbPath), { recursive: true, force: true });
  } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Scenario 1: 成功从对话历史提取记忆并持久化
// ---------------------------------------------------------------------------

describe('Scenario 1: 成功从对话历史提取记忆并持久化', () => {
  it('extracted 数组长度 > 0 且存储中可查询到对应 subject 的记忆', async () => {
    // GIVEN: 存储中无任何记忆条目
    const initialMemories = db.prepare('SELECT COUNT(*) as cnt FROM memories').get() as { cnt: number };
    expect(initialMemories.cnt).toBe(0);

    // AND: 存在一段包含用户偏好信息的对话历史
    const conversationHistory: Message[] = SAMPLE_CONVERSATION;

    // Mock LLM to return a real memory response
    vi.spyOn(llmModule, 'callLLM').mockResolvedValueOnce([
      {
        type: 'preference',
        content: 'User prefers dark mode for coding',
        subject: 'user-editor-theme',
        confidence: 0.9,
        importance: 0.8,
      },
      {
        type: 'fact',
        content: 'User is a software engineer named Alice',
        subject: 'user-identity',
        confidence: 0.95,
        importance: 0.9,
      },
    ]);

    // WHEN: 调用 extractMemories 传入该对话历史
    const result = await extractMemories(db, facade, 'session-bdd-1', conversationHistory);

    // THEN: 返回的 extracted 数组长度 > 0
    expect(result.extracted.length).toBeGreaterThan(0);

    // AND: 存储中可查询到对应 subject 的记忆条目
    for (const mem of result.extracted) {
      const stored = getMemoriesBySubject(db, mem.subject);
      expect(stored.length).toBeGreaterThan(0);
      const found = stored.find(s => s.subject === mem.subject && s.type === mem.type);
      expect(found).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: 冲突记忆触发更新而非重复插入
// ---------------------------------------------------------------------------

describe('Scenario 2: 冲突记忆触发更新而非重复插入', () => {
  it('同 subject+type 的记忆被更新，而非新增，且 updated_at 晚于 created_at', async () => {
    // GIVEN: 存储中已有 subject='user-lang' type='preference' 的记忆，content 为旧值
    const oldCreatedAt = new Date(Date.now() - 5000).toISOString();
    const oldMemory = makeMemory({
      id: 'bdd-conflict-mem-001',
      type: 'preference',
      content: 'User prefers Python',
      subject: 'user-lang',
      confidence: 0.6,
      importance: 0.5,
      source_session: 'old-session',
      created_at: oldCreatedAt,
      updated_at: oldCreatedAt,
    });
    facade.addMemory(oldMemory);

    // Verify pre-condition: one record in storage
    const beforeExtract = getMemoriesBySubject(db, 'user-lang');
    expect(beforeExtract.length).toBe(1);
    expect(beforeExtract[0].content).toBe('User prefers Python');

    // WHEN: extractMemories 提取出同 subject 同 type 但不同 content 的记忆
    vi.spyOn(llmModule, 'callLLM').mockResolvedValueOnce([
      {
        type: 'preference',  // same type
        content: 'User prefers TypeScript',  // different content (new value)
        subject: 'user-lang',  // same subject
        confidence: 0.9,
        importance: 0.85,
      },
    ]);

    await extractMemories(db, facade, 'session-bdd-2', SAMPLE_CONVERSATION);

    // THEN: 存储中 subject='user-lang' type='preference' 的记忆仅有一条
    const afterExtract = getMemoriesBySubject(db, 'user-lang');
    const prefRecords = afterExtract.filter(m => m.type === 'preference');
    expect(prefRecords.length).toBe(1);

    // AND: 该记忆的 content 为新值
    expect(prefRecords[0].content).toBe('User prefers TypeScript');

    // AND: 该记忆的 updated_at 晚于 created_at
    const updatedAtMs = new Date(prefRecords[0].updated_at).getTime();
    const createdAtMs = new Date(prefRecords[0].created_at).getTime();
    expect(updatedAtMs).toBeGreaterThanOrEqual(createdAtMs);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: LLM 调用失败时静默降级
// ---------------------------------------------------------------------------

describe('Scenario 3: LLM 调用失败时静默降级', () => {
  it('LLM 不可用时返回空 extracted 数组，不抛出异常，已有存储数据不受影响', async () => {
    // GIVEN: 存储中已有记忆（确保已有数据不受影响）
    const existingMemory = makeMemory({
      id: 'bdd-safe-mem-001',
      subject: 'bdd-safe-subject',
      content: 'safe existing content',
      type: 'fact',
    });
    facade.addMemory(existingMemory);

    // GIVEN: LLM 服务不可用 (simulate network/service failure)
    vi.spyOn(llmModule, 'callLLM').mockRejectedValueOnce(
      new Error('LLM service unavailable: Network error'),
    );

    // WHEN: 调用 extractMemories
    let threw = false;
    let result: Awaited<ReturnType<typeof extractMemories>> | null = null;
    try {
      result = await extractMemories(db, facade, 'session-bdd-3', SAMPLE_CONVERSATION);
    } catch {
      threw = true;
    }

    // THEN: 不抛出异常
    expect(threw).toBe(false);

    // THEN: 返回空 extracted 数组
    expect(result).not.toBeNull();
    expect(result!.extracted).toHaveLength(0);
    expect(result!.conflicts_resolved).toBe(0);

    // THEN: 已有存储数据不受影响
    const stored = getMemoriesBySubject(db, 'bdd-safe-subject');
    expect(stored.length).toBe(1);
    expect(stored[0].content).toBe('safe existing content');
  });

  it('LLM HTTP 500 error 也静默降级，不影响已有数据', async () => {
    // GIVEN: 存储中已有记忆
    const existingMemory = makeMemory({
      id: 'bdd-safe-mem-002',
      subject: 'bdd-safe-subject-2',
      content: 'another safe content',
      type: 'entity',
    });
    facade.addMemory(existingMemory);

    // GIVEN: LLM 服务返回 HTTP 错误
    vi.spyOn(llmModule, 'callLLM').mockRejectedValueOnce(
      new Error('HTTP 500: Internal Server Error'),
    );

    // WHEN
    const result = await extractMemories(db, facade, 'session-bdd-3b', SAMPLE_CONVERSATION);

    // THEN
    expect(result.extracted).toHaveLength(0);

    const stored = getMemoriesBySubject(db, 'bdd-safe-subject-2');
    expect(stored.length).toBe(1);
    expect(stored[0].content).toBe('another safe content');
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: 懒提取检查正确判定已提取的 session
// ---------------------------------------------------------------------------

describe('Scenario 4: 懒提取检查正确判定已提取的 session', () => {
  it('session_key=s1 extracted=1 → should_extract=false', () => {
    // GIVEN: session_states 表中 session_key='s1' 的记录 extracted=1
    const now = new Date().toISOString();
    insertSessionState(db, {
      session_key: 's1',
      extracted: 1,
      conversation_hash: null,
      created_at: now,
      updated_at: now,
    });

    // WHEN: 对 session_key='s1' 执行 lazy extraction check
    const result = lazyExtractionCheck(db, 's1');

    // THEN: 返回 should_extract=false
    expect(result.should_extract).toBe(false);
    expect(result.session_key).toBe('s1');
  });

  it('session_key=s1 extracted=0 → should_extract=true (对照组)', () => {
    const now = new Date().toISOString();
    insertSessionState(db, {
      session_key: 's1',
      extracted: 0,
      conversation_hash: null,
      created_at: now,
      updated_at: now,
    });

    const result = lazyExtractionCheck(db, 's1');
    expect(result.should_extract).toBe(true);
  });

  it('session_key 不存在 → should_extract=true (对照组)', () => {
    const result = lazyExtractionCheck(db, 's1');
    expect(result.should_extract).toBe(true);
  });

  it('previous_session_key=null → should_extract=false (边界情况)', () => {
    const result = lazyExtractionCheck(db, null);
    expect(result.should_extract).toBe(false);
    expect(result.session_key).toBeNull();
  });
});
