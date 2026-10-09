import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  StockSharingEligibilitySchema,
  TrustedCurrentCommercePurchasingContextSchema,
  commerceScopeMatchesRelation,
} from '../../shared/domain/stock-sharing-eligibility.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const sellerId = '22222222-2222-4222-8222-222222222222';
const positionId = '33333333-3333-4333-8333-333333333333';
const configurationId = '44444444-4444-4444-8444-444444444444';
const marketId = 'market-cz';
const base = {
  commerceValidation: {
    evidenceRef: 'commerce-context-validation:1',
    observedAt: '2026-09-24T10:00:00.000Z',
    verification: 'OWNER_VERIFIED_CURRENT',
  },
  effectivePeriod: { from: '2026-09-24T10:00:00.000Z', to: null },
  lifecycle: 'CURRENT',
  ref: {
    moduleId: 'commerce.inventory',
    resourceId: '55555555-5555-4555-8555-555555555555',
    resourceType: 'commerce.inventory.stock-sharing-eligibility',
    tenantId,
  },
  revision: 1,
  scope: {
    customerConfigurationId: 'customer-configuration:primary',
    ownerConfigurationRef: {
      moduleId: 'commerce.inventory',
      resourceId: configurationId,
      resourceType: 'commerce.inventory.inventory-backend-configuration',
      tenantId,
    },
    positionRef: {
      moduleId: 'commerce.inventory',
      resourceId: positionId,
      resourceType: 'commerce.inventory.stock-position',
      tenantId,
    },
  },
  subject: {
    channel: 'B2C',
    sellingLegalEntityRef: {
      moduleId: 'core.identity',
      resourceId: sellerId,
      resourceType: 'core.identity.legal-entity',
      tenantId,
    },
  },
} as const;

const context = Schema.decodeUnknownSync(TrustedCurrentCommercePurchasingContextSchema, {
  onExcessProperty: 'error',
})({
  channel: 'B2C',
  commerceMarketRef: {
    moduleId: 'commerce.market-catalog',
    resourceId: marketId,
    resourceType: 'commerce.market-catalog.market',
    tenantId,
  },
  customerConfigurationId: 'customer-configuration:primary',
  evidenceRef: 'commerce-purchasing-context:current:1',
  observedAt: '2026-09-24T10:01:00.000Z',
  sellingLegalEntityRef: base.subject.sellingLegalEntityRef,
  status: 'CURRENT_OWNER_VERIFIED',
  storefrontRef: { appId: 'shop-cz', tenantId },
  tenantId,
});
const decodeContext = Schema.decodeUnknownSync(TrustedCurrentCommercePurchasingContextSchema, {
  onExcessProperty: 'error',
});

describe('Inventory Stock Sharing Eligibility domain', () => {
  it('accepts exactly the four confirmed subject dimensions and rejects customer selectors', () => {
    expect(Schema.decodeUnknownSync(StockSharingEligibilitySchema, { onExcessProperty: 'error' })(base)).toEqual(base);
    expect(() =>
      Schema.decodeUnknownSync(StockSharingEligibilitySchema, { onExcessProperty: 'error' })({
        ...base,
        subject: { ...base.subject, purchasingSubjectId: 'customer:1' },
      }),
    ).toThrow();
  });

  it('requires both optional restrictions when both are present', () => {
    const relation = Schema.decodeUnknownSync(StockSharingEligibilitySchema)({
      ...base,
      subject: {
        ...base.subject,
        commerceMarketRef: context.commerceMarketRef,
        storefrontRef: context.storefrontRef,
      },
    });

    expect(commerceScopeMatchesRelation(relation.subject, context)).toBe(true);
    expect(
      commerceScopeMatchesRelation(
        relation.subject,
        decodeContext({
          ...context,
          storefrontRef: { ...context.storefrontRef, appId: 'shop-sk' },
        }),
      ),
    ).toBe(false);
  });

  it('keeps a broad positive relation applicable beside a narrower relation', () => {
    const broad = Schema.decodeUnknownSync(StockSharingEligibilitySchema)(base);
    const narrow = Schema.decodeUnknownSync(StockSharingEligibilitySchema)({
      ...base,
      ref: { ...base.ref, resourceId: '66666666-6666-4666-8666-666666666666' },
      subject: { ...base.subject, commerceMarketRef: context.commerceMarketRef },
    });
    const anotherMarketContext = decodeContext({
      ...context,
      commerceMarketRef: { ...context.commerceMarketRef, resourceId: 'market-sk' },
    });

    expect(commerceScopeMatchesRelation(narrow.subject, anotherMarketContext)).toBe(false);
    expect(commerceScopeMatchesRelation(broad.subject, anotherMarketContext)).toBe(true);
  });

  it.effect('does not need a Principal, Permission, Assortment, or Reservation to evaluate the subject', () =>
    Effect.sync(() => {
      const relation = Schema.decodeUnknownSync(StockSharingEligibilitySchema)(base);
      expect(commerceScopeMatchesRelation(relation.subject, context)).toBe(true);
      expect(relation).not.toHaveProperty('principal');
      expect(relation).not.toHaveProperty('permission');
      expect(relation).not.toHaveProperty('reservation');
    }),
  );
});
