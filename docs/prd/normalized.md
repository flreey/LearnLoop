# LearnLoop - Development Specification

## Overview
LearnLoop is an OpenClaw plugin that gives AI Agents persistent memory and self-learning capabilities. It automatically extracts memories from conversations, generates reflections after tasks, and injects relevant context into future interactions. Phase 1 is an OpenClaw-native plugin; Phase 2 abstracts into an independent MCP Server / SDK.

## Scope

### In Scope (MVP — Week 1-4)
- Layer 1: Storage engine using SQLite (better-sqlite3), single-file local database
- Layer 2: Intelligent memory — auto-extraction, conflict detection, tri-dimensional retrieval, context injection
- Layer 3: Self-learning — Reflexion-based post-task reflection, success/failure signal analysis, reflection injection
- OpenClaw plugin integration via 4 hooks (afterTurn, afterTask, beforeTurn, beforeSpawn)

### Out of Scope
- Layer 4: Skill evolution (future phase)
- ExpeL rule distillation (Month 2)
- Vector embedding retrieval (Phase 2, use BM25 via minisearch/flexsearch for MVP)
- External database dependencies (Qdrant, etc.)
- Cross-agent memory sharing (open question Q4)
- Independent MCP Server / SDK (Phase 2)

## User Roles

| Role | Permissions | Key Actions |
|------|-------------|-------------|
| OpenClaw User (Phase 1) | Implicit — plugin operates transparently | Conversations trigger memory extraction and reflection; memories/reflections auto-injected |
| Agent Developer (Phase 2) | SDK/MCP integration | Not specified in PRD beyond positioning |

## Functional Requirements

### FR-1: Storage Engine (Layer 1)
**Purpose**: Persistent local storage for memories, reflections, and rules.

**Rules**:
- Use SQLite via `better-sqlite3` (Tech Review T2 decision — replaces original JSONL plan)
- Database location: `~/.openclaw/learnloop/learnloop.db`
- Must support append and update operations for memory and reflection entries
- BM25-based text search using `minisearch` or `flexsearch` library (Tech Review T1 decision)
- Search latency < 100ms for up to 1000 entries

**Data**: See Data Model section for entry schemas.

**Edge Cases**:

| Scenario | Expected Behavior |
|----------|-------------------|
| Database file does not exist | Auto-create on first write |
| Concurrent write attempts | SQLite handles via file-level locking |
| Corrupt database file | Not specified in PRD |

**Depends on**: better-sqlite3, minisearch or flexsearch

---

### FR-2: Memory Extraction (Layer 2)
**Purpose**: Automatically extract memorable content from completed conversations.

**Rules**:
- Triggered via lazy extraction: extract memories from previous session when next session starts (Tech Review T4 decision — replaces afterTurn real-time extraction)
- LLM (GPT-4o-mini, unified model per Tech Review T3) analyzes conversation to judge if content is worth remembering
- Extracts types: `preference`, `fact`, `entity`, `episode`
- Each memory includes: subject, content, confidence score (0-1), importance score (0-1)
- Extraction runs asynchronously, must not block conversation flow
- LLM call cost target: < $0.002 per call

**Data**:
- Input: Previous session conversation history
- Output: Array of memory entries (see Memory Entry schema)

**Edge Cases**:

| Scenario | Expected Behavior |
|----------|-------------------|
| LLM extraction call fails | Silent degradation, no memories stored, conversation unaffected |
| No memorable content in conversation | No entries written |
| Duplicate/redundant extraction | Conflict detection handles (see FR-3) |

**Depends on**: FR-1 (Storage), OpenClaw LLM proxy config, Hook 3 (beforeTurn)

---

### FR-3: Memory Conflict Detection & Update (Layer 2)
**Purpose**: Detect contradictions between new and existing memories, update rather than duplicate.

**Rules**:
- When a new memory conflicts with an existing memory for the same `subject`, update the existing entry instead of appending
- Conflict detection scope: same `subject` field

**Edge Cases**:

