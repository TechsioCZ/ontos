import type { OperationalScope } from '@app/core-runtime';
import type { PartyRef } from '@app/party-registry/resources/party';
import {
  SourcePersonAdmissionResponseSchema,
  SourcePersonAdmissionRequestSchema,
} from '@app/party-registry/apis/source-person-admission';
import { executeSourcePersonAdmissionWithAuthorization } from '@app/party-registry/apis/source-person-admission/client';
import {
  SourceCounterpartyAdmissionResponseSchema,
  SourceCounterpartyAdmissionRequestSchema,
} from '@app/party-registry/apis/source-counterparty-admission';
import { executeSourceCounterpartyAdmissionWithAuthorization } from '@app/party-registry/apis/source-counterparty-admission/client';
import { acquireDelegatedGatewayContext } from '@app/shared-contracts/gateway-context-server';
import { Context, Crypto, Effect, Layer, Schema } from 'effect';
import type {
  CustomerProfileCurrentPersonAdmission,
  CustomerProfileCurrentCounterpartyAdmission,
  CustomerProfilePartySourceReference,
  CustomerProfileSourceAssertion,
} from '../../shared/domain/customer-profile-source.ts';
import { commerceSourceDelegationSubject } from './source-delegation-subject.ts';
import { ProfilePersistenceDependencyFailure } from '../persistence/profile-persistence.ts';
import type { CounterpartyRoleEligibility } from '../persistence/profile-persistence.ts';
import { commerceCustomerContextEvidenceCall } from '../declared-evidence-calls.ts';

const ownerProofFailure = (cause: unknown) =>
  Object.defineProperty(
    new ProfilePersistenceDependencyFailure({ reason: 'Current source-qualified Party owner proof is unavailable' }),
    'cause',
    { configurable: true, value: cause },
  );

type RetailProof =
  | Readonly<{
      currentAdmission: CustomerProfileCurrentPersonAdmission;
      outcome: 'CURRENT_PARTY_RESOLVED';
      partyResourceId: string;
      partyResourceRevision: string;
    }>
  | Readonly<{ outcome: 'INVALID_OR_INSUFFICIENT_EVIDENCE' }>;
type CounterpartyProof =
  | (Extract<CounterpartyRoleEligibility, { readonly outcome: 'ELIGIBLE' }> & {
      readonly currentAdmission: CustomerProfileCurrentCounterpartyAdmission;
    })
  | Exclude<CounterpartyRoleEligibility, { readonly outcome: 'ELIGIBLE' }>;
export interface CommerceSourceProfileOwnerProofService {
  readonly counterparty: (
    scope: OperationalScope,
    counterpartyResourceId: string,
    source: CustomerProfileSourceAssertion,
    partySourceReference: CustomerProfilePartySourceReference,
    operationRequirementKey: string,
  ) => Effect.Effect<CounterpartyProof, ProfilePersistenceDependencyFailure>;
  readonly retail: (
    scope: OperationalScope,
    partyRef: PartyRef,
    source: CustomerProfileSourceAssertion,
    partySourceReference: CustomerProfilePartySourceReference,
    operationRequirementKey: string,
  ) => Effect.Effect<RetailProof, ProfilePersistenceDependencyFailure>;
}
export class CommerceSourceProfileOwnerProof extends Context.Service<
  CommerceSourceProfileOwnerProof,
  CommerceSourceProfileOwnerProofService
