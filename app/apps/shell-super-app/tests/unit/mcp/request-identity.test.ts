// @rstest-environment node
import { ActionTransportMetadataSchema } from '@app/core-runtime';
import { NodeCrypto } from '@effect/platform-node';
import { Deferred, Effect, Layer, Option, Ref, Schema } from 'effect';
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/unstable/http';
import { describe, expect, it } from 'effect-rstest';

import { AgentActionRequestIdentity } from '../../../api/auth/agent-action-request-identity.ts';
import { AgentReadRequestIdentity } from '../../../api/auth/agent-request-identity.ts';
import { mcpRequestIdentityMiddleware } from '../../../api/index.ts';
import { serveMcpMetadata } from '../../../api/mcp/http.ts';

const RESOURCE = 'https://identity.ontos.test/mcp';
const METADATA = 'https://identity.ontos.test/.well-known/oauth-protected-resource/mcp';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const observationSchema = Schema.Struct({
  action: Schema.OptionFromNullOr(ActionTransportMetadataSchema),
  correlationHeader: Schema.OptionFromNullOr(Schema.String),
  idempotencyHeader: Schema.OptionFromNullOr(Schema.String),
  read: Schema.OptionFromNullOr(ActionTransportMetadataSchema),
  traceHeader: Schema.OptionFromNullOr(Schema.String),
});

// This router has no principal, authentication, database, or Action authority services.
const acquireServer = (beforeObservation: Effect.Effect<void> = Effect.void) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const observe = Effect.gen(function* observeRequestIdentity() {
        yield* beforeObservation;
        const request = yield* HttpServerRequest.HttpServerRequest;
        const read = yield* Effect.serviceOption(AgentReadRequestIdentity);
        const action = yield* Effect.serviceOption(AgentActionRequestIdentity);
        return yield* HttpServerResponse.json({
          action: Option.getOrNull(action),
          correlationHeader: request.headers['x-correlation-id'] ?? null,
          idempotencyHeader: request.headers['idempotency-key'] ?? null,
          read: Option.getOrNull(read),
          traceHeader: request.headers['x-trace-id'] ?? null,
        });
      });
      const metadata = serveMcpMetadata({
        config: Effect.succeed({
          issuer: 'https://identity.ontos.test/oauth',
          prmUrl: METADATA,
          publicOrigin: 'https://identity.ontos.test',
          resource: RESOURCE,
        }),
      });
      const routes = Layer.mergeAll(
        HttpRouter.add('GET', '/mcp', observe),
        HttpRouter.add('GET', '/.well-known/oauth-protected-resource/mcp', (request) =>
          HttpServerRequest.toWeb(request).pipe(
            Effect.flatMap(metadata),
            Effect.map((response) => HttpServerResponse.raw(response, { status: response.status })),
          ),
        ),
      ).pipe(Layer.provide(mcpRequestIdentityMiddleware.layer.pipe(Layer.provide(NodeCrypto.layer))));
      return HttpRouter.toWebHandler(routes, { disableLogger: true });
    }),
    (server) => Effect.promise(() => server.dispose()),
  );

type Server = Effect.Success<ReturnType<typeof acquireServer>>;

const observeRequest = (server: Server, headers: HeadersInit = {}) =>
  Effect.gen(function* sendObservedRequest() {
    const response = yield* Effect.promise(() => server.handler(new Request(RESOURCE, { headers })));
    expect(response.status).toBe(200);
    const observed = yield* Effect.promise(() => response.json()).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(observationSchema)),
    );
    return {
      action: Option.getOrNull(observed.action),
      correlationHeader: Option.getOrNull(observed.correlationHeader),
      idempotencyHeader: Option.getOrNull(observed.idempotencyHeader),
      read: Option.getOrNull(observed.read),
      traceHeader: Option.getOrNull(observed.traceHeader),
    };
  });

