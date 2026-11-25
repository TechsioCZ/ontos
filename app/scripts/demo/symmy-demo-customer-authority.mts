#!/usr/bin/env node
/**
 * Noninteractive AKROS-only source enrollment. Run after internal workload registration.
 *
 * node scripts/demo/symmy-demo-customer-authority.mts --mode apply
 * node scripts/demo/symmy-demo-customer-authority.mts --mode verify
 *
 * No person, API key, Privacy decision, receipt, contract or legal basis is invented here.
 * The existing customer-group route identifies the integration; Core identifies the real source writers.
 * Initialize missing owner routes. On an active bootstrap-owned route the canonical reader may be appended;
 * conflicting or operator-managed policy is never replaced. The Symmy execution epoch is not rotated.
 *
 * Required: ULTRAMODERN_DEPLOYMENT_ENVIRONMENT=stage, DATABASE_URL, DATABASE_ADMIN_URL,
 * ONTOS_SYMMY_JOB_RETENTION_POLICIES. No published-composition URL is needed.
 * Customer synchronization uses the persisted, operator-authorized source policy. Publish the environment builder's
 * ONTOS_PRIVACY_SOURCE_SYNC_PROCESSING_ENABLED and ONTOS_PARTY_CLIENT_SOURCE_BINDINGS before starting owners.
 * Source-sync evidence authorizes this integration; it never fabricates consent or a business-only exemption.
 * A parent host must hand these environment additions to the owner processes; setting this child's environment
 * cannot reconfigure an already running owner. This script does not claim an end-to-end owner smoke passed.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import {
  makeSystemPrincipalContextResolver,
  parseDatabaseConnectionPair,
  registerSystemWorkload,
} from '@app/core-runtime';
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { and, eq } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Config, Console, Effect, Layer, Option, Redacted, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';
import { Reactivity } from 'effect/reactivity';
import { v5 } from 'uuid';

import { APP_DATABASE_IDENTITY_ENROLLMENT } from '../../database/identity-enrollment.ts';
import { LegalEntityIdSchema, PrincipalIdSchema, TenantIdSchema } from '../../packages/core-runtime/src/access/ids.ts';
import { writeWorkloadBindings } from '../../packages/core-runtime/src/access/workloads/binding-store.ts';
import { writeWorkloadCompanyBindings } from '../../packages/core-runtime/src/access/workloads/company-bindings.ts';
import { AccessWorkloadCompanyBindingIdSchema } from '../../packages/core-runtime/src/access/workloads/company-store.ts';
import {
  AccessWorkloadBindingIdSchema,
  AccessWorkloadBindingStore,
} from '../../packages/core-runtime/src/access/workloads/store.ts';
import { WorkloadKeySchema } from '../../packages/core-runtime/src/authorization/access-declaration.ts';
import { AccessReleaseStoreLive } from '../../packages/core-runtime/src/access/changes/persistence/drizzle-store.ts';
import { AccessWorkloadBindingStoreLive } from '../../packages/core-runtime/src/access/workloads/binding-store.ts';
import { AccessWorkloadCompanyBindingStoreLive } from '../../packages/core-runtime/src/access/workloads/company-bindings.ts';
import { makeCoreDatabase, CoreDatabase } from '../../packages/core-runtime/src/db/client.ts';
import { DatabaseIdentityEnrollmentContext } from '../../packages/core-runtime/src/db/database-identities.ts';
import {
  registerAdditiveCompanyInternalWorkloads,
  ReleaseInternalWorkloadError,
} from '../../packages/core-runtime/src/install/release-internal-workloads.ts';
import {
  accessWorkloadBindings,
  accessWorkloadCompanyBindings,
  coreRelations,
} from '../../packages/core-runtime/src/db/schema.ts';
import { stageScopeOf } from '../../packages/core-runtime/src/install/stage-context-bootstrap.ts';
import { internalWorkloadPrincipalId } from '../../packages/core-runtime/src/auth/module-credentials.ts';
import { SourceProcessingContextSchema } from '../../verticals/privacy/shared/apis/source-processing-eligibility.ts';
import { executeSourceProcessingEligibilityWithAuthorization } from '@app/privacy/api/source-processing-eligibility/client';
import { SourceSyncProcessingPolicySchema } from '../../verticals/privacy/shared/domain/source-sync-processing-policy.ts';
import { stageWorkloadBindingIds, stageWorkloadCompanyIds } from './register-stage-workloads.mts';
import type { SeedClient } from './seed-client.mts';
import {
  AssignLegalBasisPayloadSchema,
  AssignLegalBasisResultSchema,
  AssignPrivacyResponsibilityPayloadSchema,
  AssignPrivacyResponsibilityResultSchema,
  CreatePrivacySubjectPayloadSchema,
  CreatePrivacySubjectResultSchema,
  RecordApplicabilityPolicyPayloadSchema,
  RecordApplicabilityPolicyResultSchema,
  RecordPrivacyApplicabilityPayloadSchema,
  RecordPrivacyApplicabilityResultSchema,
} from '../../verticals/privacy/shared/actions/privacy-operations.ts';
import {
  CreateProcessingPurposePayloadSchema,
  CreateProcessingPurposeResultSchema,
} from '../../verticals/privacy/shared/actions/create-processing-purpose.ts';

export const SYMMY_DEMO_CUSTOMER_TENANT = 'bceaa540-13eb-5508-9ac0-9ed7e40a2ee9';
export const SYMMY_DEMO_CUSTOMER_COMPANY = 'c0c78a3e-6e2a-57e0-9d0d-86253499fee7';
export const SYMMY_DEMO_CUSTOMERS_ROUTE = '5158ef08-7315-57e1-a9ed-b0fef8cd9ac1';
export const SYMMY_DEMO_CUSTOMERS_READ_ROUTE = '03f02f99-ec4a-56a1-8baa-9802207741b3';
export const SYMMY_DEMO_GROUPS_ROUTE = 'f637a6ec-865b-43bc-9c28-57783757f367';
/** The genuine logical group source named by that enrolled transport route, not its physical route id. */
export const SYMMY_DEMO_GROUPS_SOURCE_ROUTE = '5a6fb39a-c26e-4186-9dc2-5e410210d36c';
export const SYMMY_DEMO_MEMBERSHIP_POLICY_ID = 'akros-symmy-memberships';
const issuer = 'symmy-akros';
const namespace = 'akros-erp';
const revision = 'v1';
const recordType = 'CUSTOMER';
const sourceReader = 'commerce.customer-context.source-read';
const sourceWriter = 'commerce.customer-context.source-write';
const partyWriter = 'party.registry.source-write';
const customerReceiverWorkloads = [
  'party.registry.source-read',
  'commerce.customer-context.source-read',
  'privacy.core.source-processing-check',
  'privacy.core.organization-business-check',
  'privacy.core.organization-profile-ico-check',
  'commerce.customer-context.organization-ico-facts.read',
  'integration.symmy.source-organization-facts.read',
  'pricing.price-group-catalog.source-read',
] as const;
const obsoleteExternalExecutorWorkloads = [...customerReceiverWorkloads, partyWriter, sourceWriter] as const;
export const symmyDemoReceiverWorkloadsForPhase = (phase: 'pre-owner' | 'post-registration'): readonly string[] =>
  phase === 'pre-owner' ? ['party.registry.source-read'] : customerReceiverWorkloads;
