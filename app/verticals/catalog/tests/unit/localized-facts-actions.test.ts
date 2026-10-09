import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  RemoveProductLocalizedFactsPayloadSchema,
  SetProductLocalizedFactsPayloadSchema,
  SetVariantLocalizedFactsPayloadSchema,
} from '../../shared/actions/localized-facts.ts';
import { checkLocalizedRefs, localizedOutcome } from '../../src/actions/localized-facts-action-support.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'commerce.catalog.product',
  tenantId,
} as const;
const variantRef = {
  moduleId: 'commerce.catalog',
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.catalog.variant',
  tenantId,
} as const;
const common = {
  evidenceRefs: ['catalog-source'],
  expectedRevision: 0,
  locale: 'cs-CZ',
  reason: 'Verified factual wording',
};

describe('localized Catalog facts Action boundary', () => {
  it('accepts a factual name or description with locale, CAS revision, and evidence', () => {
    const payload = Schema.decodeUnknownSync(SetProductLocalizedFactsPayloadSchema)({
      ...common,
      facts: { name: '  Police Alfa  ' },
      productRef,
    });
    expect(payload.facts.name).toBe('Police Alfa');
    expect(payload.expectedRevision).toBe(0);
    expect(
      Schema.decodeUnknownSync(SetVariantLocalizedFactsPayloadSchema)({
        ...common,
        facts: { description: 'Steel mounting bracket' },
        productRef,
        variantRef,
      }).variantRef,
    ).toEqual(variantRef);
  });

  it('rejects blank facts, missing locale, and invalid revisions', () => {
    const decode = Schema.decodeUnknownSync(SetProductLocalizedFactsPayloadSchema);
    expect(() => decode({ ...common, facts: { name: '   ' }, productRef })).toThrow();
    expect(() => decode({ ...common, facts: {}, productRef })).toThrow();
    expect(() =>
      decode({
        evidenceRefs: common.evidenceRefs,
        expectedRevision: 0,
        facts: { name: 'Alfa' },
        productRef,
        reason: common.reason,
      }),
    ).toThrow();
    expect(() => decode({ ...common, expectedRevision: -1, facts: { name: 'Alfa' }, productRef })).toThrow();
    expect(Schema.decodeUnknownSync(RemoveProductLocalizedFactsPayloadSchema)({ ...common, productRef }).locale).toBe(
      'cs-CZ',
    );
  });

  it.effect('fails closed on cross-Tenant references and stale or text-minimum outcomes', () =>
    Effect.gen(function* crossTenantAndConflictTest() {
      const crossTenant = yield* checkLocalizedRefs(tenantId, {
        ...productRef,
        tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      }).pipe(Effect.flip);
      expect(crossTenant.code).toBe('localized_facts_not_found');
      const wrongVariant = yield* checkLocalizedRefs(tenantId, productRef, {
        ...variantRef,
        tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      }).pipe(Effect.flip);
      expect(wrongVariant.code).toBe('localized_facts_not_found');
      const stale = yield* localizedOutcome({ actualRevision: 2, kind: 'STALE' }).pipe(Effect.flip);
      expect(stale).toMatchObject({ actualRevision: 2, code: 'localized_facts_conflict' });
      const minimum = yield* localizedOutcome({ kind: 'TEXT_MINIMUM_CONFLICT' }).pipe(Effect.flip);
      expect(minimum.code).toBe('localized_facts_conflict');
    }),
  );

  it.effect('reports idempotent replay without a new change', () =>
    Effect.gen(function* idempotentReplayTest() {
      expect(yield* localizedOutcome({ kind: 'CHANGED', revision: 1 })).toEqual({ changed: true, revision: 1 });
      expect(yield* localizedOutcome({ kind: 'REPLAYED', revision: 1 })).toEqual({ changed: false, revision: 1 });
    }),
  );
});
