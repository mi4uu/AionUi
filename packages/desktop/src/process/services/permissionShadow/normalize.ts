/**
 * @license
 * Copyright 2026 CharlieTheAicorn contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ShadowObservation } from '@/common/types/permissionShadow';

export type ShadowOption = { key: string; description: string; value: unknown };

export type ShadowRequest = {
  key: string;
  conversation_id: string;
  call_id: string;
  source: 'aionrs' | 'acp' | 'ask';
  tool: string;
  kind: string;
  question: string;
  options: ShadowOption[];
  /** Set when the request must not be judged, because not all of it is known. */
  unjudgeable?: 'truncated' | 'incomplete' | 'unsupported';
};

// aionrs describes a command as `Execute: ` + the first 80 bytes of it (exec_command.rs `describe`).
// A multi-byte character at the cut can leave the preview up to 3 bytes shorter.
const AIONRS_EXEC_PREFIX = 'Execute: ';
const AIONRS_PREVIEW_MIN_CUT_BYTES = 77;

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const asText = (value: unknown): string => (typeof value === 'string' ? value : '');
const asList = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.map(asRecord) : []);

// aionrs `describe()` leaves the search root out for Glob, so "inside the workspace" cannot be decided.
const AIONRS_TOOLS_WITHOUT_TARGET = new Set(['Glob']);

const ALLOW = 'Allow this one action: the rules clearly permit every part of it.';
const REJECT = 'Reject the action: the rules forbid some part of it.';

/**
 * Both backends use the wire type `acp_permission`, so the payload shape decides, not the type.
 * "Always" options are dropped on purpose: a model must never create a standing permission.
 */
export function normalizeRequest(frame: ShadowObservation): ShadowRequest | null {
  const data = asRecord(frame.data);
  const { conversation_id } = frame;
  if (!conversation_id) return null;
  const base = (call_id: string) => ({ key: `${conversation_id}:${call_id}`, conversation_id, call_id });

  if (frame.type === 'ask') {
    // Without a request id the card answers with a renderer-only uuid, so the records could never be joined.
    const call_id = asText(data.request_id);
    const questions = asList(data.questions);
    if (!call_id || questions.length === 0) return null;
    const [first] = questions;
    const single = questions.length === 1 && first.multiSelect !== true && first.multi_select !== true;
    const options = asList(first.options).map((option, index) => ({
      key: `option_${index}`,
      description: [asText(option.label), asText(option.description)].filter(Boolean).join(': '),
      value: option.label,
    }));
    return {
      ...base(call_id),
      source: 'ask',
      tool: 'question',
      kind: 'question',
      question: asText(first.question),
      options,
      unjudgeable: single && options.length > 0 ? undefined : 'unsupported',
    };
  }

  if (frame.type !== 'permission' && frame.type !== 'acp_permission') return null;

  if (data.tool_call) {
    const call = asRecord(data.tool_call);
    const call_id = asText(call.tool_call_id);
    if (!call_id) return null;
    const input = asRecord(call.raw_input);
    const locations = asList(call.locations)
      .map((location) => asText(location.path))
      .filter(Boolean);
    const options: ShadowOption[] = [];
    for (const option of asList(data.options)) {
      if (option.kind !== 'allow_once' && option.kind !== 'reject_once') continue;
      options.push({
        key: option.kind,
        description: option.kind === 'allow_once' ? ALLOW : REJECT,
        value: option.option_id,
      });
    }
    const known = Object.keys(input).length > 0 || locations.length > 0;
    return {
      ...base(call_id),
      source: 'acp',
      tool: asText(input.tool_name) || asText(call.title),
      kind: asText(call.kind),
      question: [
        `May I use: ${asText(call.title)}`,
        Object.keys(input).length > 0 ? `Input: ${JSON.stringify(input)}` : '',
        locations.length > 0 ? `Paths: ${locations.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
      options,
      unjudgeable: !known ? 'incomplete' : options.length === 0 ? 'unsupported' : undefined,
    };
  }

  const call_id = asText(data.call_id);
  if (!call_id) return null;
  const tool = asText(data.action);
  const description = asText(data.description);
  const options: ShadowOption[] = [];
  for (const option of asList(data.options)) {
    if (option.value === 'proceed_once') options.push({ key: 'allow_once', description: ALLOW, value: option.value });
    if (option.value === 'cancel') options.push({ key: 'reject_once', description: REJECT, value: option.value });
  }
  const truncated =
    description.startsWith(AIONRS_EXEC_PREFIX) &&
    new TextEncoder().encode(description.slice(AIONRS_EXEC_PREFIX.length)).length >= AIONRS_PREVIEW_MIN_CUT_BYTES;
  return {
    ...base(call_id),
    source: 'aionrs',
    tool,
    kind: asText(data.command_type),
    question: `May I use ${tool}? ${description}`,
    options,
    unjudgeable: truncated
      ? 'truncated'
      : !description || AIONRS_TOOLS_WITHOUT_TARGET.has(tool)
        ? 'incomplete'
        : options.length === 0
          ? 'unsupported'
          : undefined,
  };
}
