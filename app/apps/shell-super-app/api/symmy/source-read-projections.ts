import { CatalogSourceProductsRequestSchema } from '@app/catalog/api/catalog-source-products';
import type { CatalogSourceProductsResponse } from '@app/catalog/api/catalog-source-products';
import { executeCatalogSourceProductsWithAuthorization } from '@app/catalog/api/catalog-source-products-client';
import { CustomerProfileIcoRequestSchema } from '@app/commerce-customer-context/api/customer-profile-ico';
import { executeCustomerProfileIcoWithAuthorization } from '@app/commerce-customer-context/api/customer-profile-ico/client';
import { OrganizationCustomerProfileIcoRequestSchema } from '@app/commerce-customer-context/api/organization-customer-profile-ico';
import type { OrganizationCustomerProfileIcoResponseSchema } from '@app/commerce-customer-context/api/organization-customer-profile-ico';
import { executeOrganizationCustomerProfileIcoWithAuthorization } from '@app/commerce-customer-context/api/organization-customer-profile-ico/client';
import { CustomerProfileSourceRequestSchema } from '@app/commerce-customer-context/api/customer-profile-source';
import type {
  CustomerProfileSourceItem,
  CustomerProfileSourceResponse,
} from '@app/commerce-customer-context/api/customer-profile-source';
import { executeCustomerProfileSourceWithAuthorization } from '@app/commerce-customer-context/api/customer-profile-source/client';
import { LegalEntityIdSchema } from '@app/core-runtime/access/ids';
import { TenantIdSchema } from '@app/core-runtime/auth/external-identity-contracts';
import { SourceProfileExportRequestSchema } from '@app/party-registry/apis/source-profile-export';
import { executeSourceProfileExportWithAuthorization } from '@app/party-registry/apis/source-profile-export/client';
import { OrganizationBusinessNameExportRequestSchema } from '@app/party-registry/apis/organization-business-name-export';
import { executeOrganizationBusinessNameExportWithAuthorization } from '@app/party-registry/apis/organization-business-name-export/client';
import {
  executePriceGroupDefinitionWithAuthorization,
  executePriceGroupSourceAssociationsWithAuthorization,
} from '@app/price-group-catalog/api/client';
import type { PriceGroupSourceAssociationSchema } from '@app/price-group-catalog/apis/price-group-source-associations';
import { PriceGroupSourceAssociationsRequestSchema } from '@app/price-group-catalog/apis/price-group-source-associations';
import { PriceSourceSystemSchema } from '@app/pricing-contracts/domain/price-source-provenance';
import { executePriceGroupSourcePricesWithAuthorization } from '@app/pricing/api/client';
import { PriceGroupSourcePricesRequestSchema } from '@app/pricing/apis/price-group-source-prices';
import type { PriceGroupSourcePricesResponse } from '@app/pricing/apis/price-group-source-prices';
import { GatewayAuthenticationRequiredProblemSchema, GatewayForbiddenProblemSchema } from '@app/shared-contracts';
import { SymmyRouteContextSchema } from '@app/shared-contracts/symmy';
import { Config, DateTime, Effect, Match, Option, Schema, Redacted } from 'effect';

import { symmyInvalidProblem, symmyUnavailableProblem, symmyUnsupportedProblem } from './contract.ts';
import type { SymmyInternalReadQuerySchema, SymmyIngressProblem } from './contract.ts';
import { resolveSymmyOwnerReleaseBase } from './owner-release-transport.ts';
import { encodeSymmySourceSelector } from '@app/symmy-integration/symmy-source-selector';
import type {
  SymmyInternalCustomersProjection,
  SymmyInternalPriceListsProjection,
  SymmyInternalProductsProjection,
} from './read-projection-contracts.ts';
import type { SymmyIngressAdmission, SymmyOwnerAssertion } from './transport.ts';

export interface SymmySourceReadScope {
  readonly allowedOwnerOperations: readonly {
    readonly entrypointKey: string;
    readonly moduleId: string;
    readonly schemaVersion: string;
  }[];
  readonly issuerId: string;
  readonly legalEntityId?: string;
  readonly mappingVersion: string;
  readonly routeId: string;
  readonly routeRevision: string;
  readonly sourceEntityKind?: string;
  readonly sourceMappingVersion?: string;
  readonly sourceNamespace: string;
  readonly sourceRouteId?: string;
  readonly sourceRouteRevision?: string;
  readonly tenantId: string;
}
type ReadQuery = typeof SymmyInternalReadQuerySchema.Type;
type RequestIdentifier = Effect.Effect<string, typeof symmyUnavailableProblem>;
type PriceGroupSourceAssociation = typeof PriceGroupSourceAssociationSchema.Type;
const customerContextModule = 'commerce.customer-context';
const customerContextAudience = 'commerce-customer-context';
const partyModule = 'party.registry';
const partyProfileRead = 'party.registry.api.source-profile-export';
const organizationNameRead = 'party.registry.api.organization-business-name-export';
const personalIcoReadKey = 'commerce.customer-context.api.customer-profile-ico';
const organizationIcoReadKey = 'commerce.customer-context.api.organization-customer-profile-ico';
type IcoAuthority = NonNullable<CustomerProfileSourceItem['icoAuthority']>;
type CustomerRow = SymmyInternalCustomersProjection['customers'][number];
const authenticationRequired = GatewayAuthenticationRequiredProblemSchema.make({
  detail: 'The integration credential is unusable.',
  status: GatewayAuthenticationRequiredProblemSchema.fields.status.literal,
  title: 'Gateway authentication required',
  type: 'https://ontos.dev/problems/gateway-authentication-required',
});
const forbidden = GatewayForbiddenProblemSchema.make({
  detail: 'The current route cannot read the requested owner data.',
  status: GatewayForbiddenProblemSchema.fields.status.literal,
  title: 'Gateway context forbidden',
  type: 'https://ontos.dev/problems/gateway-forbidden',
});
export const mapSymmyOwnerReadProblem = (error: { readonly _tag: string }): SymmyIngressProblem =>
  Match.value(error._tag).pipe(
    Match.when(
      (tag) => tag.endsWith('AuthenticationProblem'),
      () => authenticationRequired,
    ),
    Match.when(
      (tag) => tag.endsWith('ForbiddenProblem'),
      () => forbidden,
    ),
    Match.orElse(() => symmyUnavailableProblem),
  );
