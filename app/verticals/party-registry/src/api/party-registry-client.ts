import { Effect } from '@modern-js/bff-effect/effect-client';
import type { HttpClientError, Schema } from '@modern-js/bff-effect/effect-client';

import { partyRegistryOperationContexts } from '../../shared/api.ts';
import type { PartyRegistryReadiness } from '../../shared/api.ts';

import { executeAresLookup } from './ares-lookup-client.ts';
import { loadCounterpartiesClient } from './counterparties-search-client.ts';
import { executeCounterpartyRead } from './counterparty-read-client.ts';
import { executeCounterpartyRoleHistory } from './counterparty-role-history-client.ts';
import { executeDuplicateCandidateDetail } from './duplicate-candidate-detail-client.ts';
import { executeGuestPartyResolution } from './guest-party-resolution-client.ts';
import { loadPartiesClient } from './parties-search-client.ts';
import { executePartyContactPointDetail } from './party-contact-point-detail-client.ts';
import { executePartyContactPoints } from './party-contact-points-client.ts';
import { executePartyCorrection } from './party-correction-client.ts';
import { executePartyDetail } from './party-detail-client.ts';
import { executePartyMatch } from './party-match-client.ts';
import { executePartyMatchDecision } from './party-match-decision-client.ts';
import { executePartyMergeReadiness } from './party-merge-readiness-client.ts';
import { executePartyOfficialIdentifierDetail } from './party-official-identifier-detail-client.ts';
import { executePartyOfficialIdentifierHistory } from './party-official-identifier-history-client.ts';
import { createPartyRegistryHttpClient } from './party-registry-http-client.ts';
import type { PartyRegistryHttpClientOptions } from './party-registry-http-client.ts';
import { executePartyRelationshipDetail } from './party-relationship-detail-client.ts';

// Public response and problem schemas travel with the generated client aggregate. Consumers must
// use this published client subpath; the owner API barrel remains private to the deployment.
export {
  CounterpartyReadResponseSchema,
  CounterpartyReadUnavailableProblemSchema,
  GuestPartyResolutionAuthenticationProblemSchema,
  GuestPartyResolutionForbiddenProblemSchema,
  GuestPartyResolutionInternalProblemSchema,
  GuestPartyResolutionInvalidProblemSchema,
  GuestPartyResolutionNotFoundProblemSchema,
  GuestPartyResolutionPolicyConflictProblemSchema,
  GuestPartyResolutionPolicyProblemSchema,
  GuestPartyResolutionResponseSchema,
  GuestPartyResolutionUnavailableProblemSchema,
  PartyContactPointDetailAuthenticationProblemSchema,
  PartyContactPointDetailForbiddenProblemSchema,
  PartyContactPointDetailInternalProblemSchema,
  PartyContactPointDetailInvalidProblemSchema,
  PartyContactPointDetailNotFoundProblemSchema,
  PartyContactPointDetailPolicyConflictProblemSchema,
  PartyContactPointDetailPolicyProblemSchema,
  PartyContactPointDetailResponseSchema,
  PartyContactPointDetailUnavailableProblemSchema,
  PartyDetailResponseSchema,
} from '../../shared/api.ts';
export type { PartyDetailResponse } from '../../shared/api.ts';
export { customerSegmentDefinitions } from '../../shared/api.ts';
export type { CustomerSegmentCode, CustomerSegmentDefinition } from '../../shared/api.ts';

