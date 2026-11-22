/**
 * @license
 * Copyright 2026 CharlieTheAicorn contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect } from 'react';
import { ipcBridge } from '@/common';
import { isElectronDesktop } from '@/renderer/utils/platform';

const WAITING_TYPES = new Set(['permission', 'acp_permission', 'ask']);
const TEXT_TYPES = new Set(['content', 'text']);
const CONTEXT_CHARS = 300;

/**
 * Copies consent requests to the main process for shadow judging. The event socket only exists in the
 * renderer (`ensureWs` is a no-op without `window`), so it cannot live in main.
 */
export const usePermissionShadow = (): void => {
  useEffect(() => {
    if (!isElectronDesktop()) return;
    const stream = ipcBridge.conversation?.responseStream;
    if (!stream) return;

    const lastText = new Map<string, string>();
    return stream.on((message) => {
      const { type, conversation_id, msg_id, data } = message ?? {};
      if (!conversation_id) return;
      if (TEXT_TYPES.has(type)) {
        const text = typeof data === 'string' ? data : (data as { content?: unknown } | null)?.content;
        if (typeof text === 'string') {
          lastText.set(conversation_id, `${lastText.get(conversation_id) ?? ''}${text}`.slice(-CONTEXT_CHARS));
        }
      } else if (type === 'finish') {
        lastText.delete(conversation_id);
      } else if (WAITING_TYPES.has(type)) {
        Promise.resolve(
          ipcBridge.permissionShadow?.observe.invoke({
            type,
            conversation_id,
            msg_id,
            data,
            context: lastText.get(conversation_id),
          })
        ).catch((): void => undefined);
      }
    });
  }, []);
};
