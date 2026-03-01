# LearnLoop - Tech Review Decisions

## T1: BM25 实现方式
**Decision**: Accept — 用 minisearch 或 flexsearch 替代自建 BM25。8KB 库不算依赖负担，CJK 支持开箱即用。

## T2: JSONL vs SQLite
**Decision**: Accept — 从 Week 1 就用 SQLite (better-sqlite3)。tech review 说得对，JSONL + 更新操作 = 自建一个差版 SQLite。单文件数据库完全符合"零基础设施"原则。

## T3: 双层 LLM 模型
**Decision**: Accept — MVP 统一用 GPT-4o-mini（通过 OpenClaw 的 LLM 配置）。效果不够再升级。

## T4: Session 结束检测
**Decision**: Accept — 用 lazy extraction（下次 session 开始时提取上次 session 的记忆）。消除所有 timer 复杂度，一个 session 的延迟完全可接受。
