import { PersistenceFailure, ScopedRoutineInvocationError } from '@app/core-runtime';
import { DateTime, Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  CurrencySupportPersistenceUnavailable,
  SetSupportedCurrenciesPayloadSchema,
  SupportedCurrenciesAdministrationRejected,
  SupportedCurrenciesRevisionConflict,
  SupportedCurrenciesScheduleAcknowledgementRequired,
  applySupportedCurrencies,
  handleSetSupportedCurrencies,
  setSupportedCurrenciesAction,
} from '../../src/actions/set-supported-currencies.action.ts';
import { currencySupportPersistence } from '../../src/persistence/currency-support-persistence.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const otherTenantId = '22222222-2222-4222-8222-222222222222';
const supportRootId = '33333333-3333-4333-8333-333333333333';
const actorPrincipalId = '44444444-4444-4444-8444-444444444444';
const actionInvocationId = '55555555-5555-4555-8555-555555555555';
const trustedOperationAt = DateTime.toDateUtc(DateTime.makeUnsafe('2026-09-27T12:00:00.000Z'));
const currentPeriod = {
  effectiveFrom: '2026-09-01T00:00:00.000Z',
  effectiveTo: '2026-10-01T00:00:00.000Z',
} as const;
const futurePeriod = {
  effectiveFrom: '2026-11-01T00:00:00.000Z',
  effectiveTo: '2027-01-01T00:00:00.000Z',
} as const;

const rootRef = {
  moduleId: 'commerce.pricing' as const,
  resourceId: supportRootId,
  resourceType: 'commerce.pricing.currency-support' as const,
  tenantId,
};
const revisionRef = (resourceId: string, generationTenantId = tenantId) => ({
  moduleId: 'commerce.pricing' as const,
  resourceId,
  resourceType: 'commerce.pricing.currency-support-revision' as const,
  supportRootId,
  tenantId: generationTenantId,
});
const current = {
  effectivePeriod: currentPeriod,
  generation: 1,
  supportedCurrencies: ['CZK'],
  supportRevisionRef: revisionRef('66666666-6666-4666-8666-666666666666'),
};
const future = {
  effectivePeriod: futurePeriod,
  generation: 2,
  supportedCurrencies: ['CZK'],
  supportRevisionRef: revisionRef('77777777-7777-4777-8777-777777777777'),
};
const result = {
  changed: true,
  current,
  scheduleRevision: 1,
  supportRootRef: rootRef,
};
const trusted = { actionInvocationId, actorPrincipalId, tenantId, trustedOperationAt } as const;

const decode = Schema.decodeUnknownSync(SetSupportedCurrenciesPayloadSchema, { onExcessProperty: 'error' });
const establishPayload = decode({
  expectedState: { state: 'ABSENT' },
  intendedEffectivePeriod: currentPeriod,
  intent: 'ESTABLISH_CURRENT',
  reason: 'Establish Czech launch support',
  schemaVersion: '2',
  supportedCurrencies: ['CZK'],
});
const expectedPresent = {
  current,
  future: [future],
  observedAt: '2026-09-27T12:00:00.000Z',
  scheduleRevision: 1,
  state: 'PRESENT' as const,
  supportRootRef: rootRef,
};
const acknowledgement = {
  actingPrincipalId: actorPrincipalId,
  expectedScheduleRevision: 1,
  fingerprint: 'a'.repeat(64),
  intendedEffectivePeriod: currentPeriod,
  intendedSupportedCurrencies: ['CZK'],
  presentedFuture: [future],
  supportRootRef: rootRef,
  targetEffectivePeriod: currentPeriod,
  targetRevisionRef: current.supportRevisionRef,
};

