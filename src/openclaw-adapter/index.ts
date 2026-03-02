/**
 * LearnLoop — OpenClaw Plugin Adapter
 *
 * Bridges LearnLoop's 3-hook SDK (beforeTurn, afterTask, beforeSpawn) into
 * OpenClaw's plugin lifecycle system via api.on() hooks.
 *
 * Hook mapping:
 *   beforeTurn  → before_agent_start  (inject memories as prependContext)
 *   afterTask   → agent_end           (extract reflections from completed runs)
 *   beforeSpawn → subagent_spawning   (augment task description with reflections)
 *
 * LLM configuration:
 *   Uses OPENCLAW_API_KEY / OPENCLAW_API_BASE env vars (set by plugin config).
 *   Falls back to OPENAI_API_KEY / default OpenAI base URL.
 */

import { createPlugin, type PluginConfig, type OpenClawPlugin } from '../plugin.js';
import type { Message } from '../types/index.js';

// Track session conversations for reflection extraction
const sessionConversations = new Map<string, Message[]>();

// LearnLoop plugin instance (lazy init)
let learnloop: OpenClawPlugin | null = null;

function getPlugin(pluginConfig?: Record<string, unknown>): OpenClawPlugin {
  if (learnloop) return learnloop;

  const config: PluginConfig = {};

  if (pluginConfig?.dbPath && typeof pluginConfig.dbPath === 'string') {
    config.dbPath = pluginConfig.dbPath;
  }

  if (pluginConfig?.retrieval && typeof pluginConfig.retrieval === 'object') {
    const r = pluginConfig.retrieval as Record<string, unknown>;
    config.retrieval = {
      a: typeof r.a === 'number' ? r.a : undefined,
      b: typeof r.b === 'number' ? r.b : undefined,
      c: typeof r.c === 'number' ? r.c : undefined,
      lambda: typeof r.lambda === 'number' ? r.lambda : undefined,
    };
  }

  // Set LLM env vars: plugin config > existing env vars > ANTHROPIC_AUTH_TOKEN fallback
  if (pluginConfig?.apiKey && typeof pluginConfig.apiKey === 'string') {
    process.env['OPENCLAW_API_KEY'] = pluginConfig.apiKey;
  } else if (!process.env['OPENCLAW_API_KEY'] && !process.env['OPENAI_API_KEY']) {
    // Fallback: use ANTHROPIC_AUTH_TOKEN if no other key is set
    const fallbackKey = process.env['ANTHROPIC_AUTH_TOKEN'] ?? process.env['ANTHROPIC_API_KEY'];
    if (fallbackKey) {
      process.env['OPENCLAW_API_KEY'] = fallbackKey;
    }
  }
  if (pluginConfig?.apiBase && typeof pluginConfig.apiBase === 'string') {
    process.env['OPENCLAW_API_BASE'] = pluginConfig.apiBase;
  }
  if (pluginConfig?.model && typeof pluginConfig.model === 'string') {
    process.env['OPENCLAW_LLM_MODEL'] = pluginConfig.model;
  }

  learnloop = createPlugin(config);
  return learnloop;
}

// ============================================================================
// OpenClaw Plugin Definition
// ============================================================================