const integrationWorkloads = ['integration.symmy-admit', 'integration.symmy-poll'] as const;
export const symmyDemoCustomerWorkloadRequirements = {
  integration: integrationWorkloads,
  existingSystemWriters: [partyWriter, sourceWriter],
} as const;
export const symmyDemoCustomerInternalWorkloadDeclarations = [
  {
    appId: 'party-registry',
    moduleKey: 'party.registry',
    workloadKey: 'party.registry.source-write',
    label: 'Party source write',
  },
  {
    appId: 'party-registry',
    moduleKey: 'party.registry',
    workloadKey: 'party.registry.source-read',
    label: 'Party source read',
  },
  {
    appId: 'privacy',
    moduleKey: 'privacy.core',
    workloadKey: 'privacy.core.source-processing-check',
    label: 'Privacy source processing',
  },
  {
    appId: 'privacy',
    moduleKey: 'privacy.core',
    workloadKey: 'privacy.core.organization-business-check',
    label: 'Privacy organization business',
  },
  {
    appId: 'privacy',
    moduleKey: 'privacy.core',
    workloadKey: 'privacy.core.organization-profile-ico-check',
    label: 'Privacy organization ICO',
  },
  {
    appId: 'commerce-customer-context',
    moduleKey: 'commerce.customer-context',
    workloadKey: 'commerce.customer-context.organization-ico-facts.read',
    label: 'Commerce organization ICO facts',
  },
  {
    appId: 'symmy-integration',
    moduleKey: 'integration.symmy',
    workloadKey: 'integration.symmy.source-organization-facts.read',
    label: 'Symmy organization facts',
  },
] as const;

export class SymmyDemoCustomerAuthorityError extends Schema.TaggedError<SymmyDemoCustomerAuthorityError>()(
  'SymmyDemoCustomerAuthorityError',
  { reason: Schema.String },
) {}
const fail = (message: string) => new SymmyDemoCustomerAuthorityError({ reason: message });
export const symmyDemoDiscoveryFailure =
  (phase: 'integration-route' | 'party-writer' | 'commerce-writer' | 'party-reader') => () =>
    fail(phase);
const tenantId = TenantIdSchema.make(SYMMY_DEMO_CUSTOMER_TENANT);
const legalEntityId = LegalEntityIdSchema.make(SYMMY_DEMO_CUSTOMER_COMPANY);
const Uuid = Schema.String.check(Schema.isUUID());
const IdentitySchema = Schema.Struct({
  commerceWriterId: Uuid,
  integrationPrincipalId: Uuid,
  partyWriterId: Uuid,
  partyReaderId: Uuid,
  privacyReceiverId: Uuid,
});
type Identities = typeof IdentitySchema.Type;
type EnvironmentIdentities = Pick<
  Identities,
  'integrationPrincipalId' | 'partyWriterId' | 'commerceWriterId' | 'partyReaderId'
>;
const SourceWriterCandidateSchema = Schema.Struct({
  bindingId: Schema.optional(Uuid),
  kind: Schema.Literals(['service', 'system']),
  legalEntityId: Schema.NullOr(Uuid),
  platformRole: Schema.NullOr(Schema.String),
  principalId: PrincipalIdSchema,
  tenantId: Uuid,
  workloadKey: Schema.String,
});

export const symmyDemoReceiverCandidates = (input: unknown, excludedBindingIds: readonly string[]) =>
  Effect.gen(function* receiverCandidates() {
    const candidates = yield* Schema.decodeUnknownEffect(Schema.Array(SourceWriterCandidateSchema))(input);
    if (candidates.filter(({ kind }) => kind === 'system').length <= 1) return candidates;
    return candidates.filter(({ bindingId }) => bindingId === undefined || !excludedBindingIds.includes(bindingId));
  });

/**
 * Preserve the native tenant-wide system writer even before its company registration exists. Otherwise select
 * only Core's actual platform-marked, canonically identified service registration of this workload and company.
 * Never use a tenant-wide first match: other companies have separate platform source-writer principals.
 */
export const selectSymmyDemoSourceWriter = (workloadKey: string, input: unknown) =>
  Effect.gen(function* selectWriter() {
    const candidates = yield* Schema.decodeUnknownEffect(Schema.Array(SourceWriterCandidateSchema))(input);
    const scoped = candidates.filter(
      (candidate) => candidate.tenantId === tenantId && candidate.workloadKey === workloadKey,
    );
    const systems = scoped.filter(({ kind }) => kind === 'system');
    const eligible =
      systems.length > 0
        ? systems
        : scoped.filter(
            (candidate) =>
              candidate.kind === 'service' &&
              candidate.legalEntityId === legalEntityId &&
              candidate.platformRole === 'internal_workload' &&
              candidate.principalId === internalWorkloadPrincipalId({ tenantId, legalEntityId, workloadKey }),
          );
    const principals = [...new Set(eligible.map(({ principalId }) => principalId))];
    const [principalId] = principals;
    if (principals.length !== 1 || principalId === undefined) {
      return yield* fail(
        `AKROS workload ${workloadKey} needs one native system writer or authentic company-bound service writer; no identity was inferred`,
      );
    }
    return principalId;
  });

const readSymmyDemoSourceWriterCandidates = (workloadKey: string) =>
  Effect.gen(function* readCandidates() {
    const sql = yield* PgClient.PgClient;
    const candidates = yield* sql`select distinct b.binding_id as "bindingId", p.principal_id as "principalId", p.kind,
      p.platform_role as "platformRole", b.tenant_id as "tenantId",
      c.legal_entity_id as "legalEntityId", b.workload_key as "workloadKey"
      from core.access_workload_bindings b
      left join core.access_workload_company_bindings c
        on c.tenant_id=b.tenant_id and c.workload_binding_id=b.binding_id
        and c.legal_entity_id=${legalEntityId} and c.status='active'
      join core.principals p on p.tenant_id=b.tenant_id and p.principal_id=b.principal_id
      join core.tenants t on t.tenant_id=b.tenant_id
      join core.legal_entities l on l.tenant_id=b.tenant_id and l.legal_entity_id=${legalEntityId}
      where b.tenant_id=${tenantId} and b.workload_key=${workloadKey}
        and b.status='active' and p.status='active'
        and p.kind in ('system','service') and t.status='active' and l.status='active'`;
    return yield* Schema.decodeUnknownEffect(Schema.Array(SourceWriterCandidateSchema))(candidates);
  });

/** Active native bindings establish the candidate set; Core revalidates the selected identity as a trusted worker. */
export const resolveSymmyDemoSourceWriter = (workloadKey: string, excludedBindingIds: readonly string[] = []) =>
  Effect.gen(function* resolveWriter() {
    const parsed = yield* symmyDemoReceiverCandidates(
      yield* readSymmyDemoSourceWriterCandidates(workloadKey),
      excludedBindingIds,
    );
    const principalId = yield* selectSymmyDemoSourceWriter(workloadKey, parsed);
    const executor = yield* makeWithDefaults({ relations: coreRelations });
    return yield* makeSystemPrincipalContextResolver({ executor }).resolve({
      principalId,
      registration: registerSystemWorkload({ allowServicePrincipal: true, jobKey: workloadKey }),
      runReference: 'akros-demo-company-source-writer',
      tenantId,
    });
  });

export const symmyDemoObsoleteReceiverBindingIds = (partyId: string, commerceId: string, key: string) =>
  [partyId, commerceId].map((principalId) => stageWorkloadBindingIds(tenantId, principalId, key).bindingId);

const resolveSymmyDemoCustomerReceivers = (
  partyId: string,
  commerceId: string,
  phase: 'pre-owner' | 'post-registration',
) =>
  Effect.gen(function* resolveReceivers() {
    const resolved = [];
    for (const key of symmyDemoReceiverWorkloadsForPhase(phase)) {
      const principal = yield* resolveSymmyDemoSourceWriter(
        key,
        symmyDemoObsoleteReceiverBindingIds(partyId, commerceId, key),
      );
      resolved.push({ key, principalId: principal.principalId });
    }
    const partyReader = resolved.find(({ key }) => key === 'party.registry.source-read');
    const commerceReader = resolved.find(({ key }) => key === sourceReader);
    const privacyReceiver = resolved.find(({ key }) => key === 'privacy.core.source-processing-check');
    if (partyReader === undefined || commerceReader === undefined || privacyReceiver === undefined)
      return yield* fail('Native customer receiver enrollment is absent');
    return {
      commerceReaderId: commerceReader.principalId,
      partyReaderId: partyReader.principalId,
      privacyReceiverId: privacyReceiver.principalId,
      receivers: resolved,
    };
  });