describe('MCP root request identity middleware', () => {
  it.live('generates a cryptographic UUID v4 and forwards the same correlation to the read service', () =>
    Effect.gen(function* generatedCorrelation() {
      const server = yield* acquireServer();
      const observed = yield* observeRequest(server);
      expect(observed.correlationHeader).toMatch(UUID_V4);
      expect(observed.read).toEqual({ correlationId: observed.correlationHeader });
      expect(observed.action).toBeNull();
      expect(observed.idempotencyHeader).toBeNull();
      expect(observed.traceHeader).toBeNull();
    }),
  );

  it.live('preserves valid caller correlation and trace without inventing an Action key', () =>
    Effect.gen(function* suppliedReadMetadata() {
      const server = yield* acquireServer();
      const observed = yield* observeRequest(server, {
        'x-correlation-id': 'client-correlation:Case-Sensitive',
        'x-trace-id': 'client-trace:Case-Sensitive',
      });
      expect(observed).toEqual({
        action: null,
        correlationHeader: 'client-correlation:Case-Sensitive',
        idempotencyHeader: null,
        read: {
          correlationId: 'client-correlation:Case-Sensitive',
          traceId: 'client-trace:Case-Sensitive',
        },
        traceHeader: 'client-trace:Case-Sensitive',
      });
    }),
  );

  it.live('preserves the caller Action key exactly and shares correlation and trace with reads', () =>
    Effect.gen(function* suppliedActionMetadata() {
      const server = yield* acquireServer();
      const idempotencyKey = 'Caller-Intent:AbC_123/retry';
      const observed = yield* observeRequest(server, {
        'idempotency-key': idempotencyKey,
        'x-correlation-id': 'action-correlation',
        'x-trace-id': 'action-trace',
      });
      expect(observed).toEqual({
        action: {
          correlationId: 'action-correlation',
          idempotencyKey,
          traceId: 'action-trace',
        },
        correlationHeader: 'action-correlation',
        idempotencyHeader: idempotencyKey,
        read: { correlationId: 'action-correlation', traceId: 'action-trace' },
        traceHeader: 'action-trace',
      });
    }),
  );

  it.live('generates only correlation when an Action key and trace are supplied without correlation', () =>
    Effect.gen(function* suppliedActionWithoutCorrelation() {
      const server = yield* acquireServer();
      const observed = yield* observeRequest(server, {
        'idempotency-key': 'Caller-Key:Keep-Exactly',
        'x-trace-id': 'caller-trace',
      });
      expect(observed.correlationHeader).toMatch(UUID_V4);
      expect(observed.read).toEqual({ correlationId: observed.correlationHeader, traceId: 'caller-trace' });
      expect(observed.action).toEqual({
        correlationId: observed.correlationHeader,
        idempotencyKey: 'Caller-Key:Keep-Exactly',
        traceId: 'caller-trace',
      });
      expect(observed.idempotencyHeader).toBe('Caller-Key:Keep-Exactly');
      expect(observed.traceHeader).toBe('caller-trace');
    }),
  );

  it.live('isolates generated and supplied metadata across overlapping requests on one router', () =>
    Effect.gen(function* concurrentRequestIdentity() {
      const requestCount = 8;
      const arrived = yield* Ref.make(0);
      const allArrived = yield* Deferred.make<boolean>();
      const barrier = Effect.gen(function* awaitOverlappingRequests() {
        const count = yield* Ref.updateAndGet(arrived, (value) => value + 1);
        if (count === requestCount) {
          yield* Deferred.succeed(allArrived, true);
        }
        yield* Deferred.await(allArrived);
      });
      const server = yield* acquireServer(barrier);
      const observations = yield* Effect.all(
        Array.from({ length: requestCount }, (_, index) =>
          index % 2 === 0
            ? observeRequest(server, {
                'idempotency-key': `caller-intent-${index}`,
                'x-correlation-id': `caller-correlation-${index}`,
                'x-trace-id': `trace-${index}`,
              })
            : observeRequest(server, { 'x-trace-id': `trace-${index}` }),
        ),
        { concurrency: 'unbounded' },
      );
      expect(new Set(observations.map((observed) => observed.correlationHeader)).size).toBe(requestCount);
      for (const [index, observed] of observations.entries()) {
        expect(observed.read).toEqual({ correlationId: observed.correlationHeader, traceId: `trace-${index}` });
        expect(observed.traceHeader).toBe(`trace-${index}`);
        if (index % 2 === 0) {
          expect(observed.correlationHeader).toBe(`caller-correlation-${index}`);
          expect(observed.action).toEqual({
            correlationId: `caller-correlation-${index}`,
            idempotencyKey: `caller-intent-${index}`,
            traceId: `trace-${index}`,
          });
          expect(observed.idempotencyHeader).toBe(`caller-intent-${index}`);
        } else {
          expect(observed.correlationHeader).toMatch(UUID_V4);
          expect(observed.action).toBeNull();
          expect(observed.idempotencyHeader).toBeNull();
        }
      }
    }),
  );

  for (const header of ['x-correlation-id', 'x-trace-id', 'idempotency-key']) {
    for (const value of ['', 'x'.repeat(201)]) {
      it.live(`leaves identities unbound and public discovery reachable for ${header} of length ${value.length}`, () =>
        Effect.gen(function* malformedRequestMetadata() {
          const server = yield* acquireServer();
          const headers = new Headers({
            'idempotency-key': 'valid-caller-intent',
            'x-correlation-id': 'valid-caller-correlation',
            'x-trace-id': 'valid-caller-trace',
          });
          headers.set(header, value);
          const observed = yield* observeRequest(server, headers);
          expect(observed.read).toBeNull();
          expect(observed.action).toBeNull();
          expect(observed.correlationHeader).toBe(headers.get('x-correlation-id'));
          expect(observed.idempotencyHeader).toBe(headers.get('idempotency-key'));
          expect(observed.traceHeader).toBe(headers.get('x-trace-id'));
          const response = yield* Effect.promise(() => server.handler(new Request(METADATA, { headers })));
          expect(response.status).toBe(200);
          const body: unknown = yield* Effect.promise(() => response.json());
          expect(body).toMatchObject({
            authorization_servers: ['https://identity.ontos.test/oauth'],
            resource: RESOURCE,
          });
        }),
      );
    }
  }
});
