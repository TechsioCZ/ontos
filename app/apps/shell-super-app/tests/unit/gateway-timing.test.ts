// @rstest-environment node
import { Effect, Exit, Logger, Option, Ref, Stream } from 'effect';
import { TestClock } from 'effect/testing';
import { HttpEffect, HttpServerRequest, HttpServerResponse } from 'effect/http';
import { describe, expect, it } from 'effect-rstest';

import { GatewayTimings, gatewayTimingCollector, observeGatewayPhase } from '../../api/auth/gateway-timing.ts';
import { relayModuleResponse } from '../../src/module-api/response-relay.ts';

// As the Shell API root wraps each gateway request.
const withGatewayTimings = <Value, Failure, Requirements>(effect: Effect.Effect<Value, Failure, Requirements>) =>
  Effect.gen(function* provideRequestTimings() {
    const collector = yield* gatewayTimingCollector;
    yield* collector.appendResponseHeader;
    return yield* effect.pipe(Effect.provideService(GatewayTimings, Option.some(collector.timings)));
  });

const handle = <Failure, Requirements>(
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, Failure, Requirements>,
) =>
  Effect.gen(function* handleGatewayResponse() {
    const response = yield* Ref.make(HttpServerResponse.empty());
    yield* HttpEffect.toHandled(effect, (_request, sent) => Ref.set(response, sent)).pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(new Request('https://shell.test/')),
      ),
    );
    return yield* Ref.get(response);
  });

const capturedLogs = (entries: unknown[]) =>
  Logger.layer([
    Logger.make((options) => {
      entries.push(Logger.formatStructured.log(options));
    }),
  ]);

const OWNER_TIMING = 'owner-total;dur=40, owner-gate;dur=12, read-owner;dur=9.125, read-encode;dur=12';

