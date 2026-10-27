import {
  MicroVerticalBuildMarkerSchema,
  MicroVerticalReadinessSchema,
  createMicroVerticalOperationContext,
} from '@modern-js/bff-effect/microvertical-api';
import type { MicroVerticalOperationContext } from '@modern-js/bff-effect/microvertical-api';
import { HttpApi, HttpApiEndpoint, HttpApiGroup, Schema } from '@modern-js/bff-effect/effect-client';
import { Brand, identity } from 'effect';

// <generated-governed-http-api-imports>
import { AresLookupApi } from './apis/ares-lookup.ts';
import { CounterpartiesSearchApi } from './apis/counterparties-search.ts';
import { CounterpartyReadApi } from './apis/counterparty-read.ts';
import { CounterpartyRoleHistoryApi } from './apis/counterparty-role-history.ts';
import { CustomerListApi } from './apis/customer-list.ts';
import { DuplicateCandidateDetailApi } from './apis/duplicate-candidate-detail.ts';
import { DuplicateCandidateListApi } from './apis/duplicate-candidate-list.ts';
import { ExecutePrivacyMeasureActionApi } from './apis/execute-privacy-measure-action.ts';
import { GuestPartyResolutionApi } from './apis/guest-party-resolution.ts';
import { OrganizationEngagementProfileApi } from './apis/organization-engagement-profile.ts';
import { PartiesSearchApi } from './apis/parties-search.ts';
import { PartyContactPointDetailApi } from './apis/party-contact-point-detail.ts';
import { PartyContactPointsApi } from './apis/party-contact-points.ts';
import { PartyCorrectionApi } from './apis/party-correction.ts';
import { PartyDetailApi } from './apis/party-detail.ts';
import { PartyMatchApi } from './apis/party-match.ts';
import { PartyMatchDecisionApi } from './apis/party-match-decision.ts';
import { PartyMergeReadinessApi } from './apis/party-merge-readiness.ts';
import { PartyOfficialIdentifierDetailApi } from './apis/party-official-identifier-detail.ts';
import { PartyOfficialIdentifierHistoryApi } from './apis/party-official-identifier-history.ts';
import { PartyRelationshipDetailApi } from './apis/party-relationship-detail.ts';
import { PersonEngagementProfileApi } from './apis/person-engagement-profile.ts';
import { PrivacyMeasureExecutionApi } from './apis/privacy-measure-execution.ts';
// </generated-governed-http-api-imports>
import { partyRegistryCommandRecoveryApi, partyRegistryCommandsApi } from './command-api.ts';
import { organizationEngagementMutationApi, personEngagementMutationApi } from './engagement-profile-api.ts';

