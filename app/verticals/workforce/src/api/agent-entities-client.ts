/**
 * Browser client of the shell's agent-entity endpoints (`AGENT_ACCESS_PATHS`). The page runs inside the shell
 * origin, so the session cookie authenticates the call; the shell resolves the selected company and the Core
 * Action authorizes and audits every change.
 */
import { Effect, Schema } from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/unstable/http';
import {
  AGENT_ACCESS_PATHS,
  AgentEntityOverviewSchema,
  ManageAgentEntityResponseSchema,
  McpTokenIssueResponseSchema,
} from '@app/shared-contracts/agent-access';
import type {
  AgentEntityOverview,
  AgentTokenRequest,
  ManageAgentEntityRequest,
  ManageAgentEntityResponse,
  McpTokenIssueResponse,
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
const decodeTokenResponse = Schema.decodeUnknownEffect(McpTokenIssueResponseSchema);

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

export const runAgentTokenCommand = (
  command: AgentTokenRequest,
  idempotencyKey: string,
): Effect.Effect<AgentOutcome<McpTokenIssueResponse>, never, HttpClient.HttpClient> =>
  Effect.gen(function* runAgentToken() {
    const answer = yield* post(AGENT_ACCESS_PATHS.token, command, idempotencyKey);
    if (answer.status === 'failed') {
      return failed(answer.reason);
    }
    const value = yield* decodeTokenResponse(answer.json);
    return { status: 'ok' as const, value };
  }).pipe(Effect.orElseSucceed(() => failed('error')));
