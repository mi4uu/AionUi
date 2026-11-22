/**
 * @license
 * Copyright 2026 CharlieTheAicorn contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ShadowRequest } from './normalize';

// These requests always go to the user. Matching too much only costs a question, so the patterns are broad.
// This is not a sandbox: a shell can hide anything, which is why the model is never the only line of defence.
const DESTRUCTIVE =
  /(?:^|[^\w-])(?:rm|rmdir|unlink|shred|dd|mkfs\w*|truncate|killall|pkill|sudo)(?:$|[^\w-])|\s-delete\b|\bgit\b.*\b(?:clean|reset|restore|rebase)\b|\bgit\b.*\bcheckout\s+--|--force\b|\bdrop\s+(?:table|database)\b/i;
const EXTERNAL =
  /(?:^|[^\w-])(?:curl|wget|nc|ncat|ssh|scp|sftp|rsync|sendmail)(?:$|[^\w-])|\bgit\b.*\bpush\b|\bgh\s+(?:pr|repo|release|issue|api|gist)\b|\b(?:npm|bun|yarn|pnpm|cargo)\s+publish\b/i;
const DESTRUCTIVE_TOOL = /(?:^|[_.\-\s])(?:delete|remove|destroy|erase|wipe)(?:$|[_.\-\s])/i;
const EXTERNAL_TOOL = /(?:^|[_.\-\s])(?:send|publish|upload|push|post|email|reply)(?:$|[_.\-\s])/i;
// Talking to the own team is not external.
const TEAM_TOOL = /^(?:mcp__)?(?:aionui-team(?:__|[./]))?team_[a-z_]+$/;

export function alwaysUserReason(request: ShadowRequest): 'destructive' | 'external' | null {
  if (request.source === 'ask' || TEAM_TOOL.test(request.tool)) return null;
  if (request.kind === 'delete' || DESTRUCTIVE.test(request.question) || DESTRUCTIVE_TOOL.test(request.tool)) {
    return 'destructive';
  }
  if (EXTERNAL.test(request.question) || EXTERNAL_TOOL.test(request.tool)) return 'external';
  return null;
}