export {
  AcceptRetailEnrollmentEvidencePayloadSchema,
  AcceptRetailEnrollmentEvidenceResultSchema,
  RetailEnrollmentEvidenceSchema,
  AddContactPointPayloadSchema,
  AddContactPointResultSchema,
  AddPartyOfficialIdentifierPayloadSchema,
  AddPartyOfficialIdentifierResultSchema,
  ArchivePartyPayloadSchema,
  ArchivePartyResultSchema,
  ConfirmDuplicatePartiesPayloadSchema,
  ConfirmDuplicatePartiesResultSchema,
  CorrectPartyFactPayloadSchema,
  CorrectPartyFactResultSchema,
  CounterpartyCustomerOnboardPayloadSchema,
  CounterpartyCustomerOnboardResultSchema,
  CounterpartyCreatePayloadSchema,
  CounterpartyCreateResultSchema,
  CounterpartyRoleAddPayloadSchema,
  CounterpartyRoleAddResultSchema,
  CounterpartyRoleEndPayloadSchema,
  CounterpartyRoleEndResultSchema,
  CreatePartyRelationshipPayloadSchema,
  CreatePartyRelationshipResultSchema,
  CreatePartyPayloadJsonSchema,
  CreatePartyPayloadSchema,
  CreatePartyResultSchema,
  DismissDuplicateCandidatePayloadSchema,
  DismissDuplicateCandidateResultSchema,
  EndContactPointPayloadSchema,
  EndContactPointResultSchema,
  EndPartyOfficialIdentifierPayloadSchema,
  EndPartyOfficialIdentifierResultSchema,
  EndPartyRelationshipPayloadSchema,
  EndPartyRelationshipResultSchema,
  MarkDuplicateCandidateNeedsEvidencePayloadSchema,
  MarkDuplicateCandidateNeedsEvidenceResultSchema,
  MatchPartyPayloadSchema,
  MatchPartyResultSchema,
  RequestSearchRebuildPayloadSchema,
  RequestSearchRebuildResultSchema,
  ResolveDuplicateCandidateCreatePayloadSchema,
  ResolveDuplicateCandidateCreateResultSchema,
  ResolveDuplicateCandidateMatchPayloadSchema,
  ResolveDuplicateCandidateMatchResultSchema,
  UnarchivePartyPayloadSchema,
  UnarchivePartyResultSchema,
  UpdateContactPointPayloadSchema,
  UpdateContactPointResultSchema,
  UpdatePartyOfficialIdentifierPayloadSchema,
  UpdatePartyOfficialIdentifierResultSchema,
  UpdatePartyRelationshipPayloadSchema,
  UpdatePartyRelationshipResultSchema,
  UpdatePartyPayloadSchema,
  UpdatePartyResultSchema,
  PartyCommandInvalidRequestProblemSchema,
  PartyCommandSchemaErrorMiddleware,
  PartyCommandAuthenticationProblemSchema,
  PartyCommandForbiddenProblemSchema,
  PartyCommandNotFoundProblemSchema,
  PartyCommandConflictProblemSchema,
  PartyCommandUnprocessableProblemSchema,
  PartyCommandPreconditionRequiredProblemSchema,
  PartyCommandUnavailableProblemSchema,
  PartyCommandAlreadyCommittedProblemSchema,
  PartyCommandCommitIndeterminateProblemSchema,
  DuplicateCandidateResolutionActionKeySchema,
  ResolvePartyCommandCommitPayloadSchema,
  ResolvePartyCommandCommitResultSchema,
  PartyCommandInternalProblemSchema,
  PartyCommandAliasWriteRejectedProblemSchema,
  partyRegistryCommandsApi,
  partyRegistryCommandRecoveryApi,
} from './command-api.ts';
export type {
  AcceptRetailEnrollmentEvidencePayload,
  RetailEnrollmentEvidence,
  AddContactPointPayload,
  AddPartyOfficialIdentifierPayload,
  ArchivePartyPayload,
  ConfirmDuplicatePartiesPayload,
  CorrectPartyFactPayload,
  CounterpartyCustomerOnboardPayload,
  CounterpartyCreatePayload,
  CounterpartyRoleAddPayload,
  CounterpartyRoleEndPayload,
  CreatePartyRelationshipPayload,
  CreatePartyPayload,
  DismissDuplicateCandidatePayload,
  EndContactPointPayload,
  EndPartyOfficialIdentifierPayload,
  EndPartyRelationshipPayload,
  MarkDuplicateCandidateNeedsEvidencePayload,
  MatchPartyPayload,
  RequestSearchRebuildPayload,
  ResolveDuplicateCandidateCreatePayload,
  ResolveDuplicateCandidateMatchPayload,
  UnarchivePartyPayload,
  UpdateContactPointPayload,
  UpdatePartyOfficialIdentifierPayload,
  UpdatePartyRelationshipPayload,
  UpdatePartyPayload,
  ResolvePartyCommandCommitPayload,
  ResolvePartyCommandCommitResult,
  PartyCommandProblem,
} from './command-api.ts';
export {
  EngagementProfileIdSchema,
  EngagementProfileNotFound,
  EngagementProfileConflict,
  EngagementProfilePersistenceUnavailable,
  PartyRegistryReferenceUnavailable,
  EngagementIsoTimestampSchema,
  OrganizationEngagementProfileSchema,
  PersonEngagementProfileSchema,
  AttachOrganizationEngagementPayloadSchema,
  AttachPersonEngagementPayloadSchema,
  OrganizationEngagementLifecyclePayloadSchema,
  PersonEngagementLifecyclePayloadSchema,
  OrganizationEngagementProfileRequestSchema,
  OrganizationEngagementProfileResponseSchema,
  OrganizationEngagementProfileAuthenticationProblemSchema,
  OrganizationEngagementProfileInvalidProblemSchema,
  OrganizationEngagementProfileUnavailableProblemSchema,
  OrganizationEngagementProfileForbiddenProblemSchema,
  OrganizationEngagementProfileNotFoundProblemSchema,
  OrganizationEngagementProfilePolicyProblemSchema,
  OrganizationEngagementProfilePolicyConflictProblemSchema,
  OrganizationEngagementProfileInternalProblemSchema,
  OrganizationEngagementProfileApi,
  PersonEngagementProfileRequestSchema,
  PersonEngagementProfileResponseSchema,
  PersonEngagementProfileAuthenticationProblemSchema,
  PersonEngagementProfileInvalidProblemSchema,
  PersonEngagementProfileUnavailableProblemSchema,
  PersonEngagementProfileForbiddenProblemSchema,
  PersonEngagementProfileNotFoundProblemSchema,
  PersonEngagementProfilePolicyProblemSchema,
  PersonEngagementProfilePolicyConflictProblemSchema,
  PersonEngagementProfileInternalProblemSchema,
  PersonEngagementProfileApi,
  ContactsInvalidRequestProblemSchema,
  ContactsAuthenticationProblemSchema,
  ContactsForbiddenProblemSchema,
  ContactsNotFoundProblemSchema,
  ContactsConflictProblemSchema,
  ContactsPreconditionRequiredProblemSchema,
  ContactsUnavailableProblemSchema,
  ContactsInternalProblemSchema,
  organizationEngagementMutationApi,
  personEngagementMutationApi,
  engagementProfileOperationContexts,
} from './engagement-profile-api.ts';
export type {
  OrganizationEngagementProfile,
  PersonEngagementProfile,
  AttachOrganizationEngagementPayload,
  AttachPersonEngagementPayload,
  OrganizationEngagementLifecyclePayload,
  PersonEngagementLifecyclePayload,
  OrganizationEngagementProfileRequest,
  OrganizationEngagementProfileResponse,
  PersonEngagementProfileRequest,
  PersonEngagementProfileResponse,
  ContactsProblem,
} from './engagement-profile-api.ts';
export { normalizePhone } from './domain/contact-point.ts';
export type { NormalizedPhone } from './domain/contact-point.ts';
export { customerSegmentDefinitions } from './domain/customer-segment-definitions.ts';
export type { CustomerSegmentCode, CustomerSegmentDefinition } from './domain/customer-segment-definitions.ts';

