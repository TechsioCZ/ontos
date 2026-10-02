import {
  CurrentSupportedCurrenciesRequestSchema,
  CurrentSupportedCurrenciesSuccessSchema,
} from '@app/pricing-contracts/current-supported-currencies';
import { PersistenceFailure } from '@app/core-runtime';
import { SetSupportedCurrenciesV2PayloadSchema } from '@app/pricing-contracts/domain/currency-support';
import { DateTime, Effect, Match, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  currencySupportCanonicalIdempotencyIntentWire,
  currencySupportRecoveryCompensationCommandWire,
  currencySupportSetCommandWire,
  decodeCurrencySupportActionResultLookup,
  decodeCurrencySupportRecoveryCompensationOutcome,
  decodeCurrencySupportGenerationThrough,
  decodeIssuedCurrencySupportProof,
  decodeResolvedCurrencySupportProof,
  decodeSetCurrencySupportOutcome,
  decodeTenantCurrencySupportRead,
  reconcileTenantCurrencySupportRead,
} from '../../src/persistence/currency-support-persistence.ts';
import type { CurrencySupportReadOutcome } from '../../src/persistence/currency-support-persistence.ts';

const effectiveAt = '2026-09-22T12:00:00.000Z';
const observedAt = '2026-09-22T12:00:02.000Z';
const revalidatedAt = '2026-09-22T12:00:03.000Z';
const supportId = '33110000-0000-4000-8000-000000000001';
const currentRevisionId = '33110000-0000-4000-8000-000000000004';
const futureRevisionId = '33110000-0000-4000-8000-000000000005';
const verificationRef = 'commerce.pricing.currency-support-proof:33110000-0000-4000-8000-000000000006';
const request = Schema.decodeSync(CurrentSupportedCurrenciesRequestSchema)({ effectiveAt, tenantId: 'tenant-cz' });
const current = {
  effectiveFrom: '2026-09-01T00:00:00.000Z',
  effectiveTo: '2026-10-01T00:00:00.000Z',
  generation: 4,
  pricingRevision: 'pricing-currency-support:4',
  supportedCurrencies: ['CZK'],
  supportRevisionId: currentRevisionId,
} as const;
const establishPayload = Schema.decodeSync(SetSupportedCurrenciesV2PayloadSchema)({
  expectedState: { state: 'ABSENT' },
  intendedEffectivePeriod: {
    effectiveFrom: effectiveAt,
    effectiveTo: null,
  },
  intent: 'ESTABLISH_CURRENT',
  reason: 'Establish the Launch support set.',
  schemaVersion: '2',
  supportedCurrencies: ['CZK'],
});
const establishCommand = {
  ...establishPayload,
  actingPrincipalId: '33110000-0000-4000-8000-000000000002',
  actionInvocationId: '33110000-0000-4000-8000-000000000003',
  tenantId: 'tenant-cz',
  trustedOperationAt: DateTime.toDateUtc(DateTime.makeUnsafe(effectiveAt)),
};
const supportRootRef = {
  moduleId: 'commerce.pricing',
  resourceId: supportId,
  resourceType: 'commerce.pricing.currency-support',
  tenantId: 'tenant-cz',
} as const;
const supportRevisionRef = (resourceId: string) => ({
  moduleId: 'commerce.pricing' as const,
  resourceId,
  resourceType: 'commerce.pricing.currency-support-revision' as const,
  supportRootId: supportId,
  tenantId: 'tenant-cz',
});
const generationSupport = Schema.decodeSync(CurrentSupportedCurrenciesSuccessSchema)({
  completenessEvidence: {
    observedAt,
    ownerRevision: currentRevisionId,
    scope: {
      kind: 'EXACT_PREDICATE',
      predicateRef: `commerce.pricing.current-supported-currencies:tenant-cz:${supportId}`,
    },
  },
  currentnessEvidence: {
    evaluatedAt: observedAt,
    evaluationMode: 'CURRENT_WITH_REVALIDATION',
    observedAt,
    revalidatedAt,
    scheduleRevision: 5,
    supportRevisionRef: supportRevisionRef(currentRevisionId),
    supportRootRef,
  },
  effectiveAt,
  effectivePeriod: { effectiveFrom: current.effectiveFrom, effectiveTo: current.effectiveTo },
  factProofs: [{ factRef: supportId, factRevisionRef: currentRevisionId, verificationRef }],
  generation: current.generation,
  observedAt,
  outcome: 'SUPPORTED_CURRENCIES_CURRENT',
  pricingRevision: current.pricingRevision,
  scheduleRevision: 5,
  supportedCurrencies: current.supportedCurrencies,
  supportRevisionRef: supportRevisionRef(currentRevisionId),
  supportRootRef,
  tenantId: 'tenant-cz',
  verificationRef,
});
const tagOf = (outcome: CurrencySupportReadOutcome) =>
  Match.value(outcome).pipe(
    Match.tags({
      absent: () => 'absent' as const,
      conflict: () => 'conflict' as const,
      current: () => 'current' as const,
      gap: () => 'gap' as const,
    }),
    Match.exhaustive,
  );
