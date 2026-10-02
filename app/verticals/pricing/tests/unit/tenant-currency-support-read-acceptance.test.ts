import { CurrentSupportedCurrenciesRequestSchema } from '@app/pricing-contracts/current-supported-currencies';
import { Effect, Exit, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { setSupportedCurrenciesAction } from '../../src/actions/set-supported-currencies.action.ts';
import {
  currentSupportedCurrenciesRead,
  resolveCurrentSupportedCurrencies,
} from '../../src/api/current-supported-currencies.read.ts';

const tenantId = '20000000-0000-4000-8000-000000000001';
const otherTenantId = '30000000-0000-4000-8000-000000000001';
const effectiveAt = '2026-09-27T10:00:00.000Z';
const request = Schema.decodeSync(CurrentSupportedCurrenciesRequestSchema)({ effectiveAt, tenantId });
const supportRootId = '40000000-0000-4000-8000-000000000001';
const supportRevisionId = '50000000-0000-4000-8000-000000000007';
const verificationRef = 'commerce.pricing.currency-support-proof:50000000-0000-4000-8000-000000000009';
const encodeUnknownJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
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
const stored = {
  currentnessEvidence: {
    evaluatedAt: effectiveAt,
    evaluationMode: 'CURRENT_WITH_REVALIDATION' as const,
    observedAt: '2026-09-27T10:00:01.000Z',
    revalidatedAt: '2026-09-27T10:00:02.000Z',
    scheduleRevision: 7,
    supportRevisionRef,
    supportRootRef,
  },
  effectivePeriod: { effectiveFrom: '2026-09-01T00:00:00.000Z', effectiveTo: null },
  factProofs: [{ factRef: supportRootId, factRevisionRef: supportRevisionId, verificationRef }],
  generation: 7,
  observedAt: '2026-09-27T10:00:01.000Z',
  predicateRef: `commerce.pricing.current-supported-currencies:${tenantId}:${supportRootId}:${supportRevisionId}:CZK`,
  pricingRevision: 'pricing-currency-support:7',
  scheduleRevision: 7,
  supportedCurrencies: ['CZK'],
  supportRevisionRef,
  supportRootRef,
  verificationRef,
} as const;

describe('Tenant Currency Support owner-read acceptance', () => {
  it('keeps Tenant support administration explicit and independent of a selected Legal Entity', () => {
    expect(setSupportedCurrenciesAction.descriptor.entrypoint.authorization).toEqual({
      kind: 'action_execution',
      provisioning: 'explicit',
    });
    expect(setSupportedCurrenciesAction.descriptor.legalEntityScope).toBe('forbidden');
    expect(currentSupportedCurrenciesRead.descriptor.legalEntityScope).toBe('forbidden');
    expect(currentSupportedCurrenciesRead.descriptor.permissionTarget).toBe('module');
  });

  it.effect('returns one Tenant root regardless of the caller purchase context', () =>
    Effect.gen(function* contextInvariantRead() {
      const loaded: unknown[] = [];
      const loadCurrent = (input: typeof request) => {
        loaded.push(input);
        return Effect.succeed({ _tag: 'current' as const, current: stored });
      };

      const retail = yield* resolveCurrentSupportedCurrencies(request, { tenantId }, loadCurrent);
      const wholesale = yield* resolveCurrentSupportedCurrencies(request, { tenantId }, loadCurrent);

      expect(loaded).toEqual([request, request]);
      expect(retail).toEqual(wholesale);
      expect(retail).toMatchObject({
        completenessEvidence: {
          scope: {
            predicateRef: `commerce.pricing.current-supported-currencies:${tenantId}:${supportRootId}:${supportRevisionId}:CZK`,
          },
        },
        outcome: 'SUPPORTED_CURRENCIES_CURRENT',
        pricingRevision: 'pricing-currency-support:7',
        supportedCurrencies: ['CZK'],
      });
      expect(yield* encodeUnknownJson(retail)).not.toMatch(/cart|channel|market|storefront|subject|legalEntity/iu);
    }),
  );

  it.effect('reports missing support without creating state or fabricating CZK', () =>
    Effect.gen(function* missingSupport() {
      let reads = 0;
      const result = yield* resolveCurrentSupportedCurrencies(request, { tenantId }, () => {
        reads += 1;
        return Effect.succeed({
          _tag: 'absent' as const,
          observedAt: '2026-09-27T10:00:01.000Z',
        });
      });

      expect(reads).toBe(1);
      expect(result).toMatchObject({
        outcome: 'SUPPORTED_CURRENCIES_UNAVAILABLE',
        retryable: true,
      });
      expect(result).not.toHaveProperty('supportedCurrencies');
      expect(yield* encodeUnknownJson(result)).not.toContain('CZK');
    }),
  );

  it.effect('reports conflicting revisions and schedule gaps without choosing a winner', () =>
    Effect.gen(function* explicitNonCurrentEvidence() {
      const conflict = yield* resolveCurrentSupportedCurrencies(request, { tenantId }, () =>
        Effect.succeed({
          _tag: 'conflict' as const,
          candidateRevisionIds: [supportRevisionId, '50000000-0000-4000-8000-000000000008'],
          observedAt: '2026-09-27T10:00:01.000Z',
        }),
      );
      const gap = yield* resolveCurrentSupportedCurrencies(request, { tenantId }, () =>
        Effect.succeed({
          _tag: 'gap' as const,
          nextApplicabilityBoundary: '2026-11-01T00:00:00.000Z',
          observedAt: '2026-09-27T10:00:01.000Z',
        }),
      );

      expect(conflict).toMatchObject({
        code: 'pricing_currency_support_revision_conflict',
        outcome: 'SUPPORTED_CURRENCIES_INVALID',
        retryable: false,
      });
      expect(gap).toMatchObject({
        code: 'pricing_currency_support_schedule_gap',
        outcome: 'SUPPORTED_CURRENCIES_UNAVAILABLE',
        retryable: true,
      });
      expect(conflict).not.toHaveProperty('supportedCurrencies');
      expect(gap).not.toHaveProperty('supportedCurrencies');
      expect(yield* encodeUnknownJson({ conflict, gap })).not.toContain('CZK');
    }),
  );

  it.effect('fails closed across Tenants before observing another Tenant root', () =>
    Effect.gen(function* isolateTenantRoots() {
      let reads = 0;
      const exit = yield* Effect.exit(
        resolveCurrentSupportedCurrencies(request, { tenantId: otherTenantId }, () => {
          reads += 1;
          return Effect.succeed({ _tag: 'current' as const, current: stored });
        }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(reads).toBe(0);
    }),
  );
});
