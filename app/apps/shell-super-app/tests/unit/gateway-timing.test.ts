import { Effect, Exit, Logger, Option, Ref, Stream } from 'effect';
import { TestClock } from 'effect/testing';
import { HttpEffect, HttpServerRequest, HttpServerResponse } from 'effect/http';
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
  it.effect('preserves fixed numeric owner read phases alongside gateway phases', () =>
    Effect.gen(function* ownerAndGatewayTimings() {
      const ownerTimings =
        'read-authentication;dur=0, read-admission;dur=1.25, read-scope;dur=2, read-module;dur=3, read-permission;dur=4, read-prepare;dur=5, read-transaction;dur=6, read-authority;dur=7, read-rls;dur=8, read-owner;dur=9.125, read-validation;dur=10, read-audit;dur=11, read-encode;dur=12';
      const upstream = HttpServerResponse.text('owner response', {
        headers: {
          'cache-control': 'private, no-store',
          'server-timing': ownerTimings,
          'set-cookie': 'session=opaque; HttpOnly',
        },
        status: 202,
      });
      const response = yield* handle(
        TestClock.adjust(25).pipe(Effect.as(upstream), observeGatewayPhase('owner-dispatch'), withGatewayTimings),
      );
      expect(response.headers['server-timing']).toBe(`${ownerTimings}, owner-dispatch;dur=25`);
      expect(response.status).toBe(202);
      expect(response.body).toBe(upstream.body);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.headers['set-cookie']).toBe('session=opaque; HttpOnly');
    }),
  );

  it.effect('sanitizes owner-only responses without changing their streaming body or response policy', () =>
    Effect.gen(function* ownerOnlyTimings() {
      const upstream = HttpServerResponse.stream(Stream.never, {
        headers: {
          'cache-control': 'private, no-store',
          'server-timing': [
            ' read-owner ; dur=1.25 ',
            'read-encode;dur=0.0000001',
            'private-principal;dur=1',
            'read-private-tenant;dur=2',
            'isolate-private-id;dur=3',
            'owner-dispatch;dur=999',
            'read-audit;dur=1;desc="private-token"',
            'read-rls;dur=NaN',
            'read-rls;dur=Infinity',
            'read-rls;dur=-1',
            'read-rls;dur=-0',
            'read-rls;dur=+1',
            'read-rls;dur=1e3',
            'read-rls;dur=0x10',
            'read-rls;dur=.5',
            'read-rls;dur=5.',
            'read-rls;dur=1.2.3',
            'read-rls;dur=2ms',
            `read-rls;dur=${'9'.repeat(309)}`,
          ].join(', '),
          'set-cookie': 'session=opaque; HttpOnly',
        },
        status: 206,
      });
      const response = yield* handle(Effect.succeed(upstream).pipe(withGatewayTimings));
      expect(response.headers['server-timing']).toBe('read-owner;dur=1.25, read-encode;dur=0.0000001');
      expect(response.body).toBe(upstream.body);
      expect(response.status).toBe(206);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.headers['set-cookie']).toBe('session=opaque; HttpOnly');
    }),
  );

  it.effect('never promotes comma-separated text inside quoted descriptions into owner metrics', () =>
    Effect.gen(function* quotedOwnerTimings() {
      for (const description of [
        'private;desc="prefix, read-owner;dur=123456, suffix"',
        'read-audit;dur=1;desc="prefix, read-owner;dur=123456, suffix"',
        String.raw`private;desc="escaped \" quote, read-owner;dur=123456, suffix"`,
      ]) {
        const response = yield* handle(
          Effect.succeed(
            HttpServerResponse.empty({
              headers: { 'server-timing': `${description}, read-encode;dur=2` },
            }),
          ).pipe(withGatewayTimings),
        );
        expect(response.headers['server-timing']).toBe('read-encode;dur=2');
      }
      const malformed = yield* handle(
        Effect.succeed(
          HttpServerResponse.empty({
            headers: { 'server-timing': 'private;desc="unclosed, read-owner;dur=123456, read-encode;dur=2' },
          }),
        ).pipe(withGatewayTimings),
      );
      expect(malformed.headers['server-timing']).toBeUndefined();
    }),
  );

  it.effect('removes a wholly private or malformed owner header without adding empty timings', () =>
    Effect.gen(function* invalidOwnerTimings() {
      const response = yield* handle(
        Effect.succeed(
          HttpServerResponse.empty({
            headers: {
              'cache-control': 'no-store',
              'server-timing': 'private-principal;dur=1, read-owner;dur=NaN, isolate-private-id;dur=2',
            },
            status: 503,
          }),
        ).pipe(withGatewayTimings),
      );
      expect(response.headers['server-timing']).toBeUndefined();
      expect(response.status).toBe(503);
      expect(response.headers['cache-control']).toBe('no-store');
    }),
  );

  it.effect('bounds owner phases while reserving space for gateway phases', () =>
    Effect.gen(function* boundedOwnerTimings() {
      const response = yield* handle(
        TestClock.adjust(5).pipe(
          Effect.as(
            HttpServerResponse.empty({
              headers: { 'server-timing': Array.from({ length: 70 }, () => 'read-owner;dur=1').join(', ') },
            }),
          ),
          observeGatewayPhase('owner-dispatch'),
          withGatewayTimings,
        ),
      );
      expect(response.headers['server-timing']).toBe(
        [...Array.from({ length: 63 }, () => 'read-owner;dur=1'), 'owner-dispatch;dur=5'].join(', '),
      );
    }),
  );

  it.effect('rejects oversized owner headers but retains gateway diagnostics', () =>
    Effect.gen(function* oversizedOwnerTimings() {
      const response = yield* handle(
        Effect.succeed(
          HttpServerResponse.empty({
            headers: { 'server-timing': `read-owner;dur=1, ${'private'.repeat(600)}` },
          }),
        ).pipe(observeGatewayPhase('key-verify'), withGatewayTimings),
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
