import { Effect } from 'effect';
import { HttpServerRequest, HttpServerResponse } from 'effect/http';
import { assert, expect, it } from 'effect-rstest';

import { makeInternalSyncRetryTransportHandler } from '../integration/support/symmy-c14-sync-retry-transport.mts';

const syncPath = '/symmy-integration-api/symmy-integration/actions/admit-symmy-sync';
const jobPath = '/symmy-integration-api/symmy-integration/actions/admit-symmy-job';
const contextPath = '/symmy-integration-api/reads/symmy-route-context';
const retryKey = 'sync-only-retry-key';
const headers = {
  authorization: 'Bearer exact-native-assertion',
  'content-type': 'application/json',
  'idempotency-key': 'original-transport-key',
  'x-correlation-id': 'native-correlation',
  'x-ontos-composition-revision': 'native-composition',
};
const syncBody = JSON.stringify({
  customerGroups: [
    {
      businessCode: 'SOURCE_GROUP',
      code: 'SOURCE_GROUP',
      description: 'Source group description',
      meaningKey: 'source.group',
      membershipCriteria: 'Source classification',
      name: 'Source group',
      purpose: 'Source-owned grouping',
    },
  ],
  idempotencyKey: 'source-business-key',
  routeKey: 'customerGroupsBatch',
});

const harness = Effect.gen(function* transportHarness() {
  const forwarded: Request[] = [];
  const transport = yield* makeInternalSyncRetryTransportHandler({
    forward: (request) => {
      forwarded.push(request);
      return Effect.succeed(
        new Response('{"status":"queued"}', { headers: { 'x-owner-receipt': 'native-receipt' }, status: 202 }),
      );
    },
    ownerOrigin: 'https://native-owner.invalid',
  });
  const send = (path: string, body: string, method = 'POST') => {
    const init: RequestInit = { headers, method };
    if (method !== 'GET' && method !== 'HEAD') {
      init.body = body;
    }
    return transport.application.pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(new Request(`https://retry-fixture.invalid${path}`, init)),
      ),
    );
  };
  return { ...transport, forwarded, send };
});

it.effect(
  'forwards durable admission body, authority and idempotency unchanged even while the sync fault is active',
  () =>
    Effect.gen(function* durableAdmission() {
      const transport = yield* harness;
      yield* transport.activate(retryKey);
      // Deliberately not a sync payload: durable calls must not pass through the sync decoder.
      const body = '{ "products": [{"name":"Unseen SKU"}], "idempotencyKey": "business-key" }\n';
      const response = yield* transport.send(jobPath, body);
      expect(response.status).toBe(202);
      expect(response.headers['x-owner-receipt']).toBe('native-receipt');
      expect(yield* Effect.promise(() => HttpServerResponse.toWeb(response).text())).toBe('{"status":"queued"}');
      expect(transport.forwarded).toHaveLength(1);
      const [request] = transport.forwarded;
      assert.isDefined(request);
      expect(request.url).toBe(`https://native-owner.invalid${jobPath}`);
      expect(request.method).toBe('POST');
      expect(Object.fromEntries(request.headers)).toEqual(headers);
      expect(yield* Effect.promise(() => request.text())).toBe(body);
      expect(yield* transport.bodyFingerprints).toEqual([]);
    }),
);

it.effect('rejects unrelated paths and methods without forwarding or recording a sync fingerprint', () =>
  Effect.gen(function* boundedTransport() {
    const transport = yield* harness;
    yield* transport.activate(retryKey);
    for (const path of [syncPath, jobPath, contextPath]) {
      for (const method of ['GET', 'PUT', 'DELETE', 'HEAD']) {
        expect((yield* transport.send(path, syncBody, method)).status).toBe(404);
      }
    }
    for (const path of ['/unrelated', `${jobPath}/extra`, `${syncPath}/extra`]) {
      expect((yield* transport.send(path, syncBody)).status).toBe(404);
    }
    expect(transport.forwarded).toEqual([]);
    expect(yield* transport.bodyFingerprints).toEqual([]);
  }),
);

it.effect(
  'rewrites only active sync admission, preserving its body and authority and leaving route context untouched',
  () =>
    Effect.gen(function* restrictedSyncFault() {
      const transport = yield* harness;
      yield* transport.activate(retryKey);
      expect((yield* transport.send(syncPath, syncBody)).status).toBe(202);
      const [sync] = transport.forwarded;
      assert.isDefined(sync);
      expect(Object.fromEntries(sync.headers)).toEqual({ ...headers, 'idempotency-key': retryKey });
      expect(yield* Effect.promise(() => sync.text())).toBe(syncBody);
      expect(yield* transport.bodyFingerprints).toHaveLength(1);
      const contextBody = '{"routeKey":"productsBatch"}';
      expect((yield* transport.send(contextPath, contextBody)).status).toBe(202);
      const [, context] = transport.forwarded;
      assert.isDefined(context);
      expect(Object.fromEntries(context.headers)).toEqual(headers);
      expect(yield* Effect.promise(() => context.text())).toBe(contextBody);
      yield* transport.deactivate;
      expect((yield* transport.send(syncPath, syncBody)).status).toBe(202);
      const inactive = transport.forwarded.at(-1);
      assert.isDefined(inactive);
      expect(Object.fromEntries(inactive.headers)).toEqual(headers);
      expect(yield* Effect.promise(() => inactive.text())).toBe(syncBody);
      expect(yield* transport.bodyFingerprints).toHaveLength(1);
    }),
);
