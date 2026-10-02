import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  CurrencySupportRecoveryRequestSchema,
  evaluateCurrencySupportRecoveryRollback,
  executeCurrencySupportRecovery,
  planCurrencySupportRecovery,
} from '../../src/services/currency-support-recovery.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const request = Schema.decodeSync(CurrencySupportRecoveryRequestSchema)({
  actingPrincipalId: '33333333-3333-4333-8333-333333333333',
  actionInvocationId: '22222222-2222-4222-8222-222222222222',
  baseline: {
    authorityRef: 'pricing-currency-support-governance',
    authorityVersion: '3',
    effectivePeriod: { effectiveFrom: '2026-09-29T00:00:00.000Z', effectiveTo: null },
    mappingRef: 'tenant-currency-support-recovery',
    mappingVersion: '1',
    reason: 'Establish the explicit governed Launch baseline without deriving legacy values',
    supportedCurrencies: ['CZK'],
    tenantId,
  },
  bridgeMode: 'LEGACY_READ_ONLY',
  canonicalState: 'ABSENT',
  legacyMappings: [
    {
      authorityRef: 'legacy-history-qualification',
      authorityVersion: '1',
      disposition: 'HISTORY_ONLY',
      legacyRevisionRef: 'legacy-context-cz',
      mappingRef: 'legacy-context-inventory',
      mappingVersion: '7',
      reason: 'Retain the original CZK context row as qualified history only',
    },
    {
      authorityRef: 'legacy-history-qualification',
      authorityVersion: '1',
      disposition: 'HISTORY_ONLY',
      legacyRevisionRef: 'legacy-storefront-cz-eur',
      mappingRef: 'legacy-context-inventory',
      mappingVersion: '7',
      reason: 'Retain the original mixed-currency storefront row as qualified history only',
    },
  ],
  legacyRecords: [
    {
      effectivePeriod: { effectiveFrom: '2025-01-01T00:00:00.000Z', effectiveTo: null },
      legacyGeneration: 12,
      legacyRevisionRef: 'legacy-context-cz',
      originalScope: {
        legalEntityId: '44444444-4444-4444-8444-444444444444',
        scopeRef: 'context:cz',
        scopeType: 'CONTEXT',
      },
      recordedAt: '2025-01-01T00:00:01.000Z',
      supportedCurrencies: ['CZK'],
      tenantId,
    },
    {
      effectivePeriod: { effectiveFrom: '2025-06-01T00:00:00.000Z', effectiveTo: null },
      legacyGeneration: 99,
      legacyRevisionRef: 'legacy-storefront-cz-eur',
      originalScope: {
        legalEntityId: '44444444-4444-4444-8444-444444444444',
        scopeRef: 'storefront:legacy-web',
        scopeType: 'STOREFRONT',
      },
      recordedAt: '2025-06-01T00:00:01.000Z',
      supportedCurrencies: ['CZK', 'EUR'],
      tenantId,
    },
  ],
  schemaVersion: '1',
  trustedOperationAt: '2026-09-29T10:00:00.000Z',
});

const readyPlan = () => {
  const outcome = planCurrencySupportRecovery(request);
  if (outcome.outcome !== 'RECOVERY_READY') {
    throw new Error(`Expected a ready recovery plan, received ${outcome.reason}`);
  }
  return outcome.plan;
};

