# Project Knowledge

## Build & Compilation

- vitest prints a deprecation warning about `The CJS build of Vite's Node API is deprecated` — this is a cosmetic warning from vitest 1.x and does not affect test correctness or exit code

## Dependencies

- better-sqlite3 includes native bindings; npm install triggers prebuild-install (deprecated) but the prebuild for Node 20 resolves correctly without compilation

## Module Resolution & Imports

- tsconfig uses `"module": "Node16"` with `.js` extension in import paths (required for ESM compatibility with Node16 module resolution)
- `vi.spyOn` on ES module imports requires that the module exports be accessed at call-time (not captured in a local variable); importing the module as `* as moduleName` and spying on `moduleName.exportName` works correctly because the module reference is consistent at spy-time