export const acquireSymmyReadAssertion = Effect.fn('SymmyReadProjection.acquire')(function* acquire(
  admission: SymmyIngressAdmission,
  audience: string,
  legalEntityId?: string,
): Effect.fn.Return<SymmyOwnerAssertion, SymmyIngressProblem> {
  if (admission.acquireOwnerAssertion === undefined) {
    return yield* Effect.fail(symmyUnavailableProblem);
  }
  const target = legalEntityId === undefined ? { audience } : { audience, legalEntityId };
  const assertion = yield* admission.acquireOwnerAssertion(target);
  if (assertion.compositionRevision !== admission.compositionRevision) {
    return yield* Effect.fail(symmyUnavailableProblem);
  }
  const baseUrl = yield* resolveSymmyOwnerReleaseBase(assertion.apiBaseUrl, audience);
  return { ...assertion, apiBaseUrl: baseUrl.toString() };
});
const routeAllows = (scope: SymmySourceReadScope, moduleId: string, entrypointKey: string): boolean =>
  scope.allowedOwnerOperations.some(
    (operation) =>
      operation.moduleId === moduleId && operation.entrypointKey === entrypointKey && operation.schemaVersion === '1',
  );
const requireRouteRead = (scope: SymmySourceReadScope, moduleId: string, entrypointKey: string) =>
  routeAllows(scope, moduleId, entrypointKey) ? Effect.void : Effect.fail(forbidden);
const cursorQueryIsInvalid = (query: ReadQuery): boolean =>
  query.offset !== undefined ||
  query.priceLimit !== undefined ||
  query.priceOffset !== undefined ||
  (query.code !== undefined && query.afterRecordId !== undefined);
const catalogItemsAreValid = (
  result: CatalogSourceProductsResponse,
  scope: SymmySourceReadScope,
  query: ReadQuery,
): boolean =>
  result.items.length <= (query.code === undefined ? (query.limit ?? 50) : 1) &&
  (result.outcome !== 'NOT_FOUND' || (result.items.length === 0 && result.nextRecordId === undefined)) &&
  result.items.every(
    (item) =>
      item.entityKind === 'PRODUCT' &&
      item.product.productRef.tenantId === scope.tenantId &&
      item.source.issuerId === scope.issuerId &&
      item.source.routeScope === (scope.sourceRouteId ?? scope.routeId) &&
      item.source.recordNamespace === scope.sourceNamespace &&
      (query.code === undefined || item.source.recordId === query.code) &&
      item.variantSources.every(
        (variant) =>
          variant.source.issuerId === scope.issuerId &&
          variant.source.routeScope === (scope.sourceRouteId ?? scope.routeId) &&
          variant.source.recordNamespace === scope.sourceNamespace &&
          item.product.variants.some((native) => native.variantId === variant.variantId),
      ),
  );
