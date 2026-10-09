import { Effect } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  decodeExternalPriceSourceAuthorityAssessment,
  ExternalPriceSourceAuthorityPersistenceUnavailable,
} from '../../src/persistence/external-price-source-authority-persistence.ts';

describe('Pricing external Price Source Authority persistence', () => {
  it.effect('decodes one exact owner grant and fails closed on an ambiguous result', () =>
    Effect.gen(function* exactGrant() {
      const granted = yield* decodeExternalPriceSourceAuthorityAssessment([
        {
          payload: {
            grant: {
              authority: {
                sourceAuthorityRef: 'pricing-governed-erp-feed',
                sourceAuthorityVersion: '9',
              },
              effectivePeriod: { effectiveFrom: '2026-09-01T00:00:00.000Z' },
              exactIdentityKey: {
                catalogSelection: {
                  productRef: {
                    moduleId: 'commerce.catalog',
                    resourceId: '44444444-4444-4444-8444-444444444444',
                    resourceType: 'commerce.catalog.product',
                    tenantId: '11111111-1111-4111-8111-111111111111',
                  },
                  variantRef: {
                    moduleId: 'commerce.catalog',
                    resourceId: '55555555-5555-4555-8555-555555555555',
                    resourceType: 'commerce.catalog.variant',
                    tenantId: '11111111-1111-4111-8111-111111111111',
                  },
                },
                commercialScope: {
                  channelId: 'B2B',
                  marketId: 'cz-market',
                  sellingLegalEntityId: '22222222-2222-4222-8222-222222222222',
                },
                currencyCode: 'CZK',
                priceGroupSelector: { kind: 'NO_GROUP' },
                unitBasis: {
                  quantity: '1',
                  unitRef: {
                    moduleId: 'commerce.catalog',
                    resourceId: '33333333-3333-4333-8333-333333333333',
                    resourceType: 'commerce.catalog.product-unit',
                    tenantId: '11111111-1111-4111-8111-111111111111',
                  },
                },
              },
              family: 'PRICE',
              mapping: { mappingContractRef: 'erp-price-exact-key', mappingContractVersion: '4' },
              ownerModuleId: 'commerce.pricing',
              schemaVersion: '1',
              verificationRef: 'pricing-source-authority-proof-803',
              verifiedAt: '2026-09-29T10:00:00.000Z',
            },
            outcome: 'AUTHORITY_GRANTED',
          },
        },
      ]);

      expect(granted).toMatchObject({ outcome: 'AUTHORITY_GRANTED' });

      const ambiguous = yield* decodeExternalPriceSourceAuthorityAssessment([
        { payload: { outcome: 'AUTHORITY_UNRESOLVED', reason: 'MAPPING' } },
        { payload: { outcome: 'AUTHORITY_UNRESOLVED', reason: 'MAPPING' } },
      ]).pipe(Effect.flip);
      expect(ambiguous).toBeInstanceOf(ExternalPriceSourceAuthorityPersistenceUnavailable);
    }),
  );
});
