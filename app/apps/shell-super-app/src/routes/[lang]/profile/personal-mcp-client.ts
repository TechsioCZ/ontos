// @effect-diagnostics strictEffectProvide:off -- Browser client boundary: the shell runtime has no HttpClient, so the fetch layer is provided inside each exported call. expires: 2027-03-31.
/**
 * Browser client of the personal MCP access endpoints. The page runs inside the shell origin, so the session cookie
 * authenticates each call; the shell resolves the selected company and answers only the signed-in person's tokens.
 */
import { AGENT_ACCESS_PATHS } from '@app/shared-contracts/agent-access';
import type { McpTokenIssueResponse, PersonalMcpOverview, PersonalMcpTokenRequest } from '@app/shared-contracts/agent-access';
import { Effect, Schema } from 'effect';
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/unstable/http';

export type PersonalMcpFailure = 'conflict' | 'error' | 'forbidden' | 'invalid' | 'signedOut';

export type PersonalMcpOutcome<Value> =
  | { readonly reason: PersonalMcpFailure; readonly status: 'failed' }
  | { readonly status: 'ok'; readonly value: Value };

const TokenSchema = Schema.Struct({
  authBindingId: Schema.String,
  createdAt: Schema.String,
  enabled: Schema.Boolean,
  lastUsedAt: Schema.NullOr(Schema.String),
  name: Schema.NullOr(Schema.String),
  start: Schema.NullOr(Schema.String),
});

const OverviewSchema = Schema.Struct({
  company: Schema.Struct({ legalEntityId: Schema.String, legalName: Schema.String }),
  displayName: Schema.String,
  mcpUrl: Schema.String,
  tokens: Schema.Array(TokenSchema),
});

const IssueResponseSchema = Schema.Struct({
  mcpUrl: Schema.String,
  secret: Schema.NullOr(Schema.String),
  token: TokenSchema,
});

const decodeOverview = Schema.decodeUnknownEffect(OverviewSchema);
const decodeIssueResponse = Schema.decodeUnknownEffect(IssueResponseSchema);

const failureOf = (status: number): PersonalMcpFailure => {
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

const failed = (reason: PersonalMcpFailure): { readonly reason: PersonalMcpFailure; readonly status: 'failed' } => ({
  reason,
  status: 'failed',
});

/** POSTs one JSON body; a 200 answer is returned as raw JSON for the caller's schema. */
const post = (path: string, body: unknown, idempotencyKey?: string) =>
  Effect.gen(function* personalMcpCall() {
    const client = yield* HttpClient.HttpClient;
    const base = HttpClientRequest.post(path).pipe(HttpClientRequest.setHeader('accept', 'application/json'));
    const withKey =
      idempotencyKey === undefined ? base : HttpClientRequest.setHeader(base, 'idempotency-key', idempotencyKey);
    const request = yield* HttpClientRequest.bodyJson(withKey, body);
    const response = yield* client.execute(request);
    if (response.status !== 200) {
      return failed(failureOf(response.status));
    }
    const json: unknown = yield* response.json;
    return { status: 'ok' as const, json };
  });

export const loadPersonalMcp: Effect.Effect<PersonalMcpOutcome<PersonalMcpOverview>, never> = Effect.gen(
  function* loadPersonalMcpOverview() {
    const answer = yield* post(AGENT_ACCESS_PATHS.personalList, {});
    if (answer.status === 'failed') {
      return answer;
    }
    const value = yield* decodeOverview(answer.json);
    return { status: 'ok' as const, value };
  },
).pipe(Effect.orElseSucceed(() => failed('error')), Effect.provide(FetchHttpClient.layer));

export const runPersonalMcpToken = (
  command: PersonalMcpTokenRequest,
  idempotencyKey: string,
): Effect.Effect<PersonalMcpOutcome<McpTokenIssueResponse>, never> =>
  Effect.gen(function* runPersonalMcpTokenCommand() {
    const answer = yield* post(AGENT_ACCESS_PATHS.personalToken, command, idempotencyKey);
    if (answer.status === 'failed') {
      return answer;
    }
    const value = yield* decodeIssueResponse(answer.json);
    return { status: 'ok' as const, value };
  }).pipe(Effect.orElseSucceed(() => failed('error')), Effect.provide(FetchHttpClient.layer));