export const projectSymmySourceProducts = Effect.fn('SymmyReadProjection.products')(function* sourceProducts(
  scope: SymmySourceReadScope,
  query: ReadQuery,
  admission: SymmyIngressAdmission,
  newRequestIdentifier: RequestIdentifier,
): Effect.fn.Return<SymmyInternalProductsProjection, SymmyIngressProblem> {
  if (cursorQueryIsInvalid(query)) {
    return yield* Effect.fail(symmyInvalidProblem);
  }
  yield* requireRouteRead(scope, 'commerce.catalog', 'commerce.catalog.api.catalog-source-products');
  const qualifier = {
    issuerId: scope.issuerId,
    recordNamespace: scope.sourceNamespace,
    routeScope: scope.sourceRouteId ?? scope.routeId,
  };
  const listing = { ...qualifier, limit: query.limit ?? 50, operation: 'LIST' as const };
  const listInput = query.afterRecordId === undefined ? listing : { ...listing, afterRecordId: query.afterRecordId };
  const raw =
    query.code === undefined
      ? listInput
      : { ...qualifier, entityKind: 'PRODUCT', operation: 'LOOKUP', recordId: query.code };
  const payload = yield* Schema.decodeUnknownEffect(CatalogSourceProductsRequestSchema)(raw).pipe(
    Effect.catchTag('SchemaError', () => Effect.fail(symmyInvalidProblem)),
  );
  const assertion = yield* acquireSymmyReadAssertion(admission, 'catalog');
  const result = yield* executeCatalogSourceProductsWithAuthorization(
    payload,
    `Bearer ${Redacted.value(assertion.assertion)}`,
    yield* newRequestIdentifier,
    {
      baseUrl: assertion.apiBaseUrl,
      compositionRevision: assertion.compositionRevision,
    },
  ).pipe(Effect.mapError(mapSymmyOwnerReadProblem));
  if (!catalogItemsAreValid(result, scope, query)) {
    return yield* Effect.fail(symmyUnavailableProblem);
  }
  const projection: SymmyInternalProductsProjection = {
    contractVersion: 'INTERNAL_C14',
    limit: query.limit ?? 50,
    products: result.items.map((item) => ({
      id: item.source.recordId,
      product: item.product,
      variantSources: item.variantSources.map((variant) => ({
        id: variant.source.recordId,
        variantId: variant.variantId,
      })),
    })),
    projection: 'products',
    unsupported_fields: ['tax', 'assortment', 'prices', 'stock'],
  };
  return result.nextRecordId === undefined ? projection : { ...projection, nextRecordId: result.nextRecordId };
});
interface CustomerSourcePage {
  readonly items: readonly CustomerProfileSourceItem[];
  readonly nextCursor: string | null;
}
const selectCustomers = (
  response: CustomerProfileSourceResponse,
  query: ReadQuery,
): Effect.Effect<CustomerSourcePage, SymmyIngressProblem> =>
  Match.value(response).pipe(
    Match.tag('ABSENT', () =>
      query.code === undefined ? Effect.fail(symmyUnavailableProblem) : Effect.succeed({ items: [], nextCursor: null }),
    ),
    Match.tag('CURRENT', ({ item }) =>
      query.code === undefined
        ? Effect.fail(symmyUnavailableProblem)
        : Effect.succeed({ items: [item], nextCursor: null }),
    ),
    Match.tag('PAGE', ({ items, nextCursor }) =>
      query.code === undefined ? Effect.succeed({ items, nextCursor }) : Effect.fail(symmyUnavailableProblem),
    ),
    Match.tag('RECEIPT', 'MINIMAL_RECEIPT', 'ORG_RECEIPT', () => Effect.fail(symmyUnavailableProblem)),
    Match.exhaustive,
  );
const customerSubjectIsValid = (item: CustomerProfileSourceItem, scope: SymmySourceReadScope): boolean =>
  Match.value(item.profile).pipe(
    Match.when(
      { profileRef: { kind: 'RETAIL' }, subject: { kind: 'RETAIL' } },
      ({ subject }) =>
        subject.partyRef.tenantId === scope.tenantId &&
        subject.partyRef.resourceId === item.partyRef.resourceId &&
        subject.sellingLegalEntityRef.tenantId === scope.tenantId &&
        subject.sellingLegalEntityRef.resourceId === scope.legalEntityId,
    ),
    Match.when(
      { profileRef: { kind: 'COUNTERPARTY' }, subject: { kind: 'COUNTERPARTY' } },
      ({ subject }) =>
        subject.counterpartyRef.tenantId === scope.tenantId &&
        (subject.sellingLegalEntityRef === undefined ||
          (subject.sellingLegalEntityRef.tenantId === scope.tenantId &&
            subject.sellingLegalEntityRef.resourceId === scope.legalEntityId)),
    ),
    Match.orElse(() => false),
  );
const customerSourceIsValid = (
  item: CustomerProfileSourceItem,
  scope: SymmySourceReadScope,
  query: ReadQuery,
): boolean =>
  item.source.issuer === scope.issuerId &&
  item.source.namespace === scope.sourceNamespace &&
  item.source.recordType === scope.sourceEntityKind &&
  item.source.mappingRevision === (scope.sourceMappingVersion ?? scope.mappingVersion) &&
  item.source.route.id === (scope.sourceRouteId ?? scope.routeId) &&
  item.source.route.revision === (scope.sourceRouteRevision ?? scope.routeRevision) &&
  item.partyRef.tenantId === scope.tenantId &&
  item.profile.profileRef.tenantId === scope.tenantId &&
  customerSubjectIsValid(item, scope) &&
  (query.code === undefined || item.source.recordId === query.code);
const customerIcoAuthority = (
  item: CustomerProfileSourceItem,
): Effect.Effect<Option.Option<IcoAuthority>, SymmyIngressProblem> =>
  Match.value(item.profile.profileRef).pipe(
    Match.when({ kind: 'RETAIL' }, () =>
      Match.value(item.icoAuthority).pipe(
        Match.when('ORGANIZATION', () => Effect.fail(symmyUnavailableProblem)),
        Match.whenOr('PERSONAL', undefined, () => Effect.succeed(Option.some<IcoAuthority>('PERSONAL'))),
        Match.exhaustive,
      ),
    ),
    Match.when({ kind: 'COUNTERPARTY' }, () => Effect.succeed(Option.fromNullishOr(item.icoAuthority))),
    Match.exhaustive,
  );
