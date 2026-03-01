# LearnLoop — Agent Memory & Learning Platform

> 让你的 Agent 有记忆、会学习

## 1. 问题

所有 AI Agent 都有同一个病：**失忆 + 不学习**。

- 用户说过 10 遍的偏好，Agent 记不住
- 上次犯的错，下次原样再犯
- 用了半年，和第一天一样"生"

已有竞品（Mem0 $24M, Letta $10M, Zep YC W24）验证了需求存在，但它们只做了"记忆存储"，没有做"学习"。

**核心差异：Mem0 是给 Agent 装硬盘，LearnLoop 是给 Agent 装大脑。**

## 2. 产品定位

**Phase 1：OpenClaw 原生插件**
- 利用 OpenClaw 已有的对话 hook 和任务回调，实现 Agent 无感的记忆提取和学习
- 作为 OpenClaw 的差异化功能

**Phase 2（效果验证后）：独立模块**
- 抽象为 MCP Server / SDK，支持其他 Agent 框架

## 3. 目标用户

- OpenClaw 用户（Phase 1）
- Agent 开发者（Phase 2）

## 4. 核心能力（四层架构）

```
Layer 4: 技能进化 — 成功流程自动沉淀为可复用技能
Layer 3: 自我学习 — Reflexion 反思 + ExpeL 规则蒸馏
Layer 2: 智能记忆 — 自动提取/冲突更新/三维检索
Layer 1: 存储引擎 — 向量 + 结构化 + 时序
```

### MVP 范围（Phase 1, Week 1-4）

**Layer 1 — 存储引擎**
- JSONL 文件存储（reflections.jsonl, memories.jsonl）
- 升级现有 memory_search 支持反思/记忆条目的语义搜索
- Phase 2 再考虑 SQLite / Qdrant

**Layer 2 — 智能记忆**
- 对话完成后，LLM 自动判断是否有值得记住的内容
- 提取实体、偏好、事实，写入 memories.jsonl
- 冲突检测：新记忆与旧记忆矛盾时，更新而非追加
- 三维检索：recency（时间衰减）× relevance（语义相似）× importance（重要性评分）
- 下一轮对话自动注入相关记忆到 context

**Layer 3 — 自我学习（Reflexion）**
- 任务完成后自动触发反思
- 成败判断信号：
  - 用户反馈（"谢谢" = success，"不对/重来" = fail）
  - 任务被 re-spawn = 上次 fail
  - 子任务 review 结果（PASS/FAIL）
  - 超时 = fail
- 反思结果写入 reflections.jsonl
- 下次同类任务自动检索相关反思注入任务描述

**Layer 4 — 不在 MVP 范围**

## 5. 技术架构

### 运行环境
- OpenClaw 插件，运行在 OpenClaw Gateway 进程中
- Node.js / TypeScript（与 OpenClaw 同技术栈）
- 不引入外部数据库依赖（MVP 阶段）

### 文件存储
- ~/.openclaw/learnloop/memories.jsonl — 记忆条目
- ~/.openclaw/learnloop/reflections.jsonl — 反思条目
- ~/.openclaw/learnloop/rules.jsonl — 蒸馏规则（Phase 2）

### 记忆条目格式
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

### 反思条目格式
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

### OpenClaw 集成点

**Hook 1: 对话完成（afterTurn）**
- 触发条件：每轮对话结束
- 动作：后台异步调 LLM 提取记忆
- 不阻塞对话流

**Hook 2: 任务完成（afterTask / subagent completion）**
- 触发条件：子任务完成回调
- 动作：分析成败信号 → 生成反思 → 写入 reflections.jsonl

**Hook 3: 对话开始（beforeTurn）**
- 触发条件：每轮对话开始前
- 动作：检索相关记忆 + 反思 → 注入 system prompt 或 context

**Hook 4: 任务分派前（beforeSpawn）**
- 触发条件：sessions_spawn 调用前
- 动作：检索相关反思 → 注入任务描述

### LLM 调用
- 记忆提取：使用轻量模型（Haiku / GPT-4o-mini）
- 反思生成：使用中等模型（Sonnet / GPT-4o-mini）
- 通过 OpenClaw 已有的 LLM 代理配置
- 每次调用成本 < $0.002

### 三维检索算法
```
score = a * recency(t) + b * relevance(q, m) + c * importance(m)

recency(t) = exp(-lambda * hours_since_access)
relevance(q, m) = cosine_similarity(embed(q), embed(m.content))
importance(m) = m.importance  # LLM 在提取时评估

a = 0.3, b = 0.5, c = 0.2  # 可配置
lambda = 0.01  # 衰减系数
```

MVP 阶段 relevance 使用 BM25 文本匹配（避免 embedding API 依赖），Phase 2 升级为向量检索。

## 6. 非功能需求

- **性能**：记忆检索 < 100ms（1000 条以内）；记忆提取异步，不阻塞对话
- **隐私**：所有数据本地存储，不发送到外部服务（除 LLM API 调用）
- **存储**：单用户预估 < 10MB/月（1000 条记忆 + 200 条反思）
- **容错**：LLM 调用失败时静默降级，不影响正常对话

## 7. 验收标准

### Layer 1 — 存储
- AC-1: memories.jsonl 和 reflections.jsonl 可正确读写，支持追加和更新
- AC-2: 记忆检索（BM25）在 1000 条数据下 < 100ms
- AC-3: 冲突检测能识别同一 subject 的矛盾记忆并更新

### Layer 2 — 智能记忆
- AC-4: 对话结束后，LLM 能提取 preference/fact/entity 类型的记忆
- AC-5: 下一轮对话能检索到相关记忆并注入 context
- AC-6: 记忆提取异步执行，不增加对话响应延迟

### Layer 3 — 自我学习
- AC-7: 子任务完成后自动生成反思
- AC-8: 反思能正确判断成败（基于用户反馈、review 结果、re-spawn 信号）
- AC-9: 下次同类任务分派时，相关反思被注入任务描述
- AC-10: 反思注入后，Agent 返工率降低（需要运行数据验证）

## 8. 开放问题

- Q1: OpenClaw 现有的插件 hook 机制是什么？afterTurn / beforeTurn 是否已存在？
- Q2: memory_search 目前的实现方式？能否扩展支持自定义 JSONL 源？
- Q3: 记忆注入到 context 的最大 token 预算？（避免挤占正常对话空间）
- Q4: 多 Agent 场景下，记忆是否跨 Agent 共享？还是每个 Agent 独立？

## 9. 实施路径

| 阶段 | 时间 | 内容 |
|------|------|------|
| Week 1-2 | MVP Core | 存储引擎 + 反思系统（Layer 1 + Layer 3） |
| Week 3-4 | 记忆提取 | 对话 hook + LLM 提取 + 冲突检测 + 检索注入（Layer 2） |
| Month 2 | 规则蒸馏 | ExpeL 周度蒸馏 + 跨 Agent 规则共享 |
| Month 3+ | 决策点 | 效果好 → 对外产品化；一般 → 继续调优 |

## 10. 参考

| 论文 | arXiv | 用到什么 |
|------|-------|---------|
| Reflexion | 2303.11366 | 任务后自动反思 |
| ExpeL | 2308.10144 | 跨任务规则蒸馏 |
| Generative Agents | 2304.03442 | 三维度记忆检索 |
| Mem0 | 2504.19413 | 记忆提取参考 |
| Voyager | 2305.16291 | 技能库设计（Phase 2+） |