const currentnessEvidenceOf = (outcome: CurrencySupportReadOutcome) =>
  Match.value(outcome).pipe(
    Match.tags({
      absent: () => null,
      conflict: () => null,
      current: ({ current: stored }) => stored.currentnessEvidence,
      gap: () => null,
    }),
    Match.exhaustive,
  );

describe('Tenant Currency Support persistence decoding', () => {
  it.effect('maps one exact Tenant root and real currentness evidence without fabricating state', () =>
    Effect.gen(function* currentRoot() {
      const result = yield* decodeTenantCurrencySupportRead(
        {
          activeRevisionCount: 1,
          current,
          evaluatedAt: observedAt,
          evaluationMode: 'CURRENT_WITH_REVALIDATION',
          nextApplicabilityBoundary: null,
          observedAt,
          outcome: 'CURRENCY_SUPPORT_CURRENT',
          revalidatedAt,
          schedule: { current, future: [], revisions: [current] },
          scheduleRevision: 5,
          supportId,
        },
        request,
        'CURRENT_WITH_REVALIDATION',
      );
      const resolved = Match.value(result).pipe(
        Match.tags({
          absent: () => null,
          conflict: () => null,
          current: ({ current: stored }) => stored,
          gap: () => null,
        }),
        Match.exhaustive,
      );
      expect(resolved).toMatchObject({
        currentnessEvidence: {
          evaluatedAt: observedAt,
          evaluationMode: 'CURRENT_WITH_REVALIDATION',
          observedAt,
          revalidatedAt,
        },
        effectivePeriod: { effectiveFrom: current.effectiveFrom, effectiveTo: current.effectiveTo },
        generation: 4,
        pricingRevision: 'pricing-currency-support:4',
        scheduleRevision: 5,
        supportedCurrencies: ['CZK'],
        supportRootRef: { resourceId: supportId, tenantId: 'tenant-cz' },
      });
    }),
  );

  it.effect('keeps absence, gaps, and conflicts distinct and rejects unbound evaluation evidence', () =>
    Effect.gen(function* closedReadOutcomes() {
      const shared = {
        evaluatedAt: observedAt,
        evaluationMode: 'CURRENT_WITH_REVALIDATION',
        observedAt,
        revalidatedAt,
      } as const;
      const absent = yield* decodeTenantCurrencySupportRead(
        { ...shared, activeRevisionCount: 0, outcome: 'CURRENCY_SUPPORT_ABSENT' },
        request,
        'CURRENT_WITH_REVALIDATION',
      );
      const gap = yield* decodeTenantCurrencySupportRead(
        { ...shared, activeRevisionCount: 0, outcome: 'CURRENCY_SUPPORT_GAP' },
        request,
        'CURRENT_WITH_REVALIDATION',
      );
      const conflict = yield* decodeTenantCurrencySupportRead(
        {
          ...shared,
          activeRevisionCount: 2,
          candidateRevisionIds: ['33110000-0000-4000-8000-000000000003', currentRevisionId],
          outcome: 'CURRENCY_SUPPORT_CONFLICT',
        },
        request,
        'CURRENT_WITH_REVALIDATION',
      );
      expect(tagOf(absent)).toBe('absent');
      expect(tagOf(gap)).toBe('gap');
      expect(tagOf(conflict)).toBe('conflict');

      const failure = yield* decodeTenantCurrencySupportRead(
        {
          ...shared,
          activeRevisionCount: 0,
          evaluatedAt: '2026-09-22T11:59:59.000Z',
          outcome: 'CURRENCY_SUPPORT_ABSENT',
        },
        request,
        'CURRENT_WITH_REVALIDATION',
      ).pipe(Effect.flip);
      expect(failure).toBeInstanceOf(PersistenceFailure);
    }),
  );

  it.effect('promotes an exact fresh match to Current and retains historical evidence when the head changes', () =>
    Effect.gen(function* reconcileFreshRead() {
      const historical = yield* decodeTenantCurrencySupportRead(
        {
          activeRevisionCount: 1,
          current,
          evaluatedAt: effectiveAt,
          evaluationMode: 'HISTORICAL_AS_OF',
          nextApplicabilityBoundary: null,
          observedAt,
          outcome: 'CURRENCY_SUPPORT_CURRENT',
          schedule: { current, future: [], revisions: [current] },
          scheduleRevision: 5,
          supportId,
        },
        request,
        'HISTORICAL_AS_OF',
      );
      const revalidated = yield* decodeTenantCurrencySupportRead(
        {
          activeRevisionCount: 1,
          current,
          evaluatedAt: observedAt,
          evaluationMode: 'CURRENT_WITH_REVALIDATION',
          nextApplicabilityBoundary: null,
          observedAt,
          outcome: 'CURRENCY_SUPPORT_CURRENT',
          revalidatedAt,
          schedule: { current, future: [], revisions: [current] },
          scheduleRevision: 5,
          supportId,
        },
        request,
        'CURRENT_WITH_REVALIDATION',
      );
      const changedHead = yield* decodeTenantCurrencySupportRead(
        {
          activeRevisionCount: 1,
          current,
          evaluatedAt: observedAt,
          evaluationMode: 'CURRENT_WITH_REVALIDATION',
          nextApplicabilityBoundary: null,
          observedAt,
          outcome: 'CURRENCY_SUPPORT_CURRENT',
          revalidatedAt,
          schedule: { current, future: [], revisions: [current] },
          scheduleRevision: 6,
          supportId,
        },
        request,
        'CURRENT_WITH_REVALIDATION',
      );

      const promoted = reconcileTenantCurrencySupportRead(historical, revalidated);
      const retainedHistorical = reconcileTenantCurrencySupportRead(historical, changedHead);
      expect(currentnessEvidenceOf(promoted)).toMatchObject({
        evaluatedAt: observedAt,
        evaluationMode: 'CURRENT_WITH_REVALIDATION',
      });
      expect(currentnessEvidenceOf(retainedHistorical)).toMatchObject({
        evaluatedAt: effectiveAt,
        evaluationMode: 'HISTORICAL_AS_OF',
      });
    }),
  );

  it.effect('maps atomic create, unchanged, and typed conflict outcomes', () =>
    Effect.gen(function* writeOutcomes() {
      const unchangedCommand = {
        ...establishCommand,
        ...(yield* Schema.decodeEffect(SetSupportedCurrenciesV2PayloadSchema)({
          expectedState: {
            current: {
              effectivePeriod: { effectiveFrom: current.effectiveFrom, effectiveTo: current.effectiveTo },
              generation: current.generation,
              supportedCurrencies: current.supportedCurrencies,
              supportRevisionRef: supportRevisionRef(current.supportRevisionId),
            },
            future: [],
            observedAt,
            scheduleRevision: 1,
            state: 'PRESENT',
            supportRootRef,
          },
          intendedEffectivePeriod: { effectiveFrom: current.effectiveFrom, effectiveTo: current.effectiveTo },
          intent: 'VALUE_ONLY_CURRENT',
          reason: 'Confirm exact current Launch support.',
          schemaVersion: '2',
          supportedCurrencies: ['CZK'],
        })),
      };
      const applied = yield* decodeSetCurrencySupportOutcome(
        {
          changed: true,
          current,
          outcome: 'APPLIED',
          scheduleRevision: 1,
          supportId,
        },
        establishCommand,
      );
      const unchanged = yield* decodeSetCurrencySupportOutcome(
        {
          changed: false,
          current,
          outcome: 'UNCHANGED',
          scheduleRevision: 1,
          supportId,
        },
        unchangedCommand,
      );
      const stale = yield* decodeSetCurrencySupportOutcome({ outcome: 'REVISION_CONFLICT' }, establishCommand);
      const launchRejected = yield* decodeSetCurrencySupportOutcome(
        { outcome: 'LAUNCH_CURRENCY_REJECTED' },
        establishCommand,
      );

      expect(applied).toMatchObject({ outcome: 'CREATED', result: { changed: true } });
      expect(unchanged).toMatchObject({ outcome: 'UNCHANGED', result: { changed: false } });
      expect(stale).toEqual({ outcome: 'CONFLICT', reason: 'EXPECTED_CURRENT_MISMATCH' });
      expect(launchRejected).toEqual({ outcome: 'CONFLICT', reason: 'LAUNCH_CURRENCY_REJECTED' });

      for (const inconsistent of [
        { changed: true, current, outcome: 'UNCHANGED', scheduleRevision: 1, supportId },
        { changed: false, current, outcome: 'APPLIED', scheduleRevision: 1, supportId },
        { changed: false, current, outcome: 'UNCHANGED', scheduleRevision: 2, supportId },
      ]) {
        const failure = yield* decodeSetCurrencySupportOutcome(inconsistent, unchangedCommand).pipe(Effect.flip);
        expect(failure).toBeInstanceOf(PersistenceFailure);
      }
      const absentNoOp = yield* decodeSetCurrencySupportOutcome(
        { changed: false, current, outcome: 'UNCHANGED', scheduleRevision: 1, supportId },
        establishCommand,
      ).pipe(Effect.flip);
      expect(absentNoOp).toBeInstanceOf(PersistenceFailure);
    }),
  );

  it.effect('binds recovery compensation to the original committed result and a new schedule revision', () =>
    Effect.gen(function* compensationBinding() {
      const command = {
        actingPrincipalId: establishCommand.actingPrincipalId,
        actionInvocationId: '33110000-0000-4000-8000-000000000007',
        committedActionInvocationId: establishCommand.actionInvocationId,
        reason: 'End the exact recovery result through a new governed schedule transition.',
        tenantId: establishCommand.tenantId,
        trustedOperationAt: DateTime.toDateUtc(DateTime.makeUnsafe('2026-09-22T12:05:00.000Z')),
      };
      expect(currencySupportRecoveryCompensationCommandWire(command)).toEqual({
        actionInvocationId: command.actionInvocationId,
        actorPrincipalId: command.actingPrincipalId,
        committedActionInvocationId: command.committedActionInvocationId,
        reason: command.reason,
        trustedOperationAt: command.trustedOperationAt,
      });

      const compensated = yield* decodeCurrencySupportRecoveryCompensationOutcome(
        {
          absentFrom: '2026-09-22T12:05:00.000Z',
          committedActionInvocationId: command.committedActionInvocationId,
          committedGeneration: 1,
          committedScheduleRevision: 1,
          committedSupportRevisionId: currentRevisionId,
          compensationScheduleRevision: 2,
          outcome: 'CURRENCY_SUPPORT_RECOVERY_COMPENSATED',
          supportId,
        },
        command,
      );
      expect(compensated).toMatchObject({
        outcome: 'COMPENSATED',
        result: {
          committedActionInvocationId: command.committedActionInvocationId,
          committedSupportRevisionRef: supportRevisionRef(currentRevisionId),
          compensationScheduleRevision: 2,
          supportRootRef,
        },
      });

      expect(
        yield* decodeCurrencySupportRecoveryCompensationOutcome(
          {
            outcome: 'CURRENCY_SUPPORT_RECOVERY_COMPENSATION_CONFLICT',
            reason: 'CANONICAL_STATE_CHANGED',
          },
          command,
        ),
      ).toEqual({ outcome: 'CONFLICT', reason: 'CANONICAL_STATE_CHANGED' });

      const unbound = yield* decodeCurrencySupportRecoveryCompensationOutcome(
        {
          absentFrom: '2026-09-22T12:05:00.000Z',
          committedActionInvocationId: '33110000-0000-4000-8000-000000000099',
          committedGeneration: 1,
          committedScheduleRevision: 1,
          committedSupportRevisionId: currentRevisionId,
          compensationScheduleRevision: 2,
          outcome: 'CURRENCY_SUPPORT_RECOVERY_COMPENSATED',
          supportId,
        },
        command,
      ).pipe(Effect.flip);
      expect(unbound).toBeInstanceOf(PersistenceFailure);
    }),
  );

  it.effect('maps only an exact value-edit schedule challenge into a bound acknowledgement', () =>
    Effect.gen(function* scheduleChallenge() {
      const future = {
        effectivePeriod: { effectiveFrom: '2026-11-01T00:00:00.000Z', effectiveTo: null },
        generation: 5,
        supportedCurrencies: ['CZK'],
        supportRevisionRef: supportRevisionRef(futureRevisionId),
      } as const;
      const payload = yield* Schema.decodeEffect(SetSupportedCurrenciesV2PayloadSchema)({
        expectedState: {
          current: {
            effectivePeriod: { effectiveFrom: current.effectiveFrom, effectiveTo: current.effectiveTo },
            generation: current.generation,
            supportedCurrencies: current.supportedCurrencies,
            supportRevisionRef: supportRevisionRef(current.supportRevisionId),
          },
          future: [future],
          observedAt,
          scheduleRevision: 5,
          state: 'PRESENT',
          supportRootRef,
        },
        intendedEffectivePeriod: { effectiveFrom: effectiveAt, effectiveTo: current.effectiveTo },
        intent: 'VALUE_ONLY_CURRENT',
        reason: 'Reconfirm Launch support while preserving the future schedule.',
        schemaVersion: '2',
        supportedCurrencies: ['CZK'],
      });
      const command = { ...establishCommand, ...payload };
      const outcome = yield* decodeSetCurrencySupportOutcome(
        {
          outcome: 'SCHEDULE_ACKNOWLEDGEMENT_REQUIRED',
          scheduleAcknowledgement: {
            actingPrincipalId: command.actingPrincipalId,
            fingerprint: 'a'.repeat(64),
            intendedEffectivePeriod: command.intendedEffectivePeriod,
            intendedSupportedCurrencies: command.supportedCurrencies,
            presentedFuture: [
              {
                effectiveFrom: future.effectivePeriod.effectiveFrom,
                effectiveTo: future.effectivePeriod.effectiveTo,
                generation: future.generation,
                supportedCurrencies: future.supportedCurrencies,
                supportRevisionId: future.supportRevisionRef.resourceId,
              },
            ],
            scheduleRevision: 5,
            supportId,
            targetEffectivePeriod: {
              effectiveFrom: current.effectiveFrom,
              effectiveTo: current.effectiveTo,
            },
            targetRevisionId: current.supportRevisionId,
          },
        },
        command,
      );
      expect(outcome).toMatchObject({
        acknowledgement: {
          expectedScheduleRevision: 5,
          presentedFuture: [future],
          supportRootRef,
          targetRevisionRef: supportRevisionRef(current.supportRevisionId),
        },
        outcome: 'ACKNOWLEDGEMENT_REQUIRED',
      });
    }),
  );

  it.effect('keeps transient retry evidence outside the canonical Currency Support idempotency intent', () =>
    Effect.gen(function* canonicalRetryIntent() {
      const future = {
        effectivePeriod: { effectiveFrom: '2026-11-01T00:00:00.000Z', effectiveTo: null },
        generation: 5,
        supportedCurrencies: ['CZK'],
        supportRevisionRef: supportRevisionRef(futureRevisionId),
      } as const;
      const payload = yield* Schema.decodeEffect(SetSupportedCurrenciesV2PayloadSchema)({
        expectedState: {
          current: {
            effectivePeriod: { effectiveFrom: current.effectiveFrom, effectiveTo: current.effectiveTo },
            generation: current.generation,
            supportedCurrencies: current.supportedCurrencies,
            supportRevisionRef: supportRevisionRef(current.supportRevisionId),
          },
          future: [future],
          observedAt,
          scheduleRevision: 5,
          state: 'PRESENT',
          supportRootRef,
        },
        intendedEffectivePeriod: { effectiveFrom: effectiveAt, effectiveTo: current.effectiveTo },
        intent: 'VALUE_ONLY_CURRENT',
        reason: 'Reconfirm Launch support while preserving the future schedule.',
        schemaVersion: '2',
        supportedCurrencies: ['CZK'],
      });
      if (payload.intent !== 'VALUE_ONLY_CURRENT') {
        throw new Error('Expected a value-only Currency Support fixture');
      }
      const original = { ...establishCommand, ...payload };
      const challenge = yield* decodeSetCurrencySupportOutcome(
        {
          outcome: 'SCHEDULE_ACKNOWLEDGEMENT_REQUIRED',
          scheduleAcknowledgement: {
            actingPrincipalId: original.actingPrincipalId,
            fingerprint: 'b'.repeat(64),
            intendedEffectivePeriod: original.intendedEffectivePeriod,
            intendedSupportedCurrencies: original.supportedCurrencies,
            presentedFuture: [
              {
                effectiveFrom: future.effectivePeriod.effectiveFrom,
                effectiveTo: future.effectivePeriod.effectiveTo,
                generation: future.generation,
                supportedCurrencies: future.supportedCurrencies,
                supportRevisionId: future.supportRevisionRef.resourceId,
              },
            ],
            scheduleRevision: 5,
            supportId,
            targetEffectivePeriod: {
              effectiveFrom: current.effectiveFrom,
              effectiveTo: current.effectiveTo,
            },
            targetRevisionId: current.supportRevisionId,
          },
        },
        original,
      );
      if (challenge.outcome !== 'ACKNOWLEDGEMENT_REQUIRED') {
        throw new Error('Expected an acknowledgement challenge fixture');
      }
      const retryPayload = yield* Schema.decodeEffect(SetSupportedCurrenciesV2PayloadSchema)({
        acknowledgement: challenge.acknowledgement,
        expectedState: payload.expectedState,
        intendedEffectivePeriod: payload.intendedEffectivePeriod,
        intent: 'VALUE_ONLY_CURRENT',
        reason: payload.reason,
        schemaVersion: payload.schemaVersion,
        supportedCurrencies: payload.supportedCurrencies,
      });
      const retry = {
        ...establishCommand,
        ...retryPayload,
        trustedOperationAt: DateTime.toDateUtc(DateTime.makeUnsafe('2026-09-22T12:05:00.000Z')),
      };

      expect(currencySupportCanonicalIdempotencyIntentWire(retry)).toEqual(
        currencySupportCanonicalIdempotencyIntentWire(original),
      );
      expect(currencySupportCanonicalIdempotencyIntentWire({ ...retry, actingPrincipalId: supportId })).not.toEqual(
        currencySupportCanonicalIdempotencyIntentWire(original),
      );
      expect(
        currencySupportCanonicalIdempotencyIntentWire({ ...retry, reason: 'A different business intent.' }),
      ).not.toEqual(currencySupportCanonicalIdempotencyIntentWire(original));

      const originalWire = currencySupportSetCommandWire(original);
      const retryWire = currencySupportSetCommandWire(retry);
      expect(originalWire).toMatchObject({ trustedOperationAt: original.trustedOperationAt });
      expect(originalWire).not.toHaveProperty('scheduleAcknowledgement');
      expect(retryWire).toMatchObject({
        scheduleAcknowledgement: { fingerprint: challenge.acknowledgement.fingerprint },
        trustedOperationAt: retry.trustedOperationAt,
      });
    }),
  );

  it.effect('recovers only the original actor-bound mutation result and keeps missing receipts unknown', () =>
    Effect.gen(function* resultLookup() {
      const query = {
        actingPrincipalId: establishCommand.actingPrincipalId,
        actionInvocationId: establishCommand.actionInvocationId,
      };
      const found = yield* decodeCurrencySupportActionResultLookup(
        {
          ...query,
          intent: 'ESTABLISH_CURRENT',
          outcome: 'CURRENCY_SUPPORT_ACTION_RESULT_FOUND',
          result: { changed: true, current, outcome: 'APPLIED', scheduleRevision: 1, supportId },
        },
        query,
        establishCommand.tenantId,
      );
      expect(found).toMatchObject({ outcome: 'FOUND', result: { outcome: 'CREATED' } });

      const unknown = yield* decodeCurrencySupportActionResultLookup(
        { ...query, outcome: 'CURRENCY_SUPPORT_ACTION_RESULT_UNKNOWN' },
        query,
        establishCommand.tenantId,
      );
      expect(unknown).toEqual({ outcome: 'UNKNOWN' });

      const revised = yield* decodeCurrencySupportActionResultLookup(
        {
          ...query,
          intent: 'VALUE_ONLY_CURRENT',
          outcome: 'CURRENCY_SUPPORT_ACTION_RESULT_FOUND',
          result: { changed: true, current, outcome: 'APPLIED', scheduleRevision: 1, supportId },
        },
        query,
        establishCommand.tenantId,
      );
      const unchanged = yield* decodeCurrencySupportActionResultLookup(
        {
          ...query,
          intent: 'VALUE_ONLY_CURRENT',
          outcome: 'CURRENCY_SUPPORT_ACTION_RESULT_FOUND',
          result: { changed: false, current, outcome: 'UNCHANGED', scheduleRevision: 1, supportId },
        },
        query,
        establishCommand.tenantId,
      );
      expect(revised).toMatchObject({ outcome: 'FOUND', result: { outcome: 'REVISED' } });
      expect(unchanged).toMatchObject({ outcome: 'FOUND', result: { outcome: 'UNCHANGED' } });

      for (const untrusted of [
        { ...query, actingPrincipalId: '33110000-0000-4000-8000-000000000009' },
        { ...query, actionInvocationId: '33110000-0000-4000-8000-000000000009' },
      ]) {
        const failure = yield* decodeCurrencySupportActionResultLookup(
          { ...untrusted, outcome: 'CURRENCY_SUPPORT_ACTION_RESULT_UNKNOWN' },
          query,
          establishCommand.tenantId,
        ).pipe(Effect.flip);
        expect(failure).toBeInstanceOf(PersistenceFailure);
      }
      const nonLaunch = yield* decodeCurrencySupportActionResultLookup(
        {
          ...query,
          intent: 'ESTABLISH_CURRENT',
          outcome: 'CURRENCY_SUPPORT_ACTION_RESULT_FOUND',
          result: {
            changed: true,
            current: { ...current, supportedCurrencies: ['EUR'] },
            outcome: 'APPLIED',
            scheduleRevision: 1,
            supportId,
          },
        },
        query,
        establishCommand.tenantId,
      ).pipe(Effect.flip);
      expect(nonLaunch).toBeInstanceOf(PersistenceFailure);

      const inconsistentNoOp = yield* decodeCurrencySupportActionResultLookup(
        {
          ...query,
          intent: 'ESTABLISH_CURRENT',
          outcome: 'CURRENCY_SUPPORT_ACTION_RESULT_FOUND',
          result: { changed: false, current, outcome: 'UNCHANGED', scheduleRevision: 1, supportId },
        },
        query,
        establishCommand.tenantId,
      ).pipe(Effect.flip);
      expect(inconsistentNoOp).toBeInstanceOf(PersistenceFailure);
    }),
  );

  it.effect('binds unchanged-through proof to the exact Currency Support generation and preserves owner time', () =>
    Effect.gen(function* generationThrough() {
      const through = '2026-09-22T12:00:03.000Z';
      const query = { support: generationSupport, through };
      const unchanged = yield* decodeCurrencySupportGenerationThrough(
        {
          generation: current.generation,
          observedAt: '2026-09-22T12:00:04.000Z',
          outcome: 'CURRENCY_SUPPORT_UNCHANGED_THROUGH',
          scheduleRevision: 5,
          supportId,
          supportRevisionId: currentRevisionId,
          verifiedThrough: through,
        },
        query,
      );
      expect(unchanged).toEqual({
        generation: current.generation,
        nextApplicabilityBoundary: current.effectiveTo,
        observedAt: '2026-09-22T12:00:04.000Z',
        outcome: 'UNCHANGED_THROUGH',
        scheduleRevision: 5,
        supportRevisionId: currentRevisionId,
        supportRootId: supportId,
        verifiedThrough: through,
      });

      const changed = yield* decodeCurrencySupportGenerationThrough(
        {
          observedAt: '2026-09-22T12:00:05.000Z',
          outcome: 'CURRENCY_SUPPORT_CHANGED_BEFORE_FENCE',
          verifiedThrough: through,
        },
        query,
      );
      expect(changed).toEqual({
        observedAt: '2026-09-22T12:00:05.000Z',
        outcome: 'CHANGED',
        verifiedThrough: through,
      });

      const mismatched = yield* decodeCurrencySupportGenerationThrough(
        {
          generation: current.generation + 1,
          observedAt: '2026-09-22T12:00:04.000Z',
          outcome: 'CURRENCY_SUPPORT_UNCHANGED_THROUGH',
          scheduleRevision: 5,
          supportId,
          supportRevisionId: currentRevisionId,
          verifiedThrough: through,
        },
        query,
      ).pipe(Effect.flip);
      expect(mismatched).toBeInstanceOf(PersistenceFailure);
    }),
  );

  it.effect('binds an owner-issued opaque receipt and resolves its exact original Currency Support facts', () =>
    Effect.gen(function* proofReceipt() {
      const payload = {
        effectiveAt,
        effectivePeriod: { effectiveFrom: current.effectiveFrom, effectiveTo: current.effectiveTo },
        factProofs: [{ factRef: supportId, factRevisionRef: currentRevisionId, verificationRef }],
        generation: current.generation,
        nextApplicabilityBoundary: current.effectiveTo,
        observedAt: '2026-09-22T12:00:04.000Z',
        predicateRef: `commerce.pricing.current-supported-currencies:tenant-cz:${supportId}:${currentRevisionId}:CZK`,
        pricingRevision: current.pricingRevision,
        scheduleRevision: 5,
        supportedCurrencies: current.supportedCurrencies,
        supportId,
        supportRevisionId: currentRevisionId,
        tenantId: 'tenant-cz',
        verificationRef,
      } as const;
      const expected = {
        currentnessEvidence: generationSupport.currentnessEvidence,
        effectivePeriod: generationSupport.effectivePeriod,
        generation: generationSupport.generation,
        observedAt: generationSupport.observedAt,
        pricingRevision: generationSupport.pricingRevision,
        scheduleRevision: generationSupport.scheduleRevision,
        supportedCurrencies: generationSupport.supportedCurrencies,
        supportRevisionRef: generationSupport.supportRevisionRef,
        supportRootRef: generationSupport.supportRootRef,
      };
      const issued = yield* decodeIssuedCurrencySupportProof(
        { ...payload, outcome: 'CURRENCY_SUPPORT_PROOF_ISSUED' },
        request,
        expected,
      );
      expect(issued.current).toMatchObject({
        factProofs: payload.factProofs,
        observedAt: payload.observedAt,
        predicateRef: payload.predicateRef,
        verificationRef,
      });
      const resolved = yield* decodeResolvedCurrencySupportProof(
        { ...payload, outcome: 'CURRENCY_SUPPORT_PROOF_RESOLVED' },
        request.tenantId,
        verificationRef,
      );
      expect(resolved).toMatchObject({
        factProofs: payload.factProofs,
        observedAt: payload.observedAt,
        predicateRef: payload.predicateRef,
        supportRevisionId: currentRevisionId,
        supportRootId: supportId,
        verificationRef,
      });
    }),
  );
});
