import { Match, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  PriceGroupInterpretationInputSchema,
  PriceGroupInterpretationSchema,
} from '../../src/domain/price-group-interpretation.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const foreignTenantId = '99999999-9999-4999-8999-999999999999';
const effectiveAt = '2026-03-01T00:00:00.000Z';
const priceGroupRef = {
  moduleId: 'pricing.price-group-catalog',
  resourceId: '77777777-7777-4777-8777-777777777777',
  resourceType: 'pricing.price-group-catalog.price-group',
  tenantId,
} as const;
const profile = {
  kind: 'RETAIL',
  moduleId: 'commerce.customer-context',
  resourceId: '66666666-6666-4666-8666-666666666666',
  resourceType: 'commerce.customer-context.retail-customer-profile',
  tenantId,
} as const;
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
const unitRef = {
  moduleId: 'commerce.catalog',
  resourceId: '44444444-4444-4444-8444-444444444444',
  resourceType: 'commerce.catalog.product-unit',
  tenantId,
} as const;
const basis = {
  catalogSelection: { productRef, variantRef },
  commercialScope: {
    channelId: 'B2C',
    marketId: 'cz-launch',
    sellingLegalEntityId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  },
  currencyCode: 'CZK',
  unitBasis: { quantity: '1', unitRef },
} as const;
const compatibilityEvidence = {
  catalogRevision: 7,
  definitionEffectivePeriod: {
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    effectiveTo: null,
  },
  definitionRevisionId: '55555555-5555-4555-8555-555555555555',
  definitionRevisionNumber: 4,
  meaningFingerprint: 'a'.repeat(64),
  priceGroupRef,
  requiredContract: {
    contractId: 'commerce.customer-price-group-assignment.v1',
    version: 1,
  },
  trustedOperationAt: effectiveAt,
  verifiedAt: '2026-03-01T00:00:01.000Z',
} as const;
const assignmentResolution = {
  _tag: 'ASSIGNED',
  assignmentRef: {
    moduleId: 'commerce.customer-context',
    resourceId: '88888888-8888-4888-8888-888888888888',
    resourceType: 'commerce.customer-context.customer-price-group-assignment',
    tenantId,
  },
  assignmentRevision: 3,
  compatibility: compatibilityEvidence,
  effectiveFrom: '2026-01-01T00:00:00.000Z',
  effectiveTo: null,
  priceGroupRef,
} as const;

const decodeInput = Schema.decodeUnknownSync(PriceGroupInterpretationInputSchema, {
  onExcessProperty: 'error',
});
const decodeInterpretation = Schema.decodeUnknownSync(PriceGroupInterpretationSchema, {
  onExcessProperty: 'error',
});

