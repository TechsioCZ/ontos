#!/usr/bin/env node
/**
 * Noninteractive AKROS-only source enrollment. Run after internal workload registration.
 *
 * node scripts/demo/symmy-demo-customer-authority.mts --mode apply
 * node scripts/demo/symmy-demo-customer-authority.mts --mode verify
 *
 * No person, API key, Privacy decision, receipt, contract or legal basis is invented here.
 * The existing customer-group route identifies the integration; Core identifies the real source writers.
 * Administrative inserts initialize missing owner source registries and routes only. Existing differing policy is
 * refused, never replaced, so an enrollment epoch of outstanding work cannot change.
 *
 * Required: ULTRAMODERN_DEPLOYMENT_ENVIRONMENT=stage, DATABASE_URL, DATABASE_ADMIN_URL,
 * ONTOS_SYMMY_JOB_RETENTION_POLICIES. No published-composition URL is needed.
 * Synthetic imports use the migrated, administrator-owned demo source policy. Publish the environment builder's
 * ONTOS_PRIVACY_DEMO_SOURCE_PROCESSING_ENABLED and ONTOS_PARTY_CLIENT_SOURCE_BINDINGS before starting owners.
 * Real-person processing remains on Privacy's ordinary exact-context/legal-basis path; no demo policy grants it.
 * A parent host must hand these environment additions to the owner processes; setting this child's environment
 * cannot reconfigure an already running owner. This script does not claim an end-to-end owner smoke passed.
 */
import { createHash } from 'node:crypto';

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
import { AccessWorkloadBindingIdSchema } from '../../packages/core-runtime/src/access/workloads/store.ts';
import { WorkloadKeySchema } from '../../packages/core-runtime/src/authorization/access-declaration.ts';
import {
  accessWorkloadBindings,
  accessWorkloadCompanyBindings,
  coreRelations,
} from '../../packages/core-runtime/src/db/schema.ts';
import { stageScopeOf } from '../../packages/core-runtime/src/install/stage-context-bootstrap.ts';
import { SourceProcessingContextSchema } from '../../verticals/privacy/shared/apis/source-processing-eligibility.ts';
import { executeSourceProcessingEligibilityWithAuthorization } from '@app/privacy/api/source-processing-eligibility/client';
import { DemoSourceProcessingPolicySchema } from '../../verticals/privacy/shared/domain/demo-source-processing-policy.ts';
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
export const SYMMY_DEMO_MEMBERSHIP_POLICY_ID = 'akros-symmy-memberships';
const issuer = 'symmy-akros';
const namespace = 'akros-erp';
const revision = 'v1';
const recordType = 'CUSTOMER';
const sourceWriter = 'commerce.customer-context.source-write';
const partyWriter = 'party.registry.source-write';
const integrationWorkloads = [
  'integration.symmy-admit',
  'integration.symmy-poll',
  'commerce.customer-context.source-read',
  'party.registry.source-read',
  'privacy.core.source-processing-check',
] as const;
export const symmyDemoCustomerWorkloadRequirements = {
  integration: integrationWorkloads,
  existingSystemWriters: [partyWriter, sourceWriter],
} as const;

export class SymmyDemoCustomerAuthorityError extends Schema.TaggedError<SymmyDemoCustomerAuthorityError>()(
  'SymmyDemoCustomerAuthorityError',
  { reason: Schema.String },
) {}
const fail = (message: string) => new SymmyDemoCustomerAuthorityError({ reason: message });
const tenantId = TenantIdSchema.make(SYMMY_DEMO_CUSTOMER_TENANT);
const legalEntityId = LegalEntityIdSchema.make(SYMMY_DEMO_CUSTOMER_COMPANY);
const Uuid = Schema.String.check(Schema.isUUID());
const IdentitySchema = Schema.Struct({
  commerceWriterId: Uuid,
  integrationPrincipalId: Uuid,
  partyWriterId: Uuid,
});
type Identities = typeof IdentitySchema.Type;
const GroupSchema = Schema.Struct({
  code: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9._-]{1,80}$/u)),
  groupId: Uuid,
  recordId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
});
type Group = typeof GroupSchema.Type;

