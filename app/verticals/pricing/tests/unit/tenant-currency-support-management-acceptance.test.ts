import { DateTime, Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  SetSupportedCurrenciesPayloadSchema,
  SupportedCurrenciesAdministrationRejected,
  SupportedCurrenciesScheduleAcknowledgementRequired,
  applySupportedCurrencies,
} from '../../src/actions/set-supported-currencies.action.ts';

const tenantId = '20000000-0000-4000-8000-000000000001';
const supportRootId = '30000000-0000-4000-8000-000000000001';
const supportRevisionId = '70000000-0000-4000-8000-000000000001';
const effectiveAt = '2026-09-27T10:00:00.000Z';
const supportRootRef = {
  moduleId: 'commerce.pricing' as const,
  resourceId: supportRootId,
  resourceType: 'commerce.pricing.currency-support' as const,
  tenantId,
};
const supportRevisionRef = {
  moduleId: 'commerce.pricing' as const,
  resourceId: supportRevisionId,
  resourceType: 'commerce.pricing.currency-support-revision' as const,
  supportRootId,
  tenantId,
};
const current = {
  effectivePeriod: { effectiveFrom: effectiveAt, effectiveTo: null },
  generation: 1,
  supportedCurrencies: ['CZK'],
  supportRevisionRef,
};
const result = {
  changed: true,
  current,
  scheduleRevision: 1,
  supportRootRef,
};
const trusted = {
  actionInvocationId: '40000000-0000-4000-8000-000000000001',
  actorPrincipalId: '50000000-0000-4000-8000-000000000001',
  tenantId,
  trustedOperationAt: DateTime.toDateUtc(DateTime.makeUnsafe(effectiveAt)),
};
const encodeUnknownJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const establish = (supportedCurrencies: readonly string[]) =>
  Schema.decodeSync(SetSupportedCurrenciesPayloadSchema)({
    expectedState: { state: 'ABSENT' },
    intendedEffectivePeriod: current.effectivePeriod,
    intent: 'ESTABLISH_CURRENT',
    reason: 'Establish the exact Launch Currency Support set',
    schemaVersion: '2',
    supportedCurrencies,
  });

