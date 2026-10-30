/**
 * Browser client of the platform approval endpoints (`/shell-super-app-api/agent-platform/*`). The page runs inside
 * the shell origin, so the session cookie authenticates every call; the shell resolves the company and the module
 * permissions of the approving person.
 */
import { DateTime, Effect, Random, Result, Schema } from 'effect';
import { HttpBody, HttpClient, HttpClientRequest } from 'effect/http';

import {
  AgentActivityRequestSchema,
  AgentActivityResponseSchema,
  AgentDecideRequestSchema,
  AgentDecideResponseSchema,
  AgentQueueRequestSchema,
  AgentQueueResponseSchema,
  AgentRevertRequestSchema,
  AgentRevertResponseSchema,
} from '@app/shared-contracts/agent-proposals';
import type {
  AgentActivityRequest,
  AgentQueueRequest,
  AgentDecideRequest,
  AgentRevertRequest,
} from '@app/shared-contracts/agent-proposals';

import { browserRuntime } from '../../runtime/browser-effect-runtime.ts';

const BASE = '/shell-super-app-api/agent-platform';

export type AgentPlatformResult<A> =
  | { readonly status: 'ok'; readonly value: A }
  | { readonly httpStatus: number; readonly message: string; readonly status: 'failed' };

export interface AgentMutationIntent<A> {
  readonly idempotencyKey: string;
  readonly payload: A;
}

const sameMutation = Schema.toEquivalence(Schema.Union([AgentDecideRequestSchema, AgentRevertRequestSchema]));

/** Keep the exact request, not a payload rebuilt from a potentially refreshed queue. */
export const agentMutationIntent = Effect.fn('AgentPlatform.mutationIntent')(function* agentMutationIntent<
  A extends AgentDecideRequest | AgentRevertRequest,
>(previous: AgentMutationIntent<A> | undefined, payload: A) {
  if (previous !== undefined && sameMutation(previous.payload, payload)) {
    return previous;
  }
  const parts = yield* Effect.forEach([0, 1, 2, 3], () => Random.nextIntBetween(0, 2 ** 32), {
    concurrency: 1,
  });
  return {
    idempotencyKey: parts.map((part) => part.toString(16).padStart(8, '0')).join(''),
    payload: structuredClone(payload),
  } satisfies AgentMutationIntent<A>;
});

/** A lost response, in-flight conflict, timeout, rate limit, or server failure does not establish a terminal action. */
export const agentMutationUncertain = (result: AgentPlatformResult<unknown>): boolean =>
  result.status === 'failed' && ([0, 408, 409, 425, 429].includes(result.httpStatus) || result.httpStatus >= 500);

const failureBody = Schema.fromJsonString(Schema.Struct({ detail: Schema.String }));
const failureMessage = (text: string): string =>
  Result.match(Schema.decodeResult(failureBody)(text), {
    onFailure: () => 'Požadavek se nepodařilo dokončit.',
    onSuccess: (body) => body.detail,
  });

const post = Effect.fn('AgentPlatform.post')(function* post<Request, RequestEncoded, ResponseBody>(
  path: string,
  body: Request,
  requestSchema: Schema.Codec<Request, RequestEncoded>,
  responseSchema: Schema.Codec<ResponseBody, unknown>,
  idempotencyKey?: string,
): Effect.fn.Return<AgentPlatformResult<ResponseBody>, never, HttpClient.HttpClient> {
  const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(requestSchema))(body).pipe(Effect.result);
  if (Result.isFailure(encoded)) {
    return { httpStatus: 400, message: 'Požadavek nemá očekávaný tvar.', status: 'failed' };
  }
  const client = HttpClient.withScope(yield* HttpClient.HttpClient);
  let request = HttpClientRequest.post(BASE + path).pipe(
    HttpClientRequest.setBody(HttpBody.raw(encoded.success, { contentType: 'application/json' })),
  );
  if (idempotencyKey !== undefined) {
    request = HttpClientRequest.setHeader(request, 'idempotency-key', idempotencyKey);
  }
  // The native request scope stays alive until the entire body is consumed. A timeout or caller
  // interruption closes it and aborts fetch even when the response headers have already arrived.
  const transport = yield* Effect.gen(function* readResponse() {
    const response = yield* client.execute(request);
    const text = yield* response.text;
    return { response, text };
  }).pipe(Effect.scoped, Effect.timeout('30 seconds'), Effect.result);
  if (Result.isFailure(transport)) {
    return { httpStatus: 0, message: 'Server je teď nedostupný.', status: 'failed' };
  }
  const { response, text } = transport.success;
  if (response.status < 200 || response.status >= 300) {
    return { httpStatus: response.status, message: failureMessage(text), status: 'failed' };
  }
  const decoded = yield* Schema.decodeEffect(Schema.fromJsonString(responseSchema))(text).pipe(Effect.result);
  if (Result.isFailure(decoded)) {
    return { httpStatus: 0, message: 'Odpověď serveru nemá očekávaný tvar.', status: 'failed' };
  }
  return { status: 'ok', value: decoded.success };
});

// The existing page-data read boundary accepts Promises; mutations stay in the caller's browser fiber.
export const loadAgentQueue = (request: AgentQueueRequest) =>
  browserRuntime.runPromise(post('/queue', request, AgentQueueRequestSchema, AgentQueueResponseSchema));

export const decideAgentItems = (intent: AgentMutationIntent<AgentDecideRequest>) =>
  post('/decide', intent.payload, AgentDecideRequestSchema, AgentDecideResponseSchema, intent.idempotencyKey);

export const revertAgentBatch = (intent: AgentMutationIntent<AgentRevertRequest>) =>
  post('/revert', intent.payload, AgentRevertRequestSchema, AgentRevertResponseSchema, intent.idempotencyKey);

export const loadAgentActivity = (request: AgentActivityRequest) =>
  browserRuntime.runPromise(post('/activity', request, AgentActivityRequestSchema, AgentActivityResponseSchema));

const agentTimeFormat = new Intl.DateTimeFormat('cs-CZ', { dateStyle: 'medium', timeStyle: 'short' });
export const formatAgentTime = (time: DateTime.Utc): string => agentTimeFormat.format(DateTime.toEpochMillis(time));