export {
  AresLookupRequestSchema,
  AresLookupResponseSchema,
  AresLookupInvalidProblemSchema,
  AresLookupAuthenticationProblemSchema,
  AresLookupForbiddenProblemSchema,
  AresLookupNotFoundProblemSchema,
  AresLookupPolicyConflictProblemSchema,
  AresLookupPolicyProblemSchema,
  AresLookupUnavailableProblemSchema,
  AresLookupInternalProblemSchema,
  AresLookupApi,
} from './apis/ares-lookup.ts';
export type { AresLookupRequest, AresLookupResponse } from './apis/ares-lookup.ts';
export {
  CounterpartiesProviderRequestSchema,
  CounterpartiesProviderResponseSchema,
  CounterpartiesProviderUnavailableProblemSchema,
  CounterpartiesProviderAuthenticationProblemSchema,
  CounterpartiesProviderInvalidProblemSchema,
  CounterpartiesProviderForbiddenProblemSchema,
  CounterpartiesProviderNotFoundProblemSchema,
  CounterpartiesProviderPolicyProblemSchema,
  CounterpartiesProviderPolicyConflictProblemSchema,
  CounterpartiesProviderInternalProblemSchema,
  CounterpartiesSearchApi,
} from './apis/counterparties-search.ts';
export type { CounterpartiesProviderRequest, CounterpartiesProviderResponse } from './apis/counterparties-search.ts';
export {
  CounterpartyReadRequestSchema,
  CounterpartyReadResponseSchema,
  CounterpartyReadAuthenticationProblemSchema,
  CounterpartyReadInvalidProblemSchema,
  CounterpartyReadUnavailableProblemSchema,
  CounterpartyReadForbiddenProblemSchema,
  CounterpartyReadNotFoundProblemSchema,
  CounterpartyReadPolicyProblemSchema,
  CounterpartyReadPolicyConflictProblemSchema,
  CounterpartyReadInternalProblemSchema,
  CounterpartyReadApi,
} from './apis/counterparty-read.ts';
export type { CounterpartyReadRequest, CounterpartyReadResponse } from './apis/counterparty-read.ts';
export {
  CounterpartyRoleHistoryRequestSchema,
  CounterpartyRoleHistoryResponseSchema,
  CounterpartyRoleHistoryAuthenticationProblemSchema,
  CounterpartyRoleHistoryInvalidProblemSchema,
  CounterpartyRoleHistoryUnavailableProblemSchema,
  CounterpartyRoleHistoryForbiddenProblemSchema,
  CounterpartyRoleHistoryNotFoundProblemSchema,
  CounterpartyRoleHistoryPolicyProblemSchema,
  CounterpartyRoleHistoryPolicyConflictProblemSchema,
  CounterpartyRoleHistoryInternalProblemSchema,
  CounterpartyRoleHistoryApi,
} from './apis/counterparty-role-history.ts';
export type {
  CounterpartyRoleHistoryRequest,
  CounterpartyRoleHistoryResponse,
} from './apis/counterparty-role-history.ts';
export {
  DuplicateCandidateDetailRequestSchema,
  DuplicateCandidateDetailResponseSchema,
  DuplicateCandidateDetailAuthenticationProblemSchema,
  DuplicateCandidateDetailInvalidProblemSchema,
  DuplicateCandidateDetailUnavailableProblemSchema,
  DuplicateCandidateDetailForbiddenProblemSchema,
  DuplicateCandidateDetailNotFoundProblemSchema,
  DuplicateCandidateDetailPolicyProblemSchema,
  DuplicateCandidateDetailPolicyConflictProblemSchema,
  DuplicateCandidateDetailInternalProblemSchema,
  DuplicateCandidateDetailApi,
} from './apis/duplicate-candidate-detail.ts';
export type {
  DuplicateCandidateDetailRequest,
  DuplicateCandidateDetailResponse,
} from './apis/duplicate-candidate-detail.ts';
export {
  GuestPartyResolutionRequestSchema,
  GuestPartyResolutionResponseSchema,
  GuestPartyResolutionAuthenticationProblemSchema,
  GuestPartyResolutionInvalidProblemSchema,
  GuestPartyResolutionUnavailableProblemSchema,
  GuestPartyResolutionForbiddenProblemSchema,
  GuestPartyResolutionNotFoundProblemSchema,
  GuestPartyResolutionPolicyProblemSchema,
  GuestPartyResolutionPolicyConflictProblemSchema,
  GuestPartyResolutionInternalProblemSchema,
  GuestPartyResolutionApi,
} from './apis/guest-party-resolution.ts';
export type { GuestPartyResolutionRequest, GuestPartyResolutionResponse } from './apis/guest-party-resolution.ts';
export {
  PartiesProviderRequestSchema,
  PartiesProviderResponseSchema,
  PartiesProviderUnavailableProblemSchema,
  PartiesProviderAuthenticationProblemSchema,
  PartiesProviderInvalidProblemSchema,
  PartiesProviderForbiddenProblemSchema,
  PartiesProviderNotFoundProblemSchema,
  PartiesProviderPolicyProblemSchema,
  PartiesProviderPolicyConflictProblemSchema,
  PartiesProviderInternalProblemSchema,
  PartiesSearchApi,
} from './apis/parties-search.ts';
export type { PartiesProviderRequest, PartiesProviderResponse } from './apis/parties-search.ts';
export {
  PartyContactPointDetailRequestSchema,
  PartyContactPointDetailResponseSchema,
  PartyContactPointDetailAuthenticationProblemSchema,
  PartyContactPointDetailInvalidProblemSchema,
  PartyContactPointDetailUnavailableProblemSchema,
  PartyContactPointDetailForbiddenProblemSchema,
  PartyContactPointDetailNotFoundProblemSchema,
  PartyContactPointDetailPolicyProblemSchema,
  PartyContactPointDetailPolicyConflictProblemSchema,
  PartyContactPointDetailInternalProblemSchema,
  PartyContactPointDetailApi,
} from './apis/party-contact-point-detail.ts';
export type {
  PartyContactPointDetailRequest,
  PartyContactPointDetailResponse,
} from './apis/party-contact-point-detail.ts';
export {
  PartyContactPointsRequestSchema,
  PartyContactPointsResponseSchema,
  PartyContactPointsAuthenticationProblemSchema,
  PartyContactPointsInvalidProblemSchema,
  PartyContactPointsUnavailableProblemSchema,
  PartyContactPointsForbiddenProblemSchema,
  PartyContactPointsNotFoundProblemSchema,
  PartyContactPointsPolicyProblemSchema,
  PartyContactPointsPolicyConflictProblemSchema,
  PartyContactPointsInternalProblemSchema,
  PartyContactPointsApi,
} from './apis/party-contact-points.ts';
export type { PartyContactPointsRequest, PartyContactPointsResponse } from './apis/party-contact-points.ts';
export {
  PartyCorrectionRequestSchema,
  PartyCorrectionResponseSchema,
  PartyCorrectionAuthenticationProblemSchema,
  PartyCorrectionInvalidProblemSchema,
  PartyCorrectionUnavailableProblemSchema,
  PartyCorrectionForbiddenProblemSchema,
  PartyCorrectionNotFoundProblemSchema,
  PartyCorrectionPolicyProblemSchema,
  PartyCorrectionPolicyConflictProblemSchema,
  PartyCorrectionInternalProblemSchema,
  PartyCorrectionApi,
} from './apis/party-correction.ts';
export type { PartyCorrectionRequest, PartyCorrectionResponse } from './apis/party-correction.ts';
export {
  PartyDetailRequestSchema,
  PartyFactAssertionSchema,
  PartyDetailResolutionSchema,
  PartyDetailResponseSchema,
  PartyDetailAuthenticationProblemSchema,
  PartyDetailInvalidProblemSchema,
  PartyDetailUnavailableProblemSchema,
  PartyDetailForbiddenProblemSchema,
  PartyDetailNotFoundProblemSchema,
  PartyDetailPolicyProblemSchema,
  PartyDetailPolicyConflictProblemSchema,
  PartyDetailInternalProblemSchema,
  PartyDetailApi,
} from './apis/party-detail.ts';
export type {
  PartyDetailRequest,
  PartyFactAssertion,
  PartyDetailResolution,
  PartyDetailResponse,
} from './apis/party-detail.ts';
export {
  PartyMatchDecisionRequestSchema,
  PartyMatchDecisionResponseSchema,
  PartyMatchDecisionAuthenticationProblemSchema,
  PartyMatchDecisionInvalidProblemSchema,
  PartyMatchDecisionUnavailableProblemSchema,
  PartyMatchDecisionForbiddenProblemSchema,
  PartyMatchDecisionNotFoundProblemSchema,
  PartyMatchDecisionPolicyProblemSchema,
  PartyMatchDecisionPolicyConflictProblemSchema,
  PartyMatchDecisionInternalProblemSchema,
  PartyMatchDecisionApi,
} from './apis/party-match-decision.ts';
export type { PartyMatchDecisionRequest, PartyMatchDecisionResponse } from './apis/party-match-decision.ts';
export {
  PartyMatchRequestSchema,
  PartyMatchResponseSchema,
  PartyMatchAuthenticationProblemSchema,
  PartyMatchInvalidProblemSchema,
  PartyMatchUnavailableProblemSchema,
  PartyMatchForbiddenProblemSchema,
  PartyMatchNotFoundProblemSchema,
  PartyMatchPolicyProblemSchema,
  PartyMatchPolicyConflictProblemSchema,
  PartyMatchInternalProblemSchema,
  PartyMatchApi,
} from './apis/party-match.ts';
export type { PartyMatchRequest, PartyMatchResponse } from './apis/party-match.ts';
export {
  PartyMergeReadinessRequestSchema,
  PartyMergeReadinessResponseSchema,
  PartyMergeReadinessAuthenticationProblemSchema,
  PartyMergeReadinessInvalidProblemSchema,
  PartyMergeReadinessUnavailableProblemSchema,
  PartyMergeReadinessForbiddenProblemSchema,
  PartyMergeReadinessNotFoundProblemSchema,
  PartyMergeReadinessPolicyProblemSchema,
  PartyMergeReadinessPolicyConflictProblemSchema,
  PartyMergeReadinessInternalProblemSchema,
  PartyMergeReadinessApi,
} from './apis/party-merge-readiness.ts';
export type { PartyMergeReadinessRequest, PartyMergeReadinessResponse } from './apis/party-merge-readiness.ts';
export {
  PartyOfficialIdentifierDetailRequestSchema,
  PartyOfficialIdentifierDetailResponseSchema,
  PartyOfficialIdentifierDetailAuthenticationProblemSchema,
  PartyOfficialIdentifierDetailInvalidProblemSchema,
  PartyOfficialIdentifierDetailUnavailableProblemSchema,
  PartyOfficialIdentifierDetailForbiddenProblemSchema,
  PartyOfficialIdentifierDetailNotFoundProblemSchema,
  PartyOfficialIdentifierDetailPolicyProblemSchema,
  PartyOfficialIdentifierDetailPolicyConflictProblemSchema,
  PartyOfficialIdentifierDetailInternalProblemSchema,
  PartyOfficialIdentifierDetailApi,
} from './apis/party-official-identifier-detail.ts';
export type {
  PartyOfficialIdentifierDetailRequest,
  PartyOfficialIdentifierDetailResponse,
} from './apis/party-official-identifier-detail.ts';
export {
  PartyOfficialIdentifierHistoryRequestSchema,
  PartyOfficialIdentifierHistoryResponseSchema,
  PartyOfficialIdentifierHistoryAuthenticationProblemSchema,
  PartyOfficialIdentifierHistoryInvalidProblemSchema,
  PartyOfficialIdentifierHistoryUnavailableProblemSchema,
  PartyOfficialIdentifierHistoryForbiddenProblemSchema,
  PartyOfficialIdentifierHistoryNotFoundProblemSchema,
  PartyOfficialIdentifierHistoryPolicyProblemSchema,
  PartyOfficialIdentifierHistoryPolicyConflictProblemSchema,
  PartyOfficialIdentifierHistoryInternalProblemSchema,
  PartyOfficialIdentifierHistoryApi,
} from './apis/party-official-identifier-history.ts';
export type {
  PartyOfficialIdentifierHistoryRequest,
  PartyOfficialIdentifierHistoryResponse,
} from './apis/party-official-identifier-history.ts';
export {
  PartyRelationshipDetailRequestSchema,
  PartyRelationshipDetailResponseSchema,
  PartyRelationshipDetailAuthenticationProblemSchema,
  PartyRelationshipDetailInvalidProblemSchema,
  PartyRelationshipDetailUnavailableProblemSchema,
  PartyRelationshipDetailForbiddenProblemSchema,
  PartyRelationshipDetailNotFoundProblemSchema,
  PartyRelationshipDetailPolicyProblemSchema,
  PartyRelationshipDetailPolicyConflictProblemSchema,
  PartyRelationshipDetailInternalProblemSchema,
  PartyRelationshipDetailApi,
} from './apis/party-relationship-detail.ts';
export type {
  PartyRelationshipDetailRequest,
  PartyRelationshipDetailResponse,
} from './apis/party-relationship-detail.ts';
export {
  ExecutePrivacyMeasurePayloadSchema,
  ExecutePrivacyMeasureActionInvalidProblemSchema,
  ExecutePrivacyMeasureActionAuthenticationProblemSchema,
  ExecutePrivacyMeasureActionForbiddenProblemSchema,
  ExecutePrivacyMeasureActionNotFoundProblemSchema,
  ExecutePrivacyMeasureActionConflictProblemSchema,
  ExecutePrivacyMeasureActionIneligibleProblemSchema,
  ExecutePrivacyMeasureActionPreconditionProblemSchema,
  ExecutePrivacyMeasureActionUnavailableProblemSchema,
  ExecutePrivacyMeasureActionAlreadyCommittedProblemSchema,
  ExecutePrivacyMeasureActionCommitIndeterminateProblemSchema,
  ExecutePrivacyMeasureActionInternalProblemSchema,
  ExecutePrivacyMeasureActionSchemaErrorMiddleware,
  executePrivacyMeasureActionGroupDefinition,
  ExecutePrivacyMeasureActionApi,
} from './apis/execute-privacy-measure-action.ts';
export type {
  ExecutePrivacyMeasureActionProblem,
  ExecutePrivacyMeasureActionGroupContract,
} from './apis/execute-privacy-measure-action.ts';
export {
  PrivacyMeasureExecutionRequestSchema,
  PrivacyMeasureExecutionResponseSchema,
  PrivacyMeasureExecutionAuthenticationProblemSchema,
  PrivacyMeasureExecutionInvalidProblemSchema,
  PrivacyMeasureExecutionUnavailableProblemSchema,
  PrivacyMeasureExecutionForbiddenProblemSchema,
  PrivacyMeasureExecutionNotFoundProblemSchema,
  PrivacyMeasureExecutionPolicyProblemSchema,
  PrivacyMeasureExecutionPolicyConflictProblemSchema,
  PrivacyMeasureExecutionInternalProblemSchema,
  PrivacyMeasureExecutionApi,
} from './apis/privacy-measure-execution.ts';
export type {
  PrivacyMeasureExecutionRequest,
  PrivacyMeasureExecutionResponse,
} from './apis/privacy-measure-execution.ts';