const learnloopPlugin = {
  id: 'learnloop',
  name: 'LearnLoop',
  description: 'Agent Memory & Learning — automatic memory extraction, reflection generation, and context injection',
  version: '0.1.0',

  register(api: any) {
    const plugin = getPlugin(api.pluginConfig);
    const log = api.logger;

    log.info(`learnloop: registered (db: ${plugin.config.dbPath})`);

    // ======================================================================
    // Hook: before_agent_start → beforeTurn
    //
    // Triggers lazy extraction of previous session memories and injects
    // relevant memories into the agent's context as prependContext.
    // ======================================================================

    api.on('before_agent_start', async (
      event: { prompt: string; messages?: unknown[] },
      ctx: { agentId?: string; sessionKey?: string },
    ) => {
      if (!event.prompt || event.prompt.length < 5) return;
      if (!ctx.sessionKey) return;

      try {
        const result = await plugin.beforeTurn({
          session_key: ctx.sessionKey,
          conversation_context: event.prompt,
          // OpenClaw doesn't provide previous session info directly;
          // LearnLoop tracks this internally via session_states table
          previous_session_key: null,
          previous_conversation_history: null,
        });

        if (result.injected_memories.length > 0) {
          log.info(`learnloop: injecting ${result.injected_memories.length} memories`);

          const memoryBlock = result.injected_memories
            .map(m => `- [${m.type}] ${m.content}`)
            .join('\n');

          return {
            prependContext: `\n<learnloop_memories>\nRelevant memories from past sessions:\n${memoryBlock}\n</learnloop_memories>\n`,
          };
        }
      } catch (err) {
        log.warn(`learnloop: beforeTurn error: ${String(err)}`);
      }
      return undefined;
    });

    // ======================================================================
    // Hook: llm_output → track conversation messages
    //
    // Collects assistant messages per session for reflection generation.
    // ======================================================================

    api.on('llm_output', (
      event: { assistantTexts: string[] },
      ctx: { sessionKey?: string },
    ) => {
      if (!ctx.sessionKey) return;

      const existing = sessionConversations.get(ctx.sessionKey) || [];
      for (const text of event.assistantTexts) {
        if (text) {
          existing.push({ role: 'assistant', content: text });
        }
      }
      sessionConversations.set(ctx.sessionKey, existing);
    });

    // ======================================================================
    // Hook: llm_input → track user prompts
    // ======================================================================

    api.on('llm_input', (
      event: { prompt: string },
      ctx: { sessionKey?: string },
    ) => {
      if (!ctx.sessionKey || !event.prompt) return;

      const existing = sessionConversations.get(ctx.sessionKey) || [];
      existing.push({ role: 'user', content: event.prompt });
      sessionConversations.set(ctx.sessionKey, existing);
    });

    // ======================================================================
    // Hook: agent_end → afterTask
    //
    // When an agent run completes, generates a reflection from the
    // conversation history and stores it for future retrieval.
    // ======================================================================

    api.on('agent_end', async (
      event: { messages: unknown[]; success: boolean; error?: string; durationMs?: number },
      ctx: { agentId?: string; sessionKey?: string },
    ) => {
      if (!ctx.sessionKey) return;

      const history = sessionConversations.get(ctx.sessionKey) || [];

      // Only reflect on sessions with meaningful conversation
      if (history.length < 2) return;

      try {
        const result = await plugin.afterTask({
          session_key: ctx.sessionKey,
          task_type: 'agent_run',
          task_summary: history[0]?.content?.slice(0, 200) ?? 'Agent run',
          conversation_history: history,
          signals: {
            user_feedback: null,
            review_result: event.success ? 'PASS' : 'FAIL',
            was_respawned: false,
            timed_out: false,
          },
          agent_id: ctx.agentId ?? null,
        });

        if (result.reflection_id) {
          log.info(`learnloop: reflection generated (${result.outcome}) for ${ctx.sessionKey}`);
        }
      } catch (err) {
        log.warn(`learnloop: afterTask error: ${String(err)}`);
      }

      // Clean up tracked conversation
      sessionConversations.delete(ctx.sessionKey);
    });

    // ======================================================================
    // Hook: subagent_ended → afterTask (for sub-agent tasks)
    //
    // Sub-agent completions carry more structured task info (outcome, type).
    // ======================================================================

    api.on('subagent_ended', async (
      event: {
        targetSessionKey: string;
        reason: string;
        outcome?: string;
        error?: string;
      },
      ctx: { runId?: string; childSessionKey?: string },
    ) => {
      const sessionKey = event.targetSessionKey || ctx.childSessionKey;
      if (!sessionKey) return;

      const history = sessionConversations.get(sessionKey) || [];
      if (history.length < 1) return;

      try {
        const result = await plugin.afterTask({
          session_key: sessionKey,
          task_type: 'subagent',
          task_summary: history[0]?.content?.slice(0, 200) ?? 'Sub-agent task',
          conversation_history: history,
          signals: {
            user_feedback: null,
            review_result: event.outcome === 'ok' ? 'PASS' : (event.outcome === 'error' ? 'FAIL' : null),
            was_respawned: false,
            timed_out: event.outcome === 'timeout',
          },
          agent_id: null,
        });

        if (result.reflection_id) {
          log.info(`learnloop: subagent reflection generated (${result.outcome})`);
        }
      } catch (err) {
        log.warn(`learnloop: subagent afterTask error: ${String(err)}`);
      }

      sessionConversations.delete(sessionKey);
    });

    // ======================================================================
    // Hook: subagent_spawning → beforeSpawn
    //
    // Not directly usable — subagent_spawning doesn't carry task_description
    // in a way we can augment and return. The event is informational.
    // We log it for now; augmentation happens via before_agent_start on the
    // child session.
    // ======================================================================

    api.on('subagent_spawning', async (
      event: { childSessionKey: string; agentId: string; label?: string },
      _ctx: any,
    ) => {
      log.info?.(`learnloop: subagent spawning — agent=${event.agentId}, label=${event.label ?? 'none'}`);
    });

    // ======================================================================
    // Hook: session_end → cleanup conversation tracking
    // ======================================================================

    api.on('session_end', (
      event: { sessionId: string },
      _ctx: any,
    ) => {
      // Clean up any remaining tracked conversations
      sessionConversations.delete(event.sessionId);
    });

    // ======================================================================
    // Service
    // ======================================================================

    api.registerService({
      id: 'learnloop',
      start: () => {
        log.info(`learnloop: service started (db: ${plugin.config.dbPath})`);
      },
      stop: () => {
        log.info('learnloop: service stopped');
        sessionConversations.clear();
        learnloop = null;
      },
    });

    // ======================================================================
    // CLI Commands
    // ======================================================================

    api.registerCli(
      ({ program }: any) => {
        const cmd = program.command('learnloop').description('LearnLoop memory & learning plugin');

        cmd.command('stats')
          .description('Show memory and reflection statistics')
          .action(async () => {
            const p = getPlugin(api.pluginConfig);
            console.log(`LearnLoop v0.1.0`);
            console.log(`DB: ${p.config.dbPath}`);
            console.log(`Retrieval weights: a=${p.config.retrieval.a} b=${p.config.retrieval.b} c=${p.config.retrieval.c}`);
          });
      },
      { commands: ['learnloop'] },
    );
  },
};

export default learnloopPlugin;
