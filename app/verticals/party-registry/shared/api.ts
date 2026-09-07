/* eslint-disable oxc/no-barrel-file -- The published Effect API entrypoint composes and exports all governed owner contracts. expires: 2026-12-31. */
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  Schema,
} from '@modern-js/plugin-bff/effect-client';
import { Brand, identity } from 'effect';

// <generated-governed-http-api-imports>
import { AresLookupApi } from './apis/ares-lookup.ts';
import { CounterpartiesSearchApi } from './apis/counterparties-search.ts';
import { CounterpartyReadApi } from './apis/counterparty-read.ts';
import { CounterpartyRoleHistoryApi } from './apis/counterparty-role-history.ts';
import { DuplicateCandidateDetailApi } from './apis/duplicate-candidate-detail.ts';
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
// </generated-governed-http-api-imports>
import { partyRegistryCommandRecoveryApi, partyRegistryCommandsApi } from './command-api.ts';
import {
  organizationEngagementMutationApi,
  personEngagementMutationApi,
} from './engagement-profile-api.ts';

export * from './command-api.ts';
export * from './engagement-profile-api.ts';

export * from './apis/ares-lookup.ts';
export * from './apis/counterparties-search.ts';
export * from './apis/counterparty-read.ts';
export * from './apis/counterparty-role-history.ts';
export * from './apis/duplicate-candidate-detail.ts';
export * from './apis/parties-search.ts';
export * from './apis/party-contact-point-detail.ts';
export * from './apis/party-contact-points.ts';
export * from './apis/party-correction.ts';
export * from './apis/party-detail.ts';
export * from './apis/party-match-decision.ts';
export * from './apis/party-match.ts';
export * from './apis/party-merge-readiness.ts';
export * from './apis/party-official-identifier-detail.ts';
export * from './apis/party-official-identifier-history.ts';
export * from './apis/party-relationship-detail.ts';

const AppIdSchema = Schema.String.pipe(Schema.brand('AppId'));
const UnitIdSchema = Schema.String.pipe(Schema.brand('UnitId'));
type AppId = typeof AppIdSchema.Type;
type UnitId = typeof UnitIdSchema.Type;

export const partyRegistryAppIdFromString = Brand.nominal<AppId>();
export const partyRegistryUnitIdFromString = Brand.nominal<UnitId>();

export const partyRegistryMarkerSchema = Schema.Struct({
  appId: AppIdSchema,
  build: Schema.String,
  buildMarker: Schema.String,
  deployProfile: Schema.String,
  kind: Schema.Literal('microvertical-delivery-unit'),
  packageName: Schema.String,
  schemaVersion: Schema.Literal(1),
  sourceRevision: Schema.String,
  surface: Schema.String,
  unitId: UnitIdSchema,
  version: Schema.String,
});

export type PartyRegistryMarker = typeof partyRegistryMarkerSchema.Type;

export const partyRegistryReadinessSchema = Schema.Struct({
  checks: Schema.Struct({
    api: Schema.Literal('ready'),
    moduleFederation: Schema.Literal('ready'),
    ssr: Schema.Literal('ready'),
    translations: Schema.Literal('ready'),
  }),
  marker: partyRegistryMarkerSchema,
  status: Schema.Literal('ready'),
  versionSkew: Schema.Literal('none'),
});

export type PartyRegistryReadiness = typeof partyRegistryReadinessSchema.Type;

export interface OperationContext {
  readonly method: string;
  readonly operationId: string;
  readonly routePath: string;
  readonly source:
    | 'client'
    | 'server'
    | 'generated-client'
    | 'effect-adapter'
    | 'data-platform'
    | 'unknown';
}

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
  .addHttpApi(DuplicateCandidateDetailApi)
  .addHttpApi(OrganizationEngagementProfileApi)
  .addHttpApi(PartiesSearchApi)
  .addHttpApi(PersonEngagementProfileApi)
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
  // </generated-governed-http-api-additions>
  .pipe(identity);
/** Canonical composition-root binding consumed by generated governed HTTP adapters. */
export const governedHttpApi = partyRegistryApi;

const operation = (method: string, routePath: string): OperationContext => ({
  method,
  operationId: `PartyRegistryApi:${routePath}`,
  routePath,
  source: 'generated-client',
});

export const partyRegistryOperationContexts = {
  aresLookup: operation('POST', '/reads/ares-lookup'),
  counterpartiesSearch: operation('POST', '/party.registry/search/counterparties'),
  counterpartyRead: operation('POST', '/reads/counterparty-read'),
  counterpartyRoleHistory: operation('POST', '/reads/counterparty-role-history'),
  duplicateCandidateDetail: operation('POST', '/reads/duplicate-candidate-detail'),
  partiesSearch: operation('POST', '/party.registry/search/parties'),
  partyContactPointDetail: operation('POST', '/reads/party-contact-point-detail'),
  partyContactPoints: operation('POST', '/reads/party-contact-points'),
  partyCorrection: operation('POST', '/reads/party-correction'),
  partyDetail: operation('POST', '/reads/party-detail'),
  partyMatch: operation('POST', '/reads/party-match'),
  partyMatchDecision: operation('POST', '/reads/party-match-decision'),
  partyMergeReadiness: operation('POST', '/reads/party-merge-readiness'),
  partyOfficialIdentifierDetail: operation('POST', '/reads/party-official-identifier-detail'),
  partyOfficialIdentifierHistory: operation('POST', '/reads/party-official-identifier-history'),
  partyRelationshipDetail: operation('POST', '/reads/party-relationship-detail'),
  readiness: operation('GET', '/party-registry/readiness'),
} satisfies Record<string, OperationContext>;

export const partyRegistryApiContract = {
  apiPrefix: '/party-registry-api',
  basePath: '/party-registry-api/party-registry',
  ownerId: 'party-registry',
  readinessPath: '/party-registry-api/party-registry/readiness',
} as const;