/** An existing native reader is never replaced. An operator-managed route must be changed by its own Action. */
export const symmyDemoNativeReaderNeedsEnrollment = (
  route: { readonly readers: readonly string[]; readonly managed: boolean },
  integration: string,
  nativeReader: string,
) =>
  Effect.gen(function* needsEnrollment() {
    if (integration === nativeReader) return yield* fail('The external integration cannot be the native source reader');
    if (route.readers.includes(nativeReader)) return false;
    if (!route.readers.includes(integration))
      return yield* fail('The exact legacy integration reader is not enrolled on this owner route');
    if (route.managed) return yield* fail('Name the canonical Commerce reader through the managed source route Action');
    return true;
  });

const GroupSchema = Schema.Struct({
  code: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9._-]{1,80}$/u)),
  groupId: Uuid,
  recordId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
});
type Group = typeof GroupSchema.Type;

export const buildSymmySourceSyncProcessingPolicy = (identities: Identities) =>
  Schema.decodeUnknownEffect(SourceSyncProcessingPolicySchema)({
    active: true,
    callers: [
      { authMethod: 'api_key', principalId: identities.integrationPrincipalId },
      { authMethod: 'system', principalId: identities.partyWriterId },
      { authMethod: 'system', principalId: identities.commerceWriterId },
      { authMethod: 'system', principalId: identities.privacyReceiverId },
    ],
    customerRouteId: SYMMY_DEMO_CUSTOMERS_ROUTE,
    dataUse: 'SOURCE_CUSTOMER_SYNC',
    effectiveFrom: '2026-11-23T00:00:00.000Z',
    groupRouteId: SYMMY_DEMO_GROUPS_SOURCE_ROUTE,
    issuer,
    legalEntityId,
    namespace,
    policyId: 'akros-symmy-source-sync-v2',
    purpose: 'CUSTOMER_IMPORT',
    reason: 'Operator-authorized AKROS customer source synchronization for the customer demonstration',
    revision: 'v2',
    tenantId,
    validUntil: '2026-12-23T00:00:00.000Z',
  });

/**
 * Use as connectSeedClient's checkpoint callback. Native Action replay recovers generated owner IDs after a lost
 * reply; a new approved command has a different key. No receipt file, random ID or automatic HTTP retry is used.
 */
export const symmyDemoCustomerWriteKey = (audience: string, path: string, encodedPayload: string) =>
  Effect.succeed(
    `akros-customer-authority:${createHash('sha256')
      .update(JSON.stringify([tenantId, legalEntityId, audience, path, encodedPayload]))
      .digest('hex')}`,
  );

const PrivacyStepSchema = Schema.Union([
  Schema.TaggedStruct('CREATE_PURPOSE', { payload: CreateProcessingPurposePayloadSchema }),
  Schema.TaggedStruct('CREATE_SUBJECT', { payload: CreatePrivacySubjectPayloadSchema }),
  Schema.TaggedStruct('ASSIGN_RESPONSIBILITY', { payload: AssignPrivacyResponsibilityPayloadSchema }),
  Schema.TaggedStruct('RECORD_POLICY', { payload: RecordApplicabilityPolicyPayloadSchema }),
  Schema.TaggedStruct('RECORD_APPLICABILITY', { payload: RecordPrivacyApplicabilityPayloadSchema }),
  Schema.TaggedStruct('ASSIGN_BASIS', { payload: AssignLegalBasisPayloadSchema }),
]);
export { PrivacyStepSchema as SymmyDemoCustomerPrivacyStepSchema };

/**
 * The actual Privacy provisioning path for an already authorized company-scoped owner client. Supply an approved
 * native command; use the returned owner IDs in the next command. Never turn a source locator into a Data Subject:
 * CREATE_SUBJECT delegates that admission to Privacy/Party. In particular no CONTRACT or consent is inferred here.
 * The client's target must be the pinned AKROS target, authenticated by connectSeedClient; a command is not a plan.
 */
export const applySymmyDemoCustomerPrivacy = (
  client: Pick<SeedClient, 'call'>,
  target: { readonly tenantId: string; readonly legalEntityId: string },
  input: unknown,
) =>
  Effect.gen(function* privacyStep() {
    if (target.tenantId !== tenantId || target.legalEntityId !== legalEntityId) {
      return yield* fail('Privacy provisioning is restricted to the declared AKROS tenant and company');
    }
    const step = yield* Schema.decodeUnknownEffect(PrivacyStepSchema, { onExcessProperty: 'error' })(input);
    switch (step._tag) {
      case 'CREATE_PURPOSE':
        return yield* client.call(
          'privacy',
          '/privacy/actions/create-processing-purpose',
          CreateProcessingPurposePayloadSchema,
          step.payload,
          CreateProcessingPurposeResultSchema,
          true,
        );
      case 'CREATE_SUBJECT':
        return yield* client.call(
          'privacy',
          '/privacy/actions/create-privacy-subject',
          CreatePrivacySubjectPayloadSchema,
          step.payload,
          CreatePrivacySubjectResultSchema,
          true,
          ['party-registry'],
        );
      case 'ASSIGN_RESPONSIBILITY':
        return yield* client.call(
          'privacy',
          '/privacy/actions/assign-privacy-responsibility',
          AssignPrivacyResponsibilityPayloadSchema,
          step.payload,
          AssignPrivacyResponsibilityResultSchema,
          true,
        );
      case 'RECORD_POLICY':
        return yield* client.call(
          'privacy',
          '/privacy/actions/record-applicability-policy',
          RecordApplicabilityPolicyPayloadSchema,
          step.payload,
          RecordApplicabilityPolicyResultSchema,
          true,
        );
      case 'RECORD_APPLICABILITY':
        return yield* client.call(
          'privacy',
          '/privacy/actions/record-privacy-applicability',
          RecordPrivacyApplicabilityPayloadSchema,
          step.payload,
          RecordPrivacyApplicabilityResultSchema,
          true,
        );
      case 'ASSIGN_BASIS':
        return yield* client.call(
          'privacy',
          '/privacy/actions/assign-legal-basis',
          AssignLegalBasisPayloadSchema,
          step.payload,
          AssignLegalBasisResultSchema,
          true,
        );
      default: {
        const exhaustive: never = step;
        return exhaustive;
      }
    }
  });

/** Run with the real caller's Privacy gateway credential after publishing the approved owner context. */
export const verifySymmyDemoCustomerSourceProcessing = (
  context: typeof SourceProcessingContextSchema.Type,
  authorization: {
    readonly credential: Redacted.Redacted<string>;
    readonly requestCorrelation: string;
    readonly options: NonNullable<Parameters<typeof executeSourceProcessingEligibilityWithAuthorization>[3]>;
  },
) =>
  Effect.gen(function* verifySourceProcessing() {
    if (context.tenantId !== tenantId || context.legalEntityId !== legalEntityId) {
      return yield* fail('Source processing verification is restricted to the declared AKROS tenant and company');
    }
    const result = yield* executeSourceProcessingEligibilityWithAuthorization(
      context.request,
      Redacted.value(authorization.credential),
      authorization.requestCorrelation,
      authorization.options,
    );
    if (result.outcome !== 'ALLOWED') {
      return yield* fail(`Privacy refused the exact source use: ${result.reason}`);
    }
    if (
      result.authorityIncarnation !== context.authorityIncarnation ||
      result.authorityRevision !== context.authorityRevision
    ) {
      return yield* fail('Privacy source authority changed after preparation; use its current approved context');
    }
    return result;
  });

/** Physical selected routes are deterministic, but never stand in for a Party, group or principal identity. */
export const symmyDemoMembershipRouteId = (groupId: string) => v5(groupId, SYMMY_DEMO_GROUPS_ROUTE);

