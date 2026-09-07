/* eslint-disable oxc/no-barrel-file -- The published Effect API entrypoint composes and exports all governed owner contracts. expires: 2026-12-31. */
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  Schema,
} from '@modern-js/plugin-bff/effect-client';
import {
  MicroVerticalBuildMarkerSchema,
  MicroVerticalReadinessSchema,
  createMicroVerticalOperationContext,
} from '@app/shared-contracts';
import type { MicroVerticalOperationContext } from '@app/shared-contracts';
import { Brand } from 'effect';

import { AresLookupApi } from './apis/ares-lookup.ts';
import { CounterpartiesSearchApi } from './apis/counterparties-search.ts';
import { CounterpartyReadApi } from './apis/counterparty-read.ts';
import { CounterpartyRoleHistoryApi } from './apis/counterparty-role-history.ts';
import { DuplicateCandidateDetailApi } from './apis/duplicate-candidate-detail.ts';
import { PartiesSearchApi } from './apis/parties-search.ts';
import { PartyContactPointDetailApi } from './apis/party-contact-point-detail.ts';
import { PartyContactPointsApi } from './apis/party-contact-points.ts';
import { PartyCorrectionApi } from './apis/party-correction.ts';
import { PartyDetailApi } from './apis/party-detail.ts';
import { PartyMatchDecisionApi } from './apis/party-match-decision.ts';
import { PartyMatchApi } from './apis/party-match.ts';
import { PartyMergeReadinessApi } from './apis/party-merge-readiness.ts';
import { PartyOfficialIdentifierDetailApi } from './apis/party-official-identifier-detail.ts';
import { PartyOfficialIdentifierHistoryApi } from './apis/party-official-identifier-history.ts';
import { PartyRelationshipDetailApi } from './apis/party-relationship-detail.ts';
import { partyRegistryCommandRecoveryApi, partyRegistryCommandsApi } from './command-api.ts';
import {
  organizationEngagementMutationApi,
  personEngagementMutationApi,
} from './engagement-profile-api.ts';
import { OrganizationEngagementProfileApi } from './apis/organization-engagement-profile.ts';
import { PersonEngagementProfileApi } from './apis/person-engagement-profile.ts';

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

export const partyRegistryApi = HttpApi.make('PartyRegistryApi')
  .addHttpApi(partyRegistryFoundationApi)
  .addHttpApi(partyRegistryCommandsApi)
  .addHttpApi(partyRegistryCommandRecoveryApi)
  .addHttpApi(organizationEngagementMutationApi)
  .addHttpApi(personEngagementMutationApi)
  .addHttpApi(OrganizationEngagementProfileApi)
  .addHttpApi(PersonEngagementProfileApi)
  .addHttpApi(PartyDetailApi)
  // Read-only UX preview; durable matching is the explicit matchParty command.
  .addHttpApi(PartyMatchApi)
  .addHttpApi(PartyMatchDecisionApi)
  .addHttpApi(DuplicateCandidateDetailApi)
  .addHttpApi(PartyOfficialIdentifierDetailApi)
  .addHttpApi(PartyOfficialIdentifierHistoryApi)
  .addHttpApi(PartyContactPointsApi)
  .addHttpApi(PartyContactPointDetailApi)
  .addHttpApi(PartyRelationshipDetailApi)
  .addHttpApi(CounterpartyReadApi)
  .addHttpApi(CounterpartyRoleHistoryApi)
  .addHttpApi(PartyCorrectionApi)
  .addHttpApi(PartyMergeReadinessApi)
  .addHttpApi(AresLookupApi)
  .addHttpApi(PartiesSearchApi)
  .addHttpApi(CounterpartiesSearchApi);

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
