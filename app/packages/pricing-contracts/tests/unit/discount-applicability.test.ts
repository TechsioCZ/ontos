import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  PricingDiscountAudienceEvidenceBindingSchema,
  PricingDiscountCurrentResolutionSchema,
  PricingDiscountDefinitionSchema,
  PricingDiscountIdentityKeySchema,
  PricingDiscountScheduleAcknowledgementSchema,
  PricingDiscountScheduleSnapshotSchema,
  PricingWholePurchaseContractualApplicabilitySchema,
  pricingDiscountIdentityKeysEqual,
} from '../../src/domain/discount.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const productRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'commerce.catalog.product' as const,
  tenantId,
};
const variantRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.catalog.variant' as const,
  tenantId,
};
const unitRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: '44444444-4444-4444-8444-444444444444',
  resourceType: 'commerce.catalog.product-unit' as const,
  tenantId,
};
const counterpartyRef = {
  moduleId: 'party.registry' as const,
  resourceId: '55555555-5555-4555-8555-555555555555',
  resourceType: 'party.registry.counterparty' as const,
  tenantId,
};
const selection = { productRef, variantRef };
const commercialScope = {
  channelId: 'B2B' as const,
  marketId: 'cz-launch',
  sellingLegalEntityId: '66666666-6666-4666-8666-666666666666',
};
const lineIdentityKey = {
  audience: { counterpartyRef, kind: 'COUNTERPARTY' as const },
  basis: { catalogSelection: selection, kind: 'VARIANT_LINE' as const, unitBasis: { quantity: '1', unitRef } },
  commercialScope,
  currencyCode: 'CZK',
  effectKind: 'PERCENTAGE' as const,
  family: 'CONTRACTUAL_DISCOUNT' as const,
  monetaryBoundary: 'PRE_TAX' as const,
  scope: 'VARIANT_LINE' as const,
};
const wholeIdentityKey = {
  ...lineIdentityKey,
  basis: { kind: 'WHOLE_PURCHASE' as const },
  effectKind: 'FIXED_MONETARY_AMOUNT' as const,
  scope: 'WHOLE_PURCHASE' as const,
};
const discountId = '77777777-7777-4777-8777-777777777777';
const firstRevisionId = '88888888-8888-4888-8888-888888888888';
const futureRevisionId = '99999999-9999-4999-8999-999999999999';

const scheduledRevision = (
  revision: number,
  revisionId: string,
  level: string,
  effectiveFrom: string,
  effectiveTo: null | string,
) => ({
  definition: {
    discountId,
    identityKey: lineIdentityKey,
    revision: {
      configuredEffect: { kind: 'PERCENTAGE' as const, level },
      effectiveFrom,
      revision,
      revisionId,
    },
  },
  effectivePeriod: { effectiveFrom, effectiveTo },
  lineage: {
    correctedRevisionId: null,
    kind: revision === 1 ? ('INITIAL' as const) : ('SCHEDULED' as const),
    previousRevisionId: revision === 1 ? null : firstRevisionId,
  },
});

