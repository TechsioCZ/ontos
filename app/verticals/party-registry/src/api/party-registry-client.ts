/* eslint-disable oxc/no-barrel-file -- The published client entrypoint must aggregate the governed generated operation clients. */
import { Effect, makeEffectHttpApiClient } from '@modern-js/plugin-bff/effect-client';
import type { HttpClientError, Schema } from '@modern-js/plugin-bff/effect-client';

import {
  partyRegistryApiContract,
  partyRegistryFoundationApi,
  partyRegistryOperationContexts,
} from '../../shared/api.ts';
import type { OperationContext, PartyRegistryReadiness } from '../../shared/api.ts';
import { executeAresLookup } from './ares-lookup-client.ts';
import { loadCounterpartiesClient } from './counterparties-search-client.ts';
import { executeCounterpartyRead } from './counterparty-read-client.ts';
import { executeCounterpartyRoleHistory } from './counterparty-role-history-client.ts';
import { executeDuplicateCandidateDetail } from './duplicate-candidate-detail-client.ts';
import { loadPartiesClient } from './parties-search-client.ts';
import { executePartyContactPointDetail } from './party-contact-point-detail-client.ts';
import { executePartyContactPoints } from './party-contact-points-client.ts';
import { executePartyCorrection } from './party-correction-client.ts';
import { executePartyDetail } from './party-detail-client.ts';
import { executePartyMatchDecision } from './party-match-decision-client.ts';
import { executePartyMatch } from './party-match-client.ts';
import { executePartyMergeReadiness } from './party-merge-readiness-client.ts';
import { executePartyOfficialIdentifierDetail } from './party-official-identifier-detail-client.ts';
import { executePartyOfficialIdentifierHistory } from './party-official-identifier-history-client.ts';
import { executePartyRelationshipDetail } from './party-relationship-detail-client.ts';

export * from './ares-lookup-client.ts';
export * from './counterparties-search-client.ts';
export * from './counterparty-read-client.ts';
export * from './counterparty-role-history-client.ts';
export * from './duplicate-candidate-detail-client.ts';
export * from './parties-search-client.ts';
export * from './party-contact-point-detail-client.ts';
export * from './party-contact-points-client.ts';
export * from './party-correction-client.ts';
export * from './party-detail-client.ts';
export * from './party-match-decision-client.ts';
export * from './party-match-client.ts';
export * from './party-merge-readiness-client.ts';
export * from './party-official-identifier-detail-client.ts';
export * from './party-official-identifier-history-client.ts';
export * from './party-relationship-detail-client.ts';
export * from './party-command-client.ts';
export { AresApplySelectionInvalid, applyAresObservation } from './action-gateway.ts';
export type {
  AresAppliedAction,
  AresApplyOptions,
  AresApplyOutcome,
  AresApplyRequest,
  AresApplySelection,
  PartyRegistryStandardActionInvoker,
} from './action-gateway.ts';
export { Effect, runEffectRequest } from '@modern-js/plugin-bff/effect-client';

export interface PartyRegistryClient {
  readonly executeAresLookup: typeof executeAresLookup;
  readonly loadCounterpartiesClient: typeof loadCounterpartiesClient;
  readonly executeCounterpartyRead: typeof executeCounterpartyRead;
  readonly executeCounterpartyRoleHistory: typeof executeCounterpartyRoleHistory;
  readonly executeDuplicateCandidateDetail: typeof executeDuplicateCandidateDetail;
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

export type PartyRegistryClientEffect<Success> = Effect.Effect<
  Success,
  PartyRegistryClientError,
  never
>;

export interface PartyRegistryClientOptions {
  readonly baseUrl?: string | URL;
  readonly locale?: string;
  readonly operationContext?: OperationContext;
  readonly traceparent?: string;
}

interface PartyRegistryReadinessRequestContext {
  locale?: string;
  operationContext: OperationContext;
  traceparent?: string;
}

export const getPartyRegistryReadiness = (
  options: PartyRegistryClientOptions = {},
): PartyRegistryClientEffect<PartyRegistryReadiness> => {
  const requestContext: PartyRegistryReadinessRequestContext = {
    operationContext: options.operationContext ?? partyRegistryOperationContexts.readiness,
  };
  if (options.locale !== undefined) {
    requestContext.locale = options.locale;
  }
  if (options.traceparent !== undefined) {
    requestContext.traceparent = options.traceparent;
  }
  return makeEffectHttpApiClient(partyRegistryFoundationApi, {
    baseUrl: options.baseUrl ?? partyRegistryApiContract.apiPrefix,
    requestContext,
  }).pipe(Effect.flatMap((client) => client.foundation.readiness({})));
};

export const partyRegistryClient = {
  executeAresLookup,
  executeCounterpartyRead,
  executeCounterpartyRoleHistory,
  executeDuplicateCandidateDetail,
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

export { recoverPartyCreate } from './party-command-client.ts';

export {
  prefillPartyCandidateFromAres,
  deriveAresCorrectionReviewHandoffs,
} from '../../shared/domain/ares-application.ts';
export type {
  AresCorrectionReviewHandoff,
  AresCanonicalFactEvidence,
} from '../../shared/domain/ares-application.ts';
