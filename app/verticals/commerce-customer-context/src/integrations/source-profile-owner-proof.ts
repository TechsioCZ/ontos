import type { OperationalScope } from '@app/core-runtime';
import type { PartyRef } from '@app/party-registry/resources/party';
import {
  SourcePersonAdmissionResponseSchema,
  SourcePersonAdmissionRequestSchema,
} from '@app/party-registry/apis/source-person-admission';
import { executeSourcePersonAdmissionWithAuthorization } from '@app/party-registry/apis/source-person-admission/client';
import {
  SourceAdmissionSetRequestSchema,
  SourceAdmissionSetResponseSchema,
  SourceCounterpartyAdmissionResponseSchema,
  SourceCounterpartyAdmissionRequestSchema,
} from '@app/party-registry/apis/source-counterparty-admission';
import type {
  SourceCounterpartyAdmissionRequest,
  SourceCounterpartyAdmissionResponse,
} from '@app/party-registry/apis/source-counterparty-admission';
import type {
  SourcePersonAdmissionRequest,
  SourcePersonAdmissionResponse,
} from '@app/party-registry/apis/source-person-admission';
import {
  executeSourceAdmissionSetWithAuthorization,
  executeSourceCounterpartyAdmissionWithAuthorization,
} from '@app/party-registry/apis/source-counterparty-admission/client';
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
/** One customer of a source page whose current admission the Party owner proves. */
export type SourceProfileAdmissionItem =
  | Readonly<{
      counterpartyResourceId: string;
      kind: 'COUNTERPARTY';
      partySourceReference: CustomerProfilePartySourceReference;
    }>
  | Readonly<{ kind: 'RETAIL'; partyRef: PartyRef; partySourceReference: CustomerProfilePartySourceReference }>;
export type SourceProfileAdmission =
  | Readonly<{ kind: 'COUNTERPARTY'; proof: CounterpartyProof }>
  | Readonly<{ kind: 'RETAIL'; proof: RetailProof }>;

const counterpartyProofOf = (
  scope: OperationalScope,
  counterpartyResourceId: string,
  request: SourceCounterpartyAdmissionRequest,
  result: SourceCounterpartyAdmissionResponse,
): CounterpartyProof =>
  result.outcome === 'CUSTOMER_CURRENT' &&
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
const retailProofOf = (
  scope: OperationalScope,
  partyRef: PartyRef,
  request: SourcePersonAdmissionRequest,
  result: SourcePersonAdmissionResponse,
): RetailProof =>
  result.outcome === 'SOURCE_PERSON_CURRENT' &&
  result.partyRef.tenantId === scope.tenantId &&
  result.partyRef.resourceId === partyRef.resourceId
    ? {
        currentAdmission: { ...result, sourceReference: request.sourceReference },
        outcome: 'CURRENT_PARTY_RESOLVED' as const,
        partyResourceId: result.partyRef.resourceId,
        partyResourceRevision: String(result.partyRevision),
      }
    : { outcome: 'INVALID_OR_INSUFFICIENT_EVIDENCE' as const };

export interface CommerceSourceProfileOwnerProofService {
  /**
   * The current admission of every customer of a source page in one Party owner call, in their order, each judged as
   * `counterparty` or `retail` judges its own.
   */
  readonly admissionSet: (
    scope: OperationalScope,
    items: readonly SourceProfileAdmissionItem[],
    operationRequirementKey: string,
  ) => Effect.Effect<readonly SourceProfileAdmission[], ProfilePersistenceDependencyFailure>;
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
          ).pipe(commerceCustomerContextEvidenceCall.sourceCounterpartyAdmission, Effect.mapError(ownerProofFailure));
          const response = yield* executeSourceCounterpartyAdmissionWithAuthorization(
            request,
            issued.authorization,
            scope.correlationId,
            { baseUrl: new URL(issued.apiBaseUrl), compositionRevision: issued.compositionRevision },
          ).pipe(commerceCustomerContextEvidenceCall.sourceCounterpartyAdmission, Effect.mapError(ownerProofFailure));
          const result = yield* Schema.decodeUnknownEffect(SourceCounterpartyAdmissionResponseSchema)(response).pipe(
            Effect.mapError(ownerProofFailure),
          );
          return counterpartyProofOf(scope, counterpartyResourceId, request, result);
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
          return retailProofOf(scope, partyRef, request, result);
        },
      ),
      admissionSet: Effect.fn('CommerceSourceProfileOwnerProof.admissionSet')(
        function* admissionSet(scope, items, operationRequirementKey) {
          if (items.length === 0) {
            return [];
          }
          const request = yield* Schema.decodeUnknownEffect(SourceAdmissionSetRequestSchema)({
            items: items.map((item) =>
              item.kind === 'COUNTERPARTY'
                ? {
                    counterpartyRef: {
                      moduleId: 'party.registry',
                      resourceId: item.counterpartyResourceId,
                      resourceType: 'party.registry.counterparty',
                      tenantId: scope.tenantId,
                    },
                    kind: 'COUNTERPARTY',
                    sourceReference: item.partySourceReference,
                  }
                : { kind: 'PERSON', partyRef: item.partyRef, sourceReference: item.partySourceReference },
            ),
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
                'party.registry.source-admission-set.read',
                request,
                operationRequirementKey,
              ),
            },
            crypto,
          ).pipe(commerceCustomerContextEvidenceCall.sourceCounterpartyAdmission, Effect.mapError(ownerProofFailure));
          const response = yield* executeSourceAdmissionSetWithAuthorization(
            request,
            issued.authorization,
            scope.correlationId,
            { baseUrl: new URL(issued.apiBaseUrl), compositionRevision: issued.compositionRevision },
          ).pipe(commerceCustomerContextEvidenceCall.sourceCounterpartyAdmission, Effect.mapError(ownerProofFailure));
          const result = yield* Schema.decodeUnknownEffect(SourceAdmissionSetResponseSchema)(response).pipe(
            Effect.mapError(ownerProofFailure),
          );
          if (result.items.length !== request.items.length) {
            return yield* Effect.fail(ownerProofFailure(undefined));
          }
          return yield* Effect.forEach(
            request.items,
            (asked, index): Effect.Effect<SourceProfileAdmission, ProfilePersistenceDependencyFailure> => {
              const answer = result.items[index];
              if (asked.kind === 'COUNTERPARTY' && answer?.kind === 'COUNTERPARTY') {
                return Effect.succeed({
                  kind: 'COUNTERPARTY',
                  proof: counterpartyProofOf(scope, asked.counterpartyRef.resourceId, asked, answer.result),
                });
              }
              if (asked.kind === 'PERSON' && answer?.kind === 'PERSON') {
                return Effect.succeed({
                  kind: 'RETAIL',
                  proof: retailProofOf(scope, asked.partyRef, asked, answer.result),
                });
              }
              return Effect.fail(ownerProofFailure(undefined));
            },
          );
        },
      ),
    };
  }),
);
