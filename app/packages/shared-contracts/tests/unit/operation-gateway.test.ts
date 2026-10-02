import { Effect, Schema } from 'effect';
import { afterEach, beforeEach, expect, it } from 'effect-rstest';

import {
  DocumentCompositionRevisionError,
  pinDocumentCompositionRevision,
} from '../../src/document-composition-revision.ts';
import { makeOperationGateway } from '../../src/operation-gateway.ts';

const compositionRevision = 'a'.repeat(64);
const approvedTarget = {
  apiBaseUrl: '/shell-super-app-api/module-api/inventory-stock/build-1/inventory-stock-api',
  compositionRevision,
};
const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
beforeEach(() => {
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { querySelectorAll: () => [] } });
});
afterEach(() => {
  if (previousDocument === undefined) {
    Reflect.deleteProperty(globalThis, 'document');
  } else {
    Object.defineProperty(globalThis, 'document', previousDocument);
  }
});

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
    yield* pinDocumentCompositionRevision(compositionRevision);
    const gateway = makeOperationGateway(audience, ({ audience: receivedAudience }) => {
      expectType<typeof audience>(receivedAudience);
      return Effect.fail(gatewayAcquisitionFailure);
    });

    yield* expectType<
      Effect.Effect<
        never,
        | typeof gatewayAcquisitionFailure
        | typeof operationAttemptFailure
        | DocumentCompositionRevisionError
        | Schema.SchemaError
      >
    >(gateway.invoke(() => Effect.fail(operationAttemptFailure))).pipe(Effect.flip);
    yield* expectType<Effect.Effect<'completed', DocumentCompositionRevisionError | Schema.SchemaError>>(
      makeOperationGateway(audience, () =>
        Effect.succeed({ ...approvedTarget, expiresAt: 1_700_000_300, token: 'test-token' }),
      ).invoke(() => Effect.succeed('completed' as const)),
    );
  }),
);

it.effect('acquires one audience-scoped assertion and forwards options unchanged', () =>
  Effect.gen(function* audienceAssertionEffect() {
    yield* pinDocumentCompositionRevision(compositionRevision);
    const issuerCalls: {
      readonly audience: typeof audience;
      readonly compositionRevision: string;
      readonly options: typeof options;
    }[] = [];
    const authorizations: string[] = [];
    const gateway = makeOperationGateway(audience, (payload, receivedOptions) =>
      Effect.sync(() => {
        expect(receivedOptions).toBe(options);
        issuerCalls.push({ audience: payload.audience, compositionRevision: payload.compositionRevision, options });
        return {
          ...approvedTarget,
          expiresAt: 1_700_000_300,
          token: 'header.payload.signature',
        };
      }),
    );

    const result = yield* gateway.invoke((authorization, target) => {
      authorizations.push(authorization);
      expect(target).toEqual(approvedTarget);
      return Effect.succeed('completed' as const);
    }, options);

    expect(result).toBe('completed');
    expect(issuerCalls).toEqual([{ audience, compositionRevision, options }]);
    expect(authorizations).toEqual(['Bearer header.payload.signature']);
  }),
);

it.effect('acquires a fresh assertion whenever an invocation Effect is executed', () =>
  Effect.gen(function* freshAssertionEffect() {
    yield* pinDocumentCompositionRevision(compositionRevision);
    let acquisitions = 0;
    const gateway = makeOperationGateway(audience, () =>
      Effect.sync(() => {
        acquisitions += 1;
        return { ...approvedTarget, expiresAt: 1_700_000_300, token: `attempt-${acquisitions}` };
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
    yield* pinDocumentCompositionRevision(compositionRevision);
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
    yield* pinDocumentCompositionRevision(compositionRevision);
    const gateway = makeOperationGateway(audience, () =>
      Effect.succeed({ ...approvedTarget, expiresAt: 1_700_000_300, token: 'test-token' }),
    );

    const received = yield* gateway.invoke(() => Effect.fail(operationAttemptFailure)).pipe(Effect.flip);

    expect(received).toBe(operationAttemptFailure);
  }),
);

it.effect('does not contact the issuer or owner before the document admits a release', () =>
  Effect.gen(function* missingDocumentRevisionEffect() {
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { querySelectorAll: () => [] } });
    let issuerCalls = 0;
    let attemptCalls = 0;
    const gateway = makeOperationGateway(audience, () => {
      issuerCalls += 1;
      return Effect.succeed({ ...approvedTarget, expiresAt: 1_700_000_300, token: 'must not issue' });
    });

    const failure = yield* gateway
      .invoke(() => {
        attemptCalls += 1;
        return Effect.void;
      })
      .pipe(Effect.flip);

    expect(Schema.is(DocumentCompositionRevisionError)(failure)).toBe(true);
    const documentFailure = yield* Schema.decodeUnknownEffect(DocumentCompositionRevisionError)(failure);
    expect(documentFailure.reason).toBe('uninitialized');
    expect(issuerCalls).toBe(0);
    expect(attemptCalls).toBe(0);
  }),
);

it.effect('keeps the original document revision after renewal and refuses replacement', () =>
  Effect.gen(function* renewedDocumentRevisionEffect() {
    yield* pinDocumentCompositionRevision(compositionRevision);
    const replacement = yield* pinDocumentCompositionRevision('b'.repeat(64)).pipe(Effect.flip);
    expect(replacement.reason).toBe('revision-mismatch');
    const gateway = makeOperationGateway(audience, (payload) => {
      expect(payload.compositionRevision).toBe(compositionRevision);
      return Effect.succeed({ ...approvedTarget, expiresAt: 1_700_000_300, token: 'original-release-token' });
    });
    yield* gateway.invoke(() => Effect.void);
  }),
);

it.effect('rejects issuer admission for a different document before constructing the owner invocation', () =>
  Effect.gen(function* rejectedIssuerReleaseEffect() {
    yield* pinDocumentCompositionRevision(compositionRevision);
    let attempts = 0;
    const gateway = makeOperationGateway(audience, () =>
      Effect.succeed({
        ...approvedTarget,
        compositionRevision: 'b'.repeat(64),
        expiresAt: 1_700_000_300,
        token: 'other-release',
      }),
    );
    const failure = yield* gateway
      .invoke(() => {
        attempts += 1;
        return Effect.void;
      })
      .pipe(Effect.flip);
    const documentFailure = yield* Schema.decodeUnknownEffect(DocumentCompositionRevisionError)(failure);
    expect(documentFailure.reason).toBe('revision-mismatch');
    expect(attempts).toBe(0);
  }),
);

it.effect(
  'rejects an off-origin target from a custom issuer before exposing its credential to an owner invocation',
  () =>
    Effect.gen(function* invalidIssuerTargetEffect() {
      yield* pinDocumentCompositionRevision(compositionRevision);
      let attempts = 0;
      const gateway = makeOperationGateway(audience, () =>
        Effect.succeed({
          ...approvedTarget,
          apiBaseUrl: 'https://attacker.example/owner-api',
          expiresAt: 1_700_000_300,
          token: 'must-stay-in-shell',
        }),
      );
      const failure = yield* gateway
        .invoke(() => {
          attempts += 1;
          return Effect.void;
        })
        .pipe(Effect.flip);
      expect(Schema.isSchemaError(failure)).toBe(true);
      expect(attempts).toBe(0);
    }),
);