export { executeAresLookupWithAuthorization, executeAresLookup } from './ares-lookup-client.ts';
export type { AresLookupClientOptions } from './ares-lookup-client.ts';
export { loadCounterpartiesClientWithAuthorization, loadCounterpartiesClient } from './counterparties-search-client.ts';
export type { CounterpartiesSearchClientOptions } from './counterparties-search-client.ts';
export { executeCounterpartyReadWithAuthorization, executeCounterpartyRead } from './counterparty-read-client.ts';
export type { CounterpartyReadClientOptions } from './counterparty-read-client.ts';
export {
  executeCounterpartyRoleHistoryWithAuthorization,
  executeCounterpartyRoleHistory,
} from './counterparty-role-history-client.ts';
export type { CounterpartyRoleHistoryClientOptions } from './counterparty-role-history-client.ts';
export { executeCustomerListWithAuthorization, executeCustomerList } from './customer-list-client.ts';
export type { CustomerListClientOptions } from './customer-list-client.ts';
export {
  listCustomers,
  CustomerCreateAmbiguous,
  CreatedCustomerOutcomeSchema,
  createCustomer,
  updateCustomer,
  archiveCustomer,
} from './customers-client.ts';
export type {
  CustomerListItem,
  CustomerListRequest,
  CreateCustomerAddress,
  CreateCustomerInput,
  CreatedCustomerOutcome,
  CreatedCustomer,
  UpdateCustomerPatch,
} from './customers-client.ts';
export {
  executeDuplicateCandidateDetailWithAuthorization,
  executeDuplicateCandidateDetail,
} from './duplicate-candidate-detail-client.ts';
export type { DuplicateCandidateDetailClientOptions } from './duplicate-candidate-detail-client.ts';
export {
  executeDuplicateCandidateListWithAuthorization,
  executeDuplicateCandidateList,
} from './duplicate-candidate-list-client.ts';
export type { DuplicateCandidateListClientOptions } from './duplicate-candidate-list-client.ts';
export {
  createContactsClient,
  getContactsReadiness,
  attachOrganizationEngagement,
  archiveOrganizationEngagement,
  unarchiveOrganizationEngagement,
  attachPersonEngagement,
  archivePersonEngagement,
  unarchivePersonEngagement,
} from './engagement-profile-client.ts';
export type {
  ContactsClient,
  ContactsClientError,
  ContactsClientEffect,
  ContactsClientOptions,
  ContactsOperationOptions,
  ContactsMutationOptions,
} from './engagement-profile-client.ts';
export {
  executeGuestPartyResolutionWithAuthorization,
  executeGuestPartyResolution,
} from './guest-party-resolution-client.ts';
export type { GuestPartyResolutionClientOptions } from './guest-party-resolution-client.ts';
export {
  executeOrganizationEngagementProfileWithAuthorization,
  executeOrganizationEngagementProfile,
} from './organization-engagement-profile-client.ts';
export type { OrganizationEngagementProfileClientOptions } from './organization-engagement-profile-client.ts';
export {
  executePersonEngagementProfileWithAuthorization,
  executePersonEngagementProfile,
} from './person-engagement-profile-client.ts';
export type { PersonEngagementProfileClientOptions } from './person-engagement-profile-client.ts';
export { loadPartiesClientWithAuthorization, loadPartiesClient } from './parties-search-client.ts';
export type { PartiesSearchClientOptions } from './parties-search-client.ts';
export {
  executePartyContactPointDetailWithAuthorization,
  executePartyContactPointDetail,
} from './party-contact-point-detail-client.ts';
export type { PartyContactPointDetailClientOptions } from './party-contact-point-detail-client.ts';
export {
  executePartyContactPointsWithAuthorization,
  executePartyContactPoints,
} from './party-contact-points-client.ts';
export type { PartyContactPointsClientOptions } from './party-contact-points-client.ts';
export { executePartyCorrectionWithAuthorization, executePartyCorrection } from './party-correction-client.ts';
export type { PartyCorrectionClientOptions } from './party-correction-client.ts';
export { executePartyDetailWithAuthorization, executePartyDetail } from './party-detail-client.ts';
export type { PartyDetailClientOptions } from './party-detail-client.ts';
export {
  executePartyMatchDecisionWithAuthorization,
  executePartyMatchDecision,
} from './party-match-decision-client.ts';
export type { PartyMatchDecisionClientOptions } from './party-match-decision-client.ts';
export { executePartyMatchWithAuthorization, executePartyMatch } from './party-match-client.ts';
export type { PartyMatchClientOptions } from './party-match-client.ts';
export {
  executePartyMergeReadinessWithAuthorization,
  executePartyMergeReadiness,
} from './party-merge-readiness-client.ts';
export type { PartyMergeReadinessClientOptions } from './party-merge-readiness-client.ts';
export {
  executePartyOfficialIdentifierDetailWithAuthorization,
  executePartyOfficialIdentifierDetail,
} from './party-official-identifier-detail-client.ts';
export type { PartyOfficialIdentifierDetailClientOptions } from './party-official-identifier-detail-client.ts';
export {
  executePartyOfficialIdentifierHistoryWithAuthorization,
  executePartyOfficialIdentifierHistory,
} from './party-official-identifier-history-client.ts';
export type { PartyOfficialIdentifierHistoryClientOptions } from './party-official-identifier-history-client.ts';
export {
  executePartyRelationshipDetailWithAuthorization,
  executePartyRelationshipDetail,
} from './party-relationship-detail-client.ts';
export type { PartyRelationshipDetailClientOptions } from './party-relationship-detail-client.ts';
export {
  executePrivacyMeasureExecutionWithAuthorization,
  executePrivacyMeasureExecution,
} from './privacy-measure-execution-client.ts';
export type { PrivacyMeasureExecutionClientOptions } from './privacy-measure-execution-client.ts';
export {
  resolvePartyCommandCommitWithAuthorization,
  resolvePartyCommandCommit,
  acceptRetailEnrollmentEvidenceWithAuthorization,
  acceptRetailEnrollmentEvidence,
  addContactPointWithAuthorization,
  addContactPoint,
  addPartyOfficialIdentifierWithAuthorization,
  addPartyOfficialIdentifier,
  archivePartyWithAuthorization,
  archiveParty,
  confirmDuplicatePartiesWithAuthorization,
  confirmDuplicateParties,
  correctPartyFactWithAuthorization,
  correctPartyFact,
  counterpartyCreateWithAuthorization,
  counterpartyCreate,
  counterpartyCustomerOnboardWithAuthorization,
  counterpartyCustomerOnboard,
  counterpartyRoleAddWithAuthorization,
  counterpartyRoleAdd,
  counterpartyRoleEndWithAuthorization,
  counterpartyRoleEnd,
  createPartyRelationshipWithAuthorization,
  createPartyRelationship,
  createPartyWithAuthorization,
  createParty,
  dismissDuplicateCandidateWithAuthorization,
  dismissDuplicateCandidate,
  endContactPointWithAuthorization,
  endContactPoint,
  endPartyOfficialIdentifierWithAuthorization,
  endPartyOfficialIdentifier,
  endPartyRelationshipWithAuthorization,
  endPartyRelationship,
  markDuplicateCandidateNeedsEvidenceWithAuthorization,
  markDuplicateCandidateNeedsEvidence,
  matchPartyWithAuthorization,
  matchParty,
  requestSearchRebuildWithAuthorization,
  requestSearchRebuild,
  resolveDuplicateCandidateCreateWithAuthorization,
  resolveDuplicateCandidateCreate,
  resolveDuplicateCandidateMatchWithAuthorization,
  resolveDuplicateCandidateMatch,
  unarchivePartyWithAuthorization,
  unarchiveParty,
  updateContactPointWithAuthorization,
  updateContactPoint,
  updatePartyOfficialIdentifierWithAuthorization,
  updatePartyOfficialIdentifier,
  updatePartyRelationshipWithAuthorization,
  updatePartyRelationship,
  updatePartyWithAuthorization,
  updateParty,
} from './party-command-client.ts';
export type {
  PartyCommandClient,
  PartyCommandRecoveryOptions,
  PartyCommandOptions,
  PartyCreateRecoveryAuthorization,
} from './party-command-client.ts';
// <generated-action-http-client-exports>
export {
  executeExecutePrivacyMeasureWithAuthorization,
  executeExecutePrivacyMeasure,
} from './execute-privacy-measure-action-client.ts';
export type { ExecutePrivacyMeasureActionClientOptions } from './execute-privacy-measure-action-client.ts';
// </generated-action-http-client-exports>
export {
  AresApplySelectionInvalid,
  applyAresObservation,
  deriveAresCorrectionReviewHandoffs,
  prefillPartyCandidateFromAres,
} from './action-gateway.ts';
export type {
  AresCanonicalFactEvidence,
  AresCorrectionReviewHandoff,
  AresAppliedAction,
  AresApplyOptions,
  AresApplyOutcome,
  AresApplyRequest,
  AresApplySelection,
  PartyRegistryStandardActionInvoker,
} from './action-gateway.ts';
export { Effect } from '@modern-js/bff-effect/effect-client';

