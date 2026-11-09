import {
  CatalogSourceProductsForbiddenProblemSchema,
  CatalogSourceProductsResponseSchema,
} from '@app/catalog/api/catalog-source-products';
import {
  CustomerProfileSourceItemSchema,
  CustomerProfileSourceResponseSchema,
} from '@app/commerce-customer-context/api/customer-profile-source';
import type { CustomerProfileSourceResponse } from '@app/commerce-customer-context/api/customer-profile-source';
import { CustomerProfileIcoResponseSchema } from '@app/commerce-customer-context/api/customer-profile-ico';
import {
  OrganizationCustomerProfileIcoResponseSchema,
  OrganizationCustomerProfileIcoForbiddenProblemSchema,
  OrganizationCustomerProfileIcoUnavailableProblemSchema,
} from '@app/commerce-customer-context/api/organization-customer-profile-ico';
import { SourceProfileExportResponseSchema } from '@app/party-registry/apis/source-profile-export';
import {
  OrganizationBusinessNameExportResponseSchema,
  OrganizationBusinessNameExportForbiddenProblemSchema,
  OrganizationBusinessNameExportUnavailableProblemSchema,
} from '@app/party-registry/apis/organization-business-name-export';
import type { OrganizationBusinessNameExportResponse } from '@app/party-registry/apis/organization-business-name-export';
import { PriceGroupDefinitionResponseSchema } from '@app/price-group-catalog/api/client';
import { PriceGroupSourceAssociationsResponseSchema } from '@app/price-group-catalog/apis/price-group-source-associations';
import { GatewayForbiddenProblemSchema } from '@app/shared-contracts';
import { ConfigProvider, Effect, Redacted, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { TestClock } from 'effect/testing';
import { describe, expect, it } from 'effect-rstest';

import { SymmyCustomerIcoProjectionSchema } from '../../shared/symmy/read-projection-contracts.ts';
import { SymmyInternalReadQuerySchema, SymmyUnavailableProblemSchema } from '../../shared/symmy/contract.ts';
import {
  acquireSymmyReadAssertion,
  projectSymmySourceCustomers,
  projectSymmySourcePriceLists,
  projectSymmySourceProducts,
} from '../../api/symmy/source-read-projections.ts';
import type { SymmySourceReadScope } from '../../api/symmy/source-read-projections.ts';
import type { SymmyIngressAdmission } from '../../api/symmy/transport.ts';
import { decodeSymmySourceSelector, verifySymmySourceSelector } from '@app/symmy-integration/symmy-source-selector';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const productId = '33333333-3333-4333-8333-333333333333';
const variantId = '44444444-4444-4444-8444-444444444444';
const partyId = '55555555-5555-4555-8555-555555555555';
const profileId = '66666666-6666-4666-8666-666666666666';
const routeId = '77777777-7777-4777-8777-777777777777';
const groupId = '88888888-8888-4888-8888-888888888888';
const invocationId = '99999999-9999-4999-8999-999999999999';
const at = '1970-01-01T00:00:00.000Z';
const revision = 'a'.repeat(64);
const allowedOwnerOperations = [
  { entrypointKey: 'commerce.catalog.api.catalog-source-products', moduleId: 'commerce.catalog', schemaVersion: '1' },
  {
    entrypointKey: 'commerce.customer-context.api.customer-profile-source',
    moduleId: 'commerce.customer-context',
    schemaVersion: '1',
  },
  {
    entrypointKey: 'commerce.customer-context.api.customer-profile-ico',
    moduleId: 'commerce.customer-context',
    schemaVersion: '1',
  },
  { entrypointKey: 'party.registry.api.source-profile-export', moduleId: 'party.registry', schemaVersion: '1' },
  {
    entrypointKey: 'pricing.price-group-catalog.api.price-group-source-associations',
    moduleId: 'pricing.price-group-catalog',
    schemaVersion: '1',
  },
  {
    entrypointKey: 'pricing.price-group-catalog.api.price-group-definition',
    moduleId: 'pricing.price-group-catalog',
    schemaVersion: '1',
  },
  { entrypointKey: 'commerce.pricing.api.price-group-source-prices', moduleId: 'commerce.pricing', schemaVersion: '1' },
];
const scope: SymmySourceReadScope = {
  allowedOwnerOperations,
  issuerId: 'fixture-issuer-a',
  legalEntityId,
  mappingVersion: 'map-1',
  routeId,
  routeRevision: 'route-1',
  sourceEntityKind: 'CUSTOMER',
  sourceNamespace: 'fixture-records',
  tenantId,
};
const query = Schema.decodeUnknownSync(SymmyInternalReadQuerySchema)({ contractVersion: 'INTERNAL_C14', limit: '1' });
const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: productId,
  resourceType: 'commerce.catalog.product',
  tenantId,
} as const;
const partyRef = {
  moduleId: 'party.registry',
  resourceId: partyId,
  resourceType: 'party.registry.party',
  tenantId,
} as const;
const profileRef = {
  kind: 'RETAIL',
  moduleId: 'commerce.customer-context',
  resourceId: profileId,
  resourceType: 'commerce.customer-context.retail-customer-profile',
  tenantId,
} as const;
const groupRef = {
  moduleId: 'pricing.price-group-catalog',
  resourceId: groupId,
  resourceType: 'pricing.price-group-catalog.price-group',
  tenantId,
} as const;
const partySourceReference = {
  occurrenceId: 'original-party-create-occurrence',
  recordId: 'original-party-person-key',
  source: {
    issuer: 'fixture-issuer-a',
    namespace: 'party-original-namespace',
    recordType: 'PERSON',
    routeRef: 'party-original-route',
  },
};
const customer = Schema.decodeUnknownSync(CustomerProfileSourceItemSchema)({
  partyRef,
  partySourceReference,
  profile: {
    profileRef,
    revision: 1,
    state: 'ACTIVE',
    subject: {
      kind: 'RETAIL',
      partyRef,
      sellingLegalEntityRef: {
        moduleId: 'core.identity',
        resourceId: legalEntityId,
        resourceType: 'core.identity.legal-entity',
        tenantId,
      },
    },
  },
  source: {
    effectId: 'commerce-effect',
    issuer: scope.issuerId,
    mappingRevision: scope.mappingVersion,
    namespace: scope.sourceNamespace,
    occurrenceId: 'latest-commerce-occurrence',
    order: 1,
    recordId: 'customer-record',
    recordType: 'CUSTOMER',
    revision: 'source-r1',
    route: { id: routeId, revision: scope.routeRevision },
  },
});
const customerReceiptMetadata = {
  currentAdmission: {
    outcome: 'SOURCE_PERSON_CURRENT',
    partyRef,
    partyRevision: 1,
    sourceActionInvocationId: '70000000-0000-4000-8000-000000000001',
    sourceDecisionRef: {
      moduleId: 'party.registry',
      resourceId: '70000000-0000-4000-8000-000000000002',
      resourceType: 'party.registry.party-match-decision',
      tenantId,
    },
    sourceReference: partySourceReference,
  },
  receipt: {
    actionInvocationId: '70000000-0000-4000-8000-000000000003',
    actorPrincipalId: '70000000-0000-4000-8000-000000000004',
    intent: {
      effectiveAt: at,
      partySourceReference,
      source: customer.source,
      subject: customer.profile.subject,
      trigger: 'AUTHORIZED_ONBOARDING',
    },
    profileKind: 'RETAIL',
    recordedAt: at,
    result: {
      outcome: 'PROFILE_CREATED',
      profileRef,
      revision: 1,
      sourceEffect: { effectId: customer.source.effectId, replayed: false },
      state: 'ACTIVE',
    },
  },
};
const customerReceiptResponses = [
  Schema.decodeUnknownSync(CustomerProfileSourceResponseSchema)({
    _tag: 'RECEIPT',
    ...customerReceiptMetadata,
    current: customer,
  }),
  Schema.decodeUnknownSync(CustomerProfileSourceResponseSchema)({
    _tag: 'MINIMAL_RECEIPT',
    ...customerReceiptMetadata,
  }),
  Schema.decodeUnknownSync(CustomerProfileSourceResponseSchema)({
    _tag: 'ORG_RECEIPT',
    receipt: {
      actionInvocationId: customerReceiptMetadata.receipt.actionInvocationId,
      intent: {
        ...customerReceiptMetadata.receipt.intent,
        subject: {
          counterpartyRef: {
            moduleId: 'party.registry',
            resourceId: partyId,
            resourceType: 'party.registry.counterparty',
            tenantId,
          },
          kind: 'COUNTERPARTY',
        },
      },
      profileKind: 'COUNTERPARTY',
      recordedAt: at,
      result: {
        ...customerReceiptMetadata.receipt.result,
        profileRef: {
          moduleId: 'commerce.customer-context',
          resourceId: profileId,
          resourceType: 'commerce.customer-context.counterparty-purchasing-profile',
          tenantId,
        },
      },
    },
  }),
];
const companyPartySourceReference = {
  ...partySourceReference,
  occurrenceId: 'original-company-admission',
  recordId: 'original-company-key',
  source: { ...partySourceReference.source, recordType: 'ORGANIZATION' },
};
const companyProfileRef = {
  kind: 'COUNTERPARTY',
  moduleId: 'commerce.customer-context',
  resourceId: profileId,
  resourceType: 'commerce.customer-context.counterparty-purchasing-profile',
  tenantId,
} as const;
const company = Schema.decodeUnknownSync(CustomerProfileSourceItemSchema)({
  ...customer,
  icoAuthority: 'ORGANIZATION',
  partySourceReference: companyPartySourceReference,
  profile: {
    ...customer.profile,
    profileRef: companyProfileRef,
    subject: {
      counterpartyRef: {
        moduleId: 'party.registry',
        resourceId: partyId,
        resourceType: 'party.registry.counterparty',
        tenantId,
      },
      kind: 'COUNTERPARTY',
    },
  },
});
const orgIcoRead = 'commerce.customer-context.api.organization-customer-profile-ico';
const personalIcoRead = 'commerce.customer-context.api.customer-profile-ico';
const companyScope = {
  ...scope,
  allowedOwnerOperations: [
    ...scope.allowedOwnerOperations.filter(
      ({ entrypointKey }) => entrypointKey !== 'party.registry.api.source-profile-export',
    ),
    { entrypointKey: orgIcoRead, moduleId: 'commerce.customer-context', schemaVersion: '1' },
  ],
};
const orgNameRead = 'party.registry.api.organization-business-name-export';
const personalNameRead = 'party.registry.api.source-profile-export';
const companyNameScope = {
  ...companyScope,
  allowedOwnerOperations: [
    ...companyScope.allowedOwnerOperations,
    { entrypointKey: orgNameRead, moduleId: 'party.registry', schemaVersion: '1' },
    { entrypointKey: personalNameRead, moduleId: 'party.registry', schemaVersion: '1' },
  ],
};
const organizationNameCurrent = Schema.decodeUnknownSync(OrganizationBusinessNameExportResponseSchema)({
  businessName: {
    assertionId: '90000000-0000-4000-8000-000000000003',
    outcome: 'AVAILABLE',
    recordedAt: at,
    validFrom: at,
    value: 'Internal fixture company s.r.o.',
  },
  outcome: 'CURRENT_ORGANIZATION_BUSINESS_NAME',
  partyRef,
  partyRevision: 2,
  sourceCitation: {
    originalOccurrenceId: companyPartySourceReference.occurrenceId,
    sourceActionInvocationId: '90000000-0000-4000-8000-000000000001',
    sourceDecisionRef: {
      moduleId: 'party.registry',
      resourceId: '90000000-0000-4000-8000-000000000002',
      resourceType: 'party.registry.party-match-decision',
      tenantId,
    },
  },
});
const organizationNameReply = (value: OrganizationBusinessNameExportResponse = organizationNameCurrent) =>
  Response.json(Schema.encodeSync(OrganizationBusinessNameExportResponseSchema)(value));