const icoReadKey = (authority: IcoAuthority) =>
  Match.value(authority).pipe(
    Match.when('PERSONAL', () => personalIcoReadKey),
    Match.when('ORGANIZATION', () => organizationIcoReadKey),
    Match.exhaustive,
  );
const readCustomerIco = Effect.fn('SymmyReadProjection.customerIco')(function* customerIco(
  item: CustomerProfileSourceItem,
  scope: SymmySourceReadScope,
  admission: SymmyIngressAdmission,
  newRequestIdentifier: RequestIdentifier,
): Effect.fn.Return<NonNullable<CustomerRow['ico']>, SymmyIngressProblem> {
  const input = yield* Schema.decodeUnknownEffect(CustomerProfileIcoRequestSchema)({
    authorizationSubject: item.profile.subject,
    profileRef: item.profile.profileRef,
  }).pipe(Effect.catchTag('SchemaError', () => Effect.fail(symmyUnavailableProblem)));
  const assertion = yield* acquireSymmyReadAssertion(admission, customerContextAudience, scope.legalEntityId);
  const ico = yield* executeCustomerProfileIcoWithAuthorization(
    input,
    `Bearer ${Redacted.value(assertion.assertion)}`,
    yield* newRequestIdentifier,
    {
      baseUrl: assertion.apiBaseUrl,
      compositionRevision: assertion.compositionRevision,
    },
  ).pipe(Effect.mapError(mapSymmyOwnerReadProblem));
  if (
    ico.profileRef.kind !== item.profile.profileRef.kind ||
    ico.profileRef.resourceId !== item.profile.profileRef.resourceId ||
    ico.profileRef.tenantId !== scope.tenantId
  ) {
    return yield* Effect.fail(symmyUnavailableProblem);
  }
  return yield* Match.value(ico).pipe(
    Match.tag('PRESENT', ({ current }) =>
      current.normalizedValue === null
        ? Effect.fail(symmyUnavailableProblem)
        : Effect.succeed({ _tag: 'PRESENT' as const, normalizedValue: current.normalizedValue }),
    ),
    Match.tag('ABSENT', () => Effect.succeed({ _tag: 'ABSENT' as const })),
    Match.tag('MIGRATION_REQUIRED', () => Effect.succeed({ _tag: 'MIGRATION_REQUIRED' as const })),
    Match.tag('RECEIPT', () => Effect.fail(symmyUnavailableProblem)),
    Match.exhaustive,
  );
});
const organizationIcoCurrentIsValid = (
  current: (typeof OrganizationCustomerProfileIcoResponseSchema.members)[1]['fields']['current']['Type'],
  item: CustomerProfileSourceItem,
): boolean =>
  current.profileRef.tenantId === item.profile.profileRef.tenantId &&
  current.profileRef.resourceId === item.profile.profileRef.resourceId &&
  current.profileRef.resourceType === item.profile.profileRef.resourceType &&
  (current.partyRef === null ||
    (current.partyRef.tenantId === item.partyRef.tenantId && current.partyRef.resourceId === item.partyRef.resourceId));
