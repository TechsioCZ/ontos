// @rstest-environment node
import { Effect, Exit, Logger, Option, Ref, Stream } from 'effect';
import { TestClock } from 'effect/testing';
import { HttpEffect, HttpServerRequest, HttpServerResponse } from 'effect/http';
import { describe, expect, it } from 'effect-rstest';

import { GatewayTimings, observeGatewayPhase } from '../../api/auth/gateway-timing.ts';
import { withoutServerTiming } from '../../api/no-server-timing.ts';

// As the Shell API root wraps each gateway request.
const withGatewayTimings = <Value, Failure, Requirements>(effect: Effect.Effect<Value, Failure, Requirements>) =>
  effect.pipe(Effect.provideService(GatewayTimings, true));

/** The response `effect` sends, its pre-response hooks applied. */
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

/** A request hook adding `server-timing`, as the gateway collector and Core's in-process Action runner used to. */
const addsServerTiming = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(HttpServerResponse.setHeader(response, 'server-timing', OWNER_TIMING)),
);

describe('Shell gateway phase timing', () => {
  it.effect('logs each measured phase with its milliseconds, and nothing for an unmeasured request', () => {
    const entries: unknown[] = [];
    return Effect.gen(function* measuredPhases() {
      const phases = Effect.gen(function* runPhases() {
        yield* TestClock.adjust(125).pipe(observeGatewayPhase('legal-entity-sql'));
        yield* TestClock.adjust(1750).pipe(observeGatewayPhase('legal-entity-spicedb'));
        return HttpServerResponse.text('catalog');
      });
      yield* handle(phases.pipe(withGatewayTimings));
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
      yield* handle(phases);
      expect(entries).toHaveLength(2);
    }).pipe(Effect.provide(capturedLogs(entries)));
  });

  it.effect('logs a failed phase as a warning without its private cause, and keeps the failure', () => {
    const entries: unknown[] = [];
    return Effect.gen(function* failedGateway() {
      const privateFailure = { credential: 'private-api-key', principalId: 'private-principal' };
      const exit = yield* TestClock.adjust(2000).pipe(
        Effect.andThen(Effect.fail(privateFailure)),
        observeGatewayPhase('key-verify'),
        withGatewayTimings,
        Effect.exit,
      );
      expect(Exit.findErrorOption(exit)).toEqual(Option.some(privateFailure));
      expect(entries).toMatchObject([
        { annotations: { durationMs: 2000, gatewayPhase: 'key-verify' }, message: 'Shell gateway phase failed' },
      ]);
      expect(JSON.stringify(entries)).not.toContain('private-api-key');
      expect(JSON.stringify(entries)).not.toContain('private-principal');
    }).pipe(Effect.provide(capturedLogs(entries)));
  });
});

describe('no Shell response carries server-timing', () => {
  it.effect('removes one a request hook added, after every hook, on success and on failure', () =>
    Effect.gen(function* hookTimingRemoved() {
      const succeeded = yield* handle(
        Effect.succeed(HttpServerResponse.text('ok')).pipe(
          Effect.tap(() => addsServerTiming),
          withoutServerTiming,
        ),
      );
      expect(succeeded.headers['server-timing']).toBeUndefined();
      const failed = yield* handle(
        addsServerTiming.pipe(
          Effect.andThen(Effect.fail('refused')),
          withoutServerTiming,
          Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 503 })),
        ),
      );
      expect(failed.status).toBe(503);
      expect(failed.headers['server-timing']).toBeUndefined();
    }),
  );

  it.effect('removes one already on the response without changing its stream, status or other headers', () =>
    Effect.gen(function* upstreamTimingRemoved() {
      const upstream = HttpServerResponse.stream(Stream.never, {
        headers: {
          'cache-control': 'private, no-store',
          'server-timing': OWNER_TIMING,
          'set-cookie': 'session=opaque; HttpOnly',
        },
        status: 206,
      });
      const response = yield* handle(Effect.succeed(upstream).pipe(withoutServerTiming));
      expect(response.headers['server-timing']).toBeUndefined();
      expect(response.body).toBe(upstream.body);
      expect(response.status).toBe(206);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.headers['set-cookie']).toBe('session=opaque; HttpOnly');
    }),
  );
});
