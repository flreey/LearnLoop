/**
 * OpenClaw plugin entry point.
 *
 * Wires all three hook handlers (beforeTurn, afterTask, beforeSpawn) into a
 * single plugin object with:
 *   - Unified dependency injection (DB, StorageFacade, SearchEngine)
 *   - Configuration management with defaults
 *   - Silent degradation: any exception caught, logged, never re-thrown
 *
 * Design refs:
 *   - endpoints[hook-before-turn]
 *   - endpoints[hook-after-task]
 *   - endpoints[hook-before-spawn]
 *   - constraints[silent-degradation]
 */

import * as os from 'os';
import * as path from 'path';
import { initializeDatabase } from './storage/db.js';
import { createSearchEngine } from './search/index.js';
import { StorageFacade } from './storage/facade.js';
import {
  handleBeforeTurn,
  handleAfterTask,
  handleBeforeSpawn,
  type BeforeTurnInput,
  type BeforeTurnResult,
  type AfterTaskInput,
  type AfterTaskResult,
  type BeforeSpawnInput,
  type BeforeSpawnResult,
} from './hooks/index.js';

// ---------------------------------------------------------------------------
// Configuration types
// ---------------------------------------------------------------------------

export interface PluginRetrievalConfig {
  /** Recency weight (a). Default: 0.3 */
  a: number;
  /** Relevance weight (b). Default: 0.5 */
  b: number;
  /** Importance weight (c). Default: 0.2 */
  c: number;
  /** Exponential time-decay lambda. Default: 0.01 */
  lambda: number;
}

export interface PluginConfig {
  /** Path to the SQLite database file. Default: ~/.openclaw/learnloop/learnloop.db */
  dbPath?: string;
  /** Retrieval weights and decay configuration */
  retrieval?: Partial<PluginRetrievalConfig>;
}

// ---------------------------------------------------------------------------
// Default configuration
// ---------------------------------------------------------------------------

const DEFAULT_DB_PATH = path.join(
  os.homedir(),
  '.openclaw',
  'learnloop',
  'learnloop.db',
);

export const defaultPluginConfig: Required<{ dbPath: string; retrieval: PluginRetrievalConfig }> = {
  dbPath: DEFAULT_DB_PATH,
  retrieval: {
    a: 0.3,
    b: 0.5,
    c: 0.2,
    lambda: 0.01,
  },
};

// ---------------------------------------------------------------------------
// Plugin type
// ---------------------------------------------------------------------------

export interface OpenClawPlugin {
  beforeTurn(input: BeforeTurnInput): Promise<BeforeTurnResult>;
  afterTask(input: AfterTaskInput): Promise<AfterTaskResult>;
  beforeSpawn(input: BeforeSpawnInput): Promise<BeforeSpawnResult>;
  /** Resolved configuration used by this plugin instance */
  readonly config: { dbPath: string; retrieval: PluginRetrievalConfig };
}

// ---------------------------------------------------------------------------
// createPlugin factory
// ---------------------------------------------------------------------------

/**
 * Create and initialize the OpenClaw LearnLoop plugin.
 *
 * Sets up the storage layer (SQLite + SearchEngine + StorageFacade) and returns
 * a plugin object with all three hooks wired together. Each hook wraps its
 * implementation in a top-level try/catch for silent degradation — exceptions
 * are logged but never re-thrown to the OpenClaw host process.
 *
 * @param config  Optional configuration; any missing fields use defaults.
 */
export function createPlugin(config?: PluginConfig): OpenClawPlugin {
  // Resolve final configuration (merge with defaults)
  const dbPath = config?.dbPath ?? defaultPluginConfig.dbPath;
  const retrieval: PluginRetrievalConfig = {
    a: config?.retrieval?.a ?? defaultPluginConfig.retrieval.a,
    b: config?.retrieval?.b ?? defaultPluginConfig.retrieval.b,
    c: config?.retrieval?.c ?? defaultPluginConfig.retrieval.c,
    lambda: config?.retrieval?.lambda ?? defaultPluginConfig.retrieval.lambda,
  };

  // Initialize dependencies
  const db = initializeDatabase(dbPath);
  const engine = createSearchEngine(db);
  const facade = new StorageFacade(db, engine);



  // -------------------------------------------------------------------------
  // beforeTurn
  // -------------------------------------------------------------------------

  async function beforeTurn(input: BeforeTurnInput): Promise<BeforeTurnResult> {
    try {
      return await handleBeforeTurn(db, facade, input, {
        recency: retrieval.a,
        relevance: retrieval.b,
        importance: retrieval.c,
        lambda: retrieval.lambda,
      });
    } catch (err) {
      // Silent degradation — log, return safe fallback
      console.error('[LearnLoop] beforeTurn: unexpected error', err);
      return {
        injected_memories: [],
        extraction_triggered: false,
      };
    }
  }

  // -------------------------------------------------------------------------
  // afterTask
  // -------------------------------------------------------------------------

  async function afterTask(input: AfterTaskInput): Promise<AfterTaskResult> {
    try {
      return await handleAfterTask(db, facade, input);
    } catch (err) {
      // Silent degradation — log, return safe fallback
      console.error('[LearnLoop] afterTask: unexpected error', err);
      return {
        reflection_id: null,
        outcome: null,
      };
    }
  }

  // -------------------------------------------------------------------------
  // beforeSpawn
  // -------------------------------------------------------------------------

  async function beforeSpawn(input: BeforeSpawnInput): Promise<BeforeSpawnResult> {
    try {
      return await handleBeforeSpawn(db, facade, input);
    } catch (err) {
      // Silent degradation — log, return safe fallback (original description unchanged)
      console.error('[LearnLoop] beforeSpawn: unexpected error', err);
      return {
        augmented_task_description: input.task_description,
        injected_reflections: [],
      };
    }
  }

  // -------------------------------------------------------------------------
  // Return plugin object
  // -------------------------------------------------------------------------

  return {
    beforeTurn,
    afterTask,
    beforeSpawn,
    config: { dbPath, retrieval },
  };
}