| Scenario | Expected Behavior |
|----------|-------------------|
| Contradictory memories for same subject | Update existing entry with new content, update `updated_at` timestamp |
| Similar but non-contradictory memories | Not specified in PRD — ambiguous boundary |

**Depends on**: FR-1 (Storage), FR-2 (Extraction)

---

### FR-4: Tri-Dimensional Memory Retrieval (Layer 2)
**Purpose**: Retrieve the most relevant memories using a weighted scoring algorithm combining recency, relevance, and importance.

**Rules**:
- Scoring formula:
```
score = a * recency(t) + b * relevance(q, m) + c * importance(m)

recency(t) = exp(-lambda * hours_since_access)
relevance(q, m) = BM25_score(q, m.content)  // MVP: minisearch/flexsearch
importance(m) = m.importance  // Set by LLM during extraction

Default weights: a = 0.3, b = 0.5, c = 0.2  (configurable)
lambda = 0.01  (decay coefficient)
```
- MVP uses BM25 text matching via minisearch/flexsearch for relevance (no embedding API dependency)
- Phase 2: upgrade to vector/cosine similarity retrieval
- Retrieval latency: < 100ms for ≤ 1000 entries

**Data**:
- Input: Query string (current conversation context or task description)
- Output: Ranked list of memory entries with scores

**Depends on**: FR-1 (Storage), minisearch or flexsearch

---

### FR-5: Memory Context Injection (Layer 2)
**Purpose**: Inject relevant memories into conversation context before each turn.

**Rules**:
- Triggered at conversation start (beforeTurn hook)
- Retrieve relevant memories via FR-4
- Inject into system prompt or context

**Edge Cases**:

| Scenario | Expected Behavior |
|----------|-------------------|
| No relevant memories found | Proceed without injection |
| Token budget exceeded | Not specified in PRD (open question Q3) |

**Depends on**: FR-4 (Retrieval), Hook 3 (beforeTurn)

---

### FR-6: Post-Task Reflection (Layer 3 — Reflexion)
**Purpose**: Automatically generate reflections after task completion to enable learning from experience.

**Rules**:
- Triggered on subtask completion callback (afterTask / subagent completion hook)
- Success/failure signal sources:
  - User feedback: "谢谢" → success; "不对/重来" → failure
  - Task re-spawn → previous attempt = failure
  - Sub-task review result: PASS → success; FAIL → failure
  - Timeout → failure
- LLM (GPT-4o-mini) generates reflection including: task summary, outcome, signals, reflection text, lessons array
- Reflection written to SQLite reflections table

**Data**:
- Input: Task context, completion signals, conversation history
- Output: Reflection entry (see Reflection Entry schema)

**Edge Cases**:

| Scenario | Expected Behavior |
|----------|-------------------|
| LLM reflection call fails | Silent degradation, no reflection stored |
| Ambiguous success/failure signals | Not specified in PRD |
| Multiple signals conflict | Not specified in PRD |

**Depends on**: FR-1 (Storage), OpenClaw LLM proxy, Hook 2 (afterTask)

---

### FR-7: Reflection Injection for Task Dispatch (Layer 3)
**Purpose**: Inject relevant past reflections into task descriptions before spawning subtasks.

**Rules**:
- Triggered before `sessions_spawn` call (beforeSpawn hook)
- Retrieve reflections relevant to the new task via BM25 search on task_type and task_summary
- Inject relevant reflections into task description

**Edge Cases**:

| Scenario | Expected Behavior |
|----------|-------------------|
| No relevant reflections found | Proceed without injection |
| Task type not previously encountered | No reflections to inject |

**Depends on**: FR-1 (Storage), FR-4 (Retrieval adapted for reflections), Hook 4 (beforeSpawn)

---

## Data Model

### Memory Entry
```json
{
  "id": "uuid",
  "type": "preference|fact|entity|episode",
  "content": "用户偏好中文沟通",
  "subject": "flreey",
  "confidence": 0.9,
  "source_session": "session-key",
  "created_at": "ISO8601",
  "updated_at": "ISO8601",
  "access_count": 5,
  "importance": 0.8
}
```