describe('Pricing Discount applicability contracts (#771)', () => {
  it('keeps exact logical identity separate from immutable configured value revisions', () => {
    const decodeKey = Schema.decodeUnknownSync(PricingDiscountIdentityKeySchema, { onExcessProperty: 'error' });
    const decodeDefinition = Schema.decodeUnknownSync(PricingDiscountDefinitionSchema, { onExcessProperty: 'error' });
    const decoded = decodeKey(lineIdentityKey);

    expect(
      pricingDiscountIdentityKeysEqual(
        decoded,
        decodeKey({
          ...lineIdentityKey,
          basis: { ...lineIdentityKey.basis, unitBasis: { ...lineIdentityKey.basis.unitBasis, quantity: '1.0' } },
        }),
      ),
    ).toBe(true);
    expect(
      pricingDiscountIdentityKeysEqual(
        decoded,
        decodeKey({ ...lineIdentityKey, commercialScope: { ...commercialScope, channelId: 'B2C' } }),
      ),
    ).toBe(false);
    expect(
      pricingDiscountIdentityKeysEqual(decoded, decodeKey({ ...lineIdentityKey, effectKind: 'FIXED_MONETARY_AMOUNT' })),
    ).toBe(false);

    expect(
      decodeDefinition({
        discountId,
        identityKey: lineIdentityKey,
        revision: {
          configuredEffect: { kind: 'PERCENTAGE', level: '10' },
          effectiveFrom: '2026-09-01T00:00:00.000Z',
          revision: 1,
          revisionId: firstRevisionId,
        },
      }).revision.configuredEffect,
    ).toEqual({ kind: 'PERCENTAGE', level: '10' });
    expect(() =>
      decodeDefinition({
        discountId,
        identityKey: lineIdentityKey,
        revision: {
          configuredEffect: { kind: 'FIXED_MONETARY_AMOUNT', level: { amount: '10', currencyCode: 'CZK' } },
          effectiveFrom: '2026-09-01T00:00:00.000Z',
          revision: 1,
          revisionId: firstRevisionId,
        },
      }),
    ).toThrow();
  });

  it('uses half-open Current selection, preserves gaps/future state, and exposes overlap as conflict', () => {
    const current = scheduledRevision(1, firstRevisionId, '10', '2026-09-01T00:00:00.000Z', '2026-09-28T00:00:00.000Z');
    const future = scheduledRevision(2, futureRevisionId, '15', '2026-10-01T00:00:00.000Z', null);
    const decodeSchedule = Schema.decodeUnknownSync(PricingDiscountScheduleSnapshotSchema);
    const decodeCurrent = Schema.decodeUnknownSync(PricingDiscountCurrentResolutionSchema);

    expect(
      decodeSchedule({
        discountId,
        future: [future],
        identityKey: lineIdentityKey,
        observedAt: '2026-09-29T00:00:00.000Z',
        revisions: [current, future],
        scheduleRevision: 2,
      }).current,
    ).toBeUndefined();
    expect(
      decodeCurrent({
        candidateRevisionIds: [firstRevisionId, futureRevisionId],
        identityKey: lineIdentityKey,
        observedAt: '2026-09-27T00:00:00.000Z',
        outcome: 'DISCOUNT_CURRENT_CONFLICT',
      }).outcome,
    ).toBe('DISCOUNT_CURRENT_CONFLICT');
    expect(() =>
      decodeSchedule({
        current,
        discountId,
        future: [],
        identityKey: lineIdentityKey,
        observedAt: '2026-09-27T00:00:00.000Z',
        revisions: [
          current,
          { ...future, effectivePeriod: { effectiveFrom: '2026-09-27T00:00:00.000Z', effectiveTo: null } },
        ],
        scheduleRevision: 2,
      }),
    ).toThrow();

    const changedValueAndIntervalWithDuplicateId = scheduledRevision(
      2,
      firstRevisionId,
      '25',
      '2026-10-02T00:00:00.000Z',
      null,
    );
    expect(() =>
      decodeSchedule({
        discountId,
        future: [changedValueAndIntervalWithDuplicateId],
        identityKey: lineIdentityKey,
        observedAt: '2026-09-29T00:00:00.000Z',
        revisions: [current, changedValueAndIntervalWithDuplicateId],
        scheduleRevision: 2,
      }),
    ).toThrow();

    const overlappingDuplicateId = scheduledRevision(2, firstRevisionId, '30', '2026-09-27T00:00:00.000Z', null);
    expect(() =>
      decodeSchedule({
        current,
        discountId,
        future: [],
        identityKey: lineIdentityKey,
        observedAt: '2026-09-27T12:00:00.000Z',
        revisions: [current, overlappingDuplicateId],
        scheduleRevision: 2,
      }),
    ).toThrow();

    const duplicateRevisionNumber = scheduledRevision(1, futureRevisionId, '20', '2026-10-02T00:00:00.000Z', null);
    expect(() =>
      decodeSchedule({
        discountId,
        future: [duplicateRevisionNumber],
        identityKey: lineIdentityKey,
        observedAt: '2026-09-29T00:00:00.000Z',
        revisions: [current, duplicateRevisionNumber],
        scheduleRevision: 2,
      }),
    ).toThrow();

    expect(
      decodeCurrent({
        claimants: [
          { revision: 1, revisionId: firstRevisionId },
          { revision: 2, revisionId: firstRevisionId },
        ],
        identityKey: lineIdentityKey,
        observedAt: '2026-09-27T12:00:00.000Z',
        outcome: 'DISCOUNT_REVISION_INVARIANT_VIOLATION',
        reason: 'DUPLICATE_REVISION_ID',
      }).outcome,
    ).toBe('DISCOUNT_REVISION_INVARIANT_VIOLATION');
    expect(() =>
      decodeCurrent({
        candidateRevisionIds: [firstRevisionId, firstRevisionId],
        identityKey: lineIdentityKey,
        observedAt: '2026-09-27T12:00:00.000Z',
        outcome: 'DISCOUNT_CURRENT_CONFLICT',
      }),
    ).toThrow();
  });

  it('binds value-only acknowledgement to the exact interval/target while preserving the future schedule', () => {
    const current = scheduledRevision(1, firstRevisionId, '10', '2026-09-01T00:00:00.000Z', '2026-09-28T00:00:00.000Z');
    const future = scheduledRevision(2, futureRevisionId, '15', '2026-10-01T00:00:00.000Z', null);
    const acknowledgement = {
      actingPrincipalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      discountId,
      fingerprint: 'a'.repeat(64),
      identityKey: lineIdentityKey,
      intendedConfiguredEffect: { kind: 'PERCENTAGE' as const, level: '12' },
      intendedEffectivePeriod: {
        effectiveFrom: '2026-09-27T12:00:00.000Z',
        effectiveTo: current.effectivePeriod.effectiveTo,
      },
      intent: 'VALUE_ONLY_CURRENT' as const,
      presentedFuture: [future],
      scheduleRevision: 2,
      targetEffectivePeriod: current.effectivePeriod,
      targetRevisionId: firstRevisionId,
    };
    const decode = Schema.decodeUnknownSync(PricingDiscountScheduleAcknowledgementSchema);

    expect(decode(acknowledgement).presentedFuture).toHaveLength(1);
    expect(() =>
      decode({
        ...acknowledgement,
        intendedEffectivePeriod: {
          effectiveFrom: '2026-08-31T12:00:00.000Z',
          effectiveTo: current.effectivePeriod.effectiveTo,
        },
      }),
    ).toThrow();
    expect(() =>
      decode({
        ...acknowledgement,
        intendedEffectivePeriod: { ...current.effectivePeriod, effectiveTo: '2026-09-30T00:00:00.000Z' },
      }),
    ).toThrow();
    expect(() =>
      decode({
        ...acknowledgement,
        presentedFuture: [future, scheduledRevision(3, futureRevisionId, '20', '2026-11-01T00:00:00.000Z', null)],
      }),
    ).toThrow();
    expect(() =>
      decode({
        ...acknowledgement,
        presentedFuture: [
          future,
          scheduledRevision(2, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', '20', '2026-11-01T00:00:00.000Z', null),
        ],
      }),
    ).toThrow();
  });

  it('keeps owner-proven Counterparty audience independent from the actual no-group base Price path', () => {
    const binding = {
      applicabilityBasis: {
        basis: lineIdentityKey.basis,
        commercialScope,
        currencyCode: 'CZK',
        observedAt: '2026-09-27T10:00:00.000Z',
      },
      basePricePath: {
        kind: 'NO_GROUP_PRICE' as const,
        priceRef: {
          moduleId: 'commerce.pricing' as const,
          resourceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          resourceType: 'commerce.pricing.price' as const,
          tenantId,
        },
        priceRevisionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      },
      evidence: {
        audience: lineIdentityKey.audience,
        kind: 'COUNTERPARTY_OWNER_EVIDENCE' as const,
        observedAt: '2026-09-27T10:00:00.000Z',
        ownerRevision: 'party-registry:41',
        source: 'PARTY_REGISTRY' as const,
      },
      identityKey: lineIdentityKey,
    };
    const decode = Schema.decodeUnknownSync(PricingDiscountAudienceEvidenceBindingSchema, {
      onExcessProperty: 'error',
    });

    expect(decode(binding).basePricePath.kind).toBe('NO_GROUP_PRICE');
    expect(() => decode({ ...binding, email: 'not-owner-evidence@example.invalid' })).toThrow();
  });

  it('applies whole-purchase fixed D exactly when B > D and emits no allocation contract', () => {
    const definition = {
      discountId,
      identityKey: wholeIdentityKey,
      revision: {
        configuredEffect: { kind: 'FIXED_MONETARY_AMOUNT' as const, level: { amount: '100', currencyCode: 'CZK' } },
        effectiveFrom: '2026-09-01T00:00:00.000Z',
        revision: 1,
        revisionId: firstRevisionId,
      },
    };
    const decode = Schema.decodeUnknownSync(PricingWholePurchaseContractualApplicabilitySchema, {
      onExcessProperty: 'error',
    });
    const basis = {
      currencyCode: 'CZK',
      eligibleAmount: '100.0072',
      recipients: [
        {
          intermediateValue: { amount: '9.7097', currencyCode: 'CZK' },
          occurrenceId: 'line:first',
          recipientKind: 'MERCHANDISE' as const,
        },
        {
          intermediateValue: { amount: '90.2975', currencyCode: 'CZK' },
          occurrenceId: 'line:second',
          recipientKind: 'MERCHANDISE' as const,
        },
      ],
    };

    expect(
      decode({
        basis,
        contribution: { amount: '-100', currencyCode: 'CZK' },
        definition,
        outcome: 'WHOLE_PURCHASE_DISCOUNT_APPLICABLE',
      }).outcome,
    ).toBe('WHOLE_PURCHASE_DISCOUNT_APPLICABLE');
    expect(
      decode({
        basis: {
          ...basis,
          eligibleAmount: '100',
          recipients: [
            {
              intermediateValue: { amount: '100', currencyCode: 'CZK' },
              occurrenceId: 'line:first',
              recipientKind: 'MERCHANDISE',
            },
          ],
        },
        definition,
        outcome: 'WHOLE_PURCHASE_DISCOUNT_NOT_APPLICABLE',
        reason: 'BASIS_NOT_GREATER_THAN_DISCOUNT',
      }).outcome,
    ).toBe('WHOLE_PURCHASE_DISCOUNT_NOT_APPLICABLE');
    const empty = decode({
      basis: { currencyCode: 'CZK', eligibleAmount: '0', recipients: [] },
      definition,
      outcome: 'WHOLE_PURCHASE_DISCOUNT_NOT_APPLICABLE',
      reason: 'EMPTY_ELIGIBLE_SET',
    });
    expect(empty.outcome).toBe('WHOLE_PURCHASE_DISCOUNT_NOT_APPLICABLE');
    expect(() =>
      decode({
        allocation: [],
        basis,
        contribution: { amount: '-100', currencyCode: 'CZK' },
        definition,
        outcome: 'WHOLE_PURCHASE_DISCOUNT_APPLICABLE',
      }),
    ).toThrow();
  });
});
