import { CatalogSelectionSchema } from '@app/catalog/domain/catalog-selection-evidence';
import { CatalogSelectionOwnerAssessmentResultSchema } from '@app/catalog/domain/catalog-selection-owner-contract';
import { Effect, Redacted, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { makeCatalogSelectionGatewayCredentialIssuer } from '../../api/catalog-selection-gateway-credential.ts';
import { CatalogSelectionGatewayCredentialService } from '../../shared/domain/catalog-selection-gateway-credential.ts';
import { catalogSelectionAssessmentPortFromEnvironment } from '../../src/integrations/catalog-selection-evidence.ts';

const tenantId = '22222222-2222-4222-8222-222222222222';
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

const gateway = {
  issue: () =>
    Effect.succeed({
      baseUrl: new URL('https://catalog.example.test'),
      credential: Redacted.make('Bearer catalog-owner-assertion'),
    }),
};

describe('Pricing Catalog selection evidence integration', () => {
  it.effect('sends only the exact selection with PRICING purpose through the generated Catalog client seam', () =>
    Effect.gen(function* assessExactTarget() {
      const requests: unknown[] = [];
      const port = yield* catalogSelectionAssessmentPortFromEnvironment(
        { legalEntityId, requestCorrelation: 'define-price-correlation' },
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
          options: { baseUrl: new URL('https://catalog.example.test') },
          payload: { purpose: 'PRICING', selection },
          requestCorrelation: 'define-price-correlation',
        },
      ]);
    }).pipe(Effect.provideService(CatalogSelectionGatewayCredentialService, gateway)),
  );

  it.effect('rejects a Catalog response that does not attest the requested exact selection', () =>
    Effect.gen(function* rejectSubstitutedTarget() {
      const port = yield* catalogSelectionAssessmentPortFromEnvironment(
        { legalEntityId, requestCorrelation: 'define-price-correlation' },
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
    }).pipe(Effect.provideService(CatalogSelectionGatewayCredentialService, gateway)),
  );

  it.effect('issues a fresh Legal-Entity-bound catalog assertion and returns the Catalog service URL', () =>
    Effect.gen(function* issueCatalogAssertion() {
      const requests: unknown[] = [];
      const issuer = makeCatalogSelectionGatewayCredentialIssuer(
        {
          apiKey: Redacted.make('pricing-service-key'),
          catalogBaseUrl: new URL('https://catalog.example.test'),
          shellBaseUrl: new URL('https://shell.example.test'),
        },
        (payload, options) =>
          Effect.sync(() => {
            requests.push({ options, payload });
            return { expiresAt: 1_700_000_300, token: 'catalog-owner-assertion' };
          }),
      );

      const connection = yield* issuer.issue({
        audience: 'catalog',
        legalEntityId,
        requestCorrelation: 'define-price-correlation',
      });

      expect(connection.baseUrl).toEqual(new URL('https://catalog.example.test'));
      expect(Redacted.value(connection.credential)).toBe('Bearer catalog-owner-assertion');
      expect(requests).toEqual([
        {
          options: {
            apiKey: expect.anything(),
            baseUrl: new URL('https://shell.example.test'),
            requestCorrelation: 'define-price-correlation',
          },
          payload: { audience: 'catalog', legalEntityId },
        },
      ]);
    }),
  );
});