export const buildSymmyDemoSourceProcessingPolicy = (identities: Identities) =>
  Schema.decodeUnknownEffect(DemoSourceProcessingPolicySchema)({
    active: true,
    callers: [
      { authMethod: 'api_key', principalId: identities.integrationPrincipalId },
      { authMethod: 'system', principalId: identities.partyWriterId },
      { authMethod: 'system', principalId: identities.commerceWriterId },
    ],
    customerRouteId: SYMMY_DEMO_CUSTOMERS_ROUTE,
    dataUse: 'DEMO_TEST_DATA_ONLY',
    effectiveFrom: '2026-11-23T00:00:00.000Z',
    groupRouteId: SYMMY_DEMO_GROUPS_ROUTE,
    issuer,
    legalEntityId,
    namespace,
    policyId: 'akros-symmy-demo-test-data',
    purpose: 'DEMO_CUSTOMER_IMPORT_TESTING',
    reason: 'Standing operator approval for AKROS stage synthetic customer import testing; not real-person processing',
    revision,
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
          ...configuration(SYMMY_DEMO_GROUPS_ROUTE, 'CUSTOMER_GROUP', [
            operation('commerce.customer-context', 'commerce.customer-context.apply-customer-group-membership-source'),
          ]),
          selector: {
            kind: 'CUSTOMER_GROUP',
            source: {
              entityKind: 'CUSTOMER_GROUP',
              issuerId: issuer,
              route: { integrationRouteId: SYMMY_DEMO_GROUPS_ROUTE, tenantId },
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
  identities: Identities,
  existing: readonly (typeof PartyBindingSchema.Type)[] = [],
) => {
  const additions = [
    { authMethod: 'api_key' as const, principalId: identities.integrationPrincipalId },
    { authMethod: 'system' as const, principalId: identities.partyWriterId },
    { authMethod: 'system' as const, principalId: identities.commerceWriterId },
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
    ONTOS_PRIVACY_DEMO_SOURCE_PROCESSING_ENABLED: 'true',
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

/** Read this before starting Party. No composition, operator session, new identity or write is needed. */
export const readSymmyDemoCustomerEnvironment = Effect.gen(function* readEnvironment() {
  if ((yield* Config.String('ULTRAMODERN_DEPLOYMENT_ENVIRONMENT')) !== 'stage') {
    return yield* fail('Customer authority bootstrap is restricted to stage');
  }
  const sql = yield* PgClient.PgClient;
  const executor = yield* makeWithDefaults({ relations: coreRelations });
  const rows = yield* sql`select principal_id as "principalId" from symmy_integration.job_routes
    where tenant_id=${tenantId} and legal_entity_id=${legalEntityId}
      and route_id=${SYMMY_DEMO_GROUPS_ROUTE} and route_key='customerGroupsBatch' and active=true`;
  const [integration] = yield* Schema.decodeUnknownEffect(
    Schema.Tuple([Schema.Struct({ principalId: PrincipalIdSchema })]),
  )(rows);
  const resolver = makeSystemPrincipalContextResolver({ executor });
  const resolve = (jobKey: string) =>
    resolver.resolveEnrolled({
      registration: registerSystemWorkload({ jobKey }),
      runReference: 'akros-demo-customer-environment-discovery',
      tenantId,
    });
  const [party, commerce] = yield* Effect.all([resolve(partyWriter), resolve(sourceWriter)], { concurrency: 1 });
  const identities = yield* Schema.decodeUnknownEffect(IdentitySchema)({
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
      existing.configuration.items.some(
        ({ source }) => source.issuerId !== issuer || source.sourceNamespace !== namespace,
      )
    ) {
      return yield* fail('The existing AKROS group route does not name the declared Symmy source');
    }
    const resolver = makeSystemPrincipalContextResolver({ executor });
    const resolve = (jobKey: string) =>
      resolver.resolveEnrolled({
        registration: registerSystemWorkload({ jobKey }),
        runReference: 'akros-demo-customer-authority-bootstrap',
        tenantId,
      });
    const [party, commerce] = yield* Effect.all([resolve(partyWriter), resolve(sourceWriter)], { concurrency: 1 });
    const identities = yield* Schema.decodeUnknownEffect(IdentitySchema)({
      commerceWriterId: commerce.principalId,
      integrationPrincipalId: existing.principalId,
      partyWriterId: party.principalId,
    });
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
    const database = { enrollment: APP_DATABASE_IDENTITY_ENROLLMENT, executor };
    const grants = [
      ...integrationWorkloads.map((key) => ({ key, principalId: existing.principalId })),
      ...[partyWriter, 'privacy.core.source-processing-check', 'privacy.core.organization-business-check'].map(
        (key) => ({ key, principalId: party.principalId }),
      ),
      ...[
        sourceWriter,
        'privacy.core.source-processing-check',
        'privacy.core.organization-business-check',
        'party.registry.source-read',
        'commerce.customer-context.source-read',
      ].map((key) => ({ key, principalId: commerce.principalId })),
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
    const demoPolicy = yield* buildSymmyDemoSourceProcessingPolicy(identities);
    const encodedDemoPolicy = yield* Schema.encodeEffect(DemoSourceProcessingPolicySchema)(demoPolicy);
    if (mode === 'apply') {
      yield* sql.withTransaction(
        Effect.gen(function* installDemoPolicy() {
          yield* sql`select pg_advisory_xact_lock(hashtextextended(
            ${`${tenantId}:${legalEntityId}:demo-source-processing-policy`},0))`;
          yield* sql`insert into privacy.demo_source_processing_policies
          (tenant_id,legal_entity_id,policy_id,policy_record)
          values(${tenantId},${legalEntityId},${demoPolicy.policyId},${sql.json(encodedDemoPolicy)})
          on conflict do nothing`;
        }),
      );
    }
    const verifiedPolicy = yield* sql`select policy_id from privacy.demo_source_processing_policies
      where tenant_id=${tenantId} and legal_entity_id=${legalEntityId}
        and policy_id=${demoPolicy.policyId} and policy_record=${sql.json(encodedDemoPolicy)}::jsonb`;
    if (verifiedPolicy.length !== 1) {
      return yield* fail('Existing demo source policy differs; no policy was overwritten or reactivated');
    }

    // Bootstrap inserts are not Action invocations and deliberately manufacture no Action history/receipt.
    // A conflicting existing row is never changed: verify the full source policy after ON CONFLICT DO NOTHING.
    yield* sql.withTransaction(
      Effect.gen(function* ownerSources() {
        yield* sql`select pg_advisory_xact_lock(hashtextextended(${`${tenantId}:symmy-demo-customer-authority`},0))`;
        if (mode === 'apply') {
          yield* sql`insert into commerce_customer_context.customer_profile_source_routes
          (tenant_id,legal_entity_id,route_id,route_revision,mapping_revision,issuer,namespace,record_type,
            principal_id,active,source_reader_principal_ids)
          values(${tenantId},${legalEntityId},${SYMMY_DEMO_CUSTOMERS_ROUTE},${revision},${revision},
            ${issuer},${namespace},${recordType},${commerce.principalId},true,ARRAY[${existing.principalId}]::uuid[])
          on conflict do nothing`;
          yield* sql`insert into commerce_customer_context.saved_address_source_routes
          (tenant_id,legal_entity_id,route_ref,route_revision,mapping_revision,issuer,namespace,record_type,principal_id,active)
          values(${tenantId},${legalEntityId},${SYMMY_DEMO_CUSTOMERS_ROUTE},${revision},${revision},
            ${issuer},${namespace},${recordType},${commerce.principalId},true) on conflict do nothing`;
          yield* sql`insert into commerce_customer_context.customer_group_membership_source_routes
          (tenant_id,legal_entity_id,route_id,route_revision,issuer,source_namespace,principal_id,active,allow_complete)
          values(${tenantId},${legalEntityId},${SYMMY_DEMO_GROUPS_ROUTE},${revision},
            ${issuer},${namespace},${commerce.principalId},true,false) on conflict do nothing`;
        }
        const checks = yield* sql`select
        exists(select 1 from commerce_customer_context.customer_profile_source_routes
          where tenant_id=${tenantId} and legal_entity_id=${legalEntityId} and route_id=${SYMMY_DEMO_CUSTOMERS_ROUTE}
          and route_revision=${revision} and mapping_revision=${revision} and issuer=${issuer} and namespace=${namespace}
          and record_type=${recordType} and principal_id=${commerce.principalId} and active=true
          and ${existing.principalId}::uuid=any(source_reader_principal_ids)) as profile,
        exists(select 1 from commerce_customer_context.saved_address_source_routes
          where tenant_id=${tenantId} and legal_entity_id=${legalEntityId} and route_ref=${SYMMY_DEMO_CUSTOMERS_ROUTE}
          and route_revision=${revision} and mapping_revision=${revision} and issuer=${issuer} and namespace=${namespace}
          and record_type=${recordType} and principal_id=${commerce.principalId} and active=true) as address,
        exists(select 1 from commerce_customer_context.customer_group_membership_source_routes
          where tenant_id=${tenantId} and legal_entity_id=${legalEntityId} and route_id=${SYMMY_DEMO_GROUPS_ROUTE}
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
        and source_intent #>> '{payload,source,route,id}'=${SYMMY_DEMO_GROUPS_ROUTE}`;
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
      personalDataAuthority: 'DEMO_TEST_DATA_SOURCE_POLICY' as const,
      exactPersonalDataContexts: personalContexts.length,
      readyForPersonalData: false,
      receipts,
      retention: symmyDemoCustomerRetentionRefs(),
    };
  },
);

const command = Command.make(
  'symmy-demo-customer-authority',
  { mode: Flag.Literals('mode', ['apply', 'verify', 'environment']).pipe(Flag.withDefault('verify')) },
  ({ mode }) =>
    mode === 'environment'
      ? readSymmyDemoCustomerEnvironment.pipe(
          Effect.flatMap(({ environment }) => Console.log(JSON.stringify(environment))),
        )
      : bootstrapSymmyDemoCustomerAuthority(mode).pipe(
          Effect.flatMap((result) =>
            Console.log({
              mode,
              personalDataAuthority: result.personalDataAuthority,
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
