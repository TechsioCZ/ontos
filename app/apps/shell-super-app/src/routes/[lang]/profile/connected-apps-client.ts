// @effect-diagnostics strictEffectProvide:off -- Browser client boundary: the shell runtime has no HttpClient, so the fetch layer is provided inside each exported call. expires: 2027-03-31.
/**
 * Browser client of the connection management endpoints ("Připojené aplikace"). The page runs inside the shell origin,
 * so the session cookie authenticates each call; the server enforces who may read or change which connection.
 */
import {
  CONNECTION_MANAGEMENT_PATHS,
  ConnectionAdminListResponseSchema,
  ConnectionListResponseSchema,
  ConnectionMutationResponseSchema,
} from '@app/shared-contracts/agent-access';
import type {
  ConnectionAdminListRequest,
  ConnectionAdminListResponse,
  ConnectionListResponse,
  ConnectionMutationResponse,
  ConnectionRevokeRequest,
  ConnectionUpdateRequest,
} from '@app/shared-contracts/agent-access';
import { Effect, Schema } from 'effect';
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/unstable/http';

export type ConnectionsFailure = 'conflict' | 'error' | 'forbidden' | 'invalid' | 'notFound' | 'signedOut';

export type ConnectionsOutcome<Value> =
  | { readonly detail: string | null; readonly reason: ConnectionsFailure; readonly status: 'failed' }
  | { readonly status: 'ok'; readonly value: Value };

const DetailSchema = Schema.Struct({ detail: Schema.String });

const decodeDetail = Schema.decodeUnknownEffect(DetailSchema);
const decodeMine = Schema.decodeUnknownEffect(ConnectionListResponseSchema);
const decodeAdminList = Schema.decodeUnknownEffect(ConnectionAdminListResponseSchema);
const decodeMutation = Schema.decodeUnknownEffect(ConnectionMutationResponseSchema);

const failureOf = (status: number): ConnectionsFailure => {
  if (status === 401) {
    return 'signedOut';
  }
  if (status === 403) {
    return 'forbidden';
  }
  if (status === 404) {
    return 'notFound';
  }
  if (status === 409) {
    return 'conflict';
  }
  if (status === 400 || status === 422) {
    return 'invalid';
  }
  return 'error';
};

const failed = (reason: ConnectionsFailure, detail: string | null) => ({ detail, reason, status: 'failed' as const });

/** POSTs one JSON body; a 200 answer is returned as raw JSON for the caller's schema. */
const post = (path: string, body: unknown) =>
  Effect.gen(function* connectionsCall() {
    const client = yield* HttpClient.HttpClient;
    const base = HttpClientRequest.post(path).pipe(HttpClientRequest.setHeader('accept', 'application/json'));
    const request = yield* HttpClientRequest.bodyJson(base, body);
    const response = yield* client.execute(request);
    if (response.status === 200) {
      const json: unknown = yield* response.json;
      return { status: 'ok' as const, json };
    }
    const reason = failureOf(response.status);
    if (response.status === 403 || response.status === 404 || response.status === 409 || response.status === 422) {
      // The problem body carries `detail` for the person; anything else leaves it null.
      const detail = yield* response.json.pipe(
        Effect.flatMap((json) => decodeDetail(json)),
        Effect.map((body) => body.detail),
        Effect.orElseSucceed((): string | null => null),
      );
      return failed(reason, detail);
    }
    return failed(reason, null);
  });

export const loadMyConnections: Effect.Effect<ConnectionsOutcome<ConnectionListResponse>, never> = Effect.gen(
  function* loadMyConnectionsCall() {
    const answer = yield* post(CONNECTION_MANAGEMENT_PATHS.mine, {});
    if (answer.status === 'failed') {
      return answer;
    }
    const value = yield* decodeMine(answer.json);
    return { status: 'ok' as const, value };
  },
).pipe(
  Effect.orElseSucceed(() => failed('error', null)),
  Effect.provide(FetchHttpClient.layer),
);

export const loadCompanyConnections = (
  request: ConnectionAdminListRequest,
): Effect.Effect<ConnectionsOutcome<ConnectionAdminListResponse>, never> =>
  Effect.gen(function* loadCompanyConnectionsCall() {
    const answer = yield* post(CONNECTION_MANAGEMENT_PATHS.adminList, request);
    if (answer.status === 'failed') {
      return answer;
    }
    const value = yield* decodeAdminList(answer.json);
    return { status: 'ok' as const, value };
  }).pipe(
    Effect.orElseSucceed(() => failed('error', null)),
    Effect.provide(FetchHttpClient.layer),
  );

export const updateConnectionAccess = (
  request: ConnectionUpdateRequest,
): Effect.Effect<ConnectionsOutcome<ConnectionMutationResponse>, never> =>
  Effect.gen(function* updateConnectionAccessCall() {
    const answer = yield* post(CONNECTION_MANAGEMENT_PATHS.update, request);
    if (answer.status === 'failed') {
      return answer;
    }
    const value = yield* decodeMutation(answer.json);
    return { status: 'ok' as const, value };
  }).pipe(
    Effect.orElseSucceed(() => failed('error', null)),
    Effect.provide(FetchHttpClient.layer),
  );

export const revokeConnection = (
  request: ConnectionRevokeRequest,
): Effect.Effect<ConnectionsOutcome<ConnectionMutationResponse>, never> =>
  Effect.gen(function* revokeConnectionCall() {
    const answer = yield* post(CONNECTION_MANAGEMENT_PATHS.revoke, request);
    if (answer.status === 'failed') {
      return answer;
    }
    const value = yield* decodeMutation(answer.json);
    return { status: 'ok' as const, value };
  }).pipe(
    Effect.orElseSucceed(() => failed('error', null)),
    Effect.provide(FetchHttpClient.layer),
  );
