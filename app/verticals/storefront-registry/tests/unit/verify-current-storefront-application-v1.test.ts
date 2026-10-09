import { PersistenceFailure, ReadPermissionDenied, TrustedPrincipalContextSchema } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime/operations/context';
import {
  CurrentStorefrontApplicationCurrentSchema,
  CurrentStorefrontApplicationRequestSchema,
} from '@app/storefront-registry-contracts';
import { describe, expect, it } from 'effect-rstest';
import { Effect, Option, Schema } from 'effect';
import { handleVerifyCurrentStorefrontApplicationV1 } from '../../src/api/verify-current-storefront-application-v1.read.ts';
import type {
  CurrentStorefrontApplicationPersistence,
  CurrentStorefrontApplicationSnapshot,
} from '../../src/persistence/current-storefront-application-persistence.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const principalId = '22222222-2222-4222-8222-222222222222';
const trustedPrincipalInput = {
  authBindingId: '33333333-3333-4333-8333-333333333333',
  authContextRef: 'session:test-verification',
  authMethod: 'session' as const,
  legalEntityId: '44444444-4444-4444-8444-444444444444',
  principalId,
  tenantId,
  trustedStorefrontId: 'shop-cz',
};
const trustedPrincipal = Schema.decodeSync(TrustedPrincipalContextSchema)(trustedPrincipalInput);
const basePrincipal = Schema.decodeSync(TrustedPrincipalContextSchema)({
  authBindingId: trustedPrincipalInput.authBindingId,
  authContextRef: trustedPrincipalInput.authContextRef,
  authMethod: trustedPrincipalInput.authMethod,
  legalEntityId: trustedPrincipalInput.legalEntityId,
  principalId,
  tenantId,
});
const trustedScope: OperationalScope = { ...trustedPrincipal, correlationId: 'storefront-registry-verify' };
const baseScope: OperationalScope = {
  ...basePrincipal,
  correlationId: 'storefront-registry-verify',
};
const originalRequest = Schema.decodeSync(CurrentStorefrontApplicationRequestSchema)({
  effectiveAt: '2026-09-22T10:00:00.000Z',
  requestedChannel: 'B2C',
  storefrontAppId: 'shop-cz',
  tenantId,
});
const laterRequest = Schema.decodeSync(CurrentStorefrontApplicationRequestSchema)({
  ...originalRequest,
  effectiveAt: '2026-09-23T10:00:00.000Z',
});
const otherChannelRequest = Schema.decodeSync(CurrentStorefrontApplicationRequestSchema)({
  ...originalRequest,
  requestedChannel: 'B2B',
});
const otherStorefrontRequest = Schema.decodeSync(CurrentStorefrontApplicationRequestSchema)({
  ...originalRequest,
  storefrontAppId: 'shop-sk',
});
const active = {
  allowedChannels: ['B2C', 'B2B'],
  effectiveFrom: '2026-09-01T00:00:00.000Z',
  effectiveTo: '2026-10-01T00:00:00.000Z',
  generation: 7,
  lifecycle: 'ACTIVE',
  observedAt: '2026-09-22T09:59:59.000Z',
  revision: 3,
} satisfies CurrentStorefrontApplicationSnapshot;
const revised: CurrentStorefrontApplicationSnapshot = {
  ...active,
  allowedChannels: ['B2B'],
  generation: 8,
  revision: 4,
};
const activeOption = Option.some(active);
const revisedOption = Option.some(revised);
const missingOption = Option.none<CurrentStorefrontApplicationSnapshot>();

