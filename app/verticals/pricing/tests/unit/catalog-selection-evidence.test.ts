import { CatalogSelectionSchema } from '@app/catalog/domain/catalog-selection-evidence';
import { CatalogSelectionOwnerAssessmentResultSchema } from '@app/catalog/domain/catalog-selection-owner-contract';
import { Effect, Redacted, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { makeCatalogSelectionAssessmentPort } from '../../src/integrations/catalog-selection-evidence.ts';
import type { OwnerGatewayConnectionAcquire } from '../../src/integrations/owner-gateway-connection.ts';
import { ownerConnectionStub, verifiedTestScope } from '../support/owner-gateway-connection.fixture.ts';

const tenantId = '22222222-2222-4222-8222-222222222222';
const compositionRevision = '1'.repeat(64);

const legalEntityId = '33333333-3333-4333-8333-333333333333';
const selection = Schema.decodeSync(CatalogSelectionSchema)({
  productRef: {
    moduleId: 'commerce.catalog',
    resourceId: '55555555-5555-4555-8555-555555555555',
    resourceType: 'commerce.catalog.product',
    tenantId,
  },
  variantRef: {
    moduleId: 'commerce.catalog',
    resourceId: '66666666-6666-4666-8666-666666666666',
    resourceType: 'commerce.catalog.variant',
    tenantId,
  },
});
const assessedAt = '2026-09-27T10:00:00.000Z';
const evidence = Schema.decodeSync(CatalogSelectionOwnerAssessmentResultSchema)({
  assessedAt,
  basis: [
    { role: 'PRODUCT', source: { resourceRef: selection.productRef, revision: 1 } },
    { role: 'VARIANT', source: { resourceRef: selection.variantRef, revision: 1 } },
    {
      role: 'PRODUCT_TYPE',
      source: {
        resourceRef: {
          moduleId: 'commerce.catalog',
          resourceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          resourceType: 'commerce.catalog.product-type',
          tenantId,
        },
        revision: 1,
      },
    },
  ],
  membership: {
    attestationId: 'catalog-membership-v1',
    observedAt: assessedAt,
    productRef: selection.productRef,
    source: 'CATALOG_OWNER_CURRENT_READ',
    variant: { resourceRef: selection.variantRef, revision: 1 },
  },
  purpose: 'PRICING',
  selection,
  status: 'VALID',
});

const principalId = '44444444-4444-4444-8444-444444444444';
const catalogOwner = ownerConnectionStub('Bearer catalog-owner-assertion', 'https://catalog.example.test');

/** Builds the port from a provenance-bearing verified scope, the way the receiving request does. */
const portFromEnvironment = (
  context: {
    readonly compositionRevision: string;
    readonly legalEntityId: string;
    readonly requestCorrelation: string;
  },
  execute: Parameters<typeof makeCatalogSelectionAssessmentPort>[0]['execute'],
  acquire: OwnerGatewayConnectionAcquire = catalogOwner,
) =>
  Effect.succeed(
    makeCatalogSelectionAssessmentPort({
      acquire,
      context: {
        ...context,
        scope: verifiedTestScope({
          correlationId: context.requestCorrelation,
          legalEntityId: context.legalEntityId,
          principalId,
          tenantId,
        }),
      },
      execute,
    }),
  );

describe('Pricing Catalog selection evidence integration', () => {
  it.effect('sends only the exact selection with PRICING purpose through the generated Catalog client seam', () =>
    Effect.gen(function* assessExactTarget() {
      const requests: unknown[] = [];
      const port = yield* portFromEnvironment(
        { compositionRevision, legalEntityId, requestCorrelation: 'define-price-correlation' },
        (payload, credential, requestCorrelation, options) =>
          Effect.sync(() => {
            requests.push({ credential: Redacted.value(credential), options, payload, requestCorrelation });
            return { evidence, missingRoles: [] };
          }),
      );

      const result = yield* port.assess(selection);

      expect(result).toEqual(evidence);
      expect(requests).toEqual([
        {
          credential: 'Bearer catalog-owner-assertion',
          options: { baseUrl: new URL('https://catalog.example.test'), compositionRevision },
          payload: { purpose: 'PRICING', selection },
          requestCorrelation: 'define-price-correlation',
        },
      ]);
    }),
  );

  it.effect('rejects a Catalog response that does not attest the requested exact selection', () =>
    Effect.gen(function* rejectSubstitutedTarget() {
      const port = yield* portFromEnvironment(
        { compositionRevision, legalEntityId, requestCorrelation: 'define-price-correlation' },
        () =>
          Effect.succeed({
            evidence: {
              kind: 'NOT_FOUND' as const,
              requested: { ...selection, variantRef: { ...selection.variantRef, resourceId: 'foreign-variant' } },
            },
            missingRoles: [],
          }),
      );

      const failure = yield* port.assess(selection).pipe(Effect.flip);
      expect(failure).toMatchObject({ code: 'pricing_catalog_selection_unavailable', retryable: true });
    }),
  );
});