const operation = (moduleId: string, entrypointKey: string) => ({ entrypointKey, moduleId, schemaVersion: '1' });
export const symmyDemoCustomerOperations = [
  operation('party.registry', 'party.registry.create-party'),
  operation('party.registry', 'party.registry.add-contact-point'),
  operation('party.registry', 'party.registry.counterparty-customer-onboard'),
  operation('commerce.customer-context', 'commerce.customer-context.ensure-retail-customer-profile'),
  operation('commerce.customer-context', 'commerce.customer-context.create-counterparty-purchasing-profile'),
  operation('commerce.customer-context', 'commerce.customer-context.add-saved-address'),
  operation('commerce.customer-context', 'commerce.customer-context.change-organization-customer-profile-ico'),
];
const customerReadOperations = [
  operation('commerce.customer-context', 'commerce.customer-context.api.customer-profile-source-page'),
  operation('commerce.customer-context', 'commerce.customer-context.api.customer-profile-source-parties'),
  operation('commerce.customer-context', 'commerce.customer-context.api.organization-customer-profile-ico'),
  operation('party.registry', 'party.registry.api.source-profile-export'),
  operation('party.registry', 'party.registry.api.organization-business-name-export'),
  operation('party.registry', 'party.registry.api.source-party-search'),
];
const configuration = (
  logicalRouteId: string,
  entityKind: string,
  operations: readonly ReturnType<typeof operation>[],
) => ({
  items: [
    {
      effects: operations.map((entry, index) => ({ effectKey: `operation-${index}`, operation: entry })),
      itemKey: 'source-template',
      source: {
        entityKind,
        issuerId: issuer,
        sourceNamespace: namespace,
        sourceRecordId: 'ENROLLMENT_TEMPLATE',
      },
    },
  ],
  sourceMappingVersion: revision,
  sourceRouteId: logicalRouteId,
  sourceRouteRevision: revision,
});

/** Retention IDs are stable deployment configuration, not generated per boot. */
export const symmyDemoCustomerRetentionRefs = () => [
  { policyId: 'akros-symmy-customers', revision, routeId: SYMMY_DEMO_CUSTOMERS_ROUTE },
  {
    policyId: SYMMY_DEMO_MEMBERSHIP_POLICY_ID,
    revision,
    routeId: SYMMY_DEMO_GROUPS_ROUTE,
  },
];

export const buildSymmyDemoCustomerRoutes = (principalId: string, groups: readonly Group[]) =>
  Effect.gen(function* buildRoutes() {
    yield* Schema.decodeUnknownEffect(PrincipalIdSchema)(principalId);
    const { SymmyRouteEnrollmentRequestSchema } = yield* Effect.tryPromise({
      catch: () => fail('The production Symmy enrollment contract could not be loaded'),
      try: () => import('../../verticals/symmy-integration/src/ops/symmy-route-enrollment.ts'),
    });
    return yield* Schema.decodeUnknownEffect(Schema.Array(SymmyRouteEnrollmentRequestSchema))([
      {
        configuration: configuration(SYMMY_DEMO_CUSTOMERS_ROUTE, recordType, symmyDemoCustomerOperations),
        legalEntityId,
        lifecyclePolicy: { policyId: 'akros-symmy-customers', revision },
        mappingVersion: revision,
        principalId,
        routeId: SYMMY_DEMO_CUSTOMERS_ROUTE,
        routeKey: 'customersBatch',
        routeRevision: revision,
        tenantId,
      },
      {
        configuration: configuration(SYMMY_DEMO_CUSTOMERS_ROUTE, recordType, customerReadOperations),
        legalEntityId,
        mappingVersion: revision,
        principalId,
        routeId: SYMMY_DEMO_CUSTOMERS_READ_ROUTE,
        routeKey: 'adminCustomers',
        routeRevision: revision,
        tenantId,
      },
      ...groups.map(({ code, groupId, recordId }) => ({
        configuration: {
          ...configuration(SYMMY_DEMO_GROUPS_SOURCE_ROUTE, 'CUSTOMER_GROUP', [
            operation('commerce.customer-context', 'commerce.customer-context.apply-customer-group-membership-source'),
          ]),
          selector: {
            kind: 'CUSTOMER_GROUP',
            source: {
              entityKind: 'CUSTOMER_GROUP',
              issuerId: issuer,
              route: { integrationRouteId: SYMMY_DEMO_GROUPS_SOURCE_ROUTE, tenantId },
              sourceNamespace: namespace,
              sourceRecordId: recordId,
            },
            target: {
              moduleId: 'commerce.customer-context',
              resourceId: groupId,
              resourceType: 'commerce.customer-context.customer-group',
              tenantId,
            },
          },
        },
        legalEntityId,
        lifecyclePolicy: { policyId: SYMMY_DEMO_MEMBERSHIP_POLICY_ID, revision },
        mappingVersion: revision,
        principalId,
        routeCode: code,
        routeId: symmyDemoMembershipRouteId(groupId),
        routeKey: 'customerGroupCustomersBatch',
        routeRevision: revision,
        tenantId,
      })),
    ]);
  });

const PartyBindingSchema = Schema.Struct({
  authMethod: Schema.Literals(['api_key', 'system']),
  issuer: Schema.String,
  namespace: Schema.String,
  principalId: Uuid,
  recordType: Schema.String,
  routeRef: Uuid,
  tenantId: Uuid,
});

/** Additive owner configuration. The parent publishes this to Party, never to another Tenant's owner scope. */
export const symmyDemoCustomerEnvironment = (
  identities: EnvironmentIdentities,
  existing: readonly (typeof PartyBindingSchema.Type)[] = [],
) => {
  const additions = [
    { authMethod: 'api_key' as const, principalId: identities.integrationPrincipalId },
    { authMethod: 'system' as const, principalId: identities.partyWriterId },
    { authMethod: 'system' as const, principalId: identities.commerceWriterId },
    { authMethod: 'system' as const, principalId: identities.partyReaderId },
  ].map((identity) => ({
    ...identity,
    issuer,
    namespace,
    recordType,
    routeRef: SYMMY_DEMO_CUSTOMERS_ROUTE,
    tenantId,
  }));
  const entries = new Map(
    [...existing, ...additions].map((entry) => [
      JSON.stringify([
        entry.tenantId,
        entry.principalId,
        entry.authMethod,
        entry.issuer,
        entry.namespace,
        entry.recordType,
        entry.routeRef,
      ]),
      entry,
    ]),
  );
  return {
    ONTOS_PARTY_CLIENT_SOURCE_BINDINGS: JSON.stringify([...entries.values()]),
    ONTOS_PRIVACY_SOURCE_SYNC_PROCESSING_ENABLED: 'true',
  };
};

const AdminLive = Layer.unwrap(
  Effect.gen(function* adminLayer() {
    const environment = yield* Config.String('ULTRAMODERN_DEPLOYMENT_ENVIRONMENT');
    if (environment !== 'stage') {
      return yield* fail('Customer authority bootstrap is restricted to stage');
    }
    const [runtime, admin] = yield* Effect.all([
      Config.Redacted('DATABASE_URL'),
      Config.Redacted('DATABASE_ADMIN_URL'),
    ]);
    const connections = yield* parseDatabaseConnectionPair({
      DATABASE_ADMIN_URL: Redacted.value(admin),
      DATABASE_URL: Redacted.value(runtime),
    });
    return PgClient.layer({ url: Redacted.make(connections.admin.connectionString), maxConnections: 1 });
  }),
).pipe(Layer.provide(Reactivity.layer));
export const SymmyDemoCustomerAuthorityLive = AdminLive;

