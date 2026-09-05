/* eslint-disable oxc/no-barrel-file -- The published client entrypoint must aggregate the governed generated operation clients. */
import { Effect, makeEffectHttpApiClient } from '@modern-js/plugin-bff/effect-client';
import type { HttpClientError, Schema } from '@modern-js/plugin-bff/effect-client';
import { Context } from 'effect';
import type { Cause } from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/unstable/http';
import type { Headers } from 'effect/unstable/http';

import { partyRegistryApiContract, partyRegistryFoundationApi } from '../../shared/api.ts';
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

export type PartyRegistryClientError =
  | Cause.TimeoutError
  | HttpClientError.HttpClientError
  | Schema.SchemaError;

export type PartyRegistryClientEffect<Success> = Effect.Effect<
  Success,
  PartyRegistryClientError,
  never
>;

export interface PartyRegistryClientOptions {
  readonly baseUrl?: string | URL;
  readonly locale?: string;
  readonly operationContext?: OperationContext;
  readonly timeoutMs?: number;
  readonly traceparent?: string;
}

/** Whole-operation budget, response decode included. Overridable per call so tests stay bounded. */
const DEFAULT_TIMEOUT_MS = 10_000;

/** What one in-flight readiness call contributes to its request; never held by the client. */
interface PartyRegistryReadinessCallTransport {
  readonly baseUrl: string;
  readonly headers: Headers.Input;
}

/**
 * A `Context.Reference`, not a service: it carries a default, so the public Effect keeps
 * `R = never`. That default is fail-closed — a request issued outside a prepared call dies
 * instead of borrowing whichever context happened to be in scope.
 */
const CurrentPartyRegistryReadinessCall =
  Context.Reference<PartyRegistryReadinessCallTransport | null>(
    'party-registry/CurrentPartyRegistryReadinessCall',
    { defaultValue: () => null },
  );

/**
 * `HttpClient.mapRequestEffect` resolves its effect in the fiber that executes the request, so
 * concurrent readiness probes each read their own transport off one shared client.
 */
const applyCallTransport = (client: HttpClient.HttpClient): HttpClient.HttpClient =>
  HttpClient.mapRequestEffect(client, (request) =>
    Effect.flatMap(Effect.service(CurrentPartyRegistryReadinessCall), (transport) =>
      transport === null
        ? Effect.die('The Party registry readiness client was used outside a prepared call')
        : Effect.succeed(
            request.pipe(
              HttpClientRequest.setHeaders(transport.headers),
              HttpClientRequest.prependUrl(transport.baseUrl),
            ),
          ),
    ),
  );

/**
 * The readiness client, built once on its own root fiber at module load. Both
 * `HttpApiClient.makeClient` and `FetchHttpClient.layer` capture construction context and merge it
 * *under* every later request, so building inside the first caller would pin that caller's fetch,
 * logger and spans onto every later probe. `baseUrl` stays out of construction — it bakes into the
 * transport — and moves to the per-call prefix above.
 */
const partyRegistryFoundationClient = Effect.runSync(
  makeEffectHttpApiClient(partyRegistryFoundationApi, { transformClient: applyCallTransport }),
);

/**
 * Exactly the headers the construction-time `requestContext` produced: this BFF maps a request
 * context to `accept-language` and `traceparent` and nothing else, and drops empty values.
 * `operationContext` stays an accepted client-side descriptor — it never reached the wire.
 */
const readinessHeaders = (options: PartyRegistryClientOptions): Headers.Input => {
  const headers: Record<string, string> = {};
  if (options.locale !== undefined && options.locale !== '') {
    headers['accept-language'] = options.locale;
  }
  if (options.traceparent !== undefined && options.traceparent !== '') {
    headers['traceparent'] = options.traceparent;
  }
  return headers;
};

export const getPartyRegistryReadiness = (
  options: PartyRegistryClientOptions = {},
): PartyRegistryClientEffect<PartyRegistryReadiness> =>
  partyRegistryFoundationClient.foundation.readiness({}).pipe(
    Effect.provideService(CurrentPartyRegistryReadinessCall, {
      baseUrl: (options.baseUrl ?? partyRegistryApiContract.apiPrefix).toString(),
      headers: readinessHeaders(options),
    }),
    Effect.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  );

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
