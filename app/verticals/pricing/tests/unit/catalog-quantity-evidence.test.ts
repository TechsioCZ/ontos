import { CatalogQuantityHandoffReadySchema } from '@app/catalog/domain/catalog-quantity-handoff';
import type { CatalogQuantityHandoff } from '@app/catalog/domain/catalog-quantity-handoff';
import { CatalogSelectionSchema } from '@app/catalog/domain/catalog-selection-evidence';
import { Effect, Redacted, Schema } from 'effect';
import { HttpClientError, HttpClientRequest } from 'effect/unstable/http';
import { describe, expect, it } from 'effect-rstest';

import type { executeQuantityBasisCompatibilityWithAuthorization } from '@app/catalog/api/quantity-basis-compatibility-client';

import { CatalogSelectionGatewayCredentialService } from '../../shared/domain/catalog-selection-gateway-credential.ts';
import { catalogQuantityBasisCompatibilityPortFromEnvironment } from '../../src/integrations/catalog-quantity-basis-compatibility.ts';
import { catalogQuantityEvidencePortFromEnvironment } from '../../src/integrations/catalog-quantity-evidence.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const otherTenantId = '11111111-1111-4111-8111-111111111199';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.catalog.product',
  tenantId,
} as const;
const variantRef = {
  moduleId: 'commerce.catalog',
  resourceId: '44444444-4444-4444-8444-444444444444',
  resourceType: 'commerce.catalog.variant',
  tenantId,
} as const;
const unitRef = {
  moduleId: 'commerce.catalog',
  resourceId: '55555555-5555-4555-8555-555555555555',
  resourceType: 'commerce.catalog.product-unit',
  tenantId,
} as const;
const categoryRef = {
  moduleId: 'commerce.catalog',
  resourceId: '66666666-6666-4666-8666-666666666666',
  resourceType: 'commerce.catalog.product-category',
  tenantId,
} as const;
const packageRef = {
  moduleId: 'commerce.catalog',
  resourceId: '77777777-7777-4777-8777-777777777777',
  resourceType: 'commerce.catalog.package-definition',
  tenantId,
} as const;
const otherProductUnitRef = {
  moduleId: 'commerce.catalog',
  resourceId: '88888888-8888-4888-8888-888888888888',
  resourceType: 'commerce.catalog.product-unit',
  tenantId,
} as const;
const physicalUnitRef = {
  moduleId: 'commerce.catalog',
  resourceId: '99999999-9999-4999-8999-999999999999',
  resourceType: 'commerce.catalog.unit',
  tenantId,
} as const;
const otherPhysicalUnitRef = {
  moduleId: 'commerce.catalog',
  resourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  resourceType: 'commerce.catalog.unit',
  tenantId,
} as const;
const unrelatedPhysicalUnitRef = {
  moduleId: 'commerce.catalog',
  resourceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  resourceType: 'commerce.catalog.unit',
  tenantId,
} as const;
const selection = Schema.decodeSync(CatalogSelectionSchema)({ productRef, variantRef });
const packageSelection = Schema.decodeSync(CatalogSelectionSchema)({
  packageOption: {
    contentRevision: { resourceRef: packageRef, revision: 10 },
    optionRef: packageRef,
  },
  productRef,
  variantRef,
});
const observedAt = '2026-09-27T12:00:00.000Z';
const nextBoundary = '2026-09-28T00:00:00.000Z';
const ownerRevision = 'commerce.catalog.quantity:revision-7';

