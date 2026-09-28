import { v1 } from '@authzed/authzed-node';
import { Cause, Effect, Fiber, Option, Predicate, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { TestClock } from 'effect/testing';

import { SPICEDB_CHECK_TIMEOUT_MS } from '../../src/permissions/client.ts';
import { openSpiceDbHttpRpc } from '../../src/permissions/spicedb-http-rpc.ts';

const origin = new URL('https://spicedb:8443');
const JsonText = Schema.fromJsonString(Schema.Json);

/** A gateway double that records each request and answers with the given response. */
const gateway = (answer: (request: Request) => Response | 'hang') => {
  const requests: Request[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    const response = answer(request);
    if (response !== 'hang') {
      return Promise.resolve(response);
    }
    const pending = Promise.withResolvers<Response>();
    request.signal.addEventListener('abort', () => pending.reject(request.signal.reason));
    return pending.promise;
  };
  const rpc = openSpiceDbHttpRpc({
    fetch,
    origin,
    preSharedKey: Redacted.make('test-key'),
    timeoutMilliseconds: SPICEDB_CHECK_TIMEOUT_MS,
  });
  return { requests, rpc };
};

const ndjson = (frames: readonly Schema.Json[]) =>
  new Response(frames.map((frame) => `${Schema.encodeSync(JsonText)(frame)}\n`).join(''));

it.effect('posts canonical proto3 JSON with the preshared key to the gateway route', () =>
  Effect.gen(function* checksGatewayRequest() {
    const { requests, rpc } = gateway(() =>
      Response.json({ checkedAt: { token: 't' }, permissionship: 'PERMISSIONSHIP_HAS_PERMISSION' }),
    );
    const response = yield* rpc.checkPermission(
      v1.CheckPermissionRequest.create({
        permission: 'access',
        resource: v1.ObjectReference.create({ objectId: 't1', objectType: 'tenant' }),
      }),
    );
    expect(response.permissionship).toBe(v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION);
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request?.url).toBe('https://spicedb:8443/v1/permissions/check');
    expect(request?.method).toBe('POST');
    expect(request?.headers.get('authorization')).toBe('Bearer test-key');
    const body = yield* Effect.promise(() => request?.text() ?? Promise.resolve(''));
    expect(yield* Schema.decodeEffect(JsonText)(body)).toStrictEqual({
      permission: 'access',
      resource: { objectId: 't1', objectType: 'tenant' },
    });
  }),
);

it.effect('a gateway status becomes a typed failure carrying the gRPC code', () =>
  Effect.gen(function* checksGatewayStatus() {
    const { rpc } = gateway(() =>
      Response.json({ code: 7, details: [], message: 'invalid preshared key: invalid token' }, { status: 403 }),
    );
    const failure = yield* Effect.flip(rpc.checkPermission(v1.CheckPermissionRequest.create({})));
    expect(Predicate.isTagged(failure, 'SpiceDbRpcError')).toBe(true);
    expect(failure.code).toStrictEqual(Option.some(7));
  }),
);

it.effect('a non-status error body fails without a code', () =>
  Effect.gen(function* checksOpaqueFailure() {
    const { rpc } = gateway(() => Response.json({ unexpected: true }, { status: 502 }));
    const failure = yield* Effect.flip(rpc.writeRelationships(v1.WriteRelationshipsRequest.create({})));
    expect(failure.code).toStrictEqual(Option.none());
  }),
);

it.effect('relationship stream frames decode in order', () =>
  Effect.gen(function* checksStreamOrder() {
    const { rpc } = gateway(() =>
      ndjson([
        { result: { relationship: { relation: 'member' } } },
        { result: { relationship: { relation: 'support' } } },
      ]),
    );
    const responses = yield* rpc.readRelationships(v1.ReadRelationshipsRequest.create({}));
    expect(responses.map(({ relationship }) => relationship?.relation)).toStrictEqual(['member', 'support']);
  }),
);

it.effect('an error frame in a relationship stream fails the whole read', () =>
  Effect.gen(function* checksStreamError() {
    const { rpc } = gateway(() =>
      ndjson([
        { result: { relationship: { relation: 'member' } } },
        { error: { code: 14, details: [], message: 'unavailable' } },
      ]),
    );
    const failure = yield* Effect.flip(rpc.readRelationships(v1.ReadRelationshipsRequest.create({})));
    expect(failure.code).toStrictEqual(Option.some(14));
  }),
);

it.effect('bulk item errors keep their code and message', () =>
  Effect.gen(function* checksBulkItemError() {
    const { rpc } = gateway(() =>
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
    const response = yield* rpc.checkBulkPermissions(v1.CheckBulkPermissionsRequest.create({}));
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
    const { requests, rpc } = gateway(() => 'hang');
    const fiber = yield* Effect.flip(rpc.checkPermission(v1.CheckPermissionRequest.create({}))).pipe(Effect.forkChild);
    yield* TestClock.adjust(SPICEDB_CHECK_TIMEOUT_MS);
    const failure = yield* Fiber.join(fiber);
    expect(Cause.isTimeoutError(failure.cause)).toBe(true);
    expect(requests.map(({ signal }) => signal.aborted)).toStrictEqual([true]);
  }),
);