export interface PartyRegistryClient {
  readonly executeAresLookup: typeof executeAresLookup;
  readonly loadCounterpartiesClient: typeof loadCounterpartiesClient;
  readonly executeCounterpartyRead: typeof executeCounterpartyRead;
  readonly executeCounterpartyRoleHistory: typeof executeCounterpartyRoleHistory;
  readonly executeDuplicateCandidateDetail: typeof executeDuplicateCandidateDetail;
  readonly executeGuestPartyResolution: typeof executeGuestPartyResolution;
  readonly loadPartiesClient: typeof loadPartiesClient;
  readonly executePartyContactPointDetail: typeof executePartyContactPointDetail;
  readonly executePartyContactPoints: typeof executePartyContactPoints;
  readonly executePartyCorrection: typeof executePartyCorrection;
  readonly executePartyDetail: typeof executePartyDetail;
  readonly executePartyMatch: typeof executePartyMatch;
  readonly executePartyMatchDecision: typeof executePartyMatchDecision;
  readonly executePartyMergeReadiness: typeof executePartyMergeReadiness;
  readonly executePartyOfficialIdentifierDetail: typeof executePartyOfficialIdentifierDetail;
  readonly executePartyOfficialIdentifierHistory: typeof executePartyOfficialIdentifierHistory;
  readonly executePartyRelationshipDetail: typeof executePartyRelationshipDetail;
  readonly getPartyRegistryReadiness: typeof getPartyRegistryReadiness;
}

