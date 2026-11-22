/**
 * @license
 * Copyright 2026 CharlieTheAicorn contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shadow mode for consent delegation: record what a decision model WOULD answer, next to what the human answered.
 *
 * It never answers an agent. This directory must not import anything that can (a unit test guards that).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ShadowAnswer, ShadowObservation } from '@/common/types/permissionShadow';
import { ASK_MANAGER, judge } from './judge';
import { normalizeRequest } from './normalize';
import { alwaysUserReason } from './rules';

export type ShadowAgent = { assistant_id?: string; name?: string; workspace?: string };

export type ShadowConfig = {
  enabled: boolean;
  endpoint: string;
  model: string;
  threshold: number;
  timeout_ms: number;
  default_policy: string;
  /** Short plain-language rules, keyed by assistant id or by agent (conversation) name. */
  policies: Record<string, string>;
};

export const DEFAULT_CONFIG: ShadowConfig = {
  enabled: false,
  endpoint: 'http://127.0.0.1:11434',
  model: 'tev1:latest',
  threshold: 0.9,
  timeout_ms: 8000,
  default_policy:
    'The agent may read, search and list inside its workspace and talk to its own team. ' +
    'Everything else needs the manager.',
  policies: {},
};

// tev1 runs with num_ctx 2048. A longer request is escalated whole, never judged by its first part.
export const MAX_STATE_CHARS = 1500;
const MAX_CONTEXT_CHARS = 300;
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_TRACKED = 2000;

export function redact(text: string): string {
  return text
    .replace(/-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?(?:-----END[^-]*-----|$)/g, '<redacted key>')
    .replace(/\b(Bearer|Basic)\s+[\w.~+/=-]{8,}/gi, '$1 <redacted>')
    .replace(
      /([\w-]*(?:api[_-]?key|token|secret|password|passwd)\\?["']?\s*[:=]\s*\\?["']?)[^\s"'\\,;]+/gi,
      '$1<redacted>'
    )
    .replace(/\b(?:sk-|gh[pousr]_|xox[abpr]-)[\w-]{12,}/g, '<redacted>');
}

export function createPermissionShadow(deps: {
  dir: string;
  resolveAgent: (conversationId: string) => Promise<ShadowAgent>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}) {
  const configFile = path.join(deps.dir, 'config.json');
  const logFile = path.join(deps.dir, 'decisions.jsonl');
  const now = deps.now ?? (() => new Date());
  const seen = new Set<string>();
  let writes: Promise<void> = Promise.resolve();

  async function ensureConfig(): Promise<void> {
    await fs.mkdir(deps.dir, { recursive: true, mode: 0o700 });
    // `wx`: never overwrite what the user configured.
    await fs
      .writeFile(configFile, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
  }

  async function readConfig(): Promise<ShadowConfig> {
    try {
      return { ...DEFAULT_CONFIG, ...(JSON.parse(await fs.readFile(configFile, 'utf8')) as Partial<ShadowConfig>) };
    } catch {
      // Missing or broken config means off.
      return DEFAULT_CONFIG;
    }
  }

  function append(record: Record<string, unknown>): Promise<void> {
    const write = writes.then(async () => {
      await fs.mkdir(deps.dir, { recursive: true, mode: 0o700 });
      const size = await fs.stat(logFile).then(
        (stat) => stat.size,
        () => 0
      );
      if (size > MAX_LOG_BYTES) await fs.rename(logFile, `${logFile}.1`);
      await fs.appendFile(logFile, `${JSON.stringify({ at: now().toISOString(), ...record })}\n`, { mode: 0o600 });
    });
    writes = write.catch((): void => undefined);
    return writes;
  }

  async function observe(frame: ShadowObservation): Promise<void> {
    try {
      const request = normalizeRequest(frame);
      if (!request) return;
      const config = await readConfig();
      // A reconnect or a second window replays the same request.
      if (config.enabled !== true || seen.has(request.key)) return;
      seen.add(request.key);
      if (seen.size > MAX_TRACKED) seen.delete(seen.values().next().value as string);

      const agent = await deps.resolveAgent(request.conversation_id).catch((): ShadowAgent => ({}));
      const policy =
        config.policies?.[agent.assistant_id ?? ''] ?? config.policies?.[agent.name ?? ''] ?? config.default_policy;
      const record: Record<string, unknown> = {
        event: 'request',
        key: request.key,
        agent: agent.name,
        assistant_id: agent.assistant_id,
        source: request.source,
        tool: redact(request.tool),
        question: redact(request.question).slice(0, 4000),
        options: request.options.map(({ key, value }) => ({ key, value })),
        policy,
      };
      const escalate = (stage: string, to: 'user' | 'manager', reason?: string) =>
        append({ ...record, stage, reason, would: { route: to } });

      const reason = alwaysUserReason(request);
      if (reason) return await escalate('rule', 'user', reason);
      // Nobody can decide on half a command, the manager included.
      if (request.unjudgeable) return await escalate(request.unjudgeable, 'user');

      const required = `Agent rules: ${policy}\nWorkspace: ${agent.workspace ?? 'unknown'}\nAgent's question: ${request.question}`;
      if (required.length > MAX_STATE_CHARS) return await escalate('too_long', 'manager');

      const context = (frame.context ?? '').slice(-MAX_CONTEXT_CHARS);
      const withContext = `${required}\nContext: ${context}`;
      const state = context && withContext.length <= MAX_STATE_CHARS ? withContext : required;

      const started = Date.now();
      try {
        const { choice, probabilities } = await judge({
          endpoint: config.endpoint,
          model: config.model,
          timeoutMs: config.timeout_ms,
          state,
          options: request.options,
          fetchImpl: deps.fetchImpl ?? fetch,
        });
        const option = request.options.find((candidate) => candidate.key === choice);
        // A threshold that is not a sane number must not turn into "always confident".
        const threshold =
          typeof config.threshold === 'number' && config.threshold >= 0.5 && config.threshold <= 1
            ? config.threshold
            : 1.01;
        const confident = option && choice !== ASK_MANAGER && probabilities[choice] >= threshold;
        await append({
          ...record,
          stage: 'model',
          context: redact(context),
          model: config.model,
          threshold,
          ms: Date.now() - started,
          choice,
          probabilities,
          would: confident ? { route: 'model', key: choice, value: option.value } : { route: 'manager' },
        });
      } catch (error) {
        await escalate('error', 'manager', redact(String(error)).slice(0, 200));
      }
    } catch (error) {
      console.warn('[PermissionShadow] observe failed:', error);
    }
  }

  async function recordAnswer(params: ShadowAnswer): Promise<void> {
    try {
      if ((await readConfig()).enabled !== true) return;
      await append({
        event: 'answer',
        key: `${params.conversation_id}:${params.call_id}`,
        answer: redact(JSON.stringify(params.answer ?? null)).slice(0, 2000),
      });
    } catch (error) {
      console.warn('[PermissionShadow] recordAnswer failed:', error);
    }
  }

  return { ensureConfig, observe, recordAnswer };
}
