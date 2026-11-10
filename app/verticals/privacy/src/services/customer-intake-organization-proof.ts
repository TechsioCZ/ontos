import { ReadHandlerUnavailable, requireModuleOperation } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { CustomerProfileOrganizationIcoFactsCurrentSchema } from '@app/commerce-customer-context/api/customer-profile-organization-ico-facts';
import { CounterpartyPurchasingProfileRefSchema } from '@app/commerce-customer-context/resources/counterparty-purchasing-profile';
import { OrganizationRecordFactsResponseSchema } from '@app/party-registry/apis/organization-record-facts';
import { executeOrganizationRecordFactsWithAuthorization } from '@app/party-registry/apis/organization-record-facts/client';
import { PartyRefSchema } from '@app/party-registry/resources/party';
import { acquireDelegatedGatewayContext } from '@app/shared-contracts/gateway-context-server';
import { Effect, Option, Redacted, Schema } from 'effect';
import type { Crypto } from 'effect';
import type { SourceProcessingEligibilityRequest } from '../../shared/apis/source-processing-eligibility.ts';
import { readOrganizationProfileOwnerFacts } from './organization-business-applicability.service.ts';

const unavailable = (cause: unknown) =>
  Object.defineProperty(
    new ReadHandlerUnavailable({
      code: 'read_handler_unavailable',
      reason: 'Current customer intake organization proof is unavailable',
    }),
    'cause',
    { value: Redacted.make(cause) },
  );

const acquire = Effect.fn('Privacy.customerIntakeOrganizationAuthority')(function* acquire(
  audience: 'commerce-customer-context' | 'party-registry',
  scope: OperationalScope,
  crypto: Crypto.Crypto,
) {
  yield* requireModuleOperation(
    audience === 'commerce-customer-context'
      ? 'privacy.core.requirement.customer-intake-organization-profile'
      : 'privacy.core.requirement.customer-intake-organization-party',
  );
  return yield* acquireDelegatedGatewayContext(
    {
      audience,
      legalEntityScope: 'subject',
      requestCorrelation: scope.correlationId,
      subject: { _tag: 'Assertion', scope },
    },
    crypto,
  );
});

const profileParty = Effect.fn('Privacy.customerIntakeOrganizationProfileParty')(function* profileParty(
  resourceId: string,
  scope: OperationalScope,
  crypto: Crypto.Crypto,
) {
  const profileRef = yield* Schema.decodeUnknownEffect(CounterpartyPurchasingProfileRefSchema)({
    moduleId: 'commerce.customer-context',
    resourceId,
    resourceType: 'commerce.customer-context.counterparty-purchasing-profile',
    tenantId: scope.tenantId,
  });
  const gateway = yield* acquire('commerce-customer-context', scope, crypto);
  const result = yield* readOrganizationProfileOwnerFacts({ profileRef }, gateway, scope);
  return Schema.is(CustomerProfileOrganizationIcoFactsCurrentSchema)(result) &&
    Schema.toEquivalence(CounterpartyPurchasingProfileRefSchema)(result.profileRef, profileRef) &&
    result.legalEntityRef.resourceId === scope.legalEntityId &&
    result.legalEntityRef.tenantId === scope.tenantId &&
    result.partyRef.tenantId === scope.tenantId
    ? Option.some(result.partyRef)
    : Option.none();
});

/** Existing native owner reads prove the current canonical organization and original source correlation. */
export const hasCurrentCustomerIntakeOrganizationProof = Effect.fn('Privacy.customerIntakeOrganizationProof')(
  function* currentOrganization(
    request: SourceProcessingEligibilityRequest,
    scope: OperationalScope,
    crypto: Crypto.Crypto,
  ) {
    const { source, target } = request;
    if (source === null || target === null || scope.authMethod !== 'api_key') {
      return false;
    }
    const party = yield* (
      target.kind === 'PARTY'
        ? Schema.decodeUnknownEffect(PartyRefSchema)({
            moduleId: 'party.registry',
            resourceId: target.resourceId,
            resourceType: 'party.registry.party',
            tenantId: scope.tenantId,
          }).pipe(Effect.map(Option.some))
        : profileParty(target.resourceId, scope, crypto)
    ).pipe(Effect.mapError(unavailable));
    if (Option.isNone(party)) {
      return false;
    }
    const gateway = yield* acquire('party-registry', scope, crypto).pipe(Effect.mapError(unavailable));
    const result = yield* executeOrganizationRecordFactsWithAuthorization(
      {
        partyRef: party.value,
        sourceRecord: {
          recordId: source.recordId,
          source: {
            issuer: source.issuer,
            namespace: source.namespace,
            recordType: source.recordType,
            routeRef: source.routeRef,
          },
        },
        target: 'PARTY',
      },
      gateway.authorization,
      scope.correlationId,
      { baseUrl: gateway.apiBaseUrl, compositionRevision: gateway.compositionRevision },
    ).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(OrganizationRecordFactsResponseSchema)),
      Effect.mapError(unavailable),
    );
    return (
      result.outcome === 'CURRENT_ORGANIZATION' &&
      Schema.toEquivalence(PartyRefSchema)(result.partyRef, party.value) &&
      result.sourceCitation !== null
    );
  },
);