interface FixtureOwnerReplies {
  readonly ico?: Response;
  readonly name?: Response;
}
const organizationCurrentIco = Schema.decodeUnknownSync(
  OrganizationCustomerProfileIcoResponseSchema.members[1].fields.current,
)({
  effectiveAt: at,
  effectiveTo: null,
  isCurrent: true,
  normalizedValue: '27074358',
  normalizerVersion: 'CZ:ICO:party-v1',
  operation: 'SET',
  originalInput: { digits: '27074358', kind: 'KNOWN' },
  partyRef,
  profileRef: companyProfileRef,
  provenance: {
    ownerReceiptRef: { _tag: 'CORE_ACTION_INVOCATION', actionInvocationId: '80000000-0000-4000-8000-000000000001' },
  },
  recordedAt: at,
  revision: 1,
});
const organizationIcoReply = (
  current: (typeof OrganizationCustomerProfileIcoResponseSchema.members)[1]['fields']['current']['Type'] = organizationCurrentIco,
) =>
  Response.json(
    Schema.encodeSync(OrganizationCustomerProfileIcoResponseSchema)(
      Schema.decodeUnknownSync(OrganizationCustomerProfileIcoResponseSchema)({
        _tag: 'PRESENT',
        current,
        history: [current],
        revision: 1,
      }),
    ),
  );
const companyPage = (item: typeof CustomerProfileSourceItemSchema.Type = company) =>
  Schema.decodeUnknownSync(CustomerProfileSourceResponseSchema)({ _tag: 'PAGE', items: [item], nextCursor: null });