export type PartyRegistryClientError = HttpClientError.HttpClientError | Schema.SchemaError;

export type PartyRegistryClientEffect<Success> = Effect.Effect<Success, PartyRegistryClientError, never>;

export type PartyRegistryClientOptions = PartyRegistryHttpClientOptions;

export const getPartyRegistryReadiness = (
  options: PartyRegistryClientOptions = {},
): PartyRegistryClientEffect<PartyRegistryReadiness> =>
  createPartyRegistryHttpClient({
    ...options,
    operationContext: options.operationContext ?? partyRegistryOperationContexts.readiness,
  }).pipe(Effect.flatMap((client) => client.foundation.readiness({})));

export const partyRegistryClient = {
  executeAresLookup,
  executeCounterpartyRead,
  executeCounterpartyRoleHistory,
  executeDuplicateCandidateDetail,
  executeGuestPartyResolution,
  executePartyContactPointDetail,
  executePartyContactPoints,
  executePartyCorrection,
  executePartyDetail,
  executePartyMatch,
  executePartyMatchDecision,
  executePartyMergeReadiness,
  executePartyOfficialIdentifierDetail,
  executePartyOfficialIdentifierHistory,
  executePartyRelationshipDetail,
  getPartyRegistryReadiness,
  loadCounterpartiesClient,
  loadPartiesClient,
} satisfies PartyRegistryClient;

export { recoverPartyCreate, recoverPartyCreateWithAuthorization } from './party-command-client.ts';
