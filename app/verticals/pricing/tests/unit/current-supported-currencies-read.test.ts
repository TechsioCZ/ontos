import {
  CurrentSupportedCurrenciesRequestSchema,
  CurrentSupportedCurrenciesResponseSchema,
  CurrentSupportedCurrenciesSuccessSchema,
} from '@app/pricing-contracts/current-supported-currencies';
import { PersistenceFailure } from '@app/core-runtime';
import { Effect, Exit, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { setSupportedCurrenciesAction } from '../../src/actions/set-supported-currencies.action.ts';
import {
  currentSupportedCurrenciesRead,
  resolveCurrentSupportedCurrencies,
} from '../../src/api/current-supported-currencies.read.ts';

const request = Schema.decodeSync(CurrentSupportedCurrenciesRequestSchema)({
  effectiveAt: '2026-09-22T12:00:00.000Z',
  tenantId: 'tenant-cz',
});
const scope = { tenantId: 'tenant-cz' } as const;
const supportRootRef = {
  moduleId: 'commerce.pricing',
  resourceId: '33110000-0000-4000-8000-000000000001',
  resourceType: 'commerce.pricing.currency-support',
  tenantId: 'tenant-cz',
} as const;
const supportRevisionRef = {
  moduleId: 'commerce.pricing',
  resourceId: '33110000-0000-4000-8000-000000000004',
  resourceType: 'commerce.pricing.currency-support-revision',
  supportRootId: supportRootRef.resourceId,
  tenantId: 'tenant-cz',
} as const;
const verificationRef = 'commerce.pricing.currency-support-proof:33110000-0000-4000-8000-000000000006';
const stored = {
  currentnessEvidence: {
    evaluatedAt: '2026-09-22T12:00:02.000Z',
    evaluationMode: 'CURRENT_WITH_REVALIDATION',
    observedAt: '2026-09-22T12:00:02.000Z',
    revalidatedAt: '2026-09-22T12:00:03.000Z',
    scheduleRevision: 5,
    supportRevisionRef,
    supportRootRef,
  },
  effectivePeriod: {
    effectiveFrom: '2026-09-01T00:00:00.000Z',
    effectiveTo: '2026-09-23T00:00:00.000Z',
  },
  factProofs: [{ factRef: supportRootRef.resourceId, factRevisionRef: supportRevisionRef.resourceId, verificationRef }],
  generation: 4,
  nextApplicabilityBoundary: '2026-09-23T00:00:00.000Z',
  observedAt: '2026-09-22T12:00:02.000Z',
  predicateRef: `commerce.pricing.current-supported-currencies:tenant-cz:${supportRootRef.resourceId}:${supportRevisionRef.resourceId}:CZK`,
  pricingRevision: 'pricing-currency-support:4',
  scheduleRevision: 5,
  supportedCurrencies: ['CZK'],
  supportRevisionRef,
  supportRootRef,
  verificationRef,
} as const;

describe('Current supported currencies owner read', () => {
  it('requires the atomic Tenant Currency Support read permission and preserves explicit Action execution', () => {
    expect(currentSupportedCurrenciesRead.descriptor).toMatchObject({
      entrypoint: {
        access: 'read',
        authorization: { kind: 'context_permission', permission: 'pricing.currency_support.read' },
      },
      legalEntityScope: 'forbidden',
      permissionTarget: 'module',
    });
    expect(setSupportedCurrenciesAction.descriptor.entrypoint.authorization).toEqual({
      kind: 'action_execution',
      provisioning: 'explicit',
    });
  });

  it.effect('returns Tenant-root identity, effectivity, currentness, and set completeness evidence', () =>
    Effect.gen(function* currentSupportEvidence() {
      const result = yield* resolveCurrentSupportedCurrencies(request, scope, () =>
        Effect.succeed({ _tag: 'current', current: stored }),
      );
      expect(result).toMatchObject({
        completenessEvidence: {
          ownerRevision: supportRevisionRef.resourceId,
          scope: { kind: 'EXACT_PREDICATE' },
        },
        currentnessEvidence: {
          evaluationMode: 'CURRENT_WITH_REVALIDATION',
          revalidatedAt: '2026-09-22T12:00:03.000Z',
        },
        effectivePeriod: stored.effectivePeriod,
        generation: 4,
        outcome: 'SUPPORTED_CURRENCIES_CURRENT',
        pricingRevision: 'pricing-currency-support:4',
        scheduleRevision: 5,
        supportedCurrencies: ['CZK'],
        supportRevisionRef,
        supportRootRef,
        tenantId: 'tenant-cz',
      });
      if (result.outcome === 'SUPPORTED_CURRENCIES_CURRENT') {
        expect(yield* Schema.decodeEffect(CurrentSupportedCurrenciesResponseSchema)(result)).toEqual(result);
        if (!Schema.is(CurrentSupportedCurrenciesSuccessSchema)(result)) {
          return yield* Effect.die('Current owner read must return canonical proof-bearing Currency Support');
        }
        const decoded = yield* Schema.decodeEffect(CurrentSupportedCurrenciesSuccessSchema)(result);
        expect(decoded.effectiveAt).toBe(request.effectiveAt);
        expect(decoded.currentnessEvidence.evaluatedAt).toBe('2026-09-22T12:00:02.000Z');
        expect(result.completenessEvidence.scope.predicateRef).toContain(supportRootRef.resourceId);
        expect(result.completenessEvidence.scope.predicateRef).toContain('CZK');
        expect(result.observedAt).toBe('2026-09-22T12:00:02.000Z');
      }
      return yield* Effect.void;
    }),
  );

  it.effect('returns typed stale when final revalidation no longer proves the requested state', () =>
    Effect.gen(function* changedBeforeRevalidation() {
      const result = yield* resolveCurrentSupportedCurrencies(request, scope, () =>
        Effect.succeed({
          _tag: 'current',
          current: {
            ...stored,
            currentnessEvidence: {
              evaluatedAt: request.effectiveAt,
              evaluationMode: 'HISTORICAL_AS_OF' as const,
              observedAt: stored.observedAt,
              scheduleRevision: stored.scheduleRevision,
              supportRevisionRef,
              supportRootRef,
            },
          },
        }),
      );

      expect(result).toMatchObject({
        code: 'pricing_currency_support_stale',
        observedAt: stored.observedAt,
        outcome: 'SUPPORTED_CURRENCIES_STALE',
        retryable: true,
      });
      expect(result).not.toHaveProperty('supportedCurrencies');
    }),
  );

  it.effect('distinguishes missing initialization, schedule gaps, conflicts, and unverifiable owner state', () =>
    Effect.gen(function* unavailableSupportEvidence() {
      const absent = yield* resolveCurrentSupportedCurrencies(request, scope, () =>
        Effect.succeed({ _tag: 'absent', observedAt: '2026-09-22T12:00:02.000Z' }),
      );
      const gap = yield* resolveCurrentSupportedCurrencies(request, scope, () =>
        Effect.succeed({ _tag: 'gap', observedAt: '2026-09-22T12:00:02.000Z' }),
      );
      const conflict = yield* resolveCurrentSupportedCurrencies(request, scope, () =>
        Effect.succeed({
          _tag: 'conflict',
          candidateRevisionIds: ['33110000-0000-4000-8000-000000000004', '33110000-0000-4000-8000-000000000005'],
          observedAt: '2026-09-22T12:00:02.000Z',
        }),
      );
      const unverifiable = yield* resolveCurrentSupportedCurrencies(request, scope, () =>
        Effect.fail(new PersistenceFailure({ cause: 'driver down', reason: 'owner read failed' })),
      );

      expect(absent).toMatchObject({
        code: 'pricing_currency_support_not_initialized',
        outcome: 'SUPPORTED_CURRENCIES_UNAVAILABLE',
      });
      expect(gap).toMatchObject({
        code: 'pricing_currency_support_schedule_gap',
        outcome: 'SUPPORTED_CURRENCIES_UNAVAILABLE',
      });
      expect(conflict).toMatchObject({
        code: 'pricing_currency_support_revision_conflict',
        outcome: 'SUPPORTED_CURRENCIES_INVALID',
      });
      expect(unverifiable).toMatchObject({
        code: 'pricing_currency_support_unverifiable',
        outcome: 'SUPPORTED_CURRENCIES_UNVERIFIABLE',
        retryable: false,
      });
    }),
  );

  it.effect('rejects request identity that differs from trusted scope before owner persistence', () =>
    Effect.gen(function* rejectUntrustedScope() {
      const exit = yield* Effect.exit(
        resolveCurrentSupportedCurrencies(request, { tenantId: 'different-tenant' }, () => Effect.die('must not run')),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );
});