const ready = Schema.decodeSync(CatalogQuantityHandoffReadySchema)({
  completeness: {
    nextApplicabilityBoundary: nextBoundary,
    observedAt,
    ownerRevision,
    scope: {
      kind: 'EXACT_PREDICATE',
      predicateRef: 'commerce.catalog.quantity-preparation:exact-selection:2',
    },
  },
  divisible: true,
  equivalentSelectionKey: 'commerce.catalog.selection:exact-selection',
  evidence: {
    assessedAt: observedAt,
    basis: [
      { role: 'PRODUCT', source: { resourceRef: productRef, revision: 2 } },
      { role: 'VARIANT', source: { resourceRef: variantRef, revision: 3 } },
      {
        provenance: 'CATALOG_OWNER_CONFIRMED_UNTYPED_DECISION',
        role: 'PRODUCT_TYPE_UNTYPED_DECISION',
        source: { resourceRef: productRef, revision: 2 },
      },
      { role: 'CATEGORY', source: { resourceRef: categoryRef, revision: 4 } },
      { role: 'UNIT_RULE', source: { resourceRef: unitRef, revision: 7 } },
      { role: 'UNIT_TARGET_DIVISIBILITY', source: { resourceRef: variantRef, revision: 5 } },
    ],
    membership: {
      attestationId: 'catalog-membership-3',
      observedAt,
      productRef,
      source: 'CATALOG_OWNER_CURRENT_READ',
      variant: { resourceRef: variantRef, revision: 3 },
    },
    purpose: 'PRICING',
    selection,
    status: 'VALID',
    validUntil: nextBoundary,
  },
  hierarchyRevision: 'commerce.catalog.hierarchy:revision-5',
  ownerRevision,
  quantity: {
    changed: false,
    notice: null,
    requested: '2',
    resulting: '2',
    rounding: 'UP',
    status: 'VALID',
    step: '1',
    targetId: variantRef.resourceId,
    tenantId,
    unitId: unitRef.resourceId,
    unitRuleRevision: 7,
  },
  quantityBasis: {
    targetDivisibilityRevision: 5,
    targetRef: variantRef,
    unitRef,
    unitRuleRevision: 7,
  },
  selection,
  status: 'READY',
  unitRef,
});
const packageReady = Schema.decodeSync(CatalogQuantityHandoffReadySchema)({
  ...ready,
  evidence: {
    ...ready.evidence,
    basis: [
      ...ready.evidence.basis,
      {
        role: 'PACKAGE_CONTENT',
        source: { resourceRef: packageRef, revision: 10 },
      },
      {
        role: 'UNIT_TARGET_DIVISIBILITY',
        source: { resourceRef: packageRef, revision: 6 },
      },
    ],
    selection: packageSelection,
  },
  packageContent: {
    amount: '20',
    path: [{ resourceRef: packageRef, revision: 10 }],
    status: 'VALID',
    unitRef,
  },
  packageRevision: {
    amount: '10',
    form: { productRef, variantRef },
    reference: { resourceRef: packageRef, revision: 10 },
    unitRef,
  },
  quantity: { ...ready.quantity, targetId: packageRef.resourceId },
  quantityBasis: {
    ...ready.quantityBasis,
    targetDivisibilityRevision: 6,
    targetRef: packageRef,
  },
  selection: packageSelection,
});
const compatibilityRequest = {
  effectiveAt: observedAt,
  handoff: ready,
  price: { quantity: '2', quantityBasis: ready.quantityBasis },
};
const compatibilityEvidence = {
  completeness: ready.completeness,
  currentness: {
    observedAt: ready.evidence.assessedAt,
    ownerRevision: ready.ownerRevision,
    status: 'CURRENT',
    validUntil: ready.evidence.validUntil,
  },
  currentnessEvidence: {
    effectiveAt: observedAt,
    generation: ownerRevision,
    observedAt: ready.evidence.assessedAt,
    predicateRef: ready.completeness.scope.predicateRef,
    revalidatedAt: ready.evidence.assessedAt,
    validUntil: ready.evidence.validUntil,
    verificationMode: 'OWNER_CURRENT_QUANTITY_REVALIDATED',
  },
  effectiveAt: observedAt,
  equivalentSelectionKey: ready.equivalentSelectionKey,
  generation: ownerRevision,
  hierarchyRevision: ready.hierarchyRevision,
  observedAt: ready.evidence.assessedAt,
  ownerModuleId: 'commerce.catalog',
  ownerRevision: ready.ownerRevision,
  requestedOwnerRevision: ready.ownerRevision,
  requestedQuantity: ready.quantity.requested,
  requestedQuantityBasis: ready.quantityBasis,
  requestedUnitRef: ready.unitRef,
  selection: ready.selection,
  source: 'CATALOG_OWNER_CURRENT_READ',
  verificationReceipt: {
    generation: ownerRevision,
    issuedAt: ready.evidence.assessedAt,
    ownerModuleId: 'commerce.catalog',
    ownerRevision,
    predicate: {
      effectiveAt: observedAt,
      price: compatibilityRequest.price,
      requestedQuantity: ready.quantity.requested,
      requestedQuantityBasis: ready.quantityBasis,
      requestedUnitRef: ready.unitRef,
      selection: ready.selection,
    },
    predicateRef: ready.completeness.scope.predicateRef,
    verificationRef: 'commerce.catalog.quantity-basis-verification:revision-7',
  },
} as const;
const noConversionResponse = {
  ...compatibilityEvidence,
  endpoints: {
    price: compatibilityRequest.price,
    purchase: { quantity: ready.quantity.resulting, quantityBasis: ready.quantityBasis },
    requested: { quantity: ready.quantity.requested, quantityBasis: ready.quantityBasis },
  },
  outcome: 'NO_CONVERSION_REQUIRED',
} as const;