describe('Issue #761 Price Group interpretation acceptance', () => {
  it('binds owner-issued ASSIGNED evidence to the exact basis and preserves Group as a separate Discount audience', () => {
    const interpreted = decodeInterpretation({
      _tag: 'ASSIGNED',
      assignmentResolution,
      basis,
      compatibilityEvidence,
      discountAudience: { kind: 'PRICE_GROUP', priceGroupRef },
      priceGroupRef,
      priceSelector: { kind: 'PRICE_GROUP', priceGroupRef },
    });
    const assigned = Match.value(interpreted).pipe(
      Match.tag('ASSIGNED', (value) => value),
      Match.orElse(() => {
        throw new Error('fixture must decode as ASSIGNED');
      }),
    );
    const ownerAssignment = Match.value(assigned.assignmentResolution).pipe(
      Match.tag('ASSIGNED', (value) => value),
      Match.exhaustive,
    );
    expect(assigned.basis).toEqual(basis);
    expect(assigned.discountAudience).toEqual({ kind: 'PRICE_GROUP', priceGroupRef });
    expect(assigned.priceSelector).toEqual({ kind: 'PRICE_GROUP', priceGroupRef });
    expect(ownerAssignment.assignmentRef).toEqual(assignmentResolution.assignmentRef);
    expect(ownerAssignment.assignmentRevision).toBe(assignmentResolution.assignmentRevision);
    expect(assigned.compatibilityEvidence).toEqual(compatibilityEvidence);
  });

  it('represents legitimate NONE without inventing a default Group', () => {
    const interpreted = decodeInterpretation({
      _tag: 'NONE',
      assignmentResolution: { _tag: 'NONE' },
      basis,
      discountAudience: { kind: 'NONE' },
      priceSelector: { kind: 'NO_GROUP' },
    });
    const none = Match.value(interpreted).pipe(
      Match.tag('NONE', (value) => value),
      Match.orElse(() => {
        throw new Error('fixture must decode as NONE');
      }),
    );
    expect(none.basis).toEqual(basis);
    expect(none.discountAudience).toEqual({ kind: 'NONE' });
    expect(none.priceSelector).toEqual({ kind: 'NO_GROUP' });
  });

  it('represents Guest/no-profile input as explicit no-group evidence', () => {
    expect(decodeInput({ assignmentRequest: { kind: 'GUEST' }, basis })).toEqual({
      assignmentRequest: { kind: 'GUEST' },
      basis,
    });
    const interpreted = decodeInterpretation({
      _tag: 'NONE',
      assignmentResolution: { _tag: 'NONE' },
      basis,
      discountAudience: { kind: 'NONE' },
      priceSelector: { kind: 'NO_GROUP' },
    });
    const none = Match.value(interpreted).pipe(
      Match.tag('NONE', (value) => value),
      Match.orElse(() => {
        throw new Error('Guest fixture must decode as NONE');
      }),
    );
    expect(none.discountAudience).toEqual({ kind: 'NONE' });
    expect(none.priceSelector).toEqual({ kind: 'NO_GROUP' });
  });

  it('keeps BROKEN, INCONSISTENT, unavailable, and unverifiable states typed and selector-free', () => {
    const brokenResolution = {
      _tag: 'BROKEN',
      assignmentRef: assignmentResolution.assignmentRef,
      assignmentRevision: assignmentResolution.assignmentRevision,
      catalogRevision: 7,
      priceGroupRef,
      reason: 'RETIRED',
    } as const;
    const outcomes = [
      {
        _tag: 'BROKEN' as const,
        assignmentResolution: brokenResolution,
        basis,
        reason: 'RETIRED' as const,
        source: 'COMMERCE_ASSIGNMENT' as const,
      },
      {
        _tag: 'INCONSISTENT' as const,
        assignmentResolution: { _tag: 'INCONSISTENT' as const, currentAssignmentCount: 2 },
        basis,
        currentAssignmentCount: 2,
      },
      {
        _tag: 'UNAVAILABLE' as const,
        basis,
        owner: 'COMMERCE_ASSIGNMENT' as const,
        reason: 'owner read unavailable',
      },
      {
        _tag: 'UNVERIFIABLE' as const,
        basis,
        owner: 'PRICE_GROUP_COMPATIBILITY' as const,
        reason: 'DEPENDENCY_EVIDENCE_UNVERIFIABLE' as const,
      },
    ];

    for (const outcome of outcomes) {
      const decoded = decodeInterpretation(outcome);
      expect('priceSelector' in decoded).toBe(false);
      expect('discountAudience' in decoded).toBe(false);
    }
  });

  it('keeps tenant, Catalog selection, commercial scope, currency, and unit basis exact', () => {
    const input = {
      assignmentRequest: {
        authorizationSubject: { kind: 'RETAIL' as const },
        effectiveAt,
        profile,
      },
      basis,
    };
    expect(decodeInput(input)).toEqual(input);

    for (const invalidBasis of [
      {
        ...basis,
        catalogSelection: {
          ...basis.catalogSelection,
          variantRef: { ...variantRef, tenantId: foreignTenantId },
        },
      },
      { ...basis, commercialScope: { ...basis.commercialScope, storefrontId: 'web-cz' } },
      { ...basis, currencyCode: 'EUR', fallbackCurrencyCode: 'CZK' },
      { ...basis, unitBasis: { ...basis.unitBasis, unitRef: { ...unitRef, tenantId: foreignTenantId } } },
    ]) {
      expect(() => decodeInput({ ...input, basis: invalidBasis })).toThrow();
    }
  });

  it('does not accept Storefront, caller Group IDs, amount, or price ordering as interpretation authority', () => {
    const input = {
      assignmentRequest: {
        authorizationSubject: { kind: 'RETAIL' as const },
        effectiveAt,
        profile,
      },
      basis,
    };
    for (const callerClaim of [
      { callerPriceGroupId: priceGroupRef.resourceId },
      { storefrontId: 'web-cz' },
      { requestedPriceGroupRef: priceGroupRef },
    ]) {
      expect(() => decodeInput({ ...input, ...callerClaim })).toThrow();
    }

    expect(() =>
      decodeInterpretation({
        _tag: 'ASSIGNED',
        amount: '999.00',
        assignmentResolution,
        basis,
        compatibilityEvidence,
        discountAudience: { kind: 'PRICE_GROUP', priceGroupRef },
        noGroupAmount: '100.00',
        priceGroupRef,
        priceSelector: { kind: 'PRICE_GROUP', priceGroupRef },
      }),
    ).toThrow();
  });

  it('keeps the actual Group audience available when a later issue substitutes only the base Price selector', () => {
    const interpreted = decodeInterpretation({
      _tag: 'ASSIGNED',
      assignmentResolution,
      basis,
      compatibilityEvidence,
      discountAudience: { kind: 'PRICE_GROUP', priceGroupRef },
      priceGroupRef,
      priceSelector: { kind: 'PRICE_GROUP', priceGroupRef },
    });
    const assigned = Match.value(interpreted).pipe(
      Match.tag('ASSIGNED', (value) => value),
      Match.orElse(() => {
        throw new Error('fixture must decode as ASSIGNED');
      }),
    );

    const laterPriceResolutionOnly = {
      discountAudience: assigned.discountAudience,
      priceSelector: { kind: 'NO_GROUP' as const },
    };
    expect(laterPriceResolutionOnly).toEqual({
      discountAudience: { kind: 'PRICE_GROUP', priceGroupRef },
      priceSelector: { kind: 'NO_GROUP' },
    });
  });
});
