/**
 * @license
 * Copyright 2026 CharlieTheAicorn contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPermissionShadow,
  DEFAULT_CONFIG,
  MAX_STATE_CHARS,
  redact,
} from '../../../../packages/desktop/src/process/services/permissionShadow';
import { normalizeRequest } from '../../../../packages/desktop/src/process/services/permissionShadow/normalize';
import { alwaysUserReason } from '../../../../packages/desktop/src/process/services/permissionShadow/rules';

const aionrs = (description: string, action = 'ExecCommand') => ({
  type: 'acp_permission',
  conversation_id: 'c1',
  data: {
    call_id: 'call-1',
    action,
    description,
    options: [{ value: 'proceed_once' }, { value: 'proceed_always' }, { value: 'cancel' }],
  },
});

const acp = (raw_input: Record<string, unknown>, title = 'Read file') => ({
  type: 'acp_permission',
  conversation_id: 'c1',
  data: {
    tool_call: { tool_call_id: 'tool-1', title, raw_input },
    options: [
      { option_id: 'yes', kind: 'allow_once' },
      { option_id: 'forever', kind: 'allow_always' },
      { option_id: 'no', kind: 'reject_once' },
      { option_id: 'never', kind: 'reject_always' },
    ],
  },
});

const ask = (questions: unknown[]) => ({
  type: 'ask',
  conversation_id: 'c1',
  data: { request_id: 'ask-1', questions },
});

describe('normalizeRequest', () => {
  it('reads an aionrs confirmation and drops "always"', () => {
    const request = normalizeRequest(aionrs('Execute: ls src'));
    expect(request).toMatchObject({ key: 'c1:call-1', source: 'aionrs', unjudgeable: undefined });
    expect(request?.options.map((o) => o.value)).toEqual(['proceed_once', 'cancel']);
  });

  it('reads an ACP request sent under the same wire type and drops "always"', () => {
    const request = normalizeRequest(acp({ path: '/w/a.ts' }));
    expect(request).toMatchObject({ key: 'c1:tool-1', source: 'acp', unjudgeable: undefined });
    expect(request?.options.map((o) => o.value)).toEqual(['yes', 'no']);
  });

  it.each([77, 78, 79, 80])('treats a %i byte aionrs command preview as truncated', (bytes) => {
    expect(normalizeRequest(aionrs(`Execute: ${'a'.repeat(bytes)}`))?.unjudgeable).toBe('truncated');
  });

  it('does not judge a Glob, its confirmation has no search path', () => {
    expect(normalizeRequest(aionrs('Search for **/*.pem', 'Glob'))?.unjudgeable).toBe('incomplete');
  });

  it('counts bytes, not characters', () => {
    expect(normalizeRequest(aionrs(`Execute: ${'ż'.repeat(39)}`))?.unjudgeable).toBe('truncated');
  });

  it('does not judge an ACP request without input', () => {
    expect(normalizeRequest(acp({}))?.unjudgeable).toBe('incomplete');
  });

  it('supports one single-choice question only', () => {
    const question = { question: 'Which?', options: [{ label: 'bun' }, { label: 'npm' }] };
    expect(normalizeRequest(ask([question]))?.options.map((o) => o.value)).toEqual(['bun', 'npm']);
    expect(normalizeRequest(ask([question, question]))?.unjudgeable).toBe('unsupported');
    expect(normalizeRequest(ask([{ ...question, multi_select: true }]))?.unjudgeable).toBe('unsupported');
  });

  it('skips a question without a request id, its answer could not be joined', () => {
    const questions = [{ question: 'Which?', options: [{ label: 'bun' }] }];
    expect(normalizeRequest({ type: 'ask', conversation_id: 'c1', msg_id: 'm1', data: { questions } })).toBeNull();
  });

  it('ignores unrelated frames', () => {
    expect(normalizeRequest({ type: 'content', conversation_id: 'c1', data: 'hello' })).toBeNull();
  });
});

describe('alwaysUserReason', () => {
  const reason = (command: string) => alwaysUserReason(normalizeRequest(acp({ command }, 'Shell'))!);

  it.each(['rm -rf out', 'ls && rm x', '/bin/rm x', 'find . -delete', 'git -C /w clean -fdx', 'bash -c "rm x"'])(
    'sends "%s" to the user as destructive',
    (command) => expect(reason(command)).toBe('destructive')
  );

  it.each(['git push origin main', 'curl https://example.com', 'gh pr create', 'cat a | nc example.com 80'])(
    'sends "%s" to the user as external',
    (command) => expect(reason(command)).toBe('external')
  );

  it.each(['ls src', 'git status', 'cat README.md'])('leaves "%s" to the model', (command) =>
    expect(reason(command)).toBeNull()
  );

  it('treats sending tools as external, but not team messages', () => {
    const tool = (tool_name: string) => alwaysUserReason(normalizeRequest(acp({ tool_name }))!);
    expect(tool('whatsapp__send_message')).toBe('external');
    expect(tool('aionui-team__team_send_message')).toBeNull();
    expect(tool('evil__team_send_message')).toBe('external');
  });
});