const partyExport = Schema.decodeUnknownSync(SourceProfileExportResponseSchema)({
  businessName: null,
  contactPoints: [],
  firstName: 'Petr',
  lastName: null,
  outcome: 'AVAILABLE',
  partyRef,
  partyType: 'PERSON',
  revision: 2,
  unsupported: ['ADDRESSES'],
});
const icoAbsent = Schema.decodeUnknownSync(CustomerProfileIcoResponseSchema)({
  _tag: 'ABSENT',
  current: null,
  history: [],
  profileRef,
  revision: 0,
});
const sourceCorrelation = {
  issuer: scope.issuerId,
  mappingVersion: scope.mappingVersion,
  namespace: scope.sourceNamespace,
  recordKey: 'price-list-record',
  routeId,
};
const provenance = {
  actionInvocationId: invocationId,
  actorPrincipalId: partyId,
  reason: 'Explicit internal fixture acceptance',
  trustedAt: at,
};
const effectivePeriod = { effectiveFrom: at, effectiveTo: null };
const fingerprint = 'b'.repeat(64);
const groupDefinition = Schema.decodeUnknownSync(PriceGroupDefinitionResponseSchema)({
  currentEvidence: {
    catalogRevision: 1,
    definitionEffectivePeriod: effectivePeriod,
    definitionRevisionId: productId,
    definitionRevisionNumber: 1,
    meaningFingerprint: fingerprint,
    observedAt: at,
    priceGroupRef: groupRef,
  },
  definition: {
    acceptedCatalogRevision: 1,
    classificationPurpose: 'Explicit fixture classification',
    compatibilityContracts: [{ contractId: 'symmy.internal.fixture', version: 1 }],
    created: provenance,
    definitionRevisionId: productId,
    description: 'Native owner description',
    displayName: 'Native owner name',
    effectivePeriod,
    meaningFingerprint: fingerprint,
    previousDefinitionRevisionId: null,
    priceGroupRef: groupRef,
    revisionNumber: 1,
    semanticContinuity: null,
  },
  identity: {
    businessCode: 'PG_FIXTURE',
    created: provenance,
    createdAtCatalogRevision: 1,
    lifecycle: { activeFrom: at, retiredAt: null, state: 'ACTIVE' },
    meaningFingerprint: fingerprint,
    priceGroupRef: groupRef,
  },
  observedAt: at,
  selection: 'CURRENT',
});
const FixtureModeSchema = Schema.Literals([
  'current',
  'foreign_product',
  'forbidden',
  'absent_product',
  'foreign_customer',
  'foreign_customer_subject',
  'party_unavailable',
  'empty_groups',
]);
type FixtureMode = typeof FixtureModeSchema.Type;

const fixtureIcoReply = (path: string, response?: Response | FixtureOwnerReplies): Response | undefined => {
  const replies = Schema.is(Schema.instanceOf(Response))(response) ? { ico: response } : response;
  if (path.endsWith('/reads/organization-business-name-export')) {
    return replies?.name?.clone() ?? Response.json({}, { status: 500 });
  }
  if (path.endsWith('/reads/organization-customer-profile-ico')) {
    return replies?.ico?.clone() ?? Response.json({}, { status: 500 });
  }
  if (path.endsWith('/reads/customer-profile-ico')) {
    return replies?.ico?.clone() ?? Response.json(Schema.encodeSync(CustomerProfileIcoResponseSchema)(icoAbsent));
  }
  return undefined;
};
const fixture = (
  mode: FixtureMode = 'current',
  recordKey = sourceCorrelation.recordKey,
  customerResponse?: CustomerProfileSourceResponse,
  icoResponse?: Response | FixtureOwnerReplies,
) => {
  const acquisitions: Parameters<NonNullable<SymmyIngressAdmission['acquireOwnerAssertion']>>[0][] = [];
  const requests: Request[] = [];
  let sequence = 0;
  const admission: SymmyIngressAdmission = {
    acquireOwnerAssertion: (target) => {
      acquisitions.push(target);
      return Effect.succeed({
        apiBaseUrl: `/shell-super-app-api/module-api/${target.audience}/fixture-release/${target.audience}-api`,
        assertion: Redacted.make(`owner-assertion-${acquisitions.length}`),
        compositionRevision: revision,
      });
    },
    apiBaseUrl: '/unused',
    assertion: Redacted.make('ingress-assertion'),
    compositionRevision: revision,
  };
  const newRequestIdentifier = Effect.sync(() => {
    sequence += 1;
    return `owner-request-${sequence}`;
  });
  const fakeFetch: typeof fetch = (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    const { pathname } = new URL(request.url);
    if (pathname.endsWith('/reads/catalog-source-products')) {
      if (mode === 'forbidden') {
        const error = CatalogSourceProductsForbiddenProblemSchema.make({
          detail: 'Owner denied',
          status: CatalogSourceProductsForbiddenProblemSchema.fields.status.literal,
          title: 'Forbidden',
          type: 'https://ontos.dev/problems/catalog-denied',
        });
        return Promise.resolve(
          Response.json(error, { headers: { 'content-type': 'application/problem+json' }, status: 403 }),
        );
      }
      const source = {
        issuerId: mode === 'foreign_product' ? 'foreign-issuer' : scope.issuerId,
        mappingRevision: 'map-1',
        recordId: 'product-record',
        recordNamespace: scope.sourceNamespace,
        routeScope: routeId,
      };
      const decoded = Schema.decodeUnknownSync(CatalogSourceProductsResponseSchema)({
        items:
          mode === 'absent_product'
            ? []
            : [
                {
                  entityKind: 'PRODUCT',
                  originalActionInvocationId: invocationId,
                  product: {
                    catalogReady: false,
                    createdAt: at,
                    lifecycle: 'DRAFT',
                    name: 'Native Product',
                    productRef,
                    revision: 1,
                    updatedAt: at,
                    variants: [
                      {
                        lifecycle: 'WORK_IN_PROGRESS',
                        productRef,
                        variantId,
                        variantRef: {
                          moduleId: 'commerce.catalog',
                          resourceId: variantId,
                          resourceType: 'commerce.catalog.variant',
                          tenantId,
                        },
                      },
                    ],
                  },
                  source,
                  variantId,
                  variantSources: [],
                },
              ],
        outcome: mode === 'absent_product' ? 'NOT_FOUND' : 'FOUND',
      });
      return Promise.resolve(Response.json(Schema.encodeSync(CatalogSourceProductsResponseSchema)(decoded)));
    }
    if (pathname.endsWith('/reads/customer-profile-source')) {
      let item =
        mode === 'foreign_customer'
          ? { ...customer, source: { ...customer.source, issuer: 'foreign-issuer' } }
          : customer;
      if (mode === 'foreign_customer_subject') {
        item = Schema.decodeUnknownSync(CustomerProfileSourceItemSchema)({
          ...customer,
          profile: {
            ...customer.profile,
            subject: {
              kind: 'RETAIL',
              partyRef: { ...partyRef, resourceId: productId },
              sellingLegalEntityRef: {
                moduleId: 'core.identity',
                resourceId: legalEntityId,
                resourceType: 'core.identity.legal-entity',
                tenantId,
              },
            },
          },
        });
      }
      const decoded =
        customerResponse ??
        Schema.decodeUnknownSync(CustomerProfileSourceResponseSchema)({
          _tag: 'PAGE',
          items: [item],
          nextCursor: null,
        });
      return Promise.resolve(Response.json(Schema.encodeSync(CustomerProfileSourceResponseSchema)(decoded)));
    }
    if (pathname.endsWith('/reads/source-profile-export')) {
      return Promise.resolve(
        Response.json(
          mode === 'party_unavailable'
            ? { outcome: 'NOT_AVAILABLE' }
            : Schema.encodeSync(SourceProfileExportResponseSchema)(partyExport),
        ),
      );
    }
    const icoReply = fixtureIcoReply(pathname, icoResponse);
    if (icoReply !== undefined) {
      return Promise.resolve(icoReply);
    }
    if (pathname.endsWith('/reads/price-group-source-associations')) {
      const decoded = Schema.decodeUnknownSync(PriceGroupSourceAssociationsResponseSchema)({
        associations:
          mode === 'empty_groups'
            ? []
            : [{ priceGroupRef: groupRef, sourceCorrelation: { ...sourceCorrelation, recordKey } }],
        count: mode === 'empty_groups' ? 0 : 1,
        limit: 1,
        offset: 0,
      });
      return Promise.resolve(Response.json(Schema.encodeSync(PriceGroupSourceAssociationsResponseSchema)(decoded)));
    }
    if (pathname.endsWith('/reads/price-group-definition')) {
      return Promise.resolve(Response.json(Schema.encodeSync(PriceGroupDefinitionResponseSchema)(groupDefinition)));
    }
    if (pathname.endsWith('/reads/price-group-source-prices')) {
      return Promise.resolve(Response.json({ count: 0, limit: 50, offset: 0, prices: [] }));
    }
    return Promise.resolve(Response.json({}, { status: 500 }));
  };
  return { acquisitions, admission, fakeFetch, newRequestIdentifier, requests };
};

