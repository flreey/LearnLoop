# Project Knowledge

## Build & Compilation

- vitest prints a deprecation warning about `The CJS build of Vite's Node API is deprecated` — this is a cosmetic warning from vitest 1.x and does not affect test correctness or exit code
- Worktree's `node_modules` is a symlink to `../../../node_modules`. Vitest 1.x `ResultsCache.writeToCache` calls `mkdir` on the symlink path (not the resolved target), which fails with `ENOTDIR`. Fix: set `cache: false` in `vitest.config.ts` to disable the results cache entirely.

## Dependencies

- better-sqlite3 includes native bindings; npm install triggers prebuild-install (deprecated) but the prebuild for Node 20 resolves correctly without compilation

## Module Resolution & Imports

- tsconfig uses `"module": "Node16"` with `.js` extension in import paths (required for ESM compatibility with Node16 module resolution)
- `vi.spyOn` on ES module imports requires that the module exports be accessed at call-time (not captured in a local variable); importing the module as `* as moduleName` and spying on `moduleName.exportName` works correctly because the module reference is consistent at spy-time

## Module Map

- `src/config/index.ts` — exports getConfig, AppConfig
- `src/hooks/index.ts` — exports handleBeforeTurn, handleAfterTask, handleBeforeSpawn and 7 more
- `src/index.ts` — src/index.ts module
- `src/llm/index.ts` — exports stripCodeFences, callLLM, parseMemoryResponse and 4 more
- `src/memory/index.ts` — exports lazyExtractionCheck, detectAndUpsert, extractMemories and 7 more
- `src/openclaw-adapter/index.ts` — src/openclaw-adapter/index.ts module
- `src/plugin.ts` — exports createPlugin, PluginRetrievalConfig, PluginConfig, OpenClawPlugin
- `src/reflection/index.ts` — exports resolveOutcome, generateReflection, retrieveReflections
- `src/search/index.ts` — exports createSearchEngine, SearchResult, EmbeddingEngine, SearchEngine
- `src/storage/db.ts` — exports initializeDatabase, DB
- `src/storage/facade.ts` — exports StorageFacade
- `src/storage/index.ts` — src/storage/index.ts module
- `src/storage/repository.ts` — exports insertMemory, getMemoryById, updateMemory and 10 more
- `src/types/index.ts` — exports MemoryType, OutcomeType, MemoryEntry and 8 more
