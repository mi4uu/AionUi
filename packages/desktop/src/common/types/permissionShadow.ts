/**
 * @license
 * Copyright 2026 CharlieTheAicorn contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/** A frame the renderer saw while an agent was waiting for the user. */
export type ShadowObservation = {
  type: string;
  conversation_id: string;
  msg_id?: string;
  data: unknown;
  /** The tail of what the agent said just before it asked. */
  context?: string;
};

/** What the human answered. `call_id` is the request id for questions. */
export type ShadowAnswer = {
  conversation_id: string;
  call_id: string;
  answer: unknown;
};
