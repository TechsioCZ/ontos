/**
 * Browser client of the shell's agent-entity endpoints (`AGENT_ACCESS_PATHS`) and of the connection-management
 * endpoints (`CONNECTION_MANAGEMENT_PATHS`: agent operators and agent connections). The page runs inside the shell
 * origin, so the session cookie authenticates the call; the shell resolves the selected company and the Core
 * Action authorizes and audits every change. Failures carry the shell's Czech problem detail (403/404/409/422).
 */
import { Effect, Option, Schema } from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/http';
import {
  AGENT_ACCESS_PATHS,
  AgentEntityOverviewSchema,
  AgentOperatorsResponseSchema,
  CONNECTION_MANAGEMENT_PATHS,
  ConnectionMutationResponseSchema,
  ManageAgentEntityResponseSchema,
} from '@app/shared-contracts/agent-access';
import type {
  AgentEntityOverview,
  AgentOperatorsRequest,
  AgentOperatorsResponse,
  ConnectionMutationResponse,
  ConnectionRevokeRequest,
  ManageAgentEntityRequest,
  ManageAgentEntityResponse,
} from '@app/shared-contracts/agent-access';

const AgentFailureSchema = Schema.Literals(['conflict', 'error', 'forbidden', 'invalid', 'signedOut']);
export type AgentFailure = typeof AgentFailureSchema.Type;
const ProblemDetailSchema = Schema.Struct({ detail: Schema.String });
export type AgentOutcome<Value> =
  | { readonly detail: string | null; readonly reason: AgentFailure; readonly status: 'failed' }
  | { readonly status: 'ok'; readonly value: Value };

const failureOf = (status: number): AgentFailure => {
  if (status === 401) {
    return 'signedOut';
  }
  if (status === 403) {
    return 'forbidden';
  }
  if (status === 409) {
    return 'conflict';
  }
  if (status === 400 || status === 422) {
    return 'invalid';
  }
  return 'error';
};

/** POSTs one JSON body to a full shell path; a 200 answer is returned as raw JSON for the caller's schema. */
const post = Effect.fn('AgentEntitiesClient.post')(function* post(
  path: string,
  body: ManageAgentEntityRequest | AgentOperatorsRequest | ConnectionRevokeRequest | Readonly<Record<string, never>>,
  idempotencyKey?: string,
) {
  const client = yield* HttpClient.HttpClient;
  const base = HttpClientRequest.post(path).pipe(HttpClientRequest.setHeader('accept', 'application/json'));
  const withKey =
    idempotencyKey === undefined ? base : HttpClientRequest.setHeader(base, 'idempotency-key', idempotencyKey);
  const request = yield* HttpClientRequest.bodyJson(withKey, body);
  const response = yield* client.execute(request);
  if (response.status !== 200) {
    const problem = yield* response.json.pipe(
      Effect.map(Schema.decodeUnknownOption(ProblemDetailSchema)),
      Effect.orElseSucceed(() => Option.none<{ readonly detail: string }>()),
    );
    const detail = [403, 404, 409, 422].includes(response.status)
      ? Option.getOrNull(problem.pipe(Option.map((value) => value.detail)))
      : null;
    return { detail, reason: failureOf(response.status), status: 'failed' as const };
  }
  const json = yield* response.json;
  return { json, status: 'ok' as const };
}, Effect.timeout('30 seconds'));

const failed = (reason: AgentFailure, detail: string | null = null) => ({
  detail,
  reason,
  status: 'failed' as const,
});

const decodeOverview = Schema.decodeUnknownEffect(AgentEntityOverviewSchema);
const decodeManageResponse = Schema.decodeUnknownEffect(ManageAgentEntityResponseSchema);
const decodeOperators = Schema.decodeUnknownEffect(AgentOperatorsResponseSchema);
const decodeMutation = Schema.decodeUnknownEffect(ConnectionMutationResponseSchema);

export const loadAgentEntities: Effect.Effect<
  AgentOutcome<AgentEntityOverview>,
  never,
  HttpClient.HttpClient
> = Effect.gen(function* loadAgentOverview() {
  const answer = yield* post(AGENT_ACCESS_PATHS.list, {});
  if (answer.status === 'failed') {
    return failed(answer.reason, answer.detail);
  }
  const value = yield* decodeOverview(answer.json);
  return { status: 'ok' as const, value };
}).pipe(Effect.orElseSucceed(() => failed('error')));

export const runAgentCommand = (
  command: ManageAgentEntityRequest,
  idempotencyKey: string,
): Effect.Effect<AgentOutcome<ManageAgentEntityResponse>, never, HttpClient.HttpClient> =>
  Effect.gen(function* runAgentManage() {
    const answer = yield* post(AGENT_ACCESS_PATHS.manage, command, idempotencyKey);
    if (answer.status === 'failed') {
      return failed(answer.reason, answer.detail);
    }
    const value = yield* decodeManageResponse(answer.json);
    return { status: 'ok' as const, value };
  }).pipe(Effect.orElseSucceed(() => failed('error')));

/** Replaces the complete operator set of one agent; the shell answers how many connections were revoked with it. */
export const saveAgentOperators = (
  request: AgentOperatorsRequest,
): Effect.Effect<AgentOutcome<AgentOperatorsResponse>, never, HttpClient.HttpClient> =>
  Effect.gen(function* saveAgentOperatorsCall() {
    const answer = yield* post(CONNECTION_MANAGEMENT_PATHS.operators, request);
    if (answer.status === 'failed') {
      return failed(answer.reason, answer.detail);
    }
    const value = yield* decodeOperators(answer.json);
    return { status: 'ok' as const, value };
  }).pipe(Effect.orElseSucceed(() => failed('error')));

/** Revokes one connection (owner, or administrator of the company) with a reason for the audit trail. */
export const revokeAgentConnection = (
  request: ConnectionRevokeRequest,
): Effect.Effect<AgentOutcome<ConnectionMutationResponse>, never, HttpClient.HttpClient> =>
  Effect.gen(function* revokeAgentConnectionCall() {
    const answer = yield* post(CONNECTION_MANAGEMENT_PATHS.revoke, request);
    if (answer.status === 'failed') {
      return failed(answer.reason, answer.detail);
    }
    const value = yield* decodeMutation(answer.json);
    return { status: 'ok' as const, value };
  }).pipe(Effect.orElseSucceed(() => failed('error')));