describe('Tenant Currency Support management acceptance', () => {
  it.effect('accepts exactly CZK for Launch and writes only the trusted Tenant root', () =>
    Effect.gen(function* exactLaunchSet() {
      const commands: unknown[] = [];
      const output = yield* applySupportedCurrencies(establish(['CZK']), trusted, (command) => {
        commands.push(command);
        return Effect.succeed({ outcome: 'CREATED' as const, result });
      });

      expect(output).toEqual(result);
      expect(commands).toHaveLength(1);
      expect(commands[0]).toMatchObject({
        actingPrincipalId: trusted.actorPrincipalId,
        expectedState: { state: 'ABSENT' },
        supportedCurrencies: ['CZK'],
        tenantId,
      });
      expect(yield* encodeUnknownJson(commands[0])).not.toMatch(/cart|channel|market|storefront|subject|legalEntity/iu);
    }),
  );

  it.effect('rejects EUR activation and mixed CZK/EUR before persistence while keeping schemas generalized', () =>
    Effect.gen(function* rejectUnprovedCurrencyActivation() {
      let writes = 0;
      const mustNotPersist = () => {
        writes += 1;
        return Effect.die('must not persist an unproved Launch currency');
      };
      for (const requestedSet of [['EUR'], ['CZK', 'EUR']] as const) {
        const decoded = establish(requestedSet);
        expect(decoded.supportedCurrencies).toEqual(requestedSet);
        const failure = yield* applySupportedCurrencies(decoded, trusted, mustNotPersist).pipe(Effect.flip);
        expect(Schema.is(SupportedCurrenciesAdministrationRejected)(failure)).toBe(true);
        expect(failure).toMatchObject({ code: 'supported_currencies_launch_set_invalid' });
      }
      expect(writes).toBe(0);
    }),
  );

  it.effect('requires the exact expected Tenant state before an unchanged result', () =>
    Effect.gen(function* expectedBeforeNoOp() {
      const expectedState = {
        current,
        future: [],
        observedAt: '2026-09-27T10:00:01.000Z',
        scheduleRevision: 1,
        state: 'PRESENT' as const,
        supportRootRef,
      };
      const payload = yield* Schema.decodeEffect(SetSupportedCurrenciesPayloadSchema)({
        expectedState,
        intendedEffectivePeriod: current.effectivePeriod,
        intent: 'VALUE_ONLY_CURRENT',
        reason: 'Reassert the existing exact Launch set',
        schemaVersion: '2',
        supportedCurrencies: ['CZK'],
      });
      let received: unknown;
      const output = yield* applySupportedCurrencies(payload, trusted, (command) => {
        received = command;
        return Effect.succeed({
          outcome: 'UNCHANGED' as const,
          result: { ...result, changed: false },
        });
      });

      expect(received).toMatchObject({ expectedState, tenantId });
      expect(output.changed).toBe(false);
    }),
  );

  it.effect('returns a typed blocking schedule challenge before an unacknowledged change', () =>
    Effect.gen(function* requireScheduleAcknowledgement() {
      const finiteCurrent = {
        ...current,
        effectivePeriod: {
          effectiveFrom: '2026-09-01T00:00:00.000Z',
          effectiveTo: '2026-10-01T00:00:00.000Z',
        },
      };
      const future = {
        effectivePeriod: { effectiveFrom: '2026-11-01T00:00:00.000Z', effectiveTo: null },
        generation: 2,
        supportedCurrencies: ['CZK'],
        supportRevisionRef: {
          ...supportRevisionRef,
          resourceId: '70000000-0000-4000-8000-000000000002',
        },
      };
      const expectedState = {
        current: finiteCurrent,
        future: [future],
        observedAt: '2026-09-27T10:00:01.000Z',
        scheduleRevision: 3,
        state: 'PRESENT' as const,
        supportRootRef,
      };
      const intendedEffectivePeriod = {
        effectiveFrom: effectiveAt,
        effectiveTo: finiteCurrent.effectivePeriod.effectiveTo,
      };
      const payload = yield* Schema.decodeEffect(SetSupportedCurrenciesPayloadSchema)({
        expectedState,
        intendedEffectivePeriod,
        intent: 'VALUE_ONLY_CURRENT',
        reason: 'Preserve the finite end, schedule gap, and future revision',
        schemaVersion: '2',
        supportedCurrencies: ['CZK'],
      });
      const acknowledgement = {
        actingPrincipalId: trusted.actorPrincipalId,
        expectedScheduleRevision: expectedState.scheduleRevision,
        fingerprint: 'b'.repeat(64),
        intendedEffectivePeriod,
        intendedSupportedCurrencies: ['CZK'],
        presentedFuture: expectedState.future,
        supportRootRef,
        targetEffectivePeriod: finiteCurrent.effectivePeriod,
        targetRevisionRef: finiteCurrent.supportRevisionRef,
      };
      let persistenceCalls = 0;
      const failure = yield* applySupportedCurrencies(payload, trusted, () => {
        persistenceCalls += 1;
        return Effect.succeed({
          acknowledgement,
          outcome: 'ACKNOWLEDGEMENT_REQUIRED' as const,
        });
      }).pipe(Effect.flip);

      expect(persistenceCalls).toBe(1);
      expect(Schema.is(SupportedCurrenciesScheduleAcknowledgementRequired)(failure)).toBe(true);
      expect(failure).toMatchObject({
        acknowledgement,
        code: 'supported_currencies_schedule_acknowledgement_required',
      });
    }),
  );

  it.effect('rejects a different Tenant root before persistence', () =>
    Effect.gen(function* isolateTenantManagement() {
      const foreignTenantId = '60000000-0000-4000-8000-000000000001';
      const payload = yield* Schema.decodeEffect(SetSupportedCurrenciesPayloadSchema)({
        expectedState: {
          current: {
            ...current,
            supportRevisionRef: { ...supportRevisionRef, tenantId: foreignTenantId },
          },
          future: [],
          observedAt: '2026-09-27T10:00:01.000Z',
          scheduleRevision: 1,
          state: 'PRESENT',
          supportRootRef: { ...supportRootRef, tenantId: foreignTenantId },
        },
        intendedEffectivePeriod: current.effectivePeriod,
        intent: 'VALUE_ONLY_CURRENT',
        reason: 'Attempt to reuse another Tenant root',
        schemaVersion: '2',
        supportedCurrencies: ['CZK'],
      });
      let writes = 0;
      const failure = yield* applySupportedCurrencies(payload, trusted, () => {
        writes += 1;
        return Effect.die('must not persist across Tenants');
      }).pipe(Effect.flip);

      expect(Schema.is(SupportedCurrenciesAdministrationRejected)(failure)).toBe(true);
      expect(failure).toMatchObject({ code: 'supported_currencies_scope_mismatch' });
      expect(writes).toBe(0);
    }),
  );
});