const gateway = {
  issue: () =>
    Effect.succeed({
      baseUrl: new URL('https://catalog.example.test'),
      credential: Redacted.make('Bearer catalog-owner-assertion'),
    }),
};

describe('Pricing Catalog Quantity evidence adapter', () => {
  it.effect('uses the generated Catalog client seam and preserves exact owner Quantity evidence', () =>
    Effect.gen(function* exactEvidence() {
      const calls: unknown[] = [];
      const port = yield* catalogQuantityEvidencePortFromEnvironment(
        { legalEntityId, requestCorrelation: 'pricing-quantity-evidence', tenantId },
        (payload, credential, requestCorrelation, options) =>
          Effect.sync(() => {
            calls.push({ credential: Redacted.value(credential), options, payload, requestCorrelation });
            return ready;
          }),
      );

      const result = yield* port.assess({ amount: '2', selection });

      expect(result).toEqual(ready);
      expect(result).toMatchObject({
        evidence: { assessedAt: observedAt, purpose: 'PRICING' },
        ownerRevision,
        quantity: { requested: '2', resulting: '2', unitRuleRevision: 7 },
        quantityBasis: { targetDivisibilityRevision: 5, unitRuleRevision: 7 },
        status: 'READY',
      });
      expect(calls).toEqual([
        {
          credential: 'Bearer catalog-owner-assertion',
          options: { baseUrl: new URL('https://catalog.example.test') },
          payload: { amount: '2', purpose: 'PRICING', selection },
          requestCorrelation: 'pricing-quantity-evidence',
        },
      ]);
      expect(calls[0]).not.toHaveProperty('storefrontId');
      expect(calls[0]).not.toHaveProperty('currency');
    }).pipe(Effect.provideService(CatalogSelectionGatewayCredentialService, gateway)),
  );

  it.effect('preserves Catalog INVALID, UNVERIFIABLE, and STALE decisions without replacing them', () =>
    Effect.gen(function* preserveOwnerDecision() {
      for (const ownerResponse of [
        { reason: 'Quantity is not allowed', status: 'INVALID' },
        { reason: 'Exact Package revision cannot be verified', status: 'UNVERIFIABLE' },
        { reason: 'Unit rule changed during preparation', status: 'STALE' },
      ] as const satisfies readonly CatalogQuantityHandoff[]) {
        const port = yield* catalogQuantityEvidencePortFromEnvironment(
          { legalEntityId, requestCorrelation: 'pricing-quantity-evidence', tenantId },
          () => Effect.succeed(ownerResponse),
        );
        expect(yield* port.assess({ amount: '2', selection })).toEqual(ownerResponse);
      }
    }).pipe(Effect.provideService(CatalogSelectionGatewayCredentialService, gateway)),
  );

  it.effect('preserves a pinned Package Content conversion instead of consulting a newer Current revision', () =>
    Effect.gen(function* preservePinnedPackage() {
      const port = yield* catalogQuantityEvidencePortFromEnvironment(
        { legalEntityId, requestCorrelation: 'pricing-package-evidence', tenantId },
        () => Effect.succeed(packageReady),
      );

      const result = yield* port.assess({ amount: '2', selection: packageSelection });

      expect(result).toEqual(packageReady);
      expect(result).toMatchObject({
        packageContent: { amount: '20', path: [{ revision: 10 }] },
        packageRevision: { amount: '10', reference: { revision: 10 } },
        quantity: { requested: '2', resulting: '2' },
        status: 'READY',
      });
    }).pipe(Effect.provideService(CatalogSelectionGatewayCredentialService, gateway)),
  );

  it.effect('rejects a cross-Tenant selection before credential issuance or owner execution', () => {
    let credentialCalls = 0;
    let ownerCalls = 0;
    const foreignSelection = Schema.decodeSync(CatalogSelectionSchema)({
      productRef: { ...productRef, tenantId: otherTenantId },
      variantRef: { ...variantRef, tenantId: otherTenantId },
    });
    return Effect.gen(function* rejectCrossTenant() {
      const port = yield* catalogQuantityEvidencePortFromEnvironment(
        { legalEntityId, requestCorrelation: 'pricing-quantity-evidence', tenantId },
        () => {
          ownerCalls += 1;
          return Effect.succeed(ready);
        },
      );

      expect(yield* port.assess({ amount: '2', selection: foreignSelection })).toMatchObject({ status: 'INVALID' });
      expect(credentialCalls).toBe(0);
      expect(ownerCalls).toBe(0);
    }).pipe(
      Effect.provideService(CatalogSelectionGatewayCredentialService, {
        issue: () => {
          credentialCalls += 1;
          return Effect.die('must not issue a credential');
        },
      }),
    );
  });

  it.effect('fails closed when owner evidence does not bind exact request or Current facts', () =>
    Effect.gen(function* rejectUnverifiableEvidence() {
      for (const ownerResponse of [
        { ...ready, quantity: { ...ready.quantity, requested: '3' } },
        {
          ...ready,
          completeness: { ...ready.completeness, ownerRevision: 'commerce.catalog.quantity:other-revision' },
        },
        {
          ...ready,
          evidence: {
            ...ready.evidence,
            basis: ready.evidence.basis.filter(({ role }) => role !== 'CATEGORY'),
          },
        },
      ]) {
        const port = yield* catalogQuantityEvidencePortFromEnvironment(
          { legalEntityId, requestCorrelation: 'pricing-quantity-evidence', tenantId },
          () => Effect.succeed(ownerResponse),
        );
        expect(yield* port.assess({ amount: '2', selection })).toMatchObject({ status: 'UNVERIFIABLE' });
      }
    }).pipe(Effect.provideService(CatalogSelectionGatewayCredentialService, gateway)),
  );

  it.effect('fails retryably when no server-owned Catalog credential is configured', () =>
    Effect.gen(function* missingCredential() {
      const port = yield* catalogQuantityEvidencePortFromEnvironment({
        legalEntityId,
        requestCorrelation: 'pricing-quantity-evidence',
        tenantId,
      });
      const failure = yield* port.assess({ amount: '2', selection }).pipe(Effect.flip);
      expect(failure).toMatchObject({ code: 'pricing_catalog_selection_unavailable', retryable: true });
    }),
  );
});