const EnrollmentLive = Layer.unwrap(
  Effect.gen(function* enrollmentLayer() {
    const runtime = yield* Config.Redacted('DATABASE_URL').pipe(
      Effect.mapError(() => fail('enrollment-database-config')),
    );
    const admin = yield* Config.Redacted('DATABASE_ADMIN_URL').pipe(
      Effect.mapError(() => fail('enrollment-database-config')),
    );
    const connections = yield* parseDatabaseConnectionPair({
      DATABASE_URL: Redacted.value(runtime),
      DATABASE_ADMIN_URL: Redacted.value(admin),
    }).pipe(Effect.mapError(() => fail('enrollment-database-config')));
    const database = Layer.mergeAll(
      Layer.effect(
        CoreDatabase,
        // Core's real writers install an enrolled operation scope; the admin login deliberately has no such authority.
        makeCoreDatabase(connections.runtime).pipe(Effect.mapError(() => fail('enrollment-core-client'))),
      ),
      Layer.succeed(DatabaseIdentityEnrollmentContext, APP_DATABASE_IDENTITY_ENROLLMENT),
    );
    return Layer.mergeAll(
      database,
      Layer.mergeAll(
        AccessReleaseStoreLive,
        AccessWorkloadBindingStoreLive,
        AccessWorkloadCompanyBindingStoreLive,
      ).pipe(Layer.provide(database)),
    );
  }),
);
const safeEnrollmentCodes: ReadonlySet<string> = new Set([
  'enrollment-database-config',
  'enrollment-core-client',
  'enrollment-catalog-read',
  'enrollment-catalog-declaration',
  'enrollment-source-read',
  'enrollment-legacy-ambiguity',
  'additive-read-tenant',
  'additive-company-inactive',
  'additive-module-inactive',
  'additive-release-scope',
  'additive-step-create-principal',
  'additive-step-bind-workload',
  'additive-step-bind-company',
  'additive-step-reactivate-principal',
  'additive-step-rename-principal',
  'additive-step-revoke-company',
  'additive-step-revoke-workload',
  'additive-step-disable-principal',
]);
export const safeSymmyDemoEnrollmentFailure = (error: unknown) => {
  if (
    !(Schema.is(SymmyDemoCustomerAuthorityError)(error) || Schema.is(ReleaseInternalWorkloadError)(error)) ||
    !safeEnrollmentCodes.has(error.reason)
  )
    return fail('customer-workload-enrollment');
  const detail = Schema.is(ReleaseInternalWorkloadError)(error)
    ? `:${error.sqlState ?? 'no-sqlstate'}:${error.databaseConstraint ?? 'unclassified-constraint'}`
    : '';
  return fail(`${error.reason}${detail}`);
};

/** Explicit additive administrative operation, restricted to the standing-approved AKROS stage source. */
export const ensureSymmyDemoCustomerInternalWorkloads = Effect.gen(function* ensureWorkloads() {
  if ((yield* Config.String('ULTRAMODERN_DEPLOYMENT_ENVIRONMENT')) !== 'stage')
    return yield* fail('Customer workload enrollment is restricted to stage');
  const catalog = yield* Effect.tryPromise(() =>
    readFile(new URL('../../topology/authorization-catalog.json', import.meta.url), 'utf8'),
  ).pipe(
    Effect.flatMap(
      Schema.decodeUnknownEffect(
        Schema.fromJsonString(Schema.Struct({ declaredWorkloadKeys: Schema.Array(Schema.String) })),
      ),
    ),
    Effect.mapError(() => fail('enrollment-catalog-read')),
  );
  const declarations = [];
  for (const declaration of symmyDemoCustomerInternalWorkloadDeclarations) {
    if (!catalog.declaredWorkloadKeys.includes(declaration.workloadKey))
      return yield* fail('enrollment-catalog-declaration');
    const candidates = yield* readSymmyDemoSourceWriterCandidates(declaration.workloadKey).pipe(
      Effect.mapError(() => fail('enrollment-source-read')),
    );
    const systems = candidates.filter(({ kind }) => kind === 'system');
    if (systems.length > 1) return yield* fail('enrollment-legacy-ambiguity');
    if (systems.length === 0) declarations.push(declaration);
  }
  const { executor } = yield* CoreDatabase;
  return yield* registerAdditiveCompanyInternalWorkloads(
    { enrollment: APP_DATABASE_IDENTITY_ENROLLMENT, executor },
    { tenantId, legalEntityId, declarations, runReference: 'akros-stage-customer-enrollment' },
  );
}).pipe(Effect.provide(EnrollmentLive), Effect.mapError(safeSymmyDemoEnrollmentFailure));

/** Core scoped writers use the enrolled runtime connection; raw administrator SQL is a separate capability. */
export const symmyDemoCustomerBindingDatabase = CoreDatabase.pipe(
  Effect.map(({ executor }) => ({ enrollment: APP_DATABASE_IDENTITY_ENROLLMENT, executor })),
);

/** Native registrations need not use stage bootstrap ids. Reuse the exact live company epoch, never replace it. */
export const symmyDemoCompanyBindingNeedsCreate = (active: readonly { readonly legalEntityId: string }[]) =>
  active.length > 1 || active.some((binding) => binding.legalEntityId !== legalEntityId)
    ? Effect.fail(fail('Existing workload company registration is ambiguous or names another company'))
    : Effect.succeed(active.length === 0);

const ExternalReceiverAliasSchema = Schema.Struct({
  bindingId: Uuid,
  incarnation: Uuid,
  principalId: Uuid,
  tenantId: Uuid,
  workloadKey: Schema.String,
  kind: Schema.String,
  status: Schema.String,
  foreignCompany: Schema.Boolean,
});
export const symmyDemoExternalReceiverBindingsToRevoke = (integrationPrincipalId: string, input: unknown) =>
  Schema.decodeUnknownEffect(Schema.Array(ExternalReceiverAliasSchema))(input).pipe(
    Effect.flatMap((rows) => {
      const owned = rows.filter((row) => {
        const ids = stageWorkloadBindingIds(tenantId, integrationPrincipalId, row.workloadKey);
        return (
          row.tenantId === tenantId &&
          row.principalId === integrationPrincipalId &&
          row.kind === 'integration' &&
          row.status === 'active' &&
          obsoleteExternalExecutorWorkloads.some((key) => key === row.workloadKey) &&
          row.bindingId === ids.bindingId &&
          row.incarnation === ids.bindingIncarnation
        );
      });
      return owned.some(({ foreignCompany }) => foreignCompany)
        ? Effect.fail(
            fail('Bootstrap-owned receiver alias unexpectedly names another company; no registration was revoked'),
          )
        : Effect.succeed(owned.map(({ bindingId }) => AccessWorkloadBindingIdSchema.make(bindingId)));
    }),
  );

/** Read this before starting Party. No composition, operator session, new identity or write is needed. */
export const readSymmyDemoCustomerEnvironment = Effect.gen(function* readEnvironment() {
  if ((yield* Config.String('ULTRAMODERN_DEPLOYMENT_ENVIRONMENT')) !== 'stage') {
    return yield* fail('Customer authority bootstrap is restricted to stage');
  }
  yield* ensureSymmyDemoCustomerInternalWorkloads;
  const sql = yield* PgClient.PgClient;
  const [integration] = yield* sql`select principal_id as "principalId" from symmy_integration.job_routes
    where tenant_id=${tenantId} and legal_entity_id=${legalEntityId}
      and route_id=${SYMMY_DEMO_GROUPS_ROUTE} and route_key='customerGroupsBatch' and active=true`.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ principalId: PrincipalIdSchema })]))),
    Effect.mapError(symmyDemoDiscoveryFailure('integration-route')),
  );
  const party = yield* resolveSymmyDemoSourceWriter(partyWriter).pipe(
    Effect.mapError(symmyDemoDiscoveryFailure('party-writer')),
  );
  const commerce = yield* resolveSymmyDemoSourceWriter(sourceWriter).pipe(
    Effect.mapError(symmyDemoDiscoveryFailure('commerce-writer')),
  );
  const reader = yield* resolveSymmyDemoSourceWriter(
    'party.registry.source-read',
    symmyDemoObsoleteReceiverBindingIds(party.principalId, commerce.principalId, 'party.registry.source-read'),
  ).pipe(Effect.mapError(symmyDemoDiscoveryFailure('party-reader')));
  const identities = yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      commerceWriterId: Uuid,
      integrationPrincipalId: Uuid,
      partyWriterId: Uuid,
      partyReaderId: Uuid,
    }),
  )({
    partyReaderId: reader.principalId,
    commerceWriterId: commerce.principalId,
    integrationPrincipalId: integration.principalId,
    partyWriterId: party.principalId,
  });
  const configuredBindings = yield* Config.schema(
    Schema.fromJsonString(Schema.Array(PartyBindingSchema)),
    'ONTOS_PARTY_CLIENT_SOURCE_BINDINGS',
  ).pipe(Config.withDefault([]));
  return { environment: symmyDemoCustomerEnvironment(identities, configuredBindings), identities };
});