const persistence = (
  snapshot: Option.Option<CurrentStorefrontApplicationSnapshot>,
): CurrentStorefrontApplicationPersistence => ({
  load: () =>
    Effect.succeed({
      generation: Option.isSome(snapshot) ? snapshot.value.generation : 7,
      observedAt: active.observedAt,
      snapshot,
    }),
});
const context = (services: CurrentStorefrontApplicationPersistence, scope: OperationalScope = trustedScope) => ({
  readKey: 'commerce.storefront-registry.api.verify-current-storefront-application-v1',
  scope,
  services,
});
const currentContext = activeOption.pipe(persistence, context);
const revisedContext = revisedOption.pipe(persistence, context);
const missingContext = missingOption.pipe(persistence, context);
const currentProof = Schema.decodeSync(CurrentStorefrontApplicationCurrentSchema)({
  ...originalRequest,
  allowedChannels: ['B2C', 'B2B'],
  effectiveInterval: {
    effectiveFrom: active.effectiveFrom,
    effectiveTo: active.effectiveTo,
  },
  lifecycle: 'ACTIVE',
  nextApplicabilityBoundary: active.effectiveTo,
  observedAt: active.observedAt,
  outcome: 'CURRENT',
  ownerRevision: 'storefront-application:shop-cz:r3:g7',
});

describe('Verify Current Storefront Application v1', () => {
  it.effect('confirms an exact matching request and owner revision', () =>
    Effect.gen(function* verifyExactOwnerEvidence() {
      const result = yield* handleVerifyCurrentStorefrontApplicationV1(
        { observedProof: currentProof, originalRequest },
        currentContext,
      );
      expect(result.result).toMatchObject({ currentProof, state: 'CURRENT' });
    }),
  );

  it.effect('marks effective time or channel substitution stale when owner rows are unchanged', () =>
    Effect.gen(function* verifyExactScope() {
      const timeSubstitution = yield* handleVerifyCurrentStorefrontApplicationV1(
        { observedProof: currentProof, originalRequest: laterRequest },
        currentContext,
      );
      expect(timeSubstitution.result.state).toBe('STALE');

      const channelSubstitution = yield* handleVerifyCurrentStorefrontApplicationV1(
        { observedProof: currentProof, originalRequest: otherChannelRequest },
        currentContext,
      );
      expect(channelSubstitution.result.state).toBe('STALE');
    }),
  );

  it.effect('marks a changed Storefront revision or allowed channel set stale', () =>
    handleVerifyCurrentStorefrontApplicationV1({ observedProof: currentProof, originalRequest }, revisedContext).pipe(
      Effect.tap((result) => Effect.sync(() => expect(result.result.state).toBe('STALE'))),
    ),
  );

  it.effect('marks missing owner evidence stale and reports persistence failure unavailable', () =>
    Effect.gen(function* verifyOwnerAvailability() {
      const missing = yield* handleVerifyCurrentStorefrontApplicationV1(
        { observedProof: currentProof, originalRequest },
        missingContext,
      );
      expect(missing.result.state).toBe('STALE');

      const unavailable: CurrentStorefrontApplicationPersistence = {
        load: () => Effect.fail(new PersistenceFailure({ cause: 'fixture', reason: 'fixture' })),
      };
      const failure = yield* handleVerifyCurrentStorefrontApplicationV1(
        { observedProof: currentProof, originalRequest },
        context(unavailable),
      );
      expect(failure.result).toMatchObject({ retryable: true, state: 'UNAVAILABLE' });
    }),
  );

  it.effect('requires the exact trusted Storefront before owner access', () =>
    Effect.gen(function* rejectUntrustedStorefront() {
      let loadCount = 0;
      const services: CurrentStorefrontApplicationPersistence = {
        load: () => {
          loadCount += 1;
          return Effect.succeed({ generation: 7, observedAt: active.observedAt, snapshot: Option.some(active) });
        },
      };
      const failure = yield* handleVerifyCurrentStorefrontApplicationV1(
        { observedProof: currentProof, originalRequest: otherStorefrontRequest },
        context(services),
      ).pipe(Effect.flip);
      const missingTrustedContext = yield* handleVerifyCurrentStorefrontApplicationV1(
        { observedProof: currentProof, originalRequest },
        context(services, baseScope),
      ).pipe(Effect.flip);
      expect(Schema.is(ReadPermissionDenied)(failure)).toBe(true);
      expect(Schema.is(ReadPermissionDenied)(missingTrustedContext)).toBe(true);
      expect(loadCount).toBe(0);
    }),
  );
});