describe('Pricing Catalog Quantity-basis compatibility adapter', () => {
  it.effect('calls the generated owner API and preserves exact no-conversion evidence', () =>
    Effect.gen(function* assessCompatibleBasis() {
      const calls: unknown[] = [];
      const port = yield* catalogQuantityBasisCompatibilityPortFromEnvironment(
        { legalEntityId, requestCorrelation: 'pricing-basis-compatibility', tenantId },
        (payload, credential, requestCorrelation, options) =>
          Effect.sync(() => {
            calls.push({ credential: Redacted.value(credential), options, payload, requestCorrelation });
            return noConversionResponse;
          }),
      );

      const result = yield* port.assess(compatibilityRequest);

      expect(result).toMatchObject({
        completeness: ready.completeness,
        endpoints: noConversionResponse.endpoints,
        observedAt: ready.evidence.assessedAt,
        outcome: 'NO_CONVERSION_REQUIRED',
        ownerRevision: ready.ownerRevision,
        selection: ready.selection,
      });
      expect(calls).toEqual([
        {
          credential: 'Bearer catalog-owner-assertion',
          options: { baseUrl: new URL('https://catalog.example.test') },
          payload: compatibilityRequest,
          requestCorrelation: 'pricing-basis-compatibility',
        },
      ]);
      expect(calls[0]).not.toHaveProperty('storefrontId');
      expect(calls[0]).not.toHaveProperty('currency');
    }).pipe(Effect.provideService(CatalogSelectionGatewayCredentialService, gateway)),
  );

  it.effect('accepts numerically equal decimal quantities without rewriting owner lexical evidence', () =>
    Effect.gen(function* acceptEquivalentDecimals() {
      const ownerResponse = {
        ...noConversionResponse,
        endpoints: {
          price: { ...noConversionResponse.endpoints.price, quantity: '2.0' },
          purchase: { ...noConversionResponse.endpoints.purchase, quantity: '2.00' },
          requested: { ...noConversionResponse.endpoints.requested, quantity: '2.000' },
        },
      };
      const port = yield* catalogQuantityBasisCompatibilityPortFromEnvironment(
        { legalEntityId, requestCorrelation: 'pricing-basis-compatibility', tenantId },
        () => Effect.succeed(ownerResponse),
      );

      const result = yield* port.assess(compatibilityRequest);
      expect(result).toMatchObject({ endpoints: ownerResponse.endpoints, outcome: 'NO_CONVERSION_REQUIRED' });
    }).pipe(Effect.provideService(CatalogSelectionGatewayCredentialService, gateway)),
  );

  it.effect('accepts a later truthful Current observation bound to the same effective instant and exact basis', () =>
    Effect.gen(function* acceptLaterObservation() {
      const laterObservedAt = '2026-09-27T12:00:05.000Z';
      const laterOwnerRevision = 'commerce.catalog.quantity:revision-8';
      const ownerResponse = {
        ...noConversionResponse,
        completeness: {
          ...noConversionResponse.completeness,
          observedAt: laterObservedAt,
          ownerRevision: laterOwnerRevision,
        },
        currentness: {
          ...noConversionResponse.currentness,
          observedAt: laterObservedAt,
          ownerRevision: laterOwnerRevision,
        },
        currentnessEvidence: {
          ...noConversionResponse.currentnessEvidence,
          generation: laterOwnerRevision,
          observedAt: laterObservedAt,
          revalidatedAt: laterObservedAt,
        },
        generation: laterOwnerRevision,
        observedAt: laterObservedAt,
        ownerRevision: laterOwnerRevision,
        verificationReceipt: {
          ...noConversionResponse.verificationReceipt,
          generation: laterOwnerRevision,
          issuedAt: laterObservedAt,
          ownerRevision: laterOwnerRevision,
        },
      };
      const port = yield* catalogQuantityBasisCompatibilityPortFromEnvironment(
        { legalEntityId, requestCorrelation: 'pricing-basis-compatibility', tenantId },
        () => Effect.succeed(ownerResponse),
      );

      expect(yield* port.assess(compatibilityRequest)).toMatchObject({
        effectiveAt: observedAt,
        observedAt: laterObservedAt,
        outcome: 'NO_CONVERSION_REQUIRED',
        ownerRevision: laterOwnerRevision,
        requestedOwnerRevision: ready.ownerRevision,
      });
    }).pipe(Effect.provideService(CatalogSelectionGatewayCredentialService, gateway)),
  );

  it.effect('preserves the owner UNVERIFIABLE outcome for a basis without stored conversion evidence', () =>
    Effect.gen(function* preserveUnverifiable() {
      const ownerResponse = {
        ...compatibilityEvidence,
        outcome: 'UNVERIFIABLE' as const,
        reason: 'Catalog has no authoritative stored conversion for the requested Product Unit bases',
      };
      const port = yield* catalogQuantityBasisCompatibilityPortFromEnvironment(
        { legalEntityId, requestCorrelation: 'pricing-basis-compatibility', tenantId },
        () => Effect.succeed(ownerResponse),
      );

      expect(yield* port.assess(compatibilityRequest)).toMatchObject({
        outcome: 'UNVERIFIABLE',
        reason: ownerResponse.reason,
      });
    }).pipe(Effect.provideService(CatalogSelectionGatewayCredentialService, gateway)),
  );

  it.effect('preserves a bound owner UNAVAILABLE decision without relabeling it as owner evidence', () =>
    Effect.gen(function* preserveUnavailable() {
      const ownerResponse = {
        effectiveAt: compatibilityRequest.effectiveAt,
        outcome: 'UNAVAILABLE' as const,
        reason: 'Catalog currentness read is temporarily unavailable',
        retryable: true,
      };
      const port = yield* catalogQuantityBasisCompatibilityPortFromEnvironment(
        { legalEntityId, requestCorrelation: 'pricing-basis-compatibility', tenantId },
        () => Effect.succeed(ownerResponse),
      );

      const result = yield* port.assess(compatibilityRequest);
      expect(result).toEqual({
        effectiveAt: compatibilityRequest.effectiveAt,
        outcome: 'UNAVAILABLE',
        reason: ownerResponse.reason,
        retryable: true,
      });
      expect(result).not.toHaveProperty('currentness');
      expect(result).not.toHaveProperty('completeness');
      expect(result).not.toHaveProperty('observedAt');
      expect(result).not.toHaveProperty('ownerRevision');
    }).pipe(Effect.provideService(CatalogSelectionGatewayCredentialService, gateway)),
  );

  it.effect('fails closed for malformed, foreign, or incoherent owner failure evidence', () =>
    Effect.gen(function* rejectUnboundFailureEvidence() {
      const responses = [
        { outcome: 'UNVERIFIABLE' },
        {
          effectiveAt: '2026-09-27T12:00:00.001Z',
          outcome: 'UNAVAILABLE',
          reason: 'unavailability for a different effective instant',
          retryable: true,
        },
        {
          ...compatibilityEvidence,
          completeness: { ...compatibilityEvidence.completeness, ownerRevision: 'foreign-owner-revision' },
          currentness: { ...compatibilityEvidence.currentness, ownerRevision: 'foreign-owner-revision' },
          outcome: 'UNVERIFIABLE',
          ownerRevision: 'foreign-owner-revision',
          reason: 'foreign evidence',
          requestedOwnerRevision: 'foreign-requested-owner-revision',
        },
        {
          ...compatibilityEvidence,
          currentness: { ...compatibilityEvidence.currentness, status: 'UNAVAILABLE' },
          outcome: 'UNVERIFIABLE',
          reason: 'incoherent currentness',
        },
      ];
      for (const ownerResponse of responses) {
        const port = yield* catalogQuantityBasisCompatibilityPortFromEnvironment(
          { legalEntityId, requestCorrelation: 'pricing-basis-compatibility', tenantId },
          () => Effect.succeed(ownerResponse),
        );
        const failure = yield* port.assess(compatibilityRequest).pipe(Effect.flip);
        expect(failure).toMatchObject({ code: 'pricing_catalog_selection_unavailable', retryable: true });
      }
    }).pipe(Effect.provideService(CatalogSelectionGatewayCredentialService, gateway)),
  );

  it.effect('maps missing server-owned credentials to the typed retryable unavailable error', () =>
    Effect.gen(function* rejectMissingCredential() {
      const port = yield* catalogQuantityBasisCompatibilityPortFromEnvironment({
        legalEntityId,
        requestCorrelation: 'pricing-basis-compatibility',
        tenantId,
      });
      expect(yield* port.assess(compatibilityRequest).pipe(Effect.flip)).toMatchObject({
        code: 'pricing_catalog_selection_unavailable',
        retryable: true,
      });
    }),
  );

  it.effect('maps generated-client failures to the typed retryable unavailable error', () =>
    Effect.gen(function* rejectClientFailure() {
      const request = HttpClientRequest.post('https://catalog.example.test/reads/quantity-basis-compatibility');
      const execute = (): ReturnType<typeof executeQuantityBasisCompatibilityWithAuthorization> =>
        Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              cause: new Error('Catalog transport failed'),
              description: 'transport unavailable',
              request,
            }),
          }),
        );
      const port = yield* catalogQuantityBasisCompatibilityPortFromEnvironment(
        { legalEntityId, requestCorrelation: 'pricing-basis-compatibility', tenantId },
        execute,
      );
      expect(yield* port.assess(compatibilityRequest).pipe(Effect.flip)).toMatchObject({
        code: 'pricing_catalog_selection_unavailable',
        retryable: true,
      });
    }).pipe(Effect.provideService(CatalogSelectionGatewayCredentialService, gateway)),
  );

  it.effect('rejects an owner success that substitutes quantities or basis evidence', () =>
    Effect.gen(function* rejectSubstitutedSuccess() {
      const port = yield* catalogQuantityBasisCompatibilityPortFromEnvironment(
        { legalEntityId, requestCorrelation: 'pricing-basis-compatibility', tenantId },
        () =>
          Effect.succeed({
            ...noConversionResponse,
            endpoints: {
              ...noConversionResponse.endpoints,
              price: { ...noConversionResponse.endpoints.price, quantity: '3' },
            },
          }),
      );

      const failure = yield* port.assess(compatibilityRequest).pipe(Effect.flip);
      expect(failure).toMatchObject({ code: 'pricing_catalog_selection_unavailable', retryable: true });
    }).pipe(Effect.provideService(CatalogSelectionGatewayCredentialService, gateway)),
  );

  it.effect('rejects conversion evidence whose physical Unit revision is unrelated to a Product Unit mapping', () =>
    Effect.gen(function* rejectUnrelatedPhysicalMapping() {
      const priceQuantityBasis = {
        ...ready.quantityBasis,
        unitRef: otherProductUnitRef,
        unitRuleRevision: 8,
      };
      const request = {
        ...compatibilityRequest,
        price: { quantity: '20', quantityBasis: priceQuantityBasis },
      };
      const ownerResponse = {
        ...compatibilityEvidence,
        endpoints: {
          price: request.price,
          purchase: { quantity: '2', quantityBasis: ready.quantityBasis },
          requested: { quantity: '2', quantityBasis: ready.quantityBasis },
        },
        mappings: [
          {
            effectiveAt: observedAt,
            observedAt,
            ownerModuleId: 'commerce.catalog',
            ownerRevision,
            physicalUnitRevision: { resourceRef: physicalUnitRef, revision: 3 },
            productUnitBasis: ready.quantityBasis,
            role: 'PURCHASE',
            source: 'CATALOG_OWNER_CURRENT_READ',
          },
          {
            effectiveAt: observedAt,
            observedAt,
            ownerModuleId: 'commerce.catalog',
            ownerRevision,
            physicalUnitRevision: { resourceRef: otherPhysicalUnitRef, revision: 4 },
            productUnitBasis: priceQuantityBasis,
            role: 'PRICE',
            source: 'CATALOG_OWNER_CURRENT_READ',
          },
        ],
        outcome: 'COMPATIBLE_CONVERSION',
        steps: [
          {
            conversion: {
              denominator: '1',
              evidenceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
              from: { resourceRef: physicalUnitRef, revision: 3 },
              numerator: '10',
              observedAt,
              ownerModuleId: 'commerce.catalog',
              source: 'CATALOG_OWNER_CURRENT_READ',
              to: { resourceRef: unrelatedPhysicalUnitRef, revision: 9 },
            },
            from: 'PURCHASE',
            fromQuantity: '2',
            to: 'PRICE',
            toQuantity: '20',
          },
        ],
      };
      const port = yield* catalogQuantityBasisCompatibilityPortFromEnvironment(
        { legalEntityId, requestCorrelation: 'pricing-basis-compatibility', tenantId },
        () => Effect.succeed(ownerResponse),
      );

      expect(yield* port.assess(request).pipe(Effect.flip)).toMatchObject({
        code: 'pricing_catalog_selection_unavailable',
        retryable: true,
      });
    }).pipe(Effect.provideService(CatalogSelectionGatewayCredentialService, gateway)),
  );

  it.effect('rejects a cross-Tenant compatibility request before credential issuance', () => {
    let credentialCalls = 0;
    const foreignRequest = {
      ...compatibilityRequest,
      handoff: {
        ...compatibilityRequest.handoff,
        selection: {
          ...compatibilityRequest.handoff.selection,
          productRef: { ...productRef, tenantId: otherTenantId },
          variantRef: { ...variantRef, tenantId: otherTenantId },
        },
      },
    };
    return Effect.gen(function* rejectForeignTenant() {
      const port = yield* catalogQuantityBasisCompatibilityPortFromEnvironment(
        { legalEntityId, requestCorrelation: 'pricing-basis-compatibility', tenantId },
        () => Effect.die('must not call Catalog'),
      );
      const failure = yield* port.assess(foreignRequest).pipe(Effect.flip);
      expect(failure).toMatchObject({ code: 'pricing_catalog_selection_unavailable', retryable: true });
      expect(credentialCalls).toBe(0);
    }).pipe(
      Effect.provideService(CatalogSelectionGatewayCredentialService, {
        issue: () => {
          credentialCalls += 1;
          return Effect.die('must not issue a credential');
        },
      }),
    );
  });
});
