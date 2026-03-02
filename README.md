# LearnLoop

Agent Memory & Learning plugin for [OpenClaw](https://github.com/openclaw/openclaw).

Gives your AI agents persistent memory across sessions — they remember what users prefer, learn from past tasks, and get smarter over time.

## What It Does

LearnLoop hooks into OpenClaw's agent lifecycle and does three things automatically:

**1. Memory Extraction** — After each session, an LLM extracts memorable information (preferences, facts, entities, events) and stores them in SQLite.

**2. Reflection Generation** — When a task completes (success or failure), the system generates a structured reflection: what happened, what worked, what didn't, and actionable lessons.

**3. Context Injection** — Before each new agent run, relevant memories and reflections are retrieved via BM25 + tri-dimensional scoring and injected into the agent's context.

```
Session ends → LLM extracts memories → SQLite
Task completes → LLM generates reflection → SQLite
                                              ↓
New session/task ← BM25 + scoring ←──────────┘
```

## Quick Start

### As OpenClaw Plugin

```bash
# Install (link mode for development)
openclaw plugins install -l /path/to/LearnLoop

# Or install from a directory
openclaw plugins install /path/to/LearnLoop

# Restart gateway
openclaw gateway restart
```

Configure in your OpenClaw config (`~/.openclaw/openclaw.json`):

```json
{
  "plugins": {
    "entries": {
      "learnloop": {
        "enabled": true,
        "config": {
          "apiKey": "your-openai-api-key",
          "apiBase": "https://api.openai.com/v1",
          "model": "gpt-4o-mini"
        }
      }
    }
  }
}
```

That's it. LearnLoop will automatically:
- Track conversations during agent runs
- Generate reflections when tasks complete
- Inject relevant memories into new sessions

### As Standalone SDK

```typescript
import { createPlugin } from 'learnloop';

const plugin = createPlugin({
  dbPath: '/path/to/learnloop.db',
  retrieval: { a: 0.3, b: 0.5, c: 0.2, lambda: 0.01 },
});

// After a task completes
const result = await plugin.afterTask({
  session_key: 'session-001',
  task_type: 'code',
  task_summary: 'Implement JWT authentication',
  conversation_history: messages,
  signals: {
    user_feedback: 'Looks good!',
    review_result: 'PASS',
    was_respawned: false,
    timed_out: false,
  },
  agent_id: 'my-agent',
});
// → { reflection_id: 'uuid', outcome: 'success' }

// Before spawning a new task
const spawn = await plugin.beforeSpawn({
  task_description: 'Implement OAuth2 login',
  task_type: 'code',
  agent_id: 'my-agent',
});
// → { augmented_task_description: '...with past reflections...', injected_reflections: [...] }

// Before a new conversation turn
const turn = await plugin.beforeTurn({
  session_key: 'session-002',
  conversation_context: 'Working on TypeScript project',
  previous_session_key: 'session-001',
  previous_conversation_history: previousMessages,
});
// → { injected_memories: [...], extraction_triggered: true }
```

## Configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `dbPath` | string | `~/.openclaw/learnloop/learnloop.db` | SQLite database path |
| `apiKey` | string | — | OpenAI-compatible API key |
| `apiBase` | string | `https://api.openai.com/v1` | LLM API base URL |
| `model` | string | `gpt-4o-mini` | Model for extraction/reflection |
| `retrieval.a` | number | `0.3` | Recency weight |
| `retrieval.b` | number | `0.5` | Relevance weight (BM25) |
| `retrieval.c` | number | `0.2` | Importance weight |
| `retrieval.lambda` | number | `0.01` | Time-decay rate |

### Environment Variables

| Variable | Description |
|----------|-------------|
| `OPENCLAW_API_KEY` | LLM API key (fallback: `OPENAI_API_KEY`) |
| `OPENCLAW_API_BASE` | LLM API base URL |

## Architecture

### Hooks

| Hook | Trigger | What It Does |
|------|---------|--------------|
| `beforeTurn` | New conversation starts | Lazy-extracts memories from previous session; injects relevant memories |
| `afterTask` | Task/agent run completes | Resolves outcome from signals; generates reflection via LLM |
| `beforeSpawn` | New sub-agent task | Retrieves relevant past reflections; augments task description |

### OpenClaw Hook Mapping

When running as an OpenClaw plugin, hooks map to lifecycle events:

| LearnLoop | OpenClaw Event | Direction |
|-----------|----------------|-----------|
| `beforeTurn` | `before_agent_start` | Injects memories into `prependContext` |
| `afterTask` | `agent_end` / `subagent_ended` | Generates reflections from completed runs |
| — | `llm_input` / `llm_output` | Tracks conversation for reflection |
| — | `session_end` | Cleanup |

### Memory Types

| Type | Description | Example |
|------|-------------|---------|
| `preference` | User likes/dislikes, settings | "Prefers TypeScript over JavaScript" |
| `fact` | Factual information | "Project uses PostgreSQL" |
| `entity` | People, places, orgs | "John is the PM" |
| `episode` | Specific events | "Deployed v2.0 on Monday" |

### Retrieval Scoring

Memories are scored using a tri-dimensional formula:

```
score = a × recency + b × relevance + c × importance

recency = exp(-λ × age_in_days)
relevance = BM25 score (normalized)
importance = stored importance value (0-1)
```

Default weights: 30% recency, 50% relevance, 20% importance.

### Reflection Outcomes

Task signals are resolved into outcomes using a rule-based algorithm:

| Signal | Maps To |
|--------|---------|
| `review_result: 'PASS'` | +success |
| `review_result: 'FAIL'` | +failure |
| `timed_out: true` | +failure |
| `was_respawned: true` | +failure |
| Positive feedback keywords | +success |
| Negative feedback keywords | +failure |

Resolution: failure + success → `partial`, only failure → `failure`, only success → `success`, neither → `partial`.

### Storage

SQLite via `better-sqlite3` with WAL mode. Three tables:

- **memories** — Extracted knowledge (preference, fact, entity, episode)
- **reflections** — Task reflections with lessons learned
- **session_states** — Tracks which sessions have been extracted (idempotent)

### Error Handling

Silent degradation throughout. No exception ever propagates to the host:
- LLM call fails → returns empty/null, agent runs unaffected
- DB error → logged, returns safe fallback
- Missing API key → skips LLM calls entirely

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run tests (344 tests)
npm test

# Run integration test (requires no API key — uses mock server)
npx tsx test/integration.ts

# Type check
npm run lint
```

### Project Structure

```
src/
├── config/           # Configuration defaults
├── hooks/            # Hook handlers (beforeTurn, afterTask, beforeSpawn)
├── llm/              # LLM client (memory extraction + reflection generation)
├── memory/           # Memory extraction, conflict detection, retrieval, injection
├── openclaw-adapter/ # OpenClaw plugin bridge
├── reflection/       # Signal resolution, reflection generation, retrieval
├── search/           # BM25 search engine (MiniSearch)
├── storage/          # SQLite schema, CRUD, facade
├── types/            # Shared TypeScript types
├── index.ts          # SDK exports
└── plugin.ts         # createPlugin() factory
```

## Cost

Each LLM call uses `gpt-4o-mini` with tight token limits:
- Memory extraction: ~1000 tokens → ~$0.001
- Reflection generation: ~800 tokens → ~$0.001
- **Total: < $0.002 per session**

## License

MIT
