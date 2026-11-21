import { CatalogSelectionSchema } from '@app/catalog-selection-contracts/catalog-selection';
import { CatalogSelectionOwnerAssessmentResultSchema } from '@app/catalog/domain/catalog-selection-owner-contract';
import { Effect, Redacted, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { makeCatalogSelectionAssessmentPort } from '../../src/integrations/catalog-selection-evidence.ts';
import type { PricingCatalogSelectionPurpose } from '../../src/integrations/catalog-selection-evidence.ts';
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

/** The membership-only answer a source-asserted Price receives: Product and Variant, no Product Type proof. */
const priceSourceEvidence = Schema.decodeSync(CatalogSelectionOwnerAssessmentResultSchema)({
  assessedAt,
  basis: [
    { role: 'PRODUCT', source: { resourceRef: selection.productRef, revision: 1 } },
    { role: 'VARIANT', source: { resourceRef: selection.variantRef, revision: 1 } },
  ],
  membership: {
    attestationId: 'catalog-membership-v1',
    observedAt: assessedAt,
    productRef: selection.productRef,
    source: 'CATALOG_OWNER_CURRENT_READ',
    variant: { resourceRef: selection.variantRef, revision: 1 },
  },
  purpose: 'PRICE_SOURCE_ASSERTION',
  selection,
  status: 'VALID',
});

/** A selection that pins a configuration as well: the price source question does not answer it. */
const configured = Schema.decodeSync(CatalogSelectionSchema)({
  ...selection,
  configuration: {
    choices: [{ choiceKey: 'packaging', value: 'standard' }],
    definition: {
      resourceRef: {
        moduleId: 'commerce.catalog',
        resourceId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        resourceType: 'commerce.catalog.configuration-definition',
        tenantId,
      },
      revision: 1,
    },
    productRef: selection.productRef,
    variantRef: selection.variantRef,
  },
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
  purpose: PricingCatalogSelectionPurpose = 'PRICING',
) =>
  Effect.succeed(
    makeCatalogSelectionAssessmentPort({
      acquire,
      context: {
        ...context,
        operationRequirementKey: 'commerce.pricing.requirement.define-price-catalog',
        purpose,
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
      const acquisitions: Parameters<OwnerGatewayConnectionAcquire>[0][] = [];
      const port = yield* portFromEnvironment(
        { compositionRevision, legalEntityId, requestCorrelation: 'define-price-correlation' },
        (payload, credential, requestCorrelation, options) =>
          Effect.sync(() => {
            requests.push({ credential: Redacted.value(credential), options, payload, requestCorrelation });
            return { evidence, missingRoles: [] };
          }),
        (input) => {
          acquisitions.push(input);
          return catalogOwner(input);
        },
      );

      const result = yield* port.assess(selection);

      expect(result).toEqual(evidence);
      expect(acquisitions[0]?.conditionalRead).toEqual({
        input: { purpose: 'PRICING', selection },
        kind: 'CATALOG_SELECTION',
        operationRequirementKey: 'commerce.pricing.requirement.define-price-catalog',
      });
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

  it.effect('asks the membership-only price source question and accepts its answer without a type proof', () =>
    Effect.gen(function* assessPriceSource() {
      const requests: unknown[] = [];
      const acquisitions: Parameters<OwnerGatewayConnectionAcquire>[0][] = [];
      const port = yield* portFromEnvironment(
        { compositionRevision, legalEntityId, requestCorrelation: 'define-price-correlation' },
        (payload) =>
          Effect.sync(() => {
            requests.push(payload);
            return { evidence: priceSourceEvidence, missingRoles: [] };
          }),
        (input) => {
          acquisitions.push(input);
          return catalogOwner(input);
        },
        'PRICE_SOURCE_ASSERTION',
      );

      expect(yield* port.assess(selection)).toEqual(priceSourceEvidence);
      expect(acquisitions[0]?.conditionalRead?.input).toEqual({ purpose: 'PRICE_SOURCE_ASSERTION', selection });
      expect(requests).toEqual([{ purpose: 'PRICE_SOURCE_ASSERTION', selection }]);
    }),
  );

  it.effect('asks the PRICING question for a selection that pins a configuration', () =>
    Effect.gen(function* assessConfiguredPriceSource() {
      const requests: unknown[] = [];
      const acquisitions: Parameters<OwnerGatewayConnectionAcquire>[0][] = [];
      const port = yield* portFromEnvironment(
        { compositionRevision, legalEntityId, requestCorrelation: 'define-price-correlation' },
        (payload) =>
          Effect.sync(() => {
            requests.push(payload);
            return { evidence: { kind: 'NOT_FOUND' as const, requested: configured }, missingRoles: [] };
          }),
        (input) => {
          acquisitions.push(input);
          return catalogOwner(input);
        },
        'PRICE_SOURCE_ASSERTION',
      );

      expect(yield* port.assess(configured)).toEqual({ kind: 'NOT_FOUND', requested: configured });
      expect(acquisitions[0]?.conditionalRead?.input).toEqual({ purpose: 'PRICING', selection: configured });
      expect(requests).toEqual([{ purpose: 'PRICING', selection: configured }]);
    }),
  );

  it.effect('refuses a PRICING answer to the price source question', () =>
    Effect.gen(function* rejectOtherPurpose() {
      const port = yield* portFromEnvironment(
        { compositionRevision, legalEntityId, requestCorrelation: 'define-price-correlation' },
        () => Effect.succeed({ evidence, missingRoles: [] }),
        catalogOwner,
        'PRICE_SOURCE_ASSERTION',
      );

      const failure = yield* port.assess(selection).pipe(Effect.flip);
      expect(failure).toMatchObject({ code: 'pricing_catalog_selection_unavailable', retryable: true });
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