/** Admin bootstrap only; authentic principal IDs come from Core's actual enrolled system workloads. */
export const bootstrapSymmyDemoCustomerAuthority = Effect.fn('SymmyDemoCustomerAuthority.bootstrap')(
  function* bootstrap(mode: 'apply' | 'verify') {
    if ((yield* Config.String('ULTRAMODERN_DEPLOYMENT_ENVIRONMENT')) !== 'stage') {
      return yield* fail('Customer authority bootstrap is restricted to stage');
    }
    if (mode === 'apply') yield* ensureSymmyDemoCustomerInternalWorkloads;
    const { SymmyRouteExecutionConfigurationSchema, SymmyJobRetentionPolicySchema } = yield* Effect.tryPromise({
      catch: () => fail('The production Symmy source contracts could not be loaded'),
      try: () => import('@app/symmy-integration/symmy-internal-contracts'),
    });
    const {
      symmyPlannedRouteRow,
      symmyRetentionRefusals,
      symmyRouteInventoryOf,
      symmyRouteRequestRefusals,
      symmyRouteEnrollmentLockKey,
    } = yield* Effect.tryPromise({
      catch: () => fail('The production Symmy enrollment contract could not be loaded'),
      try: () => import('../../verticals/symmy-integration/src/ops/symmy-route-enrollment.ts'),
    });
    const sql = yield* PgClient.PgClient;
    const executor = yield* makeWithDefaults({ relations: coreRelations });
    const rows = yield* sql`
      select principal_id as "principalId", fixture_plan as configuration,
        route_revision as "routeRevision", mapping_version as "mappingVersion"
      from symmy_integration.job_routes
      where tenant_id=${tenantId} and legal_entity_id=${legalEntityId}
        and route_id=${SYMMY_DEMO_GROUPS_ROUTE} and route_key='customerGroupsBatch' and active=true`;
    const [existing] = yield* Schema.decodeUnknownEffect(
      Schema.Tuple([
        Schema.Struct({
          configuration: SymmyRouteExecutionConfigurationSchema,
          mappingVersion: Schema.Literal(revision),
          principalId: PrincipalIdSchema,
          routeRevision: Schema.Literal(revision),
        }),
      ]),
    )(rows);
    if (
      existing.configuration.sourceRouteId !== SYMMY_DEMO_GROUPS_SOURCE_ROUTE ||
      existing.configuration.sourceRouteRevision !== revision ||
      existing.configuration.sourceMappingVersion !== revision ||
      existing.configuration.items.some(
        ({ source }) => source.issuerId !== issuer || source.sourceNamespace !== namespace,
      )
    ) {
      return yield* fail('The existing AKROS group route does not name the declared Symmy source');
    }
    const [party, commerce] = yield* Effect.all(
      [resolveSymmyDemoSourceWriter(partyWriter), resolveSymmyDemoSourceWriter(sourceWriter)],
      { concurrency: 1 },
    );
    const owners = yield* sql`
      select m.principal_id as "principalId"
      from core.access_memberships m join core.access_scopes s using(tenant_id,scope_id)
      join core.principals p on p.tenant_id=m.tenant_id and p.principal_id=m.principal_id
      where m.tenant_id=${tenantId} and s.legal_entity_id is null
        and m.kind='owner' and m.status='active' and p.kind='human' and p.status='active'
        and m.valid_from<=clock_timestamp() and (m.valid_until is null or m.valid_until>clock_timestamp())`;
    const [owner] = yield* Schema.decodeUnknownEffect(
      Schema.Tuple([Schema.Struct({ principalId: PrincipalIdSchema })]),
    )(owners);
    const scope = yield* stageScopeOf({ principalId: owner.principalId, tenantId });
    const database = yield* symmyDemoCustomerBindingDatabase;
    const bindingStore = yield* AccessWorkloadBindingStore;
    const externalAliases = yield* sql`select b.binding_id as "bindingId", b.incarnation,
      b.principal_id as "principalId", b.tenant_id as "tenantId", b.workload_key as "workloadKey",
      p.kind, b.status, exists(
        select 1 from core.access_workload_company_bindings cb where cb.tenant_id=b.tenant_id
          and cb.workload_binding_id=b.binding_id and cb.legal_entity_id<>${legalEntityId}
      ) as "foreignCompany"
      from core.access_workload_bindings b join core.principals p
        on p.tenant_id=b.tenant_id and p.principal_id=b.principal_id
      where b.tenant_id=${tenantId} and b.principal_id=${existing.principalId} and b.status='active'`;
    const obsoleteExternalBindings = yield* symmyDemoExternalReceiverBindingsToRevoke(
      existing.principalId,
      externalAliases,
    );
    if (mode === 'verify' && obsoleteExternalBindings.length > 0)
      return yield* fail('Bootstrap-owned receiver aliases remain on the external integration; run apply');
    for (const bindingId of obsoleteExternalBindings) {
      yield* bindingStore.revokeBinding(scope, { bindingId, revokedAt: new Date() });
    }
    // Remove only duplicate executor aliases this bootstrap previously created. Unique legacy SYSTEM stays.
    for (const key of customerReceiverWorkloads) {
      const systems = yield* sql`select b.binding_id as "bindingId" from core.access_workload_bindings b
        join core.principals p on p.tenant_id=b.tenant_id and p.principal_id=b.principal_id
        where b.tenant_id=${tenantId} and b.workload_key=${key} and b.status='active'
          and p.kind='system' and p.status='active'`;
      if (systems.length <= 1) continue;
      for (const principalId of [party.principalId, commerce.principalId]) {
        const ids = stageWorkloadBindingIds(tenantId, principalId, key);
        if (!systems.some((row) => row.bindingId === ids.bindingId)) continue;
        if (mode === 'apply') {
          yield* bindingStore.revokeBinding(scope, {
            bindingId: AccessWorkloadBindingIdSchema.make(ids.bindingId),
            revokedAt: new Date(),
          });
        } else {
          return yield* fail(`Duplicate obsolete bootstrap receiver binding remains for ${key}; run apply`);
        }
      }
    }
    const receiverIdentities = yield* resolveSymmyDemoCustomerReceivers(
      party.principalId,
      commerce.principalId,
      'post-registration',
    );
    const identities = yield* Schema.decodeUnknownEffect(IdentitySchema)({
      ...receiverIdentities,
      commerceWriterId: commerce.principalId,
      integrationPrincipalId: existing.principalId,
      partyWriterId: party.principalId,
    });
    const grants = [
      ...integrationWorkloads.map((key) => ({ key, principalId: existing.principalId })),
      { key: partyWriter, principalId: party.principalId },
      { key: sourceWriter, principalId: commerce.principalId },
      ...receiverIdentities.receivers,
    ];
    for (const { key, principalId } of grants) {
      const workloadKey = yield* Schema.decodeUnknownEffect(WorkloadKeySchema)(key);
      const [live] = yield* executor
        .select()
        .from(accessWorkloadBindings)
        .where(
          and(
            eq(accessWorkloadBindings.tenantId, tenantId),
            eq(accessWorkloadBindings.principalId, principalId),
            eq(accessWorkloadBindings.workloadKey, workloadKey),
            eq(accessWorkloadBindings.status, 'active'),
          ),
        );
      const ids = stageWorkloadBindingIds(tenantId, principalId, key);
      const bindingId = AccessWorkloadBindingIdSchema.make(live?.bindingId ?? ids.bindingId);
      const companyIds = stageWorkloadCompanyIds(tenantId, bindingId, legalEntityId);
      const activeCompanies = yield* executor
        .select({ legalEntityId: accessWorkloadCompanyBindings.legalEntityId })
        .from(accessWorkloadCompanyBindings)
        .where(
          and(
            eq(accessWorkloadCompanyBindings.tenantId, tenantId),
            eq(accessWorkloadCompanyBindings.workloadBindingId, bindingId),
            eq(accessWorkloadCompanyBindings.status, 'active'),
          ),
        );
      const createCompanyBinding = yield* symmyDemoCompanyBindingNeedsCreate(activeCompanies);
      if (mode === 'apply') {
        if (live === undefined) {
          yield* writeWorkloadBindings(database, scope, {
            bindings: [
              {
                bindingId,
                createdAt: new Date(),
                incarnation: AccessWorkloadBindingIdSchema.make(ids.bindingIncarnation),
                principalId,
                tenantId,
                workloadKey,
              },
            ],
          });
        }
        if (createCompanyBinding)
          yield* writeWorkloadCompanyBindings(database, scope, {
            bindings: [
              {
                companyBindingId: AccessWorkloadCompanyBindingIdSchema.make(companyIds.companyBindingId),
                createdAt: new Date(),
                incarnation: AccessWorkloadCompanyBindingIdSchema.make(companyIds.companyIncarnation),
                legalEntityId,
                tenantId,
                workloadBindingId: bindingId,
              },
            ],
          });
      }
      const bindings = yield* executor
        .select()
        .from(accessWorkloadCompanyBindings)
        .innerJoin(
          accessWorkloadBindings,
          and(
            eq(accessWorkloadBindings.tenantId, accessWorkloadCompanyBindings.tenantId),
            eq(accessWorkloadBindings.bindingId, accessWorkloadCompanyBindings.workloadBindingId),
            eq(accessWorkloadBindings.status, 'active'),
          ),
        )
        .where(
          and(
            eq(accessWorkloadCompanyBindings.tenantId, tenantId),
            eq(accessWorkloadCompanyBindings.workloadBindingId, bindingId),
            eq(accessWorkloadCompanyBindings.legalEntityId, legalEntityId),
            eq(accessWorkloadCompanyBindings.status, 'active'),
          ),
        );
      if (bindings.length !== 1) {
        return yield* fail(`No active AKROS company registration for ${key}; revoked policy is never revived`);
      }
    }
    const sourceSyncPolicy = yield* buildSymmySourceSyncProcessingPolicy(identities);
    const encodedSourceSyncPolicy = yield* Schema.encodeEffect(SourceSyncProcessingPolicySchema)(sourceSyncPolicy);
    if (mode === 'apply') {
      yield* sql.withTransaction(
        Effect.gen(function* installSourceSyncPolicy() {
          yield* sql`select pg_advisory_xact_lock(hashtextextended(
            ${`${tenantId}:${legalEntityId}:source-sync-processing-policy`},0))`;
          yield* sql`insert into privacy.demo_source_processing_policies
          (tenant_id,legal_entity_id,policy_id,policy_record)
          values(${tenantId},${legalEntityId},${sourceSyncPolicy.policyId},${sql.json(encodedSourceSyncPolicy)})
          on conflict (tenant_id,legal_entity_id,policy_id) do update
          set policy_record=jsonb_set(privacy.demo_source_processing_policies.policy_record,'{callers}',
            excluded.policy_record->'callers')
          where privacy.demo_source_processing_policies.policy_record-'callers'=excluded.policy_record-'callers'`;
        }),
      );
    }
    const verifiedPolicy = yield* sql`select policy_id from privacy.demo_source_processing_policies
      where tenant_id=${tenantId} and legal_entity_id=${legalEntityId}
        and policy_id=${sourceSyncPolicy.policyId} and policy_record=${sql.json(encodedSourceSyncPolicy)}::jsonb`;
    if (verifiedPolicy.length !== 1) {
      return yield* fail('Existing source sync policy differs; no policy was overwritten or reactivated');
    }

    // Bootstrap inserts are not Action invocations and deliberately manufacture no Action history/receipt.
    // Only the exact bootstrap-owned read grant can grow. Never overwrite an operator-managed route.
    yield* sql.withTransaction(
      Effect.gen(function* ownerSources() {
        yield* sql`select pg_advisory_xact_lock(hashtextextended(${`${tenantId}:symmy-demo-customer-authority`},0))`;
        if (mode === 'apply') {
          yield* sql`insert into commerce_customer_context.customer_profile_source_routes
          (tenant_id,legal_entity_id,route_id,route_revision,mapping_revision,issuer,namespace,record_type,
            principal_id,active,source_reader_principal_ids)
          values(${tenantId},${legalEntityId},${SYMMY_DEMO_CUSTOMERS_ROUTE},${revision},${revision},
            ${issuer},${namespace},${recordType},${commerce.principalId},true,ARRAY[${receiverIdentities.commerceReaderId}]::uuid[])
          on conflict do nothing`;
          yield* sql`insert into commerce_customer_context.saved_address_source_routes
          (tenant_id,legal_entity_id,route_ref,route_revision,mapping_revision,issuer,namespace,record_type,principal_id,active)
          values(${tenantId},${legalEntityId},${SYMMY_DEMO_CUSTOMERS_ROUTE},${revision},${revision},
            ${issuer},${namespace},${recordType},${commerce.principalId},true) on conflict do nothing`;
          yield* sql`insert into commerce_customer_context.customer_group_definition_source_routes
          (tenant_id,legal_entity_id,route_id,route_revision,mapping_revision,issuer,namespace,
            principal_id,active,source_reader_principal_ids)
          values(${tenantId},${legalEntityId},${SYMMY_DEMO_GROUPS_SOURCE_ROUTE},${revision},${revision},
            ${issuer},${namespace},${commerce.principalId},true,
            ARRAY[${existing.principalId},${receiverIdentities.commerceReaderId}]::uuid[])
          on conflict do nothing`;
          yield* sql`insert into commerce_customer_context.customer_group_membership_source_routes
          (tenant_id,legal_entity_id,route_id,route_revision,issuer,source_namespace,principal_id,active,allow_complete)
          values(${tenantId},${legalEntityId},${SYMMY_DEMO_GROUPS_SOURCE_ROUTE},${revision},
            ${issuer},${namespace},${commerce.principalId},true,false) on conflict do nothing`;
        }
        for (const [kind, id, table] of [
          ['PROFILE', SYMMY_DEMO_CUSTOMERS_ROUTE, sql`commerce_customer_context.customer_profile_source_routes`],
          [
            'GROUP_DEFINITION',
            SYMMY_DEMO_GROUPS_SOURCE_ROUTE,
            sql`commerce_customer_context.customer_group_definition_source_routes`,
          ],
        ] as const) {
          const record = kind === 'PROFILE' ? sql`and record_type=${recordType}` : sql``;
          const where = sql`tenant_id=${tenantId} and legal_entity_id=${legalEntityId} and route_id=${id}
            and route_revision=${revision} and mapping_revision=${revision} and issuer=${issuer} and namespace=${namespace}
            and principal_id=${commerce.principalId} and active ${record}`;
          const [route] = yield* sql`select source_reader_principal_ids as readers, exists(select 1 from
            commerce_customer_context.customer_source_route_history h where h.tenant_id=${tenantId} and
            h.legal_entity_id=${legalEntityId} and h.route_kind=${kind} and h.route_id=${id}) as managed
            from ${table} where ${where} for update`.pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.Tuple([Schema.Struct({ readers: Schema.Array(Uuid), managed: Schema.Boolean })]),
              ),
            ),
            Effect.mapError(() => fail(`Exact active AKROS ${kind} source route is absent`)),
          );
          if (
            yield* symmyDemoNativeReaderNeedsEnrollment(
              route,
              existing.principalId,
              receiverIdentities.commerceReaderId,
            )
          ) {
            if (mode !== 'apply') return yield* fail(`Native Commerce reader not enrolled on ${kind}`);
            yield* sql`update ${table} set source_reader_principal_ids=array_append(source_reader_principal_ids,
              ${receiverIdentities.commerceReaderId}::uuid), generation=generation+1 where ${where}
              returning ${receiverIdentities.commerceReaderId}::uuid=any(source_reader_principal_ids) as enrolled`.pipe(
              Effect.flatMap(
                Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ enrolled: Schema.Literal(true) })])),
              ),
              Effect.mapError(() => fail(`Native Commerce reader was not enrolled on ${kind}`)),
            );
          }
        }
        const checks = yield* sql`select
        exists(select 1 from commerce_customer_context.customer_profile_source_routes
          where tenant_id=${tenantId} and legal_entity_id=${legalEntityId} and route_id=${SYMMY_DEMO_CUSTOMERS_ROUTE}
          and route_revision=${revision} and mapping_revision=${revision} and issuer=${issuer} and namespace=${namespace}
          and record_type=${recordType} and principal_id=${commerce.principalId} and active=true
          and ${receiverIdentities.commerceReaderId}::uuid=any(source_reader_principal_ids)) as profile,
        exists(select 1 from commerce_customer_context.saved_address_source_routes
          where tenant_id=${tenantId} and legal_entity_id=${legalEntityId} and route_ref=${SYMMY_DEMO_CUSTOMERS_ROUTE}
          and route_revision=${revision} and mapping_revision=${revision} and issuer=${issuer} and namespace=${namespace}
          and record_type=${recordType} and principal_id=${commerce.principalId} and active=true) as address,
        exists(select 1 from commerce_customer_context.customer_group_membership_source_routes
          where tenant_id=${tenantId} and legal_entity_id=${legalEntityId} and route_id=${SYMMY_DEMO_GROUPS_SOURCE_ROUTE}
          and route_revision=${revision} and issuer=${issuer} and source_namespace=${namespace}
          and principal_id=${commerce.principalId} and active=true and allow_complete=false) as membership`;
        yield* Schema.decodeUnknownEffect(
          Schema.Tuple([
            Schema.Struct({
              address: Schema.Literal(true),
              membership: Schema.Literal(true),
              profile: Schema.Literal(true),
            }),
          ]),
        )(checks).pipe(
          Effect.mapError(() => fail('Existing owner source authority differs; no policy was overwritten')),
        );
      }),
    );
    // The selector must come from an actual owner binding, never a UUID guessed from the group code.
    const groupRows = yield* sql`select source_code as code, customer_group_id as "groupId", record_id as "recordId"
      from commerce_customer_context.customer_group_definition_source_bindings
      where tenant_id=${tenantId} and legal_entity_id=${legalEntityId}
        and issuer=${issuer} and namespace=${namespace}
        and source_intent #>> '{payload,source,route,id}'=${SYMMY_DEMO_GROUPS_SOURCE_ROUTE}`;
    const groups = yield* Schema.decodeUnknownEffect(Schema.Array(GroupSchema))(groupRows);
    const routes = yield* buildSymmyDemoCustomerRoutes(existing.principalId, groups);
    const policies = yield* Config.schema(
      Schema.fromJsonString(Schema.Array(SymmyJobRetentionPolicySchema)),
      'ONTOS_SYMMY_JOB_RETENTION_POLICIES',
    );
    const receipts: { outcome: string; routeId: string; routeKey: string }[] = [];
    for (const request of routes) {
      const inventory = symmyRouteInventoryOf(request.routeKey);
      if (Option.isNone(inventory)) {
        return yield* fail(`No production inventory for ${request.routeKey}`);
      }
      const refusals = [
        ...symmyRouteRequestRefusals(request, inventory.value),
        ...symmyRetentionRefusals(request, policies),
      ];
      if (refusals.length > 0) {
        return yield* fail(refusals.map(({ code, detail }) => `${code}: ${detail}`).join('; '));
      }
      // Only initialize. No update means a new release cannot rotate the epoch of in-flight work.
      // These are administrator enrollment records, never forged owner Action receipts.
      const planned = symmyPlannedRouteRow(request);
      const encoded = yield* Schema.encodeEffect(SymmyRouteExecutionConfigurationSchema)(request.configuration);
      const policy = request.lifecyclePolicy ?? null;
      yield* sql.withTransaction(
        Effect.gen(function* initializeRoute() {
          yield* sql`select pg_advisory_xact_lock(hashtextextended(
          ${symmyRouteEnrollmentLockKey(request)},0))`;
          const peers = yield* sql`select route_id from symmy_integration.job_routes
          where tenant_id=${tenantId} and principal_id=${existing.principalId}
            and route_key=${request.routeKey} and route_code is not distinct from ${planned.routeCode}::text
            and route_id<>${request.routeId} and active=true`;
          if (peers.length > 0) {
            return yield* fail(
              `An existing ${request.routeKey} already holds this source selector; no second company route was created`,
            );
          }
          if (mode === 'apply') {
            yield* sql`insert into symmy_integration.job_routes
          (tenant_id,legal_entity_id,principal_id,route_id,route_key,route_code,route_revision,
            mapping_version,fixture_ids,fixture_plan,lifecycle_policy,active)
          values(${tenantId},${legalEntityId},${existing.principalId},${request.routeId},${request.routeKey},
            ${planned.routeCode},${revision},${revision},${planned.fixtureIds},
            ${sql.json(encoded)},${policy === null ? null : sql.json(policy)},true) on conflict do nothing`;
          }
          const observed = yield* sql`select route_id as "routeId" from symmy_integration.job_routes
        where tenant_id=${tenantId} and legal_entity_id=${legalEntityId} and principal_id=${existing.principalId}
          and route_id=${request.routeId} and route_key=${request.routeKey}
          and route_code is not distinct from ${planned.routeCode}::text
          and route_revision=${revision} and mapping_version=${revision} and active=true
          and fixture_ids=${planned.fixtureIds}::text[] and fixture_plan=${sql.json(encoded)}::jsonb
          and lifecycle_policy is not distinct from ${policy === null ? null : sql.json(policy)}::jsonb`;
          yield* Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ routeId: Uuid })]))(observed).pipe(
            Effect.mapError(() =>
              fail(`Existing ${request.routeKey} enrollment differs; no route or epoch was replaced`),
            ),
          );
        }),
      );
      receipts.push({ outcome: 'verified', routeId: request.routeId, routeKey: request.routeKey });
    }
    const configuredBindings = yield* Config.schema(
      Schema.fromJsonString(Schema.Array(PartyBindingSchema)),
      'ONTOS_PARTY_CLIENT_SOURCE_BINDINGS',
    ).pipe(Config.withDefault([]));
    const environment = symmyDemoCustomerEnvironment(identities, configuredBindings);
    const contexts = yield* Config.schema(
      Schema.fromJsonString(Schema.Array(SourceProcessingContextSchema)),
      'ONTOS_PRIVACY_SOURCE_PROCESSING_CONTEXTS',
    ).pipe(Config.withDefault([]));
    const personalContexts = contexts.filter(
      (context) =>
        context.tenantId === tenantId &&
        context.legalEntityId === legalEntityId &&
        context.request.source?.routeRef === SYMMY_DEMO_CUSTOMERS_ROUTE,
    );
    return {
      environment,
      identities,
      sourceProcessingAuthority: 'SOURCE_SYNC_PROCESSING_POLICY' as const,
      exactPersonalDataContexts: personalContexts.length,
      readyForSourceSync: true,
      receipts,
      retention: symmyDemoCustomerRetentionRefs(),
    };
  },
  Effect.provide(EnrollmentLive),
);