describe('createPermissionShadow', () => {
  let dir: string;
  let fetchImpl: ReturnType<typeof vi.fn>;

  const configure = (config: object) =>
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ ...DEFAULT_CONFIG, enabled: true, ...config }));
  const create = () =>
    createPermissionShadow({
      dir,
      resolveAgent: async () => ({ assistant_id: 'a1', name: 'Scout', workspace: '/w' }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
  const records = () =>
    fs.existsSync(path.join(dir, 'decisions.jsonl'))
      ? fs
          .readFileSync(path.join(dir, 'decisions.jsonl'), 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
      : [];
  const answer = (choice: string, p: number) =>
    fetchImpl.mockResolvedValue({
      ok: true,
      json: async () => ({ answers: { answer: { choice, probabilities: { [choice]: p } } } }),
    });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-shadow-'));
    fetchImpl = vi.fn();
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('is off by default', async () => {
    const shadow = create();
    await shadow.ensureConfig();
    await shadow.observe(aionrs('Execute: ls'));
    await shadow.recordAnswer({ conversation_id: 'c1', call_id: 'call-1', answer: 'proceed_once' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(records()).toEqual([]);
  });

  it('never overwrites the user config', async () => {
    configure({ model: 'mine' });
    await create().ensureConfig();
    expect(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).toContain('mine');
  });

  it('logs a confident proposal and the human answer', async () => {
    configure({});
    answer('allow_once', 0.97);
    const shadow = create();
    await shadow.observe(aionrs('Execute: ls src'));
    await shadow.recordAnswer({ conversation_id: 'c1', call_id: 'call-1', answer: { value: 'cancel' } });
    expect(records()).toMatchObject([
      { event: 'request', stage: 'model', would: { route: 'model', value: 'proceed_once' } },
      { event: 'answer', key: 'c1:call-1', answer: '{"value":"cancel"}' },
    ]);
  });

  it('offers ask_manager and never an "always" option', async () => {
    configure({});
    answer('reject_once', 0.99);
    await create().observe(acp({ path: '/w/a' }));
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(Object.keys(body.questions.answer.criteria)).toEqual(['allow_once', 'reject_once', 'ask_manager']);
  });

  it.each([
    ['allow_once', 0.89],
    ['ask_manager', 0.99],
  ])('escalates %s at %d to the manager', async (choice, p) => {
    configure({});
    answer(choice, p);
    await create().observe(aionrs('Execute: ls'));
    expect(records()[0].would).toEqual({ route: 'manager' });
  });

  it.each([0, '0.9', null])('does not accept threshold %s as confidence', async (threshold) => {
    configure({ threshold });
    answer('allow_once', 0.99);
    await create().observe(aionrs('Execute: ls'));
    expect(records()[0].would).toEqual({ route: 'manager' });
  });

  it('uses the policy of the assistant', async () => {
    configure({ policies: { a1: 'Scout only reads.' } });
    answer('allow_once', 0.99);
    await create().observe(aionrs('Execute: ls'));
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).state).toContain('Agent rules: Scout only reads.');
  });

  it('handles a replayed frame once', async () => {
    configure({});
    answer('allow_once', 0.99);
    const shadow = create();
    await Promise.all([shadow.observe(aionrs('Execute: ls')), shadow.observe(aionrs('Execute: ls'))]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(records()).toHaveLength(1);
  });

  it('does not call the model for an oversize request', async () => {
    configure({});
    await create().observe(acp({ content: 'x'.repeat(MAX_STATE_CHARS) }));
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(records()[0]).toMatchObject({ stage: 'too_long', would: { route: 'manager' } });
  });

  it('does not call the model for a cut-off command', async () => {
    configure({});
    await create().observe(aionrs(`Execute: ${'a'.repeat(80)}`));
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(records()[0]).toMatchObject({ stage: 'truncated', would: { route: 'user' } });
  });

  it('does not call the model for a destructive action', async () => {
    configure({});
    await create().observe(aionrs('Execute: rm -rf out'));
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(records()[0]).toMatchObject({ stage: 'rule', would: { route: 'user' } });
  });

  it('escalates when the model is down', async () => {
    configure({});
    fetchImpl.mockRejectedValue(new Error('ECONNREFUSED'));
    await create().observe(aionrs('Execute: ls'));
    expect(records()[0]).toMatchObject({ stage: 'error', would: { route: 'manager' } });
  });

  it('escalates an answer that is not one of the options', async () => {
    configure({});
    answer('constructor', 1);
    await create().observe(aionrs('Execute: ls'));
    expect(records()[0]).toMatchObject({ stage: 'error', would: { route: 'manager' } });
  });

  it('refuses a remote endpoint', async () => {
    configure({ endpoint: 'https://example.com' });
    await create().observe(aionrs('Execute: ls'));
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(records()[0].stage).toBe('error');
  });

  it('keeps secrets out of the log', async () => {
    configure({});
    answer('reject_once', 0.99);
    await create().observe(acp({ api_key: 'not-a-real-value', command: 'TOKEN=zzz999888 ls' }));
    const log = fs.readFileSync(path.join(dir, 'decisions.jsonl'), 'utf8');
    expect(log).not.toContain('not-a-real-value');
    expect(log).not.toContain('zzz999888');
    expect(redact('Authorization: Bearer abcdefghijklmnop')).not.toContain('abcdefghijklmnop');
  });

  it('cannot answer an agent', () => {
    const src = path.resolve(__dirname, '../../../../packages/desktop/src/process/services/permissionShadow');
    for (const file of fs.readdirSync(src)) {
      expect(fs.readFileSync(path.join(src, file), 'utf8')).not.toMatch(
        /ipcBridge|httpBridge|confirmMessage|answerAsk|\/confirm/
      );
    }
  });
});