### Reflection Entry
```json
{
  "id": "uuid",
  "task_type": "code|research|deployment",
  "task_summary": "替换 Puppeteer 为 WeasyPrint",
  "outcome": "success|failure|partial",
  "signals": ["user_feedback:positive", "review:PASS"],
  "reflection": "WeasyPrint 需要系统字体依赖，部署时要确认...",
  "lessons": ["PDF 库替换前先检查系统依赖"],
  "agent_id": "hanxin",
  "created_at": "ISO8601"
}
```

### Storage Layout
```
~/.openclaw/learnloop/learnloop.db    # SQLite database (better-sqlite3)
~/.openclaw/learnloop/rules.jsonl     # Phase 2: distilled rules
```

### Relationships
- Memory Entry N:1 Session (via `source_session`)
- Reflection Entry N:1 Agent (via `agent_id`)
- Reflection Entry N:1 Task Type (via `task_type`)

## API Specifications

Not specified in PRD — LearnLoop operates as an internal OpenClaw plugin via hooks, no external API surface defined for MVP.

## Module Interfaces & Protocols

### Hook 1: Lazy Memory Extraction (beforeTurn — previous session)
**Protocol**: OpenClaw internal plugin hook (in-process callback)
**Trigger**: Each conversation turn starts (beforeTurn)
**Contract**:
- Check if previous session has unprocessed conversation history
- If yes, async call LLM (GPT-4o-mini) to extract memories
- Write extracted memories to SQLite
- Non-blocking: extraction runs in background

### Hook 2: Task Reflection (afterTask / subagent completion)
**Protocol**: OpenClaw internal plugin hook (in-process callback)
**Trigger**: Subtask completion callback
**Contract**:
- Input: task context, completion signals (user feedback, review result, re-spawn flag, timeout)
- Process: LLM analyzes signals → generates reflection
- Output: reflection entry written to SQLite
- Non-blocking

### Hook 3: Memory Injection (beforeTurn)
**Protocol**: OpenClaw internal plugin hook (in-process callback)
**Trigger**: Each conversation turn starts
**Contract**:
- Input: current conversation context
- Process: tri-dimensional retrieval (FR-4) → select top-N memories
- Output: relevant memories injected into system prompt or context
- Synchronous (must complete before turn proceeds)

### Hook 4: Reflection Injection (beforeSpawn)
**Protocol**: OpenClaw internal plugin hook (in-process callback)
**Trigger**: Before `sessions_spawn` call
**Contract**:
- Input: task description for new subtask
- Process: BM25 search for related reflections
- Output: relevant reflections appended to task description
- Synchronous (must complete before spawn proceeds)

## Technical Configuration

### Retrieval Weights (configurable)
```
a = 0.3   # recency weight
b = 0.5   # relevance weight
c = 0.2   # importance weight
lambda = 0.01  # time decay coefficient
```

### LLM Configuration
- Model: GPT-4o-mini (unified for both extraction and reflection, per Tech Review T3)
- Routed through OpenClaw's existing LLM proxy configuration
- Cost target: < $0.002 per call

## State Machines

Not applicable — no explicit state machines defined in PRD.

## Non-Functional Requirements

| Category | Requirement | Metric | Verification |
|----------|-------------|--------|--------------|
| Performance | Memory retrieval latency | < 100ms for ≤ 1000 entries | Benchmark test |
| Performance | Memory extraction | Async, non-blocking to conversation | Integration test — measure turn latency delta |
| Privacy | Data locality | All data stored locally (~/.openclaw/learnloop/) | No external data transmission except LLM API calls |
| Storage | Per-user footprint | < 10MB/month (est. 1000 memories + 200 reflections) | Monitoring |
| Fault Tolerance | LLM call failure | Silent degradation, no impact on normal conversation | Failure injection test |

## External Dependencies

