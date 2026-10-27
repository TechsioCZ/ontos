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
import { HttpClient, HttpClientRequest } from 'effect/http';

const ConnectionsFailureSchema = Schema.Literals([
  'conflict',
  'error',
  'forbidden',
  'invalid',
  'notFound',
  'signedOut',
]);
export type ConnectionsFailure = typeof ConnectionsFailureSchema.Type;

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
const post = Effect.fn('ConnectedAppsClient.post')(function* connectionsCall(
  path: string,
  body?: ConnectionAdminListRequest | ConnectionRevokeRequest | ConnectionUpdateRequest,
) {
  const client = yield* HttpClient.HttpClient;
  const base = HttpClientRequest.post(path).pipe(HttpClientRequest.setHeader('accept', 'application/json'));
  const request = yield* HttpClientRequest.bodyJson(base, body ?? {});
  const response = yield* client.execute(request).pipe(Effect.timeout('10 seconds'));
  if (response.status === 200) {
    const json: unknown = yield* response.json;
    return { json, status: 'ok' as const };
  }
  const reason = failureOf(response.status);
  if (response.status === 403 || response.status === 404 || response.status === 409 || response.status === 422) {
    // The problem body carries `detail` for the person; anything else leaves it null.
    const detail = yield* response.json.pipe(
      Effect.flatMap((json) => decodeDetail(json)),
      Effect.map((problem) => problem.detail),
      Effect.orElseSucceed((): string | null => null),
    );
    return failed(reason, detail);
  }
  return failed(reason, null);
}, Effect.timeout('10 seconds'));

export const loadMyConnections: Effect.Effect<
  ConnectionsOutcome<ConnectionListResponse>,
  never,
  HttpClient.HttpClient
> = Effect.gen(function* loadMyConnectionsCall() {
  const answer = yield* post(CONNECTION_MANAGEMENT_PATHS.mine);
  if (answer.status === 'failed') {
    return answer;
  }
  const value = yield* decodeMine(answer.json);
  return { status: 'ok' as const, value };
}).pipe(Effect.orElseSucceed(() => failed('error', null)));

export const loadCompanyConnections = (
  request: ConnectionAdminListRequest,
): Effect.Effect<ConnectionsOutcome<ConnectionAdminListResponse>, never, HttpClient.HttpClient> =>
  Effect.gen(function* loadCompanyConnectionsCall() {
    const answer = yield* post(CONNECTION_MANAGEMENT_PATHS.adminList, request);
    if (answer.status === 'failed') {
      return answer;
    }
    const value = yield* decodeAdminList(answer.json);
    return { status: 'ok' as const, value };
  }).pipe(Effect.orElseSucceed(() => failed('error', null)));

export const updateConnectionAccess = (
  request: ConnectionUpdateRequest,
): Effect.Effect<ConnectionsOutcome<ConnectionMutationResponse>, never, HttpClient.HttpClient> =>
  Effect.gen(function* updateConnectionAccessCall() {
    const answer = yield* post(CONNECTION_MANAGEMENT_PATHS.update, request);
    if (answer.status === 'failed') {
      return answer;
    }
    const value = yield* decodeMutation(answer.json);
    return { status: 'ok' as const, value };
  }).pipe(Effect.orElseSucceed(() => failed('error', null)));

export const revokeConnection = (
  request: ConnectionRevokeRequest,
): Effect.Effect<ConnectionsOutcome<ConnectionMutationResponse>, never, HttpClient.HttpClient> =>
  Effect.gen(function* revokeConnectionCall() {
    const answer = yield* post(CONNECTION_MANAGEMENT_PATHS.revoke, request);
    if (answer.status === 'failed') {
      return answer;
    }
    const value = yield* decodeMutation(answer.json);
    return { status: 'ok' as const, value };
  }).pipe(Effect.orElseSucceed(() => failed('error', null)));
