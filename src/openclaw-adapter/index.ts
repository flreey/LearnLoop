/**
 * LearnLoop — OpenClaw Plugin Adapter
 *
 * Bridges LearnLoop's 3-hook SDK (beforeTurn, afterTask, beforeSpawn) into
 * OpenClaw's plugin lifecycle system via api.on() hooks.
 *
 * Hook mapping:
 *   beforeTurn  → before_prompt_build  (inject memories as prependSystemContext)
 *   afterTask   → agent_end           (extract reflections from completed runs)
 *   beforeSpawn → subagent_spawning   (augment task description with reflections)
 *
 * Optimizations:
 *   1. Delta extraction: only sends new messages since last extraction (not full history)
 *   2. Throttling: same session only triggers extraction/reflection once per THROTTLE_MS
 *   3. Importance-gated reflection: reflection only fires for subagent tasks or when
 *      accumulated delta >= 6 messages. Memory extraction always runs (cheap).
 *
 * LLM configuration:
 *   Uses OPENCLAW_API_KEY / OPENCLAW_API_BASE env vars (set by plugin config).
 *   Falls back to OPENAI_API_KEY / default OpenAI base URL.
 */

import { createPlugin, type PluginConfig, type OpenClawPlugin } from '../plugin.js';
import type { Message } from '../types/index.js';

// ---------------------------------------------------------------------------
// Cost control constants
// ---------------------------------------------------------------------------

/** Minimum interval between extraction+reflection per session (ms) */
const THROTTLE_MS = 5 * 60 * 1000; // 5 minutes

/** Max messages to send to LLM per call */
const MAX_HISTORY_WINDOW = 10;

// ---------------------------------------------------------------------------
// Per-session state for delta tracking + throttling
// ---------------------------------------------------------------------------

interface SessionTrack {
  /** Index into the full message list: next extraction starts here */
  lastExtractedIdx: number;
  /** Timestamp of last extraction run */
  lastRunAt: number;
}

const sessionStates = new Map<string, SessionTrack>();

