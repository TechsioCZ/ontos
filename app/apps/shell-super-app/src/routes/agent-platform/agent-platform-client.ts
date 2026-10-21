// @effect-diagnostics asyncFunction:off globalFetch:off globalDate:off -- Browser fetch transport boundary: the page calls the shell API with the session cookie and formats server timestamps for display. expires: 2027-03-31.
/**
 * Browser client of the platform approval endpoints (`/shell-super-app-api/agent-platform/*`). The page runs inside
 * the shell origin, so the session cookie authenticates every call; the shell resolves the company and the module
 * permissions of the approving person.
 */
import { Schema } from 'effect';

import {
  AgentActivityResponseSchema,
  AgentDecideResponseSchema,
  AgentQueueResponseSchema,
  AgentRevertResponseSchema,
} from '@app/shared-contracts/agent-proposals';
import type {
  AgentActivityRequest,
  AgentDecideRequest,
  AgentRevertRequest,
} from '@app/shared-contracts/agent-proposals';

const BASE = '/shell-super-app-api/agent-platform';

export type AgentPlatformResult<A> =
  | { readonly status: 'ok'; readonly value: A }
  | { readonly httpStatus: number; readonly message: string; readonly status: 'failed' };

const fallbackMessage = 'Požadavek se nepodařilo dokončit.';

const failureMessage = (text: string): string => {
  try {
    const body: unknown = JSON.parse(text);
    if (typeof body === 'object' && body !== null && 'detail' in body && typeof body.detail === 'string') {
      return body.detail;
    }
  } catch {
    // Non-JSON error bodies fall back to the generic Czech message.
  }
  return fallbackMessage;
};

const post = async <A>(
  path: string,
  body: unknown,
  schema: Schema.Codec<A, unknown>,
): Promise<AgentPlatformResult<A>> => {
  let response: Response;
  try {
    response = await fetch(BASE + path, {
      body: JSON.stringify(body),
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
  } catch {
    return { httpStatus: 0, message: 'Server je teď nedostupný.', status: 'failed' };
  }
  const text = await response.text();
  if (!response.ok) {
    return { httpStatus: response.status, message: failureMessage(text), status: 'failed' };
  }
  try {
    return { status: 'ok', value: Schema.decodeUnknownSync(schema)(JSON.parse(text)) };
  } catch {
    return { httpStatus: 0, message: 'Odpověď serveru nemá očekávaný tvar.', status: 'failed' };
  }
};

export const loadAgentQueue = () => post('/queue', {}, AgentQueueResponseSchema);

export const decideAgentItems = (request: AgentDecideRequest) =>
  post('/decide', request, AgentDecideResponseSchema);

export const revertAgentBatch = (request: AgentRevertRequest) => post('/revert', request, AgentRevertResponseSchema);

export const loadAgentActivity = (request: AgentActivityRequest) =>
  post('/activity', request, AgentActivityResponseSchema);

export const formatAgentTime = (iso: string) =>
  new Intl.DateTimeFormat('cs-CZ', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
