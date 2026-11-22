/**
 * @license
 * Copyright 2026 CharlieTheAicorn contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { app } from 'electron';
import { ipcBridge } from '@/common';
import type { ShadowAnswer } from '@/common/types/permissionShadow';
import { createPermissionShadow, type ShadowAgent } from '@process/services/permissionShadow';

let shadow: ReturnType<typeof createPermissionShadow> | undefined;

async function resolveAgent(id: string): Promise<ShadowAgent> {
  const conversation = await ipcBridge.conversation.get.invoke({ id });
  const extra = (conversation?.extra ?? {}) as { preset_assistant_id?: string; workspace?: string };
  return {
    assistant_id: conversation?.assistant?.id ?? extra.preset_assistant_id,
    name: conversation?.name,
    workspace: extra.workspace,
  };
}

/** For answers given in the main process (the pet window), which do not pass through the renderer tap. */
export function recordShadowAnswer(answer: ShadowAnswer): void {
  void shadow?.recordAnswer(answer);
}

export function initPermissionShadowBridge(): void {
  // Deliberately outside the logs directory, which the feedback report collects.
  shadow = createPermissionShadow({ dir: path.join(app.getPath('userData'), 'permission-shadow'), resolveAgent });
  void shadow.ensureConfig().catch((error: unknown) => console.warn('[PermissionShadow] config failed:', error));

  // Return at once: the consent card must never wait for a model.
  ipcBridge.permissionShadow.observe.provider(async (frame) => {
    void shadow?.observe(frame);
  });
  ipcBridge.permissionShadow.answered.provider(async (answer) => {
    recordShadowAnswer(answer);
  });
}
