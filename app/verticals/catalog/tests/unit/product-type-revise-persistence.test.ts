import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { ReviseProductTypePayloadSchema } from '../../shared/actions/revise-product-type.ts';
import { CatalogRevisionNumberSchema } from '../../shared/domain/catalog-revision-reference.ts';
import {
  canonicalProductTypeRevision,
  ProductTypeImpactBasisUnavailable,
  productTypeRevisePersistenceForScope,
} from '../../src/persistence/product-type-revise-persistence.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const productTypeRef = {
  moduleId: 'commerce.catalog',
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'commerce.catalog.product-type',
  tenantId,
} as const;
const firstDefinitionRef = {
  moduleId: 'commerce.catalog',
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.catalog.attribute-definition',
  tenantId,
} as const;
const secondDefinitionRef = {
  ...firstDefinitionRef,
  resourceId: '44444444-4444-4444-8444-444444444444',
} as const;
const payload = Schema.decodeUnknownSync(ReviseProductTypePayloadSchema)({
  effectiveFrom: '2026-09-17T10:00:00.000Z',
  expectedCurrentRevision: 1,
  impactBasisToken: 'a'.repeat(64),
  productTypeRef,
  proposedRules: [
    { attributeDefinitionRef: secondDefinitionRef, level: 'VARIANT', required: false },
    { attributeDefinitionRef: firstDefinitionRef, level: 'PRODUCT', required: true },
  ],
  unresolvedProductRefs: [],
});
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:product-type-revision-test:run:1',
    authMethod: 'system',
    principalId: '55555555-5555-4555-8555-555555555555',
    tenantId,
  }),
  correlationId: 'product-type-revision-test',
};

describe('Product Type revision persistence boundary', () => {
  it('canonicalizes the exact owner-qualified rules without classification stand-ins', () => {
    const revision = Schema.decodeUnknownSync(CatalogRevisionNumberSchema)(2);
    const meaning = canonicalProductTypeRevision(productTypeRef, revision, payload.proposedRules);
    expect(meaning).toMatchObject({ productTypeRef, revision: 2 });
    expect(
      meaning.rules.map(({ attributeDefinitionRef, level }) => `${level}:${attributeDefinitionRef.resourceId}`),
    ).toEqual([`PRODUCT:${firstDefinitionRef.resourceId}`, `VARIANT:${secondDefinitionRef.resourceId}`]);
    expect(payload.proposedRules[0]?.attributeDefinitionRef).toEqual(secondDefinitionRef);
  });

  it.effect('fails closed before any database read when the Cart owner population port is absent', () =>
    Effect.gen(function* absentOwnerPopulation() {
      // @ts-expect-error The port check precedes every scoped transaction operation.
      const persistence = yield* productTypeRevisePersistenceForScope({}, scope);
      const failure = yield* Effect.flip(
        persistence.revise({
          actionInvocationId: '66666666-6666-4666-8666-666666666666',
          effectiveFrom: payload.effectiveFrom,
          expectedCurrentRevision: payload.expectedCurrentRevision,
          impactBasisToken: payload.impactBasisToken,
          principalId: scope.principalId,
          productTypeRef,
          proposedRules: payload.proposedRules,
          unresolvedProductRefs: [],
        }),
      );
      expect(failure).toBeInstanceOf(ProductTypeImpactBasisUnavailable);
      expect(failure).toMatchObject({
        code: 'product_type_impact_basis_unavailable',
        reason: 'Authoritative open-selection reader is required',
      });
    }),
  );
});
