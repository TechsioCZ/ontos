import { makeEffectTestCallback } from '@app/core-runtime/testing/effect-runtime';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Effect } from 'effect';
import { makeOperationGateway } from '../../src/operation-gateway.ts';

const gatewayAcquisitionFailure = {
  _tag: 'GatewayAcquisitionTestError',
  reason: 'issuer unavailable',
} as const;
const operationAttemptFailure = {
  _tag: 'OperationAttemptTestError',
  reason: 'operation unavailable',
} as const;

const audience = 'inventory-stock' as const;
const options = {
  baseUrl: new URL('https://shell.example.test'),
  cookie: 'session=test-session',
} as const;

const expectType = <Expected>(value: Expected): Expected => value;

void test(
  'preserves the literal audience and success and failure inference',
  makeEffectTestCallback(
    Effect.gen(function* inferenceEffect() {
      const gateway = makeOperationGateway(audience, ({ audience: receivedAudience }) => {
        expectType<typeof audience>(receivedAudience);
        return Effect.fail(gatewayAcquisitionFailure);
      });

      yield* expectType<
        Effect.Effect<never, typeof gatewayAcquisitionFailure | typeof operationAttemptFailure>
      >(gateway.invoke(() => Effect.fail(operationAttemptFailure))).pipe(Effect.flip);
      yield* expectType<Effect.Effect<'completed'>>(
        makeOperationGateway(audience, () =>
          Effect.succeed({ expiresAt: 1_700_000_300, token: 'test-token' }),
        ).invoke(() => Effect.succeed('completed' as const)),
      );
    }),
  ),
);

void test(
  'acquires one audience-scoped assertion and forwards options unchanged',
  makeEffectTestCallback(
    Effect.gen(function* audienceAssertionEffect() {
      const issuerCalls: {
        readonly audience: typeof audience;
        readonly options: typeof options;
      }[] = [];
      const authorizations: string[] = [];
      const gateway = makeOperationGateway(audience, (payload, receivedOptions) =>
        Effect.sync(() => {
          assert.equal(receivedOptions, options);
          issuerCalls.push({ audience: payload.audience, options });
          return { expiresAt: 1_700_000_300, token: 'header.payload.signature' };
        }),
      );

      const result = yield* gateway.invoke((authorization) => {
        authorizations.push(authorization);
        return Effect.succeed('completed' as const);
      }, options);

      assert.equal(result, 'completed');
      assert.deepEqual(issuerCalls, [{ audience, options }]);
      assert.deepEqual(authorizations, ['Bearer header.payload.signature']);
    }),
  ),
);

void test(
  'acquires a fresh assertion whenever an invocation Effect is executed',
  makeEffectTestCallback(
    Effect.gen(function* freshAssertionEffect() {
      let acquisitions = 0;
      const gateway = makeOperationGateway(audience, () =>
        Effect.sync(() => {
          acquisitions += 1;
          return { expiresAt: 1_700_000_300, token: `attempt-${acquisitions}` };
        }),
      );
      const authorizations: string[] = [];
      const invocation = gateway.invoke((authorization) =>
        Effect.sync(() => {
          authorizations.push(authorization);
        }),
      );

      yield* invocation;
      yield* invocation;

      assert.equal(acquisitions, 2);
      assert.deepEqual(authorizations, ['Bearer attempt-1', 'Bearer attempt-2']);
    }),
  ),
);

void test(
  'preserves issuer failure and does not construct the attempted Effect',
  makeEffectTestCallback(
    Effect.gen(function* issuerFailureEffect() {
      let attemptCalls = 0;
      const gateway = makeOperationGateway(audience, () => Effect.fail(gatewayAcquisitionFailure));

      const received = yield* gateway
        .invoke(() => {
          attemptCalls += 1;
          return Effect.succeed('must not run');
        })
        .pipe(Effect.flip);

      assert.equal(received, gatewayAcquisitionFailure);
      assert.equal(attemptCalls, 0);
    }),
  ),
);

void test(
  'preserves the attempted-operation failure without translation',
  makeEffectTestCallback(
    Effect.gen(function* attemptFailureEffect() {
      const gateway = makeOperationGateway(audience, () =>
        Effect.succeed({ expiresAt: 1_700_000_300, token: 'test-token' }),
      );

      const received = yield* gateway
        .invoke(() => Effect.fail(operationAttemptFailure))
        .pipe(Effect.flip);

      assert.equal(received, operationAttemptFailure);
    }),
  ),
);