const command = Command.make(
  'symmy-demo-customer-authority',
  { mode: Flag.Literals('mode', ['apply', 'verify', 'environment', 'enroll']).pipe(Flag.withDefault('verify')) },
  ({ mode }) =>
    mode === 'enroll'
      ? ensureSymmyDemoCustomerInternalWorkloads.pipe(
          Effect.flatMap((counts) => Console.log(JSON.stringify({ mode: 'enroll', ...counts }))),
        )
      : mode === 'environment'
        ? readSymmyDemoCustomerEnvironment.pipe(
            Effect.flatMap(({ environment }) => Console.log(JSON.stringify(environment))),
          )
        : bootstrapSymmyDemoCustomerAuthority(mode).pipe(
            Effect.flatMap((result) =>
              Console.log({
                mode,
                sourceProcessingAuthority: result.sourceProcessingAuthority,
                routes: result.receipts.map(({ outcome, routeId, routeKey }) => ({ outcome, routeId, routeKey })),
              }),
            ),
            Effect.mapError(() =>
              fail(
                'AKROS customer authority bootstrap did not converge; inspect retention, workloads and existing owner policy',
              ),
            ),
          ),
);

if (import.meta.main) {
  NodeRuntime.runMain(
    Command.run(command, { version: '1.0.0' }).pipe(
      Effect.provide(SymmyDemoCustomerAuthorityLive),
      Effect.provide(NodeServices.layer),
      Effect.tapError((error) =>
        Console.error(
          Schema.is(SymmyDemoCustomerAuthorityError)(error) ? error.reason : 'AKROS customer authority unavailable',
        ),
      ),
    ),
  );
}