const withoutPrices = ConfigProvider.fromUnknown({});
const withPrices = ConfigProvider.fromUnknown({
  ONTOS_SYMMY_PRICE_READ_SOURCES: JSON.stringify({
    routes: [
      {
        issuerId: scope.issuerId,
        legalEntityId,
        routeId,
        sourceNamespace: scope.sourceNamespace,
        sourceSystem: { ownerModuleId: 'integration.symmy', sourceSystemRef: 'explicit-owner-source-system' },
        tenantId,
      },
    ],
    schemaVersion: 1,
  }),
});

describe('Symmy source-qualified public owner read projections', () => {
  it.effect('exports lossless selected-path aliases for actual opaque Price Group source keys', () =>
    Effect.gen(function* opaqueGroupIdentifiers() {
      for (const recordKey of ['CZ wholesale', 'CZ/wholesale', 'source-key'.repeat(30)]) {
        const current = fixture('current', recordKey);
        const result = yield* projectSymmySourcePriceLists(
          scope,
          query,
          current.admission,
          current.newRequestIdentifier,
        ).pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, withoutPrices),
          Effect.provideService(FetchHttpClient.Fetch, current.fakeFetch),
        );
        const item = yield* Effect.fromNullishOr(result.price_lists[0]).pipe(Effect.orDie);
        expect(item.source_record_id).toBe(recordKey);
        expect(item.id).not.toContain('/');
        expect(
          yield* verifySymmySourceSelector(
            yield* decodeSymmySourceSelector(item.id),
            {
              ...scope,
              selectorKind: 'PRICE_GROUP',
            },
            recordKey,
            groupRef.resourceId,
          ),
        ).toBe(recordKey);
        expect(item.priceGroupRef).toEqual(groupRef);
      }
    }),
  );
  it.effect('queries logical source identities and versions across independent physical GET enrollment rows', () =>
    Effect.gen(function* logicalSourceAcrossIngressRows() {
      const selected = {
        ...scope,
        mappingVersion: 'physical-get-map',
        routeId: '77777777-7777-4777-8777-777777777778',
        routeRevision: 'physical-get-revision',
        sourceMappingVersion: scope.mappingVersion,
        sourceRouteId: scope.routeId,
        sourceRouteRevision: scope.routeRevision,
      };
      const products = fixture();
      expect(
        (yield* projectSymmySourceProducts(selected, query, products.admission, products.newRequestIdentifier).pipe(
          Effect.provideService(FetchHttpClient.Fetch, products.fakeFetch),
        )).products[0]?.id,
      ).toBe('product-record');
      const productsRequest = yield* Effect.fromNullishOr(products.requests[0]).pipe(Effect.orDie);
      expect(yield* Effect.promise(() => productsRequest.clone().json())).toMatchObject({ routeScope: routeId });
      const customers = fixture();
      expect(
        (yield* projectSymmySourceCustomers(selected, query, customers.admission, customers.newRequestIdentifier).pipe(
          Effect.provideService(FetchHttpClient.Fetch, customers.fakeFetch),
        )).customers,
      ).toHaveLength(1);
      const customersRequest = yield* Effect.fromNullishOr(customers.requests[0]).pipe(Effect.orDie);
      expect(yield* Effect.promise(() => customersRequest.clone().json())).toMatchObject({
        mappingRevision: scope.mappingVersion,
        route: { id: routeId, revision: scope.routeRevision },
      });
      const groups = fixture();
      const result = yield* projectSymmySourcePriceLists(
        selected,
        query,
        groups.admission,
        groups.newRequestIdentifier,
      ).pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, withoutPrices),
        Effect.provideService(FetchHttpClient.Fetch, groups.fakeFetch),
      );
      expect(result.price_lists[0]?.source_record_id).toBe(sourceCorrelation.recordKey);
      const groupsRequest = yield* Effect.fromNullishOr(groups.requests[0]).pipe(Effect.orDie);
      expect(yield* Effect.promise(() => groupsRequest.clone().json())).toMatchObject({ routeId });
    }),
  );
  it.effect('preserves native DRAFT and WIP facts with stable source IDs through the actual Catalog client', () =>
    Effect.gen(function* catalogRead() {
      const current = fixture();
      const result = yield* projectSymmySourceProducts(
        scope,
        query,
        current.admission,
        current.newRequestIdentifier,
      ).pipe(Effect.provideService(FetchHttpClient.Fetch, current.fakeFetch));
      expect(result.products[0]?.id).toBe('product-record');
      expect(result.products[0]?.product.lifecycle).toBe('DRAFT');
      expect(result.products[0]?.product.variants[0]?.lifecycle).toBe('WORK_IN_PROGRESS');
      expect(result.unsupported_fields).toEqual(['tax', 'assortment', 'prices', 'stock']);
      expect(current.acquisitions).toEqual([{ audience: 'catalog' }]);
    }),
  );
  for (const [mode, tag] of [
    ['foreign_product', 'SymmyUnavailableProblem'],
    ['forbidden', 'GatewayForbiddenProblem'],
  ] as const) {
    it.effect(`keeps Catalog ${mode} separate from a successful empty page`, () =>
      Effect.gen(function* catalogNegative() {
        const current = fixture(mode);
        const error = yield* projectSymmySourceProducts(
          scope,
          query,
          current.admission,
          current.newRequestIdentifier,
        ).pipe(Effect.flip, Effect.provideService(FetchHttpClient.Fetch, current.fakeFetch));
        const isExpected =
          tag === 'GatewayForbiddenProblem'
            ? Schema.is(GatewayForbiddenProblemSchema)
            : Schema.is(SymmyUnavailableProblemSchema);
        expect(isExpected(error)).toBe(true);
      }),
    );
  }
  it.effect('returns an explicit genuine Catalog absence without inventing Product IDs', () =>
    Effect.gen(function* catalogAbsence() {
      const current = fixture('absent_product');
      const result = yield* projectSymmySourceProducts(
        scope,
        query,
        current.admission,
        current.newRequestIdentifier,
      ).pipe(Effect.provideService(FetchHttpClient.Fetch, current.fakeFetch));
      expect(result.products).toEqual([]);
    }),
  );
  it.effect('exports current Party fields using the original Party locator and current profile IČO absence', () =>
    Effect.gen(function* customerRead() {
      const current = fixture();
      const result = yield* projectSymmySourceCustomers(
        scope,
        query,
        current.admission,
        current.newRequestIdentifier,
      ).pipe(Effect.provideService(FetchHttpClient.Fetch, current.fakeFetch));
      expect(result.customers[0]?.party).toEqual(partyExport);
      expect(Schema.is(SymmyCustomerIcoProjectionSchema.members[1])(result.customers[0]?.ico)).toBe(true);
      expect(result.unsupported_fields).toEqual(['addresses', 'groups']);
      const partyRequest = yield* Effect.fromNullishOr(
        current.requests.find((request) => new URL(request.url).pathname.endsWith('/reads/source-profile-export')),
      ).pipe(Effect.orDie);
      expect(yield* Effect.promise(() => partyRequest.json())).toEqual({
        partyRef,
        sourceReference: partySourceReference,
      });
      expect(current.requests.map((request) => request.headers.get('authorization'))).toEqual([
        'Bearer owner-assertion-1',
        'Bearer owner-assertion-2',
        'Bearer owner-assertion-3',
      ]);
    }),
  );
  it.effect(
    'refuses owner receipt responses for both Current and paged customer exports without projecting proof or actor data',
    () =>
      Effect.gen(function* receiptIsNotCurrent() {
        for (const response of customerReceiptResponses) {
          for (const selectedQuery of [query, { ...query, code: customer.source.recordId }]) {
            const current = fixture('current', sourceCorrelation.recordKey, response);
            const failure = yield* projectSymmySourceCustomers(
              scope,
              selectedQuery,
              current.admission,
              current.newRequestIdentifier,
            ).pipe(Effect.flip, Effect.provideService(FetchHttpClient.Fetch, current.fakeFetch));
            expect(Schema.is(SymmyUnavailableProblemSchema)(failure)).toBe(true);
            expect(current.requests).toHaveLength(1);
            expect(current.acquisitions).toEqual([{ audience: 'commerce-customer-context', legalEntityId }]);
          }
        }
      }),
  );
  it.effect(
    'selects company ICO from protected authority and preserves a known Current value when original digits are unknown',
    () =>
      Effect.gen(function* currentCompanyIco() {
        for (const originalInput of [{ digits: '27074358', kind: 'KNOWN' }, { kind: 'UNKNOWN' }] as const) {
          const current = fixture(
            'current',
            sourceCorrelation.recordKey,
            companyPage(),
            organizationIcoReply({ ...organizationCurrentIco, originalInput }),
          );
          const result = yield* projectSymmySourceCustomers(
            companyScope,
            query,
            current.admission,
            current.newRequestIdentifier,
          ).pipe(Effect.provideService(FetchHttpClient.Fetch, current.fakeFetch));
          expect(Schema.is(SymmyCustomerIcoProjectionSchema.members[0])(result.customers[0]?.ico)).toBe(true);
          expect(result.customers[0]?.ico).toMatchObject({ normalizedValue: '27074358' });
          expect(result.unsupported_fields).toEqual(['addresses', 'groups', 'name', 'contacts']);
          expect(current.requests.map((request) => new URL(request.url).pathname.split('/').at(-1))).toEqual([
            'customer-profile-source',
            'organization-customer-profile-ico',
          ]);
          const request = yield* Effect.fromNullishOr(current.requests[1]).pipe(Effect.orDie);
          expect(yield* Effect.promise(() => request.clone().json())).toEqual({
            profileRef: {
              moduleId: companyProfileRef.moduleId,
              resourceId: profileId,
              resourceType: companyProfileRef.resourceType,
              tenantId,
            },
          });
        }
      }),
  );
  it.effect('keeps a Counterparty Person on the ordinary ICO API when the protected owner classifies PERSONAL', () =>
    Effect.gen(function* personalCounterpartyIco() {
      const person = Schema.decodeUnknownSync(CustomerProfileSourceItemSchema)({
        ...company,
        icoAuthority: 'PERSONAL',
      });
      const reply = Response.json(
        Schema.encodeSync(CustomerProfileIcoResponseSchema)(
          Schema.decodeUnknownSync(CustomerProfileIcoResponseSchema)({
            _tag: 'ABSENT',
            current: null,
            history: [],
            profileRef: companyProfileRef,
            revision: 0,
          }),
        ),
      );
      const current = fixture('current', sourceCorrelation.recordKey, companyPage(person), reply);
      const result = yield* projectSymmySourceCustomers(
        companyScope,
        query,
        current.admission,
        current.newRequestIdentifier,
      ).pipe(Effect.provideService(FetchHttpClient.Fetch, current.fakeFetch));
      expect(Schema.is(SymmyCustomerIcoProjectionSchema.members[1])(result.customers[0]?.ico)).toBe(true);
      expect(current.requests.map((request) => new URL(request.url).pathname.split('/').at(-1))).toEqual([
        'customer-profile-source',
        'customer-profile-ico',
      ]);
    }),
  );
  it.effect(
    'marks ICO unsupported for missing Counterparty authority or missing chosen-operation permission without another authority probe',
    () =>
      Effect.gen(function* unsupportedCompanyAuthority() {
        const { icoAuthority: _ignoredAuthority, ...untagged } = company;
        for (const [item, selectedScope] of [
          [untagged, companyScope],
          [
            company,
            {
              ...companyScope,
              allowedOwnerOperations: companyScope.allowedOwnerOperations.filter(
                ({ entrypointKey }) => entrypointKey !== orgIcoRead,
              ),
            },
          ],
          [
            Schema.decodeUnknownSync(CustomerProfileSourceItemSchema)({ ...company, icoAuthority: 'PERSONAL' }),
            {
              ...companyScope,
              allowedOwnerOperations: companyScope.allowedOwnerOperations.filter(
                ({ entrypointKey }) => entrypointKey !== personalIcoRead,
              ),
            },
          ],
        ] as const) {
          const current = fixture('current', sourceCorrelation.recordKey, companyPage(item), organizationIcoReply());
          const result = yield* projectSymmySourceCustomers(
            selectedScope,
            query,
            current.admission,
            current.newRequestIdentifier,
          ).pipe(Effect.provideService(FetchHttpClient.Fetch, current.fakeFetch));
          expect(result.customers[0]).not.toHaveProperty('ico');
          expect(result.unsupported_fields).toContain('ico');
          expect(current.requests).toHaveLength(1);
        }
      }),
  );
  it.effect('rejects mismatched profile kinds and Retail organization authority before ICO or Party access', () =>
    Effect.gen(function* invalidProfileAuthority() {
      for (const item of [
        Schema.decodeUnknownSync(CustomerProfileSourceItemSchema)({ ...customer, icoAuthority: 'ORGANIZATION' }),
        Schema.decodeUnknownSync(CustomerProfileSourceItemSchema)({
          ...company,
          profile: { ...company.profile, subject: customer.profile.subject },
        }),
      ]) {
        const current = fixture('current', sourceCorrelation.recordKey, companyPage(item), organizationIcoReply());
        const failure = yield* projectSymmySourceCustomers(
          companyScope,
          query,
          current.admission,
          current.newRequestIdentifier,
        ).pipe(Effect.flip, Effect.provideService(FetchHttpClient.Fetch, current.fakeFetch));
        expect(Schema.is(SymmyUnavailableProblemSchema)(failure)).toBe(true);
        expect(current.requests).toHaveLength(1);
      }
    }),
  );
  it.effect('preserves organization absence and migration-required without Party or personal fallback', () =>
    Effect.gen(function* organizationAbsence() {
      for (const { isExpected, response } of [
        {
          isExpected: Schema.is(SymmyCustomerIcoProjectionSchema.members[1]),
          response: { _tag: 'ABSENT', history: [], revision: 0 },
        },
        {
          isExpected: Schema.is(SymmyCustomerIcoProjectionSchema.members[2]),
          response: { _tag: 'MIGRATION_REQUIRED', profileRef: companyProfileRef },
        },
      ]) {
        const reply = Response.json(
          Schema.encodeSync(OrganizationCustomerProfileIcoResponseSchema)(
            Schema.decodeUnknownSync(OrganizationCustomerProfileIcoResponseSchema)(response),
          ),
        );
        const current = fixture('current', sourceCorrelation.recordKey, companyPage(), reply);
        const result = yield* projectSymmySourceCustomers(
          companyScope,
          query,
          current.admission,
          current.newRequestIdentifier,
        ).pipe(Effect.provideService(FetchHttpClient.Fetch, current.fakeFetch));
        expect(isExpected(result.customers[0]?.ico)).toBe(true);
        expect(current.requests).toHaveLength(2);
      }
    }),
  );
  it.effect('fails closed for foreign, inactive, ended, null-normalized Current and receipt-only company replies', () =>
    Effect.gen(function* invalidOrganizationCurrent() {
      const invalids = [
        { ...organizationCurrentIco, profileRef: { ...companyProfileRef, resourceId: productId } },
        { ...organizationCurrentIco, partyRef: { ...partyRef, resourceId: productId } },
        { ...organizationCurrentIco, isCurrent: false },
        { ...organizationCurrentIco, operation: 'END' },
        { ...organizationCurrentIco, normalizedValue: null, originalInput: { kind: 'UNKNOWN' } },
      ];
      const replies = [
        ...invalids.map((current) => Response.json({ _tag: 'PRESENT', current, history: [], revision: 1 })),
        Response.json({ _tag: 'RECEIPT', assertion: organizationCurrentIco }),
      ];
      for (const reply of replies) {
        const current = fixture('current', sourceCorrelation.recordKey, companyPage(), reply);
        const failure = yield* projectSymmySourceCustomers(
          companyScope,
          query,
          current.admission,
          current.newRequestIdentifier,
        ).pipe(Effect.flip, Effect.provideService(FetchHttpClient.Fetch, current.fakeFetch));
        expect(Schema.is(SymmyUnavailableProblemSchema)(failure)).toBe(true);
        expect(current.requests).toHaveLength(2);
      }
    }),
  );
  it.effect('preserves organization denial and unavailable without attempting ordinary ICO', () =>
    Effect.gen(function* organizationReadAuthorityErrors() {
      const denied = OrganizationCustomerProfileIcoForbiddenProblemSchema.make({
        detail: 'Fixture denies exact organization read',
        status: 403,
        title: 'Forbidden',
        type: 'https://fixture.test/forbidden',
      });
      const unavailable = OrganizationCustomerProfileIcoUnavailableProblemSchema.make({
        detail: 'Current authority unavailable',
        retryable: true,
        status: 503,
        title: 'Unavailable',
        type: 'https://fixture.test/unavailable',
      });
      for (const problem of [denied, unavailable]) {
        const current = fixture(
          'current',
          sourceCorrelation.recordKey,
          companyPage(),
          Response.json(problem, { headers: { 'content-type': 'application/problem+json' }, status: problem.status }),
        );
        const failure = yield* projectSymmySourceCustomers(
          companyScope,
          query,
          current.admission,
          current.newRequestIdentifier,
        ).pipe(Effect.flip, Effect.provideService(FetchHttpClient.Fetch, current.fakeFetch));
        expect(
          problem.status === 403
            ? Schema.is(GatewayForbiddenProblemSchema)(failure)
            : Schema.is(SymmyUnavailableProblemSchema)(failure),
        ).toBe(true);
        expect(current.requests).toHaveLength(2);
      }
    }),
  );
  it.effect('exports only the native company BUSINESS_NAME through the original qualified Party occurrence', () =>
    Effect.gen(function* companyBusinessName() {
      const current = fixture('current', sourceCorrelation.recordKey, companyPage(), {
        ico: organizationIcoReply(),
        name: organizationNameReply(),
      });
      const result = yield* projectSymmySourceCustomers(
        companyNameScope,
        query,
        current.admission,
        current.newRequestIdentifier,
      ).pipe(Effect.provideService(FetchHttpClient.Fetch, current.fakeFetch));
      expect(result.customers[0]?.business_name).toMatchObject({
        outcome: 'AVAILABLE',
        value: 'Internal fixture company s.r.o.',
      });
      expect(result.customers[0]).not.toHaveProperty('party');
      expect(result.unsupported_fields).toEqual(['addresses', 'groups', 'contacts']);
      const nameRequest = yield* Effect.fromNullishOr(current.requests[1]).pipe(Effect.orDie);
      expect(yield* Effect.promise(() => nameRequest.clone().json())).toEqual({
        partyRef,
        sourceReference: companyPartySourceReference,
      });
      expect(current.requests.map((request) => new URL(request.url).pathname.split('/').at(-1))).toEqual([
        'customer-profile-source',
        'organization-business-name-export',
        'organization-customer-profile-ico',
      ]);
      expect(current.acquisitions.map(({ audience }) => audience)).toEqual([
        'commerce-customer-context',
        'party-registry',
        'commerce-customer-context',
      ]);
    }),
  );
  it.effect('preserves genuine missing BUSINESS_NAME without person slots or display-name fallback', () =>
    Effect.gen(function* missingBusinessName() {
      const response = Schema.decodeUnknownSync(OrganizationBusinessNameExportResponseSchema)({
        ...organizationNameCurrent,
        businessName: { outcome: 'UNAVAILABLE', reason: 'NO_CURRENT_BUSINESS_NAME' },
      });
      const current = fixture('current', sourceCorrelation.recordKey, companyPage(), {
        ico: organizationIcoReply(),
        name: organizationNameReply(response),
      });
      const result = yield* projectSymmySourceCustomers(
        companyNameScope,
        query,
        current.admission,
        current.newRequestIdentifier,
      ).pipe(Effect.provideService(FetchHttpClient.Fetch, current.fakeFetch));
      expect(result.customers[0]?.business_name).toEqual({
        outcome: 'UNAVAILABLE',
        reason: 'NO_CURRENT_BUSINESS_NAME',
      });
      expect(result.customers[0]).not.toHaveProperty('party');
      expect(
        current.requests.some((request) => new URL(request.url).pathname.endsWith('/reads/source-profile-export')),
      ).toBe(false);
    }),
  );
  it.effect(
    'never uses personal name export for a missing Counterparty authority or an unconfigured company name operation',
    () =>
      Effect.gen(function* unavailableNameAuthority() {
        const { icoAuthority: _ignoredAuthority, ...untagged } = company;
        for (const [item, selectedScope] of [
          [untagged, companyNameScope],
          [
            company,
            {
              ...companyNameScope,
              allowedOwnerOperations: companyNameScope.allowedOwnerOperations.filter(
                ({ entrypointKey }) => entrypointKey !== orgNameRead,
              ),
            },
          ],
        ] as const) {
          const current = fixture('current', sourceCorrelation.recordKey, companyPage(item), {
            ico: organizationIcoReply(),
            name: organizationNameReply(),
          });
          const result = yield* projectSymmySourceCustomers(
            selectedScope,
            query,
            current.admission,
            current.newRequestIdentifier,
          ).pipe(Effect.provideService(FetchHttpClient.Fetch, current.fakeFetch));
          expect(result.customers[0]).not.toHaveProperty('business_name');
          expect(result.customers[0]).not.toHaveProperty('party');
          expect(result.unsupported_fields).toContain('name');
          expect(
            current.requests.some((request) => new URL(request.url).pathname.endsWith('/reads/source-profile-export')),
          ).toBe(false);
          expect(
            current.requests.some((request) =>
              new URL(request.url).pathname.endsWith('/reads/organization-business-name-export'),
            ),
          ).toBe(false);
        }
      }),
  );
  it.effect('retains explicit PERSONAL Counterparty names on the personal export despite company name permission', () =>
    Effect.gen(function* counterpartyPersonalName() {
      const person = Schema.decodeUnknownSync(CustomerProfileSourceItemSchema)({
        ...company,
        icoAuthority: 'PERSONAL',
      });
      const current = fixture(
        'current',
        sourceCorrelation.recordKey,
        companyPage(person),
        Response.json({ ...icoAbsent, profileRef: companyProfileRef }),
      );
      const result = yield* projectSymmySourceCustomers(
        companyNameScope,
        query,
        current.admission,
        current.newRequestIdentifier,
      ).pipe(Effect.provideService(FetchHttpClient.Fetch, current.fakeFetch));
      expect(result.customers[0]?.party).toEqual(partyExport);
      expect(result.customers[0]).not.toHaveProperty('business_name');
      expect(
        current.requests.some((request) =>
          new URL(request.url).pathname.endsWith('/reads/organization-business-name-export'),
        ),
      ).toBe(false);
    }),
  );
  it.effect(
    'rejects foreign refs, a latest-update occurrence and wrong organization class without dependent or fallback reads',
    () =>
      Effect.gen(function* badCompanyNameBinding() {
        const otherTenant = '10000000-0000-4000-8000-000000000099';
        const valid = Schema.decodeUnknownSync(OrganizationBusinessNameExportResponseSchema.members[1])(
          organizationNameCurrent,
        );
        const responses = [
          { ...valid, partyRef: { ...partyRef, resourceId: productId } },
          { ...valid, partyRef: { ...partyRef, tenantId: otherTenant } },
          { ...valid, sourceCitation: { ...valid.sourceCitation, originalOccurrenceId: customer.source.occurrenceId } },
          {
            ...valid,
            sourceCitation: {
              ...valid.sourceCitation,
              sourceDecisionRef: { ...valid.sourceCitation.sourceDecisionRef, tenantId: otherTenant },
            },
          },
          { outcome: 'UNAVAILABLE', reason: 'NOT_CURRENT_SOURCE_ORGANIZATION' },
        ];
        for (const response of responses) {
          const current = fixture('current', sourceCorrelation.recordKey, companyPage(), {
            ico: organizationIcoReply(),
            name: Response.json(response),
          });
          const failure = yield* projectSymmySourceCustomers(
            companyNameScope,
            query,
            current.admission,
            current.newRequestIdentifier,
          ).pipe(Effect.flip, Effect.provideService(FetchHttpClient.Fetch, current.fakeFetch));
          expect(Schema.is(SymmyUnavailableProblemSchema)(failure)).toBe(true);
          expect(current.requests).toHaveLength(2);
        }
      }),
  );
  it.effect('does not fall back to person fields when company name current Privacy denies or becomes unavailable', () =>
    Effect.gen(function* currentCompanyNamePrivacy() {
      const denied = OrganizationBusinessNameExportForbiddenProblemSchema.make({
        detail: 'Exact current name policy denies',
        status: 403,
        title: 'Forbidden',
        type: 'https://fixture.test/name-denied',
      });
      const unavailable = OrganizationBusinessNameExportUnavailableProblemSchema.make({
        detail: 'Current name authority unavailable',
        retryable: true,
        status: 503,
        title: 'Unavailable',
        type: 'https://fixture.test/name-unavailable',
      });
      for (const problem of [denied, unavailable]) {
        const current = fixture('current', sourceCorrelation.recordKey, companyPage(), {
          ico: organizationIcoReply(),
          name: Response.json(problem, {
            headers: { 'content-type': 'application/problem+json' },
            status: problem.status,
          }),
        });
        const failure = yield* projectSymmySourceCustomers(
          companyNameScope,
          query,
          current.admission,
          current.newRequestIdentifier,
        ).pipe(Effect.flip, Effect.provideService(FetchHttpClient.Fetch, current.fakeFetch));
        expect(
          problem.status === 403
            ? Schema.is(GatewayForbiddenProblemSchema)(failure)
            : Schema.is(SymmyUnavailableProblemSchema)(failure),
        ).toBe(true);
        expect(current.requests).toHaveLength(2);
      }
    }),
  );
  for (const mode of ['foreign_customer', 'foreign_customer_subject', 'party_unavailable'] as const) {
    it.effect(`fails closed for ${mode} before returning any retained personal data`, () =>
      Effect.gen(function* customerNegative() {
        const current = fixture(mode);
        const error = yield* projectSymmySourceCustomers(
          scope,
          query,
          current.admission,
          current.newRequestIdentifier,
        ).pipe(Effect.flip, Effect.provideService(FetchHttpClient.Fetch, current.fakeFetch));
        expect(Schema.is(SymmyUnavailableProblemSchema)(error)).toBe(true);
        expect(
          current.requests.some((request) => new URL(request.url).pathname.endsWith('/reads/customer-profile-ico')),
        ).toBe(false);
      }),
    );
  }
  it.effect('marks unconfigured Party fields unsupported without acquiring any Party assertion', () =>
    Effect.gen(function* noPartyExport() {
      const current = fixture();
      const selected = {
        ...scope,
        allowedOwnerOperations: scope.allowedOwnerOperations.filter(
          (operation) => operation.moduleId !== 'party.registry',
        ),
      };
      const result = yield* projectSymmySourceCustomers(
        selected,
        query,
        current.admission,
        current.newRequestIdentifier,
      ).pipe(Effect.provideService(FetchHttpClient.Fetch, current.fakeFetch));
      expect(result.customers[0]).not.toHaveProperty('party');
      expect(result.unsupported_fields).toContain('name');
      expect(result.unsupported_fields).toContain('contacts');
      expect(current.acquisitions.some(({ audience }) => audience === 'party-registry')).toBe(false);
    }),
  );
  it.effect(
    'projects the actual Price Group definition and explicit current owner Price page with fresh credentials',
    () =>
      Effect.gen(function* groupRead() {
        yield* TestClock.setTime(0);
        const current = fixture();
        const result = yield* projectSymmySourcePriceLists(
          scope,
          query,
          current.admission,
          current.newRequestIdentifier,
        ).pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, withPrices),
          Effect.provideService(FetchHttpClient.Fetch, current.fakeFetch),
        );
        expect(result.price_lists[0]).toMatchObject({
          name: 'Native owner name',
          priceGroupRef: groupRef,
          prices: { count: 0, prices: [] },
          source_record_id: sourceCorrelation.recordKey,
        });
        expect(result.count).toBe(1);
        const [first] = result.price_lists;
        expect(first).toBeDefined();
        const encoded = yield* Effect.fromNullishOr(first?.id).pipe(Effect.orDie);
        expect(
          yield* verifySymmySourceSelector(
            yield* decodeSymmySourceSelector(encoded),
            {
              ...scope,
              selectorKind: 'PRICE_GROUP',
            },
            sourceCorrelation.recordKey,
            groupRef.resourceId,
          ),
        ).toBe(sourceCorrelation.recordKey);
        expect(result.unsupported_fields).toEqual([]);
        expect(current.acquisitions).toEqual([
          { audience: 'price-group-catalog' },
          { audience: 'price-group-catalog' },
          { audience: 'pricing', legalEntityId },
        ]);
      }),
  );
  it.effect('returns a genuine empty source group page and reports unsupported Price mapping', () =>
    Effect.gen(function* absentGroups() {
      const current = fixture('empty_groups');
      const result = yield* projectSymmySourcePriceLists(
        scope,
        query,
        current.admission,
        current.newRequestIdentifier,
      ).pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, withoutPrices),
        Effect.provideService(FetchHttpClient.Fetch, current.fakeFetch),
      );
      expect(result).toMatchObject({ count: 0, price_lists: [], unsupported_fields: ['prices'] });
      expect(current.requests).toHaveLength(1);
    }),
  );
  it.effect('rejects absent route authority and changed release before provider HTTP', () =>
    Effect.gen(function* releaseAndAuthority() {
      const current = fixture();
      const forbidden = yield* projectSymmySourceProducts(
        { ...scope, allowedOwnerOperations: [] },
        query,
        current.admission,
        current.newRequestIdentifier,
      ).pipe(Effect.flip);
      expect(Schema.is(GatewayForbiddenProblemSchema)(forbidden)).toBe(true);
      const acquire = yield* Effect.fromNullishOr(current.admission.acquireOwnerAssertion).pipe(Effect.orDie);
      const changed = {
        ...current.admission,
        acquireOwnerAssertion: (target: Parameters<typeof acquire>[0]) =>
          acquire(target).pipe(Effect.map((assertion) => ({ ...assertion, compositionRevision: 'c'.repeat(64) }))),
      };
      const error = yield* acquireSymmyReadAssertion(changed, 'catalog').pipe(Effect.flip);
      expect(Schema.is(SymmyUnavailableProblemSchema)(error)).toBe(true);
      expect(current.requests).toHaveLength(0);
    }),
  );
  it.effect('rejects incompatible Catalog cursor/filter and unconfigured customer identity before owner access', () =>
    Effect.gen(function* unsupportedInputs() {
      const current = fixture();
      const incompatible = Schema.decodeUnknownSync(SymmyInternalReadQuerySchema)({
        afterRecordId: 'cursor-source-record',
        code: 'product-record',
      });
      const invalid = yield* projectSymmySourceProducts(
        scope,
        incompatible,
        current.admission,
        current.newRequestIdentifier,
      ).pipe(Effect.flip);
      expect(invalid.status).toBe(400);
      const { sourceEntityKind, ...unconfigured } = scope;
      expect(sourceEntityKind).toBe('CUSTOMER');
      const unsupported = yield* projectSymmySourceCustomers(
        unconfigured,
        query,
        current.admission,
        current.newRequestIdentifier,
      ).pipe(Effect.flip);
      expect(unsupported.status).toBe(422);
      expect(current.acquisitions).toHaveLength(0);
      expect(current.requests).toHaveLength(0);
    }),
  );
  it.effect('rejects an unconfigured Price source before a requested Price page can look empty', () =>
    Effect.gen(function* unsupportedPricePage() {
      const current = fixture();
      const requested = Schema.decodeUnknownSync(SymmyInternalReadQuerySchema)({ priceLimit: '1' });
      const unsupported = yield* projectSymmySourcePriceLists(
        scope,
        requested,
        current.admission,
        current.newRequestIdentifier,
      ).pipe(Effect.flip, Effect.provideService(ConfigProvider.ConfigProvider, withoutPrices));
      expect(unsupported.status).toBe(422);
      expect(current.acquisitions).toHaveLength(0);
    }),
  );
  it.effect('rejects a Price Group from another source code before reading its native definition', () =>
    Effect.gen(function* mismatchedGroupSource() {
      const current = fixture();
      const selected = Schema.decodeUnknownSync(SymmyInternalReadQuerySchema)({
        code: 'another-source-code',
        limit: '1',
      });
      const error = yield* projectSymmySourcePriceLists(
        scope,
        selected,
        current.admission,
        current.newRequestIdentifier,
      ).pipe(
        Effect.flip,
        Effect.provideService(ConfigProvider.ConfigProvider, withoutPrices),
        Effect.provideService(FetchHttpClient.Fetch, current.fakeFetch),
      );
      expect(Schema.is(SymmyUnavailableProblemSchema)(error)).toBe(true);
      expect(current.requests).toHaveLength(1);
      expect(current.acquisitions).toHaveLength(1);
    }),
  );
});