const AppIdSchema = Schema.String.pipe(Schema.brand('AppId'));
const UnitIdSchema = Schema.String.pipe(Schema.brand('UnitId'));
type AppId = typeof AppIdSchema.Type;
type UnitId = typeof UnitIdSchema.Type;

export const partyRegistryAppIdFromString = Brand.nominal<AppId>();
export const partyRegistryUnitIdFromString = Brand.nominal<UnitId>();

export const partyRegistryMarkerSchema = Schema.Struct({
  ...MicroVerticalBuildMarkerSchema.fields,
  appId: AppIdSchema,
  kind: Schema.Literal('microvertical-delivery-unit'),
  schemaVersion: Schema.Literal(1),
  unitId: UnitIdSchema,
});

export type PartyRegistryMarker = typeof partyRegistryMarkerSchema.Type;

export const partyRegistryReadinessSchema = Schema.Struct({
  ...MicroVerticalReadinessSchema.fields,
  marker: partyRegistryMarkerSchema,
});

export type PartyRegistryReadiness = typeof partyRegistryReadinessSchema.Type;

export type OperationContext = MicroVerticalOperationContext;

export const partyRegistryFoundationApi = HttpApi.make('PartyRegistryFoundationApi').add(
  HttpApiGroup.make('foundation').add(
    HttpApiEndpoint.get('readiness', '/party-registry/readiness', {
      success: partyRegistryReadinessSchema,
    }),
  ),
);

