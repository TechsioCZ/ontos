import { v1 } from '@authzed/authzed-node';
import { Cause, Effect, Fiber, Match, Option, Predicate, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { TestClock } from 'effect/testing';
import { HttpClient, HttpClientResponse } from 'effect/unstable/http';
import type { HttpClientRequest } from 'effect/unstable/http';

import { SPICEDB_CHECK_TIMEOUT_MS } from '../../src/permissions/client.ts';
import { spiceDbHttpRpc } from '../../src/permissions/spicedb-http-rpc.ts';

const rpc = spiceDbHttpRpc({
  origin: new URL('https://spicedb:8443'),
  preSharedKey: Redacted.make('test-key'),
  timeoutMilliseconds: SPICEDB_CHECK_TIMEOUT_MS,
});
const JsonText = Schema.fromJsonString(Schema.Json);

interface RecordedRequest {
  readonly request: HttpClientRequest.HttpClientRequest;
  readonly signal: AbortSignal;
  readonly url: URL;
}

/** The HttpClient service seam: records each request and answers with the given response. */
const gateway = (answer: () => Response | 'hang') => {
  const requests: RecordedRequest[] = [];
  const client = HttpClient.make((request, url, signal) => {
    requests.push({ request, signal, url });
    const response = answer();
    return response === 'hang' ? Effect.never : Effect.succeed(HttpClientResponse.fromWeb(request, response));
  });
  return { requests, withGateway: Effect.provideService(HttpClient.HttpClient, client) };
};

const ndjson = (frames: readonly Schema.Json[]) =>
  new Response(frames.map((frame) => `${Schema.encodeSync(JsonText)(frame)}\n`).join(''));

it.effect('posts canonical proto3 JSON with the preshared key to the gateway route', () =>
  Effect.gen(function* checksGatewayRequest() {
    const { requests, withGateway } = gateway(() =>
      Response.json({ checkedAt: { token: 't' }, permissionship: 'PERMISSIONSHIP_HAS_PERMISSION' }),
    );
    const response = yield* rpc
      .checkPermission(
        v1.CheckPermissionRequest.create({
          permission: 'access',
          resource: v1.ObjectReference.create({ objectId: 't1', objectType: 'tenant' }),
        }),
      )
      .pipe(withGateway);
    expect(response.permissionship).toBe(v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION);
    expect(requests).toHaveLength(1);
    const [recorded] = requests;
    expect(recorded?.url.href).toBe('https://spicedb:8443/v1/permissions/check');
    expect(recorded?.request.method).toBe('POST');
    expect(recorded?.request.headers['authorization']).toBe('Bearer test-key');
    const text =
      recorded === undefined
        ? ''
        : Match.value(recorded.request.body).pipe(
            Match.tag('Uint8Array', ({ body }) => new TextDecoder().decode(body)),
            Match.orElse(() => ''),
          );
    expect(yield* Schema.decodeEffect(JsonText)(text)).toStrictEqual({
      permission: 'access',
      resource: { objectId: 't1', objectType: 'tenant' },
    });
  }),
);

it.effect('a gateway status becomes a typed failure carrying the gRPC code', () =>
  Effect.gen(function* checksGatewayStatus() {
    const { withGateway } = gateway(() =>
      Response.json({ code: 7, details: [], message: 'invalid preshared key: invalid token' }, { status: 403 }),
    );
    const failure = yield* Effect.flip(rpc.checkPermission(v1.CheckPermissionRequest.create({})).pipe(withGateway));
    expect(Predicate.isTagged(failure, 'SpiceDbRpcError')).toBe(true);
    expect(failure.code).toStrictEqual(Option.some(7));
  }),
);

it.effect('a non-status error body fails without a code', () =>
  Effect.gen(function* checksOpaqueFailure() {
    const { withGateway } = gateway(() => Response.json({ unexpected: true }, { status: 502 }));
    const failure = yield* Effect.flip(
      rpc.writeRelationships(v1.WriteRelationshipsRequest.create({})).pipe(withGateway),
    );
    expect(failure.code).toStrictEqual(Option.none());
  }),
);

it.effect('relationship stream frames decode in order', () =>
  Effect.gen(function* checksStreamOrder() {
    const { withGateway } = gateway(() =>
      ndjson([
        { result: { relationship: { relation: 'member' } } },
        { result: { relationship: { relation: 'support' } } },
      ]),
    );
    const responses = yield* rpc.readRelationships(v1.ReadRelationshipsRequest.create({})).pipe(withGateway);
    expect(responses.map(({ relationship }) => relationship?.relation)).toStrictEqual(['member', 'support']);
  }),
);

it.effect('an error frame in a relationship stream fails the whole read', () =>
  Effect.gen(function* checksStreamError() {
    const { withGateway } = gateway(() =>
      ndjson([
        { result: { relationship: { relation: 'member' } } },
        { error: { code: 14, details: [], message: 'unavailable' } },
      ]),
    );
    const failure = yield* Effect.flip(rpc.readRelationships(v1.ReadRelationshipsRequest.create({})).pipe(withGateway));
    expect(failure.code).toStrictEqual(Option.some(14));
  }),
);

it.effect('bulk item errors keep their code and message', () =>
  Effect.gen(function* checksBulkItemError() {
    const { withGateway } = gateway(() =>
      Response.json({
        pairs: [
          {
            error: {
              code: 9,
              details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'ERROR_REASON_UNKNOWN' }],
              message: 'relation/permission `nope` not found',
            },
            request: { permission: 'nope' },
          },
          { item: { permissionship: 'PERMISSIONSHIP_NO_PERMISSION' }, request: { permission: 'access' } },
        ],
      }),
    );
    const response = yield* rpc.checkBulkPermissions(v1.CheckBulkPermissionsRequest.create({})).pipe(withGateway);
    expect(response.pairs.map(({ response: pair }) => pair.oneofKind)).toStrictEqual(['error', 'item']);
    const [first] = response.pairs;
    expect(first?.response.oneofKind === 'error' ? first.response.error : undefined).toStrictEqual({
      code: 9,
      details: [],
      message: 'relation/permission `nope` not found',
    });
  }),
);

it.effect('a gateway that never replies is aborted at the deadline', () =>
  Effect.gen(function* checksDeadline() {
    const { requests, withGateway } = gateway(() => 'hang');
    const fiber = yield* Effect.flip(rpc.checkPermission(v1.CheckPermissionRequest.create({})).pipe(withGateway)).pipe(
      Effect.forkChild,
    );
    yield* TestClock.adjust(SPICEDB_CHECK_TIMEOUT_MS);
    const failure = yield* Fiber.join(fiber);
    expect(Cause.isTimeoutError(failure.cause)).toBe(true);
    expect(requests.map(({ signal }) => signal.aborted)).toStrictEqual([true]);
  }),
);
