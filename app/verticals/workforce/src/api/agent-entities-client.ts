/**
 * Browser client of the shell's agent-entity endpoints (`AGENT_ACCESS_PATHS`) and of the connection-management
 * endpoints (`CONNECTION_MANAGEMENT_PATHS`: agent operators and agent connections). The page runs inside the shell
 * origin, so the session cookie authenticates the call; the shell resolves the selected company and the Core
 * Action authorizes and audits every change.
 */
import { Effect, Schema } from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/unstable/http';
import {
  AGENT_ACCESS_PATHS,
  AgentConnectionsOverviewSchema,
  AgentEntityOverviewSchema,
  AgentOperatorsResponseSchema,
  CONNECTION_MANAGEMENT_PATHS,
  ConnectionMutationResponseSchema,
  ManageAgentEntityResponseSchema,
} from '@app/shared-contracts/agent-access';
import type {
  AgentConnectionsOverview,
  AgentEntityOverview,
  AgentOperatorsRequest,
  AgentOperatorsResponse,
  ConnectionMutationResponse,
  ConnectionRevokeRequest,
  ManageAgentEntityRequest,
  ManageAgentEntityResponse,
} from '@app/shared-contracts/agent-access';
import type { PeopleFailure, PeopleOutcome } from './people-admin-client.ts';

export type AgentFailure = PeopleFailure;
export type AgentOutcome<Value> = PeopleOutcome<Value>;

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
const post = (path: string, body: unknown, idempotencyKey?: string) =>
  Effect.gen(function* agentEntitiesCall() {
    const client = yield* HttpClient.HttpClient;
    const base = HttpClientRequest.post(path).pipe(HttpClientRequest.setHeader('accept', 'application/json'));
    const withKey =
      idempotencyKey === undefined ? base : HttpClientRequest.setHeader(base, 'idempotency-key', idempotencyKey);
    const request = yield* HttpClientRequest.bodyJson(withKey, body);
    const response = yield* client.execute(request);
    if (response.status !== 200) {
      return { reason: failureOf(response.status), status: 'failed' as const };
    }
    const json: unknown = yield* response.json;
    return { json, status: 'ok' as const };
  });

const failed = (reason: AgentFailure): { readonly reason: AgentFailure; readonly status: 'failed' } => ({
  reason,
  status: 'failed',
});

const decodeOverview = Schema.decodeUnknownEffect(AgentEntityOverviewSchema);
const decodeManageResponse = Schema.decodeUnknownEffect(ManageAgentEntityResponseSchema);
const decodeConnections = Schema.decodeUnknownEffect(AgentConnectionsOverviewSchema);
const decodeOperators = Schema.decodeUnknownEffect(AgentOperatorsResponseSchema);
const decodeMutation = Schema.decodeUnknownEffect(ConnectionMutationResponseSchema);

export const loadAgentEntities: Effect.Effect<
  AgentOutcome<AgentEntityOverview>,
  never,
  HttpClient.HttpClient
> = Effect.gen(function* loadAgentOverview() {
  const answer = yield* post(AGENT_ACCESS_PATHS.list, {});
  if (answer.status === 'failed') {
    return failed(answer.reason);
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
      return failed(answer.reason);
    }
    const value = yield* decodeManageResponse(answer.json);
    return { status: 'ok' as const, value };
  }).pipe(Effect.orElseSucceed(() => failed('error')));

/** Agents of the selected company with their operators and active connections. */
export const loadAgentConnections: Effect.Effect<
  AgentOutcome<AgentConnectionsOverview>,
  never,
  HttpClient.HttpClient
> = Effect.gen(function* loadAgentConnectionsCall() {
  const answer = yield* post(CONNECTION_MANAGEMENT_PATHS.agentConnections, {});
  if (answer.status === 'failed') {
    return failed(answer.reason);
  }
  const value = yield* decodeConnections(answer.json);
  return { status: 'ok' as const, value };
}).pipe(Effect.orElseSucceed(() => failed('error')));

/** Replaces the complete operator set of one agent; the shell answers how many connections were revoked with it. */
export const saveAgentOperators = (
  request: AgentOperatorsRequest,
): Effect.Effect<AgentOutcome<AgentOperatorsResponse>, never, HttpClient.HttpClient> =>
  Effect.gen(function* saveAgentOperatorsCall() {
    const answer = yield* post(CONNECTION_MANAGEMENT_PATHS.operators, request);
    if (answer.status === 'failed') {
      return failed(answer.reason);
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
      return failed(answer.reason);
    }
    const value = yield* decodeMutation(answer.json);
    return { status: 'ok' as const, value };
  }).pipe(Effect.orElseSucceed(() => failed('error')));