| System | Purpose | Version/API | Constraints |
|--------|---------|-------------|-------------|
| better-sqlite3 | Local SQLite storage engine | Latest stable | Single-file DB, no external server |
| minisearch or flexsearch | BM25 text search | Latest stable (~8KB) | Must support CJK tokenization |
| OpenClaw LLM Proxy | LLM calls for extraction & reflection | GPT-4o-mini via OpenClaw config | Cost < $0.002/call |
| OpenClaw Plugin Hooks | Integration points (afterTurn, afterTask, beforeTurn, beforeSpawn) | Depends on OpenClaw hook API | Open question: hook availability (Q1) |

## Acceptance Criteria

### Layer 1 — Storage
| ID | Criterion | Test Method |
|----|-----------|-------------|
| AC-1 | SQLite DB supports correct read/write for memories and reflections, including append and update | Unit test |
| AC-2 | BM25 retrieval (via minisearch/flexsearch) completes in < 100ms with 1000 entries | Performance benchmark |
| AC-3 | Conflict detection identifies contradictory memories for same subject and updates instead of duplicating | Unit test with conflicting inputs |

### Layer 2 — Intelligent Memory
| ID | Criterion | Test Method |
|----|-----------|-------------|
| AC-4 | After conversation ends, LLM extracts preference/fact/entity type memories | Integration test with sample conversations |
| AC-5 | Next conversation retrieves relevant memories and injects into context | Integration test across sessions |
| AC-6 | Memory extraction executes asynchronously without increasing conversation response latency | Latency measurement test |

### Layer 3 — Self-Learning
| ID | Criterion | Test Method |
|----|-----------|-------------|
| AC-7 | Subtask completion automatically triggers reflection generation | Integration test with mock task completion |
| AC-8 | Reflection correctly judges success/failure based on: user feedback, review result, re-spawn signal, timeout | Unit tests per signal type |
| AC-9 | On next similar task dispatch, relevant reflections are injected into task description | Integration test with beforeSpawn hook |
| AC-10 | After reflection injection, Agent rework rate decreases | Requires production runtime data validation |

## Edge Cases & Exception Handling

| Scenario | Condition | Expected Behavior | Fallback |
|----------|-----------|-------------------|----------|
| LLM extraction failure | Network error or API error during memory extraction | Silent degradation | No memories stored; conversation proceeds normally |
| LLM reflection failure | Network error or API error during reflection generation | Silent degradation | No reflection stored; task proceeds normally |
| Database file missing | First run or file deleted | Auto-create database and tables | N/A |
| No relevant memories | Retrieval returns empty set | Skip injection | Conversation proceeds without memory context |
| No relevant reflections | Retrieval returns empty set for task type | Skip injection | Task dispatched without reflection context |
| Memory conflict | New memory contradicts existing for same subject | Update existing entry | N/A |
| Token budget overflow | Too many memories/reflections to inject | Not specified in PRD (open question Q3) | Not specified |

## Technical Constraints
- Runtime: Node.js / TypeScript (same stack as OpenClaw)
- Runs in-process within OpenClaw Gateway
- No external database infrastructure (SQLite only)
- No embedding API dependency in MVP (BM25 text matching only)
- All data stored locally under `~/.openclaw/learnloop/`

## Environment & Tooling
```
Runtime: Node.js / TypeScript (OpenClaw Gateway process)
Database: SQLite via better-sqlite3
Search: minisearch or flexsearch (BM25, ~8KB, CJK support)
LLM: GPT-4o-mini via OpenClaw LLM proxy
Storage Path: ~/.openclaw/learnloop/
```

## Glossary

| Term | Definition |
|------|------------|
| Reflexion | Post-task self-reflection mechanism (per arXiv 2303.11366) generating lessons from success/failure signals |
| ExpeL | Cross-task rule distillation mechanism (per arXiv 2308.10144), scheduled for Phase 2 |
| Tri-dimensional retrieval | Memory scoring combining recency (time decay), relevance (BM25), and importance (LLM-assigned score) |
| Lazy extraction | Strategy where memory extraction from session N occurs at the start of session N+1, eliminating timer complexity |
| beforeTurn / afterTurn | OpenClaw plugin hooks fired before/after each conversation turn |
| beforeSpawn | OpenClaw plugin hook fired before dispatching a subtask via sessions_spawn |
| afterTask | OpenClaw plugin hook fired upon subtask completion |

