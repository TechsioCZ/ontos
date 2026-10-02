import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { SelectionEvidenceRequestSchema } from '../../shared/apis/selection-evidence.ts';
import type { SelectionEvidenceResponse } from '../../shared/apis/selection-evidence.ts';
import { CatalogSelectionInjectedOwnerEvidenceSchema } from '../../shared/domain/catalog-selection-owner-contract.ts';
import type { CatalogSelectionInjectedOwnerEvidence } from '../../shared/domain/catalog-selection-owner-contract.ts';
import { readSelectionEvidence } from '../../src/api/selection-evidence.read.ts';
import type { SelectionEvidenceServices } from '../../src/api/selection-evidence.read.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const selection = {
  productRef: {
    moduleId: 'commerce.catalog' as const,
    resourceId: '22222222-2222-4222-8222-222222222222',
    resourceType: 'commerce.catalog.product' as const,
    tenantId,
  },
  variantRef: {
    moduleId: 'commerce.catalog' as const,
    resourceId: '33333333-3333-4333-8333-333333333333',
    resourceType: 'commerce.catalog.variant' as const,
    tenantId,
  },
};
const unavailableResponse: SelectionEvidenceResponse = {
  evidence: { kind: 'UNAVAILABLE', reason: 'Owner Current basis is unavailable' },
  missingRoles: [],
};

describe('Catalog selection-evidence read owner routing', () => {
  it.effect('assesses PRICING from Catalog owner-local evidence without reading Cart evidence', () =>
    Effect.gen(function* pricingOwnerLocalEvidence() {
      const request = Schema.decodeSync(SelectionEvidenceRequestSchema)({ purpose: 'PRICING', selection });
      let cartReads = 0;
      let receivedOwnerEvidence: CatalogSelectionInjectedOwnerEvidence | 'not-called' | undefined = 'not-called';
      const services: SelectionEvidenceServices = {
        assess: (_input, ownerEvidence) => {
          receivedOwnerEvidence = ownerEvidence;
          return Effect.succeed(unavailableResponse);
        },
        readCartEvidence: () => {
          cartReads += 1;
          return Effect.die('PRICING must not request Cart evidence');
        },
      };

      const result = yield* readSelectionEvidence(request, tenantId, services);

      expect(result).toEqual(unavailableResponse);
      expect(receivedOwnerEvidence).toBeUndefined();
      expect(cartReads).toBe(0);
    }),
  );

  it.effect('preserves injected Cart evidence for non-PRICING purposes', () =>
    Effect.gen(function* cartQualifiedEvidence() {
      const request = Schema.decodeSync(SelectionEvidenceRequestSchema)({ purpose: 'CART_VALIDATION', selection });
      const ownerEvidence = Schema.decodeSync(CatalogSelectionInjectedOwnerEvidenceSchema)({
        evidenceId: 'cart-selection-evidence-v1',
        observedAt: '2026-09-27T10:00:00.000Z',
        owner: 'CART',
        ownerRevision: {
          moduleId: 'commerce.cart',
          resourceId: 'cart-1',
          resourceType: 'commerce.cart.cart',
          revision: 1,
          tenantId,
        },
        purpose: 'CART_VALIDATION',
        selection,
      });
      let receivedOwnerEvidence: CatalogSelectionInjectedOwnerEvidence | undefined;
      const services: SelectionEvidenceServices = {
        assess: (_input, evidence) => {
          receivedOwnerEvidence = evidence;
          return Effect.succeed(unavailableResponse);
        },
        readCartEvidence: () => Effect.succeed(ownerEvidence),
      };

      const result = yield* readSelectionEvidence(request, tenantId, services);

      expect(result).toEqual(unavailableResponse);
      expect(receivedOwnerEvidence).toEqual(ownerEvidence);
    }),
  );
});
