import { Effect, Exit, Logger, Option, Ref } from 'effect';
import { TestClock } from 'effect/testing';
import { HttpEffect, HttpServerRequest, HttpServerResponse } from 'effect/unstable/http';
import { describe, expect, it } from 'effect-rstest';

import { GatewayTimings, gatewayTimingCollector, observeGatewayPhase } from '../../api/auth/gateway-timing.ts';

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

describe('Shell gateway phase timing', () => {
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