describe('Set supported currencies Action', () => {
  it('declares the stable v2 Action as Tenant-only and rejects legacy purchase partitions', () => {
    expect(setSupportedCurrenciesAction.descriptor.actionKey).toBe('commerce.pricing.set-supported-currencies');
    expect(setSupportedCurrenciesAction.descriptor.schemaVersion).toBe('2');
    expect(setSupportedCurrenciesAction.descriptor.legalEntityScope).toBe('forbidden');

    for (const legacyField of [
      { cartId: 'cart-333' },
      { channelId: 'B2C' },
      { contextRevision: 'cart-context:7' },
      { effectiveFrom: currentPeriod.effectiveFrom },
      { expectedGeneration: 0 },
      { legalEntityId: '66666666-6666-4666-8666-666666666666' },
      { marketId: 'market-cz' },
      { storefrontId: 'storefront-cz' },
      { subject: { guestSessionRef: 'guest-session:9', kind: 'GUEST' } },
      { tenantId },
    ]) {
      expect(() => decode({ ...establishPayload, ...legacyField })).toThrow();
    }
  });

  it.effect('derives Tenant and operation evidence only from trusted scope', () =>
    Effect.gen(function* deriveTrustedScope() {
      const observed: unknown[] = [];
      const applied = yield* applySupportedCurrencies(establishPayload, trusted, (command) => {
        observed.push(command);
        return Effect.succeed({ outcome: 'CREATED' as const, result });
      });

      expect(applied).toEqual(result);
      expect(observed).toEqual([
        {
          ...establishPayload,
          actingPrincipalId: actorPrincipalId,
          actionInvocationId,
          tenantId,
          trustedOperationAt,
        },
      ]);
    }),
  );

  it.effect('enforces the exact Launch write set without narrowing generalized currency schemas', () =>
    Effect.gen(function* enforceLaunchSet() {
      for (const supportedCurrencies of [['EUR'], ['CZK', 'EUR']] as const) {
        const generalizedPayload = decode({ ...establishPayload, supportedCurrencies });
        const failure = yield* Effect.flip(
          applySupportedCurrencies(generalizedPayload, trusted, () => Effect.die('must not persist non-Launch set')),
        );
        expect(failure).toBeInstanceOf(SupportedCurrenciesAdministrationRejected);
        expect(failure).toMatchObject({ code: 'supported_currencies_launch_set_invalid' });
      }
      expect(() => decode({ ...establishPayload, supportedCurrencies: ['ZZZ'] })).toThrow();

      const defenseInDepth = yield* Effect.flip(
        applySupportedCurrencies(establishPayload, trusted, () =>
          Effect.succeed({ outcome: 'CONFLICT' as const, reason: 'LAUNCH_CURRENCY_REJECTED' as const }),
        ),
      );
      expect(defenseInDepth).toMatchObject({ code: 'supported_currencies_launch_set_invalid' });
    }),
  );

  it.effect('checks expected state before recognizing a no-op', () =>
    Effect.gen(function* validateExpectedStateBeforeNoOp() {
      const valueOnly = decode({
        expectedState: { ...expectedPresent, future: [] },
        intendedEffectivePeriod: currentPeriod,
        intent: 'VALUE_ONLY_CURRENT',
        reason: 'Verify unchanged Czech launch support',
        schemaVersion: '2',
        supportedCurrencies: ['CZK'],
      });
      let calls = 0;
      const failure = yield* Effect.flip(
        applySupportedCurrencies(valueOnly, trusted, (command) => {
          calls += 1;
          expect(command.expectedState).toEqual(valueOnly.expectedState);
          return Effect.succeed({ outcome: 'CONFLICT' as const, reason: 'EXPECTED_CURRENT_MISMATCH' as const });
        }),
      );
      expect(calls).toBe(1);
      expect(failure).toBeInstanceOf(SupportedCurrenciesRevisionConflict);
      expect(failure).toMatchObject({ reason: 'EXPECTED_CURRENT_MISMATCH' });

      const unchanged = yield* applySupportedCurrencies(valueOnly, trusted, () =>
        Effect.succeed({ outcome: 'UNCHANGED' as const, result: { ...result, changed: false } }),
      );
      expect(unchanged.changed).toBe(false);
    }),
  );

  it.effect('returns a blocking future-schedule acknowledgement challenge and preserves typed stale conflicts', () =>
    Effect.gen(function* requireScheduleAcknowledgement() {
      const valueOnly = decode({
        expectedState: expectedPresent,
        intendedEffectivePeriod: currentPeriod,
        intent: 'VALUE_ONLY_CURRENT',
        reason: 'Keep Czech launch support while preserving the future schedule',
        schemaVersion: '2',
        supportedCurrencies: ['CZK'],
      });
      const warning = yield* Effect.flip(
        applySupportedCurrencies(valueOnly, trusted, () =>
          Effect.succeed({ acknowledgement, outcome: 'ACKNOWLEDGEMENT_REQUIRED' as const }),
        ),
      );
      expect(warning).toBeInstanceOf(SupportedCurrenciesScheduleAcknowledgementRequired);
      expect(warning).toMatchObject({ acknowledgement });

      const acknowledged = decode({
        acknowledgement,
        expectedState: expectedPresent,
        intendedEffectivePeriod: currentPeriod,
        intent: 'VALUE_ONLY_CURRENT',
        reason: 'Keep Czech launch support while preserving the future schedule',
        schemaVersion: '2',
        supportedCurrencies: ['CZK'],
      });
      const stale = yield* Effect.flip(
        applySupportedCurrencies(acknowledged, trusted, () =>
          Effect.succeed({ outcome: 'CONFLICT' as const, reason: 'SCHEDULE_ACKNOWLEDGEMENT_STALE' as const }),
        ),
      );
      expect(stale).toBeInstanceOf(SupportedCurrenciesRevisionConflict);
      expect(stale).toMatchObject({ reason: 'SCHEDULE_ACKNOWLEDGEMENT_STALE' });
    }),
  );

  it.effect('commits the blocking schedule challenge with Action evidence before rejecting the request', () =>
    Effect.gen(function* commitScheduleChallenge() {
      const payload = decode({
        expectedState: expectedPresent,
        intendedEffectivePeriod: currentPeriod,
        intent: 'VALUE_ONLY_CURRENT',
        reason: 'Review the preserved future support schedule',
        schemaVersion: '2',
        supportedCurrencies: ['CZK'],
      });
      let auditCount = 0;
      let accessCount = 0;
      const challenge = yield* handleSetSupportedCurrencies(payload, {
        actionInvocationId,
        addDomainEvent: () => Effect.die('unused'),
        addOutboxMessage: () => Effect.die('unused'),
        compositionRevision: 'a'.repeat(64),
        recordAuditEvidence: () => {
          auditCount += 1;
          return Effect.void;
        },
        recordDataAccess: () => {
          accessCount += 1;
          return Effect.void;
        },
        scope: {
          authBindingId: '88888888-8888-4888-8888-888888888888',
          authContextRef: 'session:set-supported-currencies-unit',
          authMethod: 'session',
          correlationId: 'set-supported-currencies-unit',
          principalId: actorPrincipalId,
          tenantId,
        },
        services: {
          loadCurrent: () => Effect.die('unused'),
          setCurrent: () => Effect.succeed({ acknowledgement, outcome: 'ACKNOWLEDGEMENT_REQUIRED' as const }),
        },
      });

      expect(challenge).toBeDefined();
      expect(auditCount).toBe(1);
      expect(accessCount).toBe(1);
    }),
  );

  it.effect('rejects cross-Principal acknowledgements and cross-Tenant expected state before persistence', () =>
    Effect.gen(function* rejectScopeSubstitution() {
      const crossPrincipal = decode({
        acknowledgement: {
          ...acknowledgement,
          actingPrincipalId: '77777777-7777-4777-8777-777777777777',
        },
        expectedState: expectedPresent,
        intendedEffectivePeriod: currentPeriod,
        intent: 'VALUE_ONLY_CURRENT',
        reason: 'Substitute schedule acknowledgement',
        schemaVersion: '2',
        supportedCurrencies: ['CZK'],
      });
      const principalFailure = yield* Effect.flip(
        applySupportedCurrencies(crossPrincipal, trusted, () => Effect.die('must not redeem another Principal ack')),
      );
      expect(principalFailure).toMatchObject({ code: 'supported_currencies_acknowledgement_mismatch' });

      const otherRootRef = { ...rootRef, tenantId: otherTenantId };
      const otherCurrent = {
        ...current,
        supportRevisionRef: { ...current.supportRevisionRef, tenantId: otherTenantId },
      };
      const crossTenant = decode({
        expectedState: {
          current: otherCurrent,
          future: [],
          observedAt: expectedPresent.observedAt,
          scheduleRevision: 1,
          state: 'PRESENT',
          supportRootRef: otherRootRef,
        },
        intendedEffectivePeriod: currentPeriod,
        intent: 'VALUE_ONLY_CURRENT',
        reason: 'Substitute another Tenant support root',
        schemaVersion: '2',
        supportedCurrencies: ['CZK'],
      });
      const tenantFailure = yield* Effect.flip(
        applySupportedCurrencies(crossTenant, trusted, () => Effect.die('must not persist cross-Tenant state')),
      );
      expect(tenantFailure).toMatchObject({ code: 'supported_currencies_scope_mismatch' });
    }),
  );

  it.effect('fails closed when persistence returns untrusted scope or Launch evidence', () =>
    Effect.gen(function* rejectPersistenceSubstitution() {
      for (const substitutedResult of [
        { ...result, supportRootRef: { ...rootRef, tenantId: otherTenantId } },
        { ...result, current: { ...current, supportedCurrencies: ['EUR'] } },
      ]) {
        const failure = yield* Effect.flip(
          applySupportedCurrencies(establishPayload, trusted, () =>
            Effect.succeed({ outcome: 'CREATED' as const, result: substitutedResult }),
          ),
        );
        expect(failure).toBeInstanceOf(CurrencySupportPersistenceUnavailable);
      }
    }),
  );

  it.effect('carries the driver failure as the cause and keeps it out of the contract error', () =>
    Effect.gen(function* persistenceFailureBoundary() {
      const driverError = new ScopedRoutineInvocationError({
        code: 'scoped_routine_invocation_failed',
        constraint: Option.none(),
        ownerModuleKey: 'commerce.pricing',
        postgresCode: Option.some('08006'),
        reason: 'connection lost',
        routineKey: 'pricing.set-supported-currencies',
      });
      const persistence = currencySupportPersistence(
        { invoke: () => Effect.fail(driverError) },
        tenantId,
        actorPrincipalId,
      );

      const failure = yield* Effect.flip(applySupportedCurrencies(establishPayload, trusted, persistence.setCurrent));
      expect(failure).toBeInstanceOf(PersistenceFailure);
      expect(failure.cause).toBe(driverError);

      const contractFailure = yield* Effect.flip(
        handleSetSupportedCurrencies(establishPayload, {
          actionInvocationId: trusted.actionInvocationId,
          addDomainEvent: () => Effect.die('must not add domain events'),
          addOutboxMessage: () => Effect.die('must not add outbox messages'),
          compositionRevision: 'a'.repeat(64),
          recordAuditEvidence: () => Effect.die('must not record audit evidence'),
          recordDataAccess: () => Effect.die('must not record data access'),
          scope: {
            authBindingId: '88888888-8888-4888-8888-888888888888',
            authContextRef: 'session:pricing-persistence-failure',
            authMethod: 'session',
            correlationId: 'pricing-persistence-failure',
            principalId: trusted.actorPrincipalId,
            tenantId: trusted.tenantId,
          },
          services: persistence,
        }),
      );
      expect(Schema.is(CurrencySupportPersistenceUnavailable)(contractFailure)).toBe(true);
      const encoded = Schema.is(CurrencySupportPersistenceUnavailable)(contractFailure)
        ? yield* Schema.encodeEffect(CurrencySupportPersistenceUnavailable)(contractFailure)
        : contractFailure;
      expect(encoded).not.toHaveProperty('cause');
      expect(encoded).toHaveProperty('reason', 'Pricing currency support could not be verified');
    }),
  );
});