// PartyMatch remains a read-only UX preview; durable matching is the explicit matchParty command.
export const partyRegistryApi = HttpApi.make('PartyRegistryApi')
  .addHttpApi(partyRegistryFoundationApi)
  .addHttpApi(partyRegistryCommandsApi)
  .addHttpApi(partyRegistryCommandRecoveryApi)
  .addHttpApi(organizationEngagementMutationApi)
  .addHttpApi(personEngagementMutationApi)
  // <generated-governed-http-api-additions>
  .addHttpApi(AresLookupApi)
  .addHttpApi(CounterpartiesSearchApi)
  .addHttpApi(CounterpartyReadApi)
  .addHttpApi(CounterpartyRoleHistoryApi)
  .addHttpApi(CustomerListApi)
  .addHttpApi(DuplicateCandidateDetailApi)
  .addHttpApi(DuplicateCandidateListApi)
  .addHttpApi(ExecutePrivacyMeasureActionApi)
  .addHttpApi(GuestPartyResolutionApi)
  .addHttpApi(OrganizationEngagementProfileApi)
  .addHttpApi(PartiesSearchApi)
  .addHttpApi(PartyContactPointDetailApi)
  .addHttpApi(PartyContactPointsApi)
  .addHttpApi(PartyCorrectionApi)
  .addHttpApi(PartyDetailApi)
  .addHttpApi(PartyMatchApi)
  .addHttpApi(PartyMatchDecisionApi)
  .addHttpApi(PartyMergeReadinessApi)
  .addHttpApi(PartyOfficialIdentifierDetailApi)
  .addHttpApi(PartyOfficialIdentifierHistoryApi)
  .addHttpApi(PartyRelationshipDetailApi)
  .addHttpApi(PersonEngagementProfileApi)
  .addHttpApi(PrivacyMeasureExecutionApi)
  // </generated-governed-http-api-additions>
  .annotate(HttpApi.ParseOptions, { onExcessProperty: 'error' })
  .pipe(identity);