// Track session conversations (kept for subagent_ended which lacks event.messages)
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

  if (pluginConfig?.apiKey && typeof pluginConfig.apiKey === 'string') {
    process.env['OPENCLAW_API_KEY'] = pluginConfig.apiKey;
  } else if (!process.env['OPENCLAW_API_KEY'] && !process.env['OPENAI_API_KEY']) {
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

// ---------------------------------------------------------------------------
// Shared: extract text from Anthropic-format messages
// ---------------------------------------------------------------------------

function extractText(msg: any): string | null {
  if (!msg || typeof msg !== 'object') return null;
  const role = msg.role;
  if (role !== 'user' && role !== 'assistant') return null;

  if (typeof msg.content === 'string') return msg.content;

  if (Array.isArray(msg.content)) {
    const textParts = msg.content
      .filter((b: any) => b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string')
      .map((b: any) => b.text);
    return textParts.length > 0 ? textParts.join('\n') : null;
  }

  return null;
}

function parseHistory(rawMessages: unknown[]): Message[] {
  const history: Message[] = [];
  for (const m of rawMessages) {
    const text = extractText(m);
    if (text && text.trim()) {
      history.push({ role: (m as any).role, content: text });
    }
  }
  return history;
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
    // Hook: before_prompt_build → beforeTurn (inject memories)
    // ======================================================================

    api.on('before_prompt_build', async (
      event: { prompt: string; messages?: unknown[] },
      ctx: { agentId?: string; sessionKey?: string },
    ) => {
      // Build conversation_context: prefer joined message text over raw prompt
      let conversationContext: string;
      if (Array.isArray(event.messages) && event.messages.length > 0) {
        const parsed = parseHistory(event.messages);
        conversationContext = parsed.map(m => m.content).join('\n').trim() || event.prompt;
      } else {
        conversationContext = event.prompt;
      }

      if (!conversationContext || conversationContext.length < 5) return;
      if (!ctx.sessionKey) return;

      try {
        const result = await plugin.beforeTurn({
          session_key: ctx.sessionKey,
          conversation_context: conversationContext,
          previous_session_key: null,
          previous_conversation_history: null,
        });

        if (result.injected_memories.length > 0) {
          log.info(`learnloop: injecting ${result.injected_memories.length} memories`);
          const memoryBlock = result.injected_memories
            .map(m => `- [${m.type}] ${m.content}`)
            .join('\n');
          return {
            prependSystemContext: `\n<learnloop_memories>\nRelevant memories from past sessions:\n${memoryBlock}\n</learnloop_memories>\n`,
          };
        }
      } catch (err) {
        log.warn(`learnloop: beforeTurn error: ${String(err)}`);
      }
      return undefined;
    });

    // ======================================================================
    // Hook: llm_output → track conversation (for subagent_ended)
    // ======================================================================

    api.on('llm_output', (
      event: { assistantTexts: string[] },
      ctx: { sessionKey?: string },
    ) => {
      if (!ctx.sessionKey) return;
      const existing = sessionConversations.get(ctx.sessionKey) || [];
      for (const text of event.assistantTexts) {
        if (text) existing.push({ role: 'assistant', content: text });
      }
      sessionConversations.set(ctx.sessionKey, existing);
    });

    // ======================================================================
    // Hook: llm_input → track user prompts (for subagent_ended)
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
    // Hook: agent_end → memory extraction + conditional reflection
    //
    // Cost controls:
    //   1. Throttle: skip if same session ran < 5min ago
    //   2. Delta: only new messages since last extraction
    //   3. Window: max 10 messages per LLM call
    //   4. Reflection gating: only for subagent or delta >= 6
    // ======================================================================

    api.on('agent_end', async (
      event: { messages: unknown[]; success: boolean; error?: string; durationMs?: number },
      ctx: { agentId?: string; sessionKey?: string },
    ) => {
      if (!ctx.sessionKey) return;

      const rawMessages = Array.isArray(event.messages) ? event.messages : [];
      const fullHistory = parseHistory(rawMessages);

      if (fullHistory.length < 2) return;

      // --- Throttle check ---
      const now = Date.now();
      const track = sessionStates.get(ctx.sessionKey);
      if (track && (now - track.lastRunAt) < THROTTLE_MS) {
        track.lastExtractedIdx = fullHistory.length;
        return;
      }

      // --- Delta: only new messages since last extraction ---
      const startIdx = track?.lastExtractedIdx ?? 0;
      const delta = fullHistory.slice(startIdx);

      if (delta.length < 2) {
        sessionStates.set(ctx.sessionKey, {
          lastExtractedIdx: fullHistory.length,
          lastRunAt: track?.lastRunAt ?? 0,
        });
        return;
      }

      const window = delta.slice(-MAX_HISTORY_WINDOW);

      log.info(`learnloop: agent_end — session=${ctx.sessionKey} full=${fullHistory.length} delta=${delta.length} window=${window.length}`);

      // Update state immediately (prevents concurrent duplicate runs)
      sessionStates.set(ctx.sessionKey, {
        lastExtractedIdx: fullHistory.length,
        lastRunAt: now,
      });

      // --- Always: extract memories (1 LLM call, ~3K tokens) ---
      try {
        const memResult = await plugin.extractMemoriesNow(ctx.sessionKey, window);
        if (memResult.extracted > 0) {
          log.info(`learnloop: extracted ${memResult.extracted} memories (${memResult.conflicts} conflicts) for ${ctx.sessionKey}`);
        }
      } catch (err) {
        log.warn(`learnloop: memory extraction error: ${String(err)}`);
      }

      // --- Conditional reflection: subagent always; regular only if delta >= 6 ---
      const isSubagent = ctx.sessionKey?.includes(':subagent:') ?? false;
      if (!isSubagent && delta.length < 6) return;

      try {
        const result = await plugin.afterTask({
          session_key: ctx.sessionKey,
          task_type: isSubagent ? 'subagent' : 'agent_run',
          task_summary: window[0]?.content?.slice(0, 200) ?? 'Agent run',
          conversation_history: window,
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

      sessionConversations.delete(ctx.sessionKey);
    });

    // ======================================================================
    // Hook: subagent_ended → afterTask (sub-agent tasks always reflect)
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
          conversation_history: history.slice(-MAX_HISTORY_WINDOW),
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
    // Hook: subagent_spawning (informational)
    // ======================================================================

    api.on('subagent_spawning', async (
      event: { childSessionKey: string; agentId: string; label?: string },
      _ctx: any,
    ) => {
      log.info?.(`learnloop: subagent spawning — agent=${event.agentId}, label=${event.label ?? 'none'}`);
    });

    // ======================================================================
    // Hook: session_end → cleanup
    // ======================================================================

    api.on('session_end', (
      event: { sessionId: string },
      _ctx: any,
    ) => {
      sessionConversations.delete(event.sessionId);
      sessionStates.delete(event.sessionId);
    });

    // ======================================================================
    // Service
    // ======================================================================

    api.registerService({
      id: 'learnloop',
      start: () => log.info(`learnloop: service started (db: ${plugin.config.dbPath})`),
      stop: () => {
        log.info('learnloop: service stopped');
        sessionConversations.clear();
        sessionStates.clear();
        learnloop = null;
      },
    });

    // ======================================================================
    // CLI Commands
    // ======================================================================

    api.registerCli(
      ({ program }: any) => {
        const cmd = program.command('learnloop').description('LearnLoop memory & learning plugin');
        cmd
          .command('stats')
          .description('Show memory and reflection counts')
          .action(async () => {
            const stats = {
              dbPath: plugin.config.dbPath,
              activeSessions: sessionStates.size,
              trackedConversations: sessionConversations.size,
            };
            console.log(JSON.stringify(stats, null, 2));
          });
      },
    );
  },
};

export default learnloopPlugin;