>()('@app/commerce-customer-context/integrations/source-profile-owner-proof/CommerceSourceProfileOwnerProof') {}
export const commerceSourceProfileOwnerProofLive = Layer.effect(
  CommerceSourceProfileOwnerProof,
  Effect.gen(function* sourceProfileOwnerProof() {
    const crypto = yield* Crypto.Crypto;
    return {
      counterparty: Effect.fn('CommerceSourceProfileOwnerProof.counterparty')(
        function* counterparty(scope, counterpartyResourceId, _source, partySourceReference, operationRequirementKey) {
          const request = yield* Schema.decodeUnknownEffect(SourceCounterpartyAdmissionRequestSchema)({
            counterpartyRef: {
              moduleId: 'party.registry',
              resourceId: counterpartyResourceId,
              resourceType: 'party.registry.counterparty',
              tenantId: scope.tenantId,
            },
            sourceReference: partySourceReference,
          }).pipe(Effect.mapError(ownerProofFailure));
          // Declared in-transaction evidence call (demo divergence, DEPLOYMENT.md); see ../declared-evidence-calls.ts.
          const issued = yield* acquireDelegatedGatewayContext(
            {
              audience: 'party-registry',
              callingAppId: 'commerce-customer-context',
              legalEntityScope: 'subject',
              requestCorrelation: scope.correlationId,
              subject: commerceSourceDelegationSubject(
                scope,
                'party.registry.source-counterparty-admission.read',
                request,
                operationRequirementKey,
              ),
            },
            crypto,
          ).pipe(
            commerceCustomerContextEvidenceCall.sourceCounterpartyAdmission,
            Effect.mapError(ownerProofFailure),
          );
          const response = yield* executeSourceCounterpartyAdmissionWithAuthorization(
            request,
            issued.authorization,
            scope.correlationId,
            { baseUrl: new URL(issued.apiBaseUrl), compositionRevision: issued.compositionRevision },
          ).pipe(
            commerceCustomerContextEvidenceCall.sourceCounterpartyAdmission,
            Effect.mapError(ownerProofFailure),
          );
          const result = yield* Schema.decodeUnknownEffect(SourceCounterpartyAdmissionResponseSchema)(response).pipe(
            Effect.mapError(ownerProofFailure),
          );
          return result.outcome === 'CUSTOMER_CURRENT' &&
            result.counterpartyRef.resourceId === counterpartyResourceId &&
            result.counterpartyRef.tenantId === scope.tenantId &&
            result.partyRef.tenantId === scope.tenantId &&
            result.legalEntityRef.tenantId === scope.tenantId &&
            result.legalEntityRef.resourceId === scope.legalEntityId &&
            result.currentCustomerRoleRef.tenantId === scope.tenantId
            ? {
                counterpartyResourceRevision: result.counterpartyRevision,
                currentAdmission: { ...result, sourceReference: request.sourceReference },
                managedLegalEntityId: result.legalEntityRef.resourceId,
                outcome: 'ELIGIBLE' as const,
                partyResourceId: result.partyRef.resourceId,
                partyResourceRevision: String(result.partyRevision),
                roleResourceId: result.currentCustomerRoleRef.resourceId,
                roleResourceRevision: result.currentCustomerRoleRevision,
              }
            : { outcome: 'INELIGIBLE' as const };
        },
      ),
      retail: Effect.fn('CommerceSourceProfileOwnerProof.retail')(
        function* retail(scope, partyRef, _source, partySourceReference, operationRequirementKey) {
          const request = yield* Schema.decodeUnknownEffect(SourcePersonAdmissionRequestSchema)({
            partyRef,
            sourceReference: partySourceReference,
          }).pipe(Effect.mapError(ownerProofFailure));
          const issued = yield* acquireDelegatedGatewayContext(
            {
              audience: 'party-registry',
              callingAppId: 'commerce-customer-context',
              legalEntityScope: 'subject',
              requestCorrelation: scope.correlationId,
              subject: commerceSourceDelegationSubject(
                scope,
                'party.registry.source-person-admission.read',
                request,
                operationRequirementKey,
              ),
            },
            crypto,
          ).pipe(commerceCustomerContextEvidenceCall.sourcePersonAdmission, Effect.mapError(ownerProofFailure));
          const response = yield* executeSourcePersonAdmissionWithAuthorization(
            request,
            issued.authorization,
            scope.correlationId,
            { baseUrl: new URL(issued.apiBaseUrl), compositionRevision: issued.compositionRevision },
          ).pipe(commerceCustomerContextEvidenceCall.sourcePersonAdmission, Effect.mapError(ownerProofFailure));
          const result = yield* Schema.decodeUnknownEffect(SourcePersonAdmissionResponseSchema)(response).pipe(
            Effect.mapError(ownerProofFailure),
          );
          return result.outcome === 'SOURCE_PERSON_CURRENT' &&
            result.partyRef.tenantId === scope.tenantId &&
            result.partyRef.resourceId === partyRef.resourceId
            ? {
                currentAdmission: { ...result, sourceReference: request.sourceReference },
                outcome: 'CURRENT_PARTY_RESOLVED' as const,
                partyResourceId: result.partyRef.resourceId,
                partyResourceRevision: String(result.partyRevision),
              }
            : { outcome: 'INVALID_OR_INSUFFICIENT_EVIDENCE' as const };
        },
      ),
    };
  }),
);
