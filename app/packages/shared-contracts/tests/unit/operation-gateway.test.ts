import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

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

it.effect('preserves the literal audience and success and failure inference', () =>
  Effect.gen(function* inferenceEffect() {
    const gateway = makeOperationGateway(audience, ({ audience: receivedAudience }) => {
      expectType<typeof audience>(receivedAudience);
      return Effect.fail(gatewayAcquisitionFailure);
    });

    yield* expectType<Effect.Effect<never, typeof gatewayAcquisitionFailure | typeof operationAttemptFailure>>(
      gateway.invoke(() => Effect.fail(operationAttemptFailure)),
    ).pipe(Effect.flip);
    yield* expectType<Effect.Effect<'completed'>>(
      makeOperationGateway(audience, () => Effect.succeed({ expiresAt: 1_700_000_300, token: 'test-token' })).invoke(
        () => Effect.succeed('completed' as const),
      ),
    );
  }),
);

it.effect('acquires one audience-scoped assertion and forwards options unchanged', () =>
  Effect.gen(function* audienceAssertionEffect() {
    const issuerCalls: {
      readonly audience: typeof audience;
      readonly options: typeof options;
    }[] = [];
    const authorizations: string[] = [];
    const gateway = makeOperationGateway(audience, (payload, receivedOptions) =>
      Effect.sync(() => {
        expect(receivedOptions).toBe(options);
        issuerCalls.push({ audience: payload.audience, options });
        return {
          expiresAt: 1_700_000_300,
          token: 'header.payload.signature',
        };
      }),
    );

    const result = yield* gateway.invoke((authorization) => {
      authorizations.push(authorization);
      return Effect.succeed('completed' as const);
    }, options);

    expect(result).toBe('completed');
    expect(issuerCalls).toEqual([{ audience, options }]);
    expect(authorizations).toEqual(['Bearer header.payload.signature']);
  }),
);

it.effect('acquires a fresh assertion whenever an invocation Effect is executed', () =>
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

    expect(acquisitions).toBe(2);
    expect(authorizations).toEqual(['Bearer attempt-1', 'Bearer attempt-2']);
  }),
);

it.effect('preserves issuer failure and does not construct the attempted Effect', () =>
  Effect.gen(function* issuerFailureEffect() {
    let attemptCalls = 0;
    const gateway = makeOperationGateway(audience, () => Effect.fail(gatewayAcquisitionFailure));

    const received = yield* gateway
      .invoke(() => {
        attemptCalls += 1;
        return Effect.succeed('must not run');
      })
      .pipe(Effect.flip);

    expect(received).toBe(gatewayAcquisitionFailure);
    expect(attemptCalls).toBe(0);
  }),
);

it.effect('preserves the attempted-operation failure without translation', () =>
  Effect.gen(function* attemptFailureEffect() {
    const gateway = makeOperationGateway(audience, () =>
      Effect.succeed({ expiresAt: 1_700_000_300, token: 'test-token' }),
    );

    const received = yield* gateway.invoke(() => Effect.fail(operationAttemptFailure)).pipe(Effect.flip);

    expect(received).toBe(operationAttemptFailure);
  }),
);