describe('Shell gateway phase timing', () => {
  it.effect('sends only its own phases, never the owner timings of a relayed owner response', () =>
    Effect.gen(function* ownerTimingsStayInside() {
      const upstream = HttpServerResponse.fromWeb(
        relayModuleResponse(
          new Response('owner response', {
            headers: {
              'cache-control': 'public, max-age=3600',
              'content-type': 'application/json',
              location: 'https://untrusted.test',
              refresh: '0;url=https://untrusted.test',
              'server-timing': OWNER_TIMING,
              'set-cookie': 'session=opaque; HttpOnly',
              'x-private-debug': 'secret',
            },
            status: 202,
          }),
          'https://shell.test',
        ),
      );
      const response = yield* handle(
        TestClock.adjust(25).pipe(Effect.as(upstream), observeGatewayPhase('owner-dispatch'), withGatewayTimings),
      );
      expect(response.headers['server-timing']).toBe('owner-dispatch;dur=25');
      expect(response.status).toBe(202);
      expect(response.body).toBe(upstream.body);
      const webResponse = HttpServerResponse.toWeb(response);
      expect(yield* Effect.promise(() => webResponse.text())).toBe('owner response');
      expect(webResponse.headers.get('content-type')).toBe('application/json');
      expect(webResponse.headers.get('cache-control')).toBe('no-store');
      expect(webResponse.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
      expect(webResponse.headers.get('vary')).toBe('authorization');
      expect(webResponse.headers.get('x-content-type-options')).toBe('nosniff');
      for (const name of ['set-cookie', 'refresh', 'location', 'x-private-debug']) {
        expect(webResponse.headers.get(name)).toBeNull();
      }
    }),
  );

  it.effect('removes a server-timing header already on the response without changing its stream or policy', () =>
    Effect.gen(function* upstreamTimingRemoved() {
      const upstream = HttpServerResponse.stream(Stream.never, {
        headers: {
          'cache-control': 'private, no-store',
          'server-timing': OWNER_TIMING,
          'set-cookie': 'session=opaque; HttpOnly',
        },
        status: 206,
      });
      const response = yield* handle(Effect.succeed(upstream).pipe(withGatewayTimings));
      expect(response.headers['server-timing']).toBeUndefined();
      expect(response.body).toBe(upstream.body);
      expect(response.status).toBe(206);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.headers['set-cookie']).toBe('session=opaque; HttpOnly');
    }),
  );

  it.effect('replaces a server-timing header already on the response with its own phases', () =>
    Effect.gen(function* upstreamTimingReplaced() {
      const response = yield* handle(
        Effect.succeed(HttpServerResponse.empty({ headers: { 'server-timing': OWNER_TIMING } })).pipe(
          observeGatewayPhase('key-verify'),
          withGatewayTimings,
        ),
      );
      expect(response.headers['server-timing']).toBe('key-verify;dur=0');
    }),
  );

  it.effect('bounds repeated gateway phases even without an owner header', () =>
    Effect.gen(function* boundedGatewayTimings() {
      const response = yield* handle(
        Effect.forEach(Array.from({ length: 70 }), () => Effect.void.pipe(observeGatewayPhase('key-verify'))).pipe(
          Effect.as(HttpServerResponse.empty()),
          withGatewayTimings,
        ),
      );
      expect(response.headers['server-timing']).toBe(Array.from({ length: 64 }, () => 'key-verify;dur=0').join(', '));
    }),
  );

  it.effect('reports document session, composition, admission and signing phases', () =>
    Effect.gen(function* documentPhases() {
      const response = yield* handle(
        Effect.gen(function* prepareDocument() {
          yield* TestClock.adjust(20).pipe(observeGatewayPhase('session-read'));
          yield* TestClock.adjust(30).pipe(observeGatewayPhase('session-principal'));
          yield* TestClock.adjust(40).pipe(observeGatewayPhase('document-admission'));
          yield* TestClock.adjust(50).pipe(observeGatewayPhase('document-composition'));
          yield* TestClock.adjust(10).pipe(observeGatewayPhase('document-assertions'));
          return HttpServerResponse.empty();
        }).pipe(withGatewayTimings),
      );
      expect(response.headers['server-timing']).toBe(
        'session-read;dur=20, session-principal;dur=30, document-admission;dur=40, document-composition;dur=50, document-assertions;dur=10',
      );
    }),
  );

  it.effect('records distinct phase durations in structured logs and the real response header', () => {
    const entries: unknown[] = [];
    return Effect.gen(function* successfulGateway() {
      const response = yield* handle(
        Effect.gen(function* runPhases() {
          yield* TestClock.adjust(125).pipe(observeGatewayPhase('legal-entity-sql'));
          yield* TestClock.adjust(1750).pipe(observeGatewayPhase('legal-entity-spicedb'));
          return HttpServerResponse.text('catalog', { headers: { 'cache-control': 'no-store' } });
        }).pipe(withGatewayTimings),
      );
      expect(response.headers['server-timing']).toBe('legal-entity-sql;dur=125, legal-entity-spicedb;dur=1750');
      expect(response.headers['cache-control']).toBe('no-store');
      expect(entries).toMatchObject([
        {
          annotations: { durationMs: 125, gatewayPhase: 'legal-entity-sql' },
          message: 'Shell gateway phase completed',
        },
        {
          annotations: { durationMs: 1750, gatewayPhase: 'legal-entity-spicedb' },
          message: 'Shell gateway phase completed',
        },
      ]);
    }).pipe(Effect.provide(capturedLogs(entries)));
  });

  it.effect(
    'preserves failures and puts completed timings on the sanitized error response without logging private causes',
    () => {
      const entries: unknown[] = [];
      return Effect.gen(function* failedGateway() {
        const privateFailure = { credential: 'private-api-key', principalId: 'private-principal' };
        const response = yield* handle(
          TestClock.adjust(2000).pipe(
            Effect.andThen(Effect.fail(privateFailure)),
            observeGatewayPhase('key-verify'),
            Effect.exit,
            Effect.flatMap((exit) => {
              expect(Exit.findErrorOption(exit)).toEqual(Option.some(privateFailure));
              return Effect.succeed(HttpServerResponse.empty({ status: 503 }));
            }),
            withGatewayTimings,
          ),
        );
        expect(response.status).toBe(503);
        expect(response.headers['server-timing']).toBe('key-verify;dur=2000');
        expect(entries).toMatchObject([
          { annotations: { durationMs: 2000, gatewayPhase: 'key-verify' }, message: 'Shell gateway phase failed' },
        ]);
        expect(JSON.stringify(entries)).not.toContain('private-api-key');
        expect(JSON.stringify(entries)).not.toContain('private-principal');
      }).pipe(Effect.provide(capturedLogs(entries)));
    },
  );

  it.effect('isolates timing collectors between concurrent requests', () =>
    Effect.gen(function* concurrentGateways() {
      const [first, second] = yield* Effect.all(
        [
          handle(
            Effect.succeed(HttpServerResponse.empty()).pipe(observeGatewayPhase('key-verify'), withGatewayTimings),
          ),
          handle(
            Effect.succeed(HttpServerResponse.empty()).pipe(
              observeGatewayPhase('principal-resolve'),
              withGatewayTimings,
            ),
          ),
        ],
        { concurrency: 'unbounded' },
      );
      expect(first.headers['server-timing']).toBe('key-verify;dur=0');
      expect(second.headers['server-timing']).toBe('principal-resolve;dur=0');
    }),
  );

  it.effect('does not log outside a gateway request or add an empty header', () => {
    const entries: unknown[] = [];
    return Effect.gen(function* unrelatedRequest() {
      expect(yield* Effect.succeed('unchanged').pipe(observeGatewayPhase('owner-dispatch'))).toBe('unchanged');
      const response = yield* handle(Effect.succeed(HttpServerResponse.empty()).pipe(withGatewayTimings));
      expect(response.headers['server-timing']).toBeUndefined();
      expect(entries).toEqual([]);
    }).pipe(Effect.provide(capturedLogs(entries)));
  });
});
