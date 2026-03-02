#!/usr/bin/env npx tsx
/**
 * LearnLoop Integration Test — full lifecycle with mock LLM server.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { createPlugin } from '../src/plugin.js';

// -------------------------------------------------------------------------
// Mock OpenAI-compatible LLM server
// -------------------------------------------------------------------------

function createMockLLMServer(): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        const parsed = JSON.parse(body);
        const systemMsg = parsed.messages?.[0]?.content ?? '';
        const userMsg = parsed.messages?.[1]?.content ?? '';

        let responseContent: string;

        if (systemMsg.includes('memory extraction') || systemMsg.includes('Extract')) {
          // Memory extraction response
          responseContent = JSON.stringify({
            memories: [
              {
                type: 'preference',
                content: 'User prefers TypeScript over JavaScript for all projects',
                subject: 'language-preference',
                confidence: 0.9,
                importance: 0.8,
              },
              {
                type: 'fact',
                content: 'Project uses SQLite with better-sqlite3 for persistence',
                subject: 'tech-stack',
                confidence: 0.95,
                importance: 0.6,
              },
            ],
          });
        } else if (systemMsg.includes('reflection') || systemMsg.includes('Reflection')) {
          // Reflection generation response
          responseContent = JSON.stringify({
            task_type: 'code',
            task_summary: 'Implement user authentication with JWT',
            outcome: 'success',
            reflection: 'JWT implementation was straightforward using RS256 signing. Good test coverage.',
            lessons: [
              'Use RS256 over HS256 for production JWT',
              'Set short expiry and use refresh tokens',
            ],
          });
        } else {
          responseContent = '{}';
        }

        const response = {
          id: 'chatcmpl-mock',
          object: 'chat.completion',
          choices: [{
            index: 0,
            message: { role: 'assistant', content: responseContent },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        };

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, port: addr.port });
    });
  });
}

// -------------------------------------------------------------------------
// Main test
// -------------------------------------------------------------------------

async function main() {
  // Start mock LLM server
  const { server, port } = await createMockLLMServer();
  console.log(`🤖 Mock LLM server on port ${port}`);

  // Set env vars for LLM module
  process.env['OPENCLAW_API_KEY'] = 'test-key-12345';
  process.env['OPENCLAW_API_BASE'] = `http://127.0.0.1:${port}/v1`;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'learnloop-integration-'));
  const dbPath = path.join(tmpDir, 'integration.db');
  
  console.log('📦 Plugin DB:', dbPath);
  const plugin = createPlugin({ dbPath });

  let failures = 0;

  // --- Step 1: afterTask ---
  console.log('\n🔄 Step 1: afterTask — generate reflection');
  
  const afterResult = await plugin.afterTask({
    session_key: 'session-001',
    task_type: 'code',
    task_summary: 'Implement user authentication with JWT',
    conversation_history: [
      { role: 'user', content: 'Implement JWT auth for the API endpoints' },
      { role: 'assistant', content: "Implemented JWT auth with RS256 signing..." },
      { role: 'user', content: 'Looks good, thanks!' },
    ],
    signals: {
      user_feedback: 'Looks good, thanks!',
      review_result: 'PASS',
      was_respawned: false,
      timed_out: false,
    },
    agent_id: 'hanxin',
  });

  await new Promise(r => setTimeout(r, 300));

  console.log('   reflection_id:', afterResult.reflection_id);
  console.log('   outcome:', afterResult.outcome);
  
  if (afterResult.reflection_id && afterResult.outcome === 'success') {
    console.log('   ✅ Reflection generated');
  } else {
    console.log('   ❌ FAIL');
    failures++;
  }

  // --- Step 2: beforeSpawn ---
  console.log('\n🔄 Step 2: beforeSpawn — inject reflections');
  
  const spawnResult = await plugin.beforeSpawn({
    task_description: 'Implement OAuth2 with JWT token authentication for social login',
    task_type: 'code',
    agent_id: 'hanxin',
  });

  console.log('   injected:', spawnResult.injected_reflections.length);
  if (spawnResult.injected_reflections.length > 0) {
    console.log('   ✅ Reflections injected');
    console.log('   augmented:', spawnResult.augmented_task_description.includes('Relevant Past Reflections'));
  } else {
    console.log('   ℹ️  No BM25 match — acceptable');
  }

  // --- Step 3: beforeTurn (trigger extraction) ---
  console.log('\n🔄 Step 3: beforeTurn — lazy extraction');
  
  const turnResult = await plugin.beforeTurn({
    session_key: 'session-002',
    conversation_context: 'Working on TypeScript project with SQLite',
    previous_session_key: 'session-001',
    previous_conversation_history: [
      { role: 'user', content: 'Implement JWT auth for the API endpoints' },
      { role: 'assistant', content: "Implemented JWT auth with RS256 signing..." },
    ],
  });

  await new Promise(r => setTimeout(r, 500));

  console.log('   extraction_triggered:', turnResult.extraction_triggered);
  if (turnResult.extraction_triggered) {
    console.log('   ✅ Extraction triggered');
  } else {
    console.log('   ❌ FAIL: Expected extraction');
    failures++;
  }

  // --- Step 4: No duplicate extraction ---
  console.log('\n🔄 Step 4: No duplicate extraction');
  
  const turnResult2 = await plugin.beforeTurn({
    session_key: 'session-003',
    conversation_context: 'Continue auth work',
    previous_session_key: 'session-001',
    previous_conversation_history: [],
  });

  if (!turnResult2.extraction_triggered) {
    console.log('   ✅ No duplicate');
  } else {
    console.log('   ❌ FAIL');
    failures++;
  }

  // --- Step 5: Memory retrieval ---
  console.log('\n🔄 Step 5: Memory retrieval after extraction');
  
  const turnResult3 = await plugin.beforeTurn({
    session_key: 'session-004',
    conversation_context: 'Setting up TypeScript project with SQLite database',
    previous_session_key: null,
    previous_conversation_history: null,
  });

  console.log('   injected_memories:', turnResult3.injected_memories.length);
  if (turnResult3.injected_memories.length > 0) {
    for (const m of turnResult3.injected_memories) {
      console.log(`     - ${m.content.slice(0, 60)}`);
    }
    console.log('   ✅ Memories retrieved');
  } else {
    console.log('   ℹ️  No memories matched (BM25 threshold)');
  }

  // --- Step 6: DB verification ---
  console.log('\n📊 Step 6: Database state');
  
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(dbPath, { readonly: true });
  
  const reflections = db.prepare('SELECT id, task_type, outcome, agent_id FROM reflections').all() as any[];
  console.log('   Reflections:', reflections.length);
  for (const r of reflections) {
    console.log(`     ${r.id.slice(0,8)}... ${r.task_type} ${r.outcome} agent=${r.agent_id}`);
  }
  if (reflections.length < 1) { console.log('   ❌ No reflections'); failures++; }

  const memories = db.prepare('SELECT content, importance, type FROM memories').all() as any[];
  console.log('   Memories:', memories.length);
  for (const m of memories) {
    console.log(`     [${m.type}] ${m.content.slice(0, 50)}... imp=${m.importance}`);
  }
  if (memories.length < 1) { console.log('   ❌ No memories'); failures++; }

  const sessions = db.prepare('SELECT session_key, extracted FROM session_states').all() as any[];
  console.log('   Sessions:', sessions.length);
  for (const s of sessions) {
    console.log(`     ${s.session_key}: extracted=${s.extracted}`);
  }

  db.close();

  // --- Summary ---
  console.log('\n' + '='.repeat(60));
  if (failures === 0) {
    console.log('✅ INTEGRATION TEST PASSED — all hooks working end-to-end');
  } else {
    console.log(`❌ INTEGRATION TEST FAILED: ${failures} failure(s)`);
  }
  console.log('='.repeat(60));

  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('❌ Crashed:', err);
  process.exit(1);
});
