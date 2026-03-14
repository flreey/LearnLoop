# LearnLoop Todo

- [ ] [2026-03-14] 优化内部 LLM 调用窗口：`MAX_HISTORY_WINDOW` 当前硬截断为 10 条，超出的消息直接丢弃。应改为智能截断（按 token 预算而非条数），或在截断前先做摘要，避免长对话中段信息丢失。涉及文件：`src/openclaw-adapter/index.ts` L34、L246。