describe('Pricing Currency Support reconciliation and recovery', () => {
  it('creates one explicit CZK Tenant baseline while retaining divergent legacy values as history only', () => {
    const plan = readyPlan();

    expect(plan.command.payload).toMatchObject({
      expectedState: { state: 'ABSENT' },
      intent: 'ESTABLISH_CURRENT',
      schemaVersion: '2',
      supportedCurrencies: ['CZK'],
    });
    expect(plan.qualifiedLegacyHistory.map(({ record }) => record.supportedCurrencies)).toEqual([
      ['CZK'],
      ['CZK', 'EUR'],
    ]);
    expect(plan.bridgeMode).toBe('LEGACY_READ_ONLY');
    expect(plan.baselineDerivation).toBe('EXPLICIT_GOVERNED_INPUT_ONLY');
    expect(plan.rollbackMode).toBe('NEW_AUDITED_TRANSITION_REQUIRED');

    const reversed = planCurrencySupportRecovery({
      ...request,
      legacyMappings: request.legacyMappings.toReversed(),
      legacyRecords: request.legacyRecords.toReversed(),
    });
    expect(reversed.outcome).toBe('RECOVERY_READY');
    if (reversed.outcome === 'RECOVERY_READY') {
      expect(reversed.plan.command.payload.supportedCurrencies).toEqual(['CZK']);
      expect(reversed.plan.command.payload).toEqual(plan.command.payload);
    }
  });

  it('holds missing/duplicate mappings, an existing canonical authority, and additional-currency activation', () => {
    const [firstMapping] = request.legacyMappings;
    if (firstMapping === undefined) {
      throw new Error('The recovery fixture requires one legacy mapping');
    }
    expect(
      planCurrencySupportRecovery({ ...request, legacyMappings: request.legacyMappings.slice(0, 1) }),
    ).toMatchObject({ outcome: 'RECOVERY_HELD', reason: 'LEGACY_MAPPING_INCOMPLETE' });
    expect(
      planCurrencySupportRecovery({
        ...request,
        legacyMappings: [firstMapping, firstMapping],
      }),
    ).toMatchObject({ outcome: 'RECOVERY_HELD', reason: 'DUPLICATE_LEGACY_REVISION' });
    expect(planCurrencySupportRecovery({ ...request, canonicalState: 'PRESENT' })).toMatchObject({
      outcome: 'RECOVERY_HELD',
      reason: 'CANONICAL_AUTHORITY_ALREADY_EXISTS',
    });
    expect(
      planCurrencySupportRecovery({
        ...request,
        baseline: { ...request.baseline, supportedCurrencies: ['CZK', 'EUR'] },
      }),
    ).toMatchObject({ outcome: 'RECOVERY_HELD', reason: 'UNAUTHORIZED_CURRENCY_ACTIVATION' });
  });

  it.effect('looks up the original Action intent before retry and never repeats a proven commit', () =>
    Effect.gen(function* lookupBeforeRetry() {
      const plan = readyPlan();
      let writes = 0;
      const result = yield* executeCurrencySupportRecovery(plan, {
        establish: () => {
          writes += 1;
          return Effect.succeed({ changed: true });
        },
        lookupOriginalInvocation: () =>
          Effect.succeed({
            actionInvocationId: plan.command.actionInvocationId,
            outcome: 'FOUND' as const,
            supportedCurrencies: ['CZK'],
            tenantId,
          }),
      });

      expect(result).toEqual({ outcome: 'RECOVERY_RECONCILED' });
      expect(writes).toBe(0);
    }),
  );

  it.effect('executes only when the original intent is absent and conflicts on a mismatched receipt', () =>
    Effect.gen(function* controlledExecution() {
      const plan = readyPlan();
      let writes = 0;
      const applied = yield* executeCurrencySupportRecovery(plan, {
        establish: () => {
          writes += 1;
          return Effect.succeed({ changed: true });
        },
        lookupOriginalInvocation: () => Effect.succeed({ outcome: 'NOT_FOUND' as const }),
      });
      const conflict = yield* executeCurrencySupportRecovery(plan, {
        establish: () => Effect.die('must not execute a conflicting recovered intent'),
        lookupOriginalInvocation: () =>
          Effect.succeed({
            actionInvocationId: plan.command.actionInvocationId,
            outcome: 'FOUND' as const,
            supportedCurrencies: ['EUR'],
            tenantId,
          }),
      });

      expect(applied).toEqual({ outcome: 'RECOVERY_APPLIED' });
      expect(writes).toBe(1);
      expect(conflict).toEqual({ outcome: 'RECOVERY_CONFLICT', reason: 'ORIGINAL_INTENT_MISMATCH' });
    }),
  );

  it('rolls back safely without deleting a commit or restoring the legacy writable authority', () => {
    const plan = readyPlan();
    expect(evaluateCurrencySupportRecoveryRollback({ phase: 'BEFORE_CANONICAL_COMMIT', plan })).toEqual({
      outcome: 'ROLLBACK_COMPLETE_WITHOUT_CANONICAL_CHANGE',
    });
    expect(
      evaluateCurrencySupportRecoveryRollback({
        committedActionInvocationId: plan.command.actionInvocationId,
        phase: 'AFTER_CANONICAL_COMMIT',
        plan,
      }),
    ).toEqual({
      nextStep: 'CREATE_NEW_GOVERNED_TENANT_TRANSITION',
      outcome: 'ROLLBACK_REQUIRES_AUDITED_TRANSITION',
      reason: 'LEGACY_AUTHORITY_RESTORATION_FORBIDDEN',
    });
    expect(
      evaluateCurrencySupportRecoveryRollback({
        committedActionInvocationId: '99999999-9999-4999-8999-999999999999',
        phase: 'AFTER_CANONICAL_COMMIT',
        plan,
      }),
    ).toEqual({ outcome: 'ROLLBACK_REFUSED', reason: 'COMMITTED_INTENT_MISMATCH' });
  });
});