## Missing Information / Clarifications

- [ ] **Q1**: What is OpenClaw's existing plugin hook mechanism? Do `afterTurn`, `beforeTurn`, `afterTask`, `beforeSpawn` hooks already exist? — **Impact**: Core integration architecture depends on this; if hooks don't exist, they must be built first.
- [ ] **Q2**: What is the current `memory_search` implementation? Can it be extended to support custom SQLite sources? — **Impact**: Determines if BM25 search can reuse existing infrastructure or must be built standalone.
- [ ] **Q3**: Maximum token budget for memory/reflection injection into context? — **Impact**: Without a cap, injected context could crowd out conversation space, degrading response quality.
- [ ] **Q4**: In multi-agent scenarios, are memories shared across agents or isolated per agent? — **Impact**: Affects database schema (agent_id scoping) and retrieval logic.
- [ ] **SQLite schema DDL**: Exact table definitions not specified — need to derive from JSON entry formats. — **Impact**: Low; can be derived from data model but should be confirmed.
- [ ] **Conflict detection algorithm**: How exactly is "contradiction" determined? LLM-based or rule-based? — **Impact**: Affects complexity and cost of FR-3 implementation.
- [ ] **Top-N for injection**: How many memories/reflections to inject per turn/spawn? — **Impact**: Affects token budget and retrieval implementation.
- [ ] **Ambiguous/conflicting success signals**: How to resolve when signals disagree (e.g., user says "谢谢" but review = FAIL)? — **Impact**: Affects reflection outcome accuracy.

---

## Self-Review Results

### Identified Specification Types
- [x] Backend Code (TypeScript/Node.js): Runtime environment specified, preserved
- [x] Database Schemas (JSON entry formats): 2 schemas found (Memory Entry, Reflection Entry), all preserved verbatim
- [x] Configuration (retrieval weights, LLM config): Found and preserved
- [x] Performance Requirements: 2 found (retrieval < 100ms, async non-blocking), all preserved
- [x] External Dependencies: 3 identified (better-sqlite3, minisearch/flexsearch, OpenClaw LLM proxy), all documented
- [ ] REST/HTTP Endpoints: Not present in source PRD (internal plugin, no external API)
- [ ] Smart Contracts: Not present in source PRD
- [ ] Infrastructure (Docker/K8s): Not present in source PRD
- [ ] State Machines: Not present in source PRD
- [ ] UI Specifications: Not present in source PRD

### Preservation Summary

| Category | Source Count | Preserved | Status |
|----------|-------------|-----------|--------|
| Code/Schema Snippets | 4 (2 JSON schemas, 1 algorithm, 1 file layout) | 4 | ✓ |
| API Definitions | 0 (internal plugin) | 0 | ✓ |
| Config Examples | 2 (retrieval weights, LLM config) | 2 | ✓ |
| Acceptance Criteria | 10 (AC-1 through AC-10) | 10 | ✓ |
| Edge Cases | 7 | 7 | ✓ |
| Hook Specifications | 4 (beforeTurn, afterTurn, afterTask, beforeSpawn) | 4 | ✓ |
| Tech Review Decisions | 4 (T1-T4) | 4 applied | ✓ |

### Tech Review Decisions Applied

| Decision | Original PRD | Applied Change |
|----------|-------------|----------------|
| T1: BM25 implementation | Self-built BM25 | minisearch or flexsearch library |
| T2: Storage engine | JSONL files | SQLite via better-sqlite3 |
| T3: LLM model | Dual-tier (Haiku + Sonnet) | Unified GPT-4o-mini |
| T4: Session detection | afterTurn real-time extraction | Lazy extraction at next session start (beforeTurn) |

### Compression Metrics
- Source PRD: ~200 lines
- Normalized: ~310 lines (expanded into structured specification format with explicit gaps)
- Net: Structural expansion for development clarity; all marketing/competitive content removed