const readOrganizationCustomerIco = Effect.fn('SymmyReadProjection.organizationCustomerIco')(function* organizationIco(
  item: CustomerProfileSourceItem,
  scope: SymmySourceReadScope,
  admission: SymmyIngressAdmission,
  newRequestIdentifier: RequestIdentifier,
): Effect.fn.Return<NonNullable<CustomerRow['ico']>, SymmyIngressProblem> {
  const input = yield* Schema.decodeUnknownEffect(OrganizationCustomerProfileIcoRequestSchema)({
    profileRef: item.profile.profileRef,
  }).pipe(Effect.catchTag('SchemaError', () => Effect.fail(symmyUnavailableProblem)));
  const assertion = yield* acquireSymmyReadAssertion(admission, customerContextAudience, scope.legalEntityId);
  const ico = yield* executeOrganizationCustomerProfileIcoWithAuthorization(
    input,
    `Bearer ${Redacted.value(assertion.assertion)}`,
    yield* newRequestIdentifier,
    { baseUrl: assertion.apiBaseUrl, compositionRevision: assertion.compositionRevision },
  ).pipe(Effect.mapError(mapSymmyOwnerReadProblem));
  return yield* Match.value(ico).pipe(
    Match.tag('PRESENT', ({ current }) =>
      organizationIcoCurrentIsValid(current, item)
        ? Effect.succeed({ _tag: 'PRESENT' as const, normalizedValue: current.normalizedValue })
        : Effect.fail(symmyUnavailableProblem),
    ),
    Match.tag('ABSENT', () => Effect.succeed({ _tag: 'ABSENT' as const })),
    Match.tag('MIGRATION_REQUIRED', ({ profileRef }) =>
      profileRef.resourceId === input.profileRef.resourceId && profileRef.tenantId === input.profileRef.tenantId
        ? Effect.succeed({ _tag: 'MIGRATION_REQUIRED' as const })
        : Effect.fail(symmyUnavailableProblem),
    ),
    Match.tag('RECEIPT', () => Effect.fail(symmyUnavailableProblem)),
    Match.exhaustive,
  );
});
const readCustomerParty = Effect.fn('SymmyReadProjection.customerParty')(function* customerParty(
  item: CustomerProfileSourceItem,
  scope: SymmySourceReadScope,
  admission: SymmyIngressAdmission,
  newRequestIdentifier: RequestIdentifier,
): Effect.fn.Return<NonNullable<CustomerRow['party']>, SymmyIngressProblem> {
  const input = yield* Schema.decodeUnknownEffect(SourceProfileExportRequestSchema)({
    partyRef: item.partyRef,
    sourceReference: item.partySourceReference,
  }).pipe(Effect.catchTag('SchemaError', () => Effect.fail(symmyUnavailableProblem)));
  const assertion = yield* acquireSymmyReadAssertion(admission, 'party-registry', scope.legalEntityId);
  const result = yield* executeSourceProfileExportWithAuthorization(
    input,
    `Bearer ${Redacted.value(assertion.assertion)}`,
    yield* newRequestIdentifier,
    {
      baseUrl: assertion.apiBaseUrl,
      compositionRevision: assertion.compositionRevision,
    },
  ).pipe(Effect.mapError(mapSymmyOwnerReadProblem));
  if (result.outcome !== 'AVAILABLE') {
    return yield* Effect.fail(symmyUnavailableProblem);
  }
  if (
    result.partyRef.tenantId !== scope.tenantId ||
    result.partyRef.resourceId !== item.partyRef.resourceId ||
    result.contactPoints.some(({ contactPointRef }) => contactPointRef.tenantId !== scope.tenantId)
  ) {
    return yield* Effect.fail(symmyUnavailableProblem);
  }
  return result;
});
const readOrganizationName = Effect.fn('SymmyReadProjection.organizationName')(function* organizationName(
  item: CustomerProfileSourceItem,
  scope: SymmySourceReadScope,
  admission: SymmyIngressAdmission,
  newRequestIdentifier: RequestIdentifier,
): Effect.fn.Return<NonNullable<CustomerRow['business_name']>, SymmyIngressProblem> {
  const input = yield* Schema.decodeUnknownEffect(OrganizationBusinessNameExportRequestSchema)({
    partyRef: item.partyRef,
    sourceReference: item.partySourceReference,
  }).pipe(Effect.catchTag('SchemaError', () => Effect.fail(symmyUnavailableProblem)));
  const assertion = yield* acquireSymmyReadAssertion(admission, 'party-registry', scope.legalEntityId);
  const result = yield* executeOrganizationBusinessNameExportWithAuthorization(
    input,
    `Bearer ${Redacted.value(assertion.assertion)}`,
    yield* newRequestIdentifier,
    { baseUrl: assertion.apiBaseUrl, compositionRevision: assertion.compositionRevision },
  ).pipe(Effect.mapError(mapSymmyOwnerReadProblem));
  return yield* Match.value(result).pipe(
    Match.when({ outcome: 'UNAVAILABLE' }, () => Effect.fail(symmyUnavailableProblem)),
    Match.when({ outcome: 'CURRENT_ORGANIZATION_BUSINESS_NAME' }, (current) =>
      current.partyRef.tenantId === scope.tenantId &&
      current.partyRef.resourceId === item.partyRef.resourceId &&
      current.sourceCitation.sourceDecisionRef.tenantId === scope.tenantId &&
      current.sourceCitation.originalOccurrenceId === input.sourceReference.occurrenceId
        ? Effect.succeed(current.businessName)
        : Effect.fail(symmyUnavailableProblem),
    ),
    Match.exhaustive,
  );
});
const projectCustomer = Effect.fn('SymmyReadProjection.customer')(function* customer(
  item: CustomerProfileSourceItem,
  scope: SymmySourceReadScope,
  admission: SymmyIngressAdmission,
  newRequestIdentifier: RequestIdentifier,
): Effect.fn.Return<CustomerRow, SymmyIngressProblem> {
  const authority = yield* customerIcoAuthority(item);
  let result: CustomerRow = { id: item.source.recordId, partyRef: item.partyRef, profile: item.profile };
  if (Option.isSome(authority)) {
    result = yield* Match.value(authority.value).pipe(
      Match.when('PERSONAL', () =>
        routeAllows(scope, partyModule, partyProfileRead)
          ? readCustomerParty(item, scope, admission, newRequestIdentifier).pipe(
              Effect.map((party) => ({ ...result, party })),
            )
          : Effect.succeed(result),
      ),
      Match.when('ORGANIZATION', () =>
        routeAllows(scope, partyModule, organizationNameRead)
          ? readOrganizationName(item, scope, admission, newRequestIdentifier).pipe(
              Effect.map((businessName) => ({ ...result, business_name: businessName })),
            )
          : Effect.succeed(result),
      ),
      Match.exhaustive,
    );
  }
  if (Option.isSome(authority) && routeAllows(scope, customerContextModule, icoReadKey(authority.value))) {
    const ico = yield* Match.value(authority.value).pipe(
      Match.when('PERSONAL', () => readCustomerIco(item, scope, admission, newRequestIdentifier)),
      Match.when('ORGANIZATION', () => readOrganizationCustomerIco(item, scope, admission, newRequestIdentifier)),
      Match.exhaustive,
    );
    result = { ...result, ico };
  }
  return result;
});
const customerUnsupportedFields = (scope: SymmySourceReadScope, customers: readonly CustomerRow[]) => {
  const unsupported: SymmyInternalCustomersProjection['unsupported_fields'][number][] = ['addresses', 'groups'];
  if (
    (!routeAllows(scope, partyModule, partyProfileRead) && !routeAllows(scope, partyModule, organizationNameRead)) ||
    customers.some((row) => row.party === undefined && row.business_name === undefined)
  ) {
    unsupported.push('name');
  }
  if (!routeAllows(scope, partyModule, partyProfileRead) || customers.some((row) => row.party === undefined)) {
    unsupported.push('contacts');
  }
  if (
    (!routeAllows(scope, customerContextModule, personalIcoReadKey) &&
      !routeAllows(scope, customerContextModule, organizationIcoReadKey)) ||
    customers.some(({ ico }) => ico === undefined)
  ) {
    unsupported.push('ico');
  }
  return unsupported;
};
export const projectSymmySourceCustomers = Effect.fn('SymmyReadProjection.customers')(function* sourceCustomers(
  scope: SymmySourceReadScope,
  query: ReadQuery,
  admission: SymmyIngressAdmission,
  newRequestIdentifier: RequestIdentifier,
): Effect.fn.Return<SymmyInternalCustomersProjection, SymmyIngressProblem> {
  if (scope.sourceEntityKind === undefined) {
    return yield* Effect.fail(symmyUnsupportedProblem('projection_not_configured'));
  }
  if (cursorQueryIsInvalid(query)) {
    return yield* Effect.fail(symmyInvalidProblem);
  }
  yield* requireRouteRead(scope, customerContextModule, 'commerce.customer-context.api.customer-profile-source');
  const authority = {
    issuer: scope.issuerId,
    mappingRevision: scope.sourceMappingVersion ?? scope.mappingVersion,
    namespace: scope.sourceNamespace,
    recordType: scope.sourceEntityKind,
    route: { id: scope.sourceRouteId ?? scope.routeId, revision: scope.sourceRouteRevision ?? scope.routeRevision },
  };
  const raw =
    query.code === undefined
      ? { ...authority, cursor: query.afterRecordId ?? null, limit: query.limit ?? 50, mode: 'LIST' }
      : { ...authority, mode: 'CURRENT', recordId: query.code };
  const input = yield* Schema.decodeUnknownEffect(CustomerProfileSourceRequestSchema)(raw).pipe(
    Effect.catchTag('SchemaError', () => Effect.fail(symmyInvalidProblem)),
  );
  const assertion = yield* acquireSymmyReadAssertion(admission, customerContextAudience, scope.legalEntityId);
  const result = yield* executeCustomerProfileSourceWithAuthorization(
    input,
    `Bearer ${Redacted.value(assertion.assertion)}`,
    yield* newRequestIdentifier,
    {
      baseUrl: assertion.apiBaseUrl,
      compositionRevision: assertion.compositionRevision,
    },
  ).pipe(Effect.mapError(mapSymmyOwnerReadProblem));
  const selected = yield* selectCustomers(result, query);
  if (
    selected.items.length > (query.limit ?? 50) ||
    !selected.items.every((item) => customerSourceIsValid(item, scope, query))
  ) {
    return yield* Effect.fail(symmyUnavailableProblem);
  }
  const customers = yield* Effect.forEach(
    selected.items,
    (item) => projectCustomer(item, scope, admission, newRequestIdentifier),
    { concurrency: 1 },
  );
  const unsupported = customerUnsupportedFields(scope, customers);
  const projection: SymmyInternalCustomersProjection = {
    contractVersion: 'INTERNAL_C14',
    customers,
    limit: query.limit ?? 50,
    projection: 'customers',
    unsupported_fields: unsupported,
  };
  return selected.nextCursor === null ? projection : { ...projection, nextRecordId: selected.nextCursor };
});
export const SymmyPriceReadProjectionConfigurationSchema = Schema.Struct({
  routes: Schema.Array(
    Schema.Struct({
      issuerId: SymmyRouteContextSchema.fields.issuerId,
      legalEntityId: LegalEntityIdSchema,
      routeId: Schema.String.check(Schema.isUUID()).pipe(Schema.brand('SymmyReadRouteId')),
      sourceNamespace: SymmyRouteContextSchema.fields.sourceNamespace,
      sourceSystem: PriceSourceSystemSchema,
      tenantId: TenantIdSchema,
    }),
  ).check(Schema.isMaxLength(64)),
  schemaVersion: Schema.Literal(1),
});
type PriceReadSource = (typeof SymmyPriceReadProjectionConfigurationSchema.Type.routes)[number];
const configuredPriceSource = Effect.fn('SymmyReadProjection.configuredPriceSource')(function* priceSource(
  scope: SymmySourceReadScope,
) {
  const configuration = yield* Config.option(
    Config.schema(Schema.fromJsonString(SymmyPriceReadProjectionConfigurationSchema), 'ONTOS_SYMMY_PRICE_READ_SOURCES'),
  ).pipe(Effect.catchTag('ConfigError', () => Effect.fail(symmyUnavailableProblem)));
  if (Option.isNone(configuration)) {
    return Option.none<PriceReadSource>();
  }
  const matches = configuration.value.routes.filter(
    (entry) =>
      entry.tenantId === scope.tenantId &&
      entry.routeId === scope.routeId &&
      entry.issuerId === scope.issuerId &&
      entry.sourceNamespace === scope.sourceNamespace &&
      entry.legalEntityId === scope.legalEntityId,
  );
  if (matches.length > 1) {
    return yield* Effect.fail(symmyUnavailableProblem);
  }
  return Option.fromNullishOr(matches[0]);
});
const sourcePricesAreValid = (
  page: PriceGroupSourcePricesResponse,
  request: typeof PriceGroupSourcePricesRequestSchema.Type,
  scope: SymmySourceReadScope,
): boolean =>
  page.limit === request.limit &&
  page.offset === request.offset &&
  page.prices.length <= request.limit &&
  page.prices.every(({ price, provenance }) => {
    if (price.outcome !== 'PRICE_DEFINITION_CURRENT') {
      return price.priceRef.tenantId === scope.tenantId;
    }
    const selector = price.definition.identityKey.priceGroupSelector;
    return (
      price.definition.priceRef.tenantId === scope.tenantId &&
      price.definition.identityKey.commercialScope.sellingLegalEntityId === scope.legalEntityId &&
      selector.kind === 'PRICE_GROUP' &&
      selector.priceGroupRef.resourceId === request.priceGroupRef.resourceId &&
      selector.priceGroupRef.tenantId === scope.tenantId &&
      provenance !== undefined &&
      provenance.evidence.sourceAssertion.sourceRecord.sourceSystem.ownerModuleId ===
        request.sourceSystem.ownerModuleId &&
      provenance.evidence.sourceAssertion.sourceRecord.sourceSystem.sourceSystemRef ===
        request.sourceSystem.sourceSystemRef
    );
  });