export const partyRegistryOperationContexts = {
  aresLookup: createMicroVerticalOperationContext({
    method: 'POST',
    operationId: 'PartyRegistryApi:/reads/ares-lookup',
    routePath: '/reads/ares-lookup',
  }),
  counterpartiesSearch: createMicroVerticalOperationContext({
    method: 'POST',
    operationId: 'PartyRegistryApi:/party.registry/search/counterparties',
    routePath: '/party.registry/search/counterparties',
  }),
  counterpartyRead: createMicroVerticalOperationContext({
    method: 'POST',
    operationId: 'PartyRegistryApi:/reads/counterparty-read',
    routePath: '/reads/counterparty-read',
  }),
  counterpartyRoleHistory: createMicroVerticalOperationContext({
    method: 'POST',
    operationId: 'PartyRegistryApi:/reads/counterparty-role-history',
    routePath: '/reads/counterparty-role-history',
  }),
  duplicateCandidateDetail: createMicroVerticalOperationContext({
    method: 'POST',
    operationId: 'PartyRegistryApi:/reads/duplicate-candidate-detail',
    routePath: '/reads/duplicate-candidate-detail',
  }),
  guestPartyResolution: createMicroVerticalOperationContext({
    method: 'POST',
    operationId: 'PartyRegistryApi:/reads/guest-party-resolution',
    routePath: '/reads/guest-party-resolution',
  }),
  partiesSearch: createMicroVerticalOperationContext({
    method: 'POST',
    operationId: 'PartyRegistryApi:/party.registry/search/parties',
    routePath: '/party.registry/search/parties',
  }),
  partyContactPointDetail: createMicroVerticalOperationContext({
    method: 'POST',
    operationId: 'PartyRegistryApi:/reads/party-contact-point-detail',
    routePath: '/reads/party-contact-point-detail',
  }),
  partyContactPoints: createMicroVerticalOperationContext({
    method: 'POST',
    operationId: 'PartyRegistryApi:/reads/party-contact-points',
    routePath: '/reads/party-contact-points',
  }),
  partyCorrection: createMicroVerticalOperationContext({
    method: 'POST',
    operationId: 'PartyRegistryApi:/reads/party-correction',
    routePath: '/reads/party-correction',
  }),
  partyDetail: createMicroVerticalOperationContext({
    method: 'POST',
    operationId: 'PartyRegistryApi:/reads/party-detail',
    routePath: '/reads/party-detail',
  }),
  partyMatch: createMicroVerticalOperationContext({
    method: 'POST',
    operationId: 'PartyRegistryApi:/reads/party-match',
    routePath: '/reads/party-match',
  }),
  partyMatchDecision: createMicroVerticalOperationContext({
    method: 'POST',
    operationId: 'PartyRegistryApi:/reads/party-match-decision',
    routePath: '/reads/party-match-decision',
  }),
  partyMergeReadiness: createMicroVerticalOperationContext({
    method: 'POST',
    operationId: 'PartyRegistryApi:/reads/party-merge-readiness',
    routePath: '/reads/party-merge-readiness',
  }),
  partyOfficialIdentifierDetail: createMicroVerticalOperationContext({
    method: 'POST',
    operationId: 'PartyRegistryApi:/reads/party-official-identifier-detail',
    routePath: '/reads/party-official-identifier-detail',
  }),
  partyOfficialIdentifierHistory: createMicroVerticalOperationContext({
    method: 'POST',
    operationId: 'PartyRegistryApi:/reads/party-official-identifier-history',
    routePath: '/reads/party-official-identifier-history',
  }),
  partyRelationshipDetail: createMicroVerticalOperationContext({
    method: 'POST',
    operationId: 'PartyRegistryApi:/reads/party-relationship-detail',
    routePath: '/reads/party-relationship-detail',
  }),
  readiness: createMicroVerticalOperationContext({
    method: 'GET',
    operationId: 'PartyRegistryApi:/party-registry/readiness',
    routePath: '/party-registry/readiness',
  }),
} satisfies Record<string, OperationContext>;

export const partyRegistryApiContract = {
  apiPrefix: '/party-registry-api',
  basePath: '/party-registry-api/party-registry',
  ownerId: 'party-registry',
  readinessPath: '/party-registry-api/party-registry/readiness',
} as const;