const readSourcePrices = Effect.fn('SymmyReadProjection.sourcePrices')(function* sourcePrices(
  source: PriceReadSource,
  association: PriceGroupSourceAssociation,
  scope: SymmySourceReadScope,
  query: ReadQuery,
  admission: SymmyIngressAdmission,
  newRequestIdentifier: RequestIdentifier,
) {
  const assertion = yield* acquireSymmyReadAssertion(admission, 'pricing', source.legalEntityId);
  const input = yield* Schema.decodeUnknownEffect(PriceGroupSourcePricesRequestSchema)({
    limit: query.priceLimit ?? 50,
    offset: query.priceOffset ?? 0,
    priceGroupRef: association.priceGroupRef,
    sourceSystem: source.sourceSystem,
  }).pipe(Effect.catchTag('SchemaError', () => Effect.fail(symmyUnavailableProblem)));
  const result = yield* executePriceGroupSourcePricesWithAuthorization(
    input,
    `Bearer ${Redacted.value(assertion.assertion)}`,
    yield* newRequestIdentifier,
    {
      baseUrl: assertion.apiBaseUrl,
      compositionRevision: assertion.compositionRevision,
    },
  ).pipe(Effect.mapError(mapSymmyOwnerReadProblem));
  if (!sourcePricesAreValid(result, input, scope)) {
    return yield* Effect.fail(symmyUnavailableProblem);
  }
  return result;
});
const projectPriceList = Effect.fn('SymmyReadProjection.priceList')(function* priceList(
  association: PriceGroupSourceAssociation,
  source: Option.Option<PriceReadSource>,
  scope: SymmySourceReadScope,
  query: ReadQuery,
  admission: SymmyIngressAdmission,
  newRequestIdentifier: RequestIdentifier,
): Effect.fn.Return<SymmyInternalPriceListsProjection['price_lists'][number], SymmyIngressProblem> {
  const assertion = yield* acquireSymmyReadAssertion(admission, 'price-group-catalog');
  const definition = yield* executePriceGroupDefinitionWithAuthorization(
    { priceGroupRef: association.priceGroupRef, trustedOperationAt: DateTime.formatIso(yield* DateTime.now) },
    `Bearer ${Redacted.value(assertion.assertion)}`,
    yield* newRequestIdentifier,
    {
      baseUrl: assertion.apiBaseUrl,
      compositionRevision: assertion.compositionRevision,
    },
  ).pipe(Effect.mapError(mapSymmyOwnerReadProblem));
  if (
    definition.selection !== 'CURRENT' ||
    definition.identity.priceGroupRef.resourceId !== association.priceGroupRef.resourceId ||
    definition.identity.priceGroupRef.tenantId !== scope.tenantId
  ) {
    return yield* Effect.fail(symmyUnavailableProblem);
  }
  const base: SymmyInternalPriceListsProjection['price_lists'][number] = {
    description: definition.definition.description,
    id: encodeSymmySourceSelector(
      {
        issuerId: association.sourceCorrelation.issuer,
        routeId: association.sourceCorrelation.routeId,
        selectorKind: 'PRICE_GROUP',
        sourceNamespace: association.sourceCorrelation.namespace,
        tenantId: association.priceGroupRef.tenantId,
      },
      association.sourceCorrelation.recordKey,
      association.priceGroupRef.resourceId,
    ),
    name: definition.definition.displayName,
    priceGroupRef: association.priceGroupRef,
    source_record_id: association.sourceCorrelation.recordKey,
    starts_at: definition.definition.effectivePeriod.effectiveFrom,
  };
  const withPeriod =
    definition.definition.effectivePeriod.effectiveTo === null
      ? base
      : { ...base, ends_at: definition.definition.effectivePeriod.effectiveTo };
  if (Option.isNone(source)) {
    return withPeriod;
  }
  return {
    ...withPeriod,
    prices: yield* readSourcePrices(source.value, association, scope, query, admission, newRequestIdentifier),
  };
});
export const projectSymmySourcePriceLists: (
  scope: SymmySourceReadScope,
  query: ReadQuery,
  admission: SymmyIngressAdmission,
  newRequestIdentifier: RequestIdentifier,
) => Effect.Effect<SymmyInternalPriceListsProjection, SymmyIngressProblem> = Effect.fn(
  'SymmyReadProjection.priceLists',
)(function* sourcePriceLists(
  scope: SymmySourceReadScope,
  query: ReadQuery,
  admission: SymmyIngressAdmission,
  newRequestIdentifier: RequestIdentifier,
): Effect.fn.Return<SymmyInternalPriceListsProjection, SymmyIngressProblem> {
  if (query.afterRecordId !== undefined) {
    return yield* Effect.fail(symmyInvalidProblem);
  }
  yield* requireRouteRead(
    scope,
    'pricing.price-group-catalog',
    'pricing.price-group-catalog.api.price-group-source-associations',
  );
  yield* requireRouteRead(
    scope,
    'pricing.price-group-catalog',
    'pricing.price-group-catalog.api.price-group-definition',
  );
  const raw = {
    issuer: scope.issuerId,
    limit: query.limit ?? 50,
    namespace: scope.sourceNamespace,
    offset: query.offset ?? 0,
    routeId: scope.sourceRouteId ?? scope.routeId,
  };
  const input = yield* Schema.decodeUnknownEffect(PriceGroupSourceAssociationsRequestSchema)(
    query.code === undefined ? raw : { ...raw, recordKey: query.code },
  ).pipe(Effect.catchTag('SchemaError', () => Effect.fail(symmyInvalidProblem)));
  const source = yield* configuredPriceSource(scope);
  if (Option.isSome(source)) {
    yield* requireRouteRead(scope, 'commerce.pricing', 'commerce.pricing.api.price-group-source-prices');
  }
  if (Option.isNone(source) && (query.priceLimit !== undefined || query.priceOffset !== undefined)) {
    return yield* Effect.fail(symmyUnsupportedProblem('projection_not_configured'));
  }
  const assertion = yield* acquireSymmyReadAssertion(admission, 'price-group-catalog');
  const page = yield* executePriceGroupSourceAssociationsWithAuthorization(
    input,
    `Bearer ${Redacted.value(assertion.assertion)}`,
    yield* newRequestIdentifier,
    {
      baseUrl: assertion.apiBaseUrl,
      compositionRevision: assertion.compositionRevision,
    },
  ).pipe(Effect.mapError(mapSymmyOwnerReadProblem));
  if (
    page.limit !== input.limit ||
    page.offset !== input.offset ||
    page.associations.length > input.limit ||
    page.associations.length > Math.max(0, page.count - page.offset) ||
    page.associations.some(
      ({ priceGroupRef, sourceCorrelation }) =>
        priceGroupRef.tenantId !== scope.tenantId ||
        sourceCorrelation.issuer !== scope.issuerId ||
        sourceCorrelation.routeId !== (scope.sourceRouteId ?? scope.routeId) ||
        sourceCorrelation.namespace !== scope.sourceNamespace ||
        (query.code !== undefined && sourceCorrelation.recordKey !== query.code),
    )
  ) {
    return yield* Effect.fail(symmyUnavailableProblem);
  }
  const priceLists = yield* Effect.forEach(
    page.associations,
    (association) => projectPriceList(association, source, scope, query, admission, newRequestIdentifier),
    { concurrency: 1 },
  );
  return {
    contractVersion: 'INTERNAL_C14',
    count: page.count,
    limit: page.limit,
    offset: page.offset,
    price_lists: priceLists,
    projection: 'price_lists',
    unsupported_fields: Option.isNone(source) ? ['prices'] : [],
  };
});
