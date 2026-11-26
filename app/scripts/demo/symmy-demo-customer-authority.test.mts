import { Effect, Option, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { internalWorkloadPrincipalId } from '../../packages/core-runtime/src/auth/module-credentials.ts';
import {
  planAdditiveCompanyInternalWorkloads,
  ReleaseInternalWorkloadError,
} from '../../packages/core-runtime/src/install/release-internal-workloads.ts';
import { CoreDatabase } from '../../packages/core-runtime/src/db/client.ts';
import { makeTestDatabase } from '../../packages/core-runtime/tests/support/database.ts';
import { TrustedPrincipalContextSchema } from '../../packages/core-runtime/src/actions/principal-context.ts';
import { writeWorkloadBindings } from '../../packages/core-runtime/src/access/workloads/binding-store.ts';
import { AccessWorkloadBindingIdSchema } from '../../packages/core-runtime/src/access/workloads/store.ts';
import { TenantIdSchema, PrincipalIdSchema } from '../../packages/core-runtime/src/access/ids.ts';
import { WorkloadKeySchema } from '../../packages/core-runtime/src/authorization/access-declaration.ts';
import { stageWorkloadBindingIds } from './register-stage-workloads.mts';

import {
  buildSymmyDemoCustomerRoutes,
  buildSymmySourceSyncProcessingPolicy,
  SYMMY_DEMO_CUSTOMERS_READ_ROUTE,
  SYMMY_DEMO_CUSTOMERS_ROUTE,
  SYMMY_DEMO_CUSTOMER_COMPANY,
  SYMMY_DEMO_CUSTOMER_TENANT,
  SYMMY_DEMO_GROUPS_ROUTE,
  SYMMY_DEMO_GROUPS_SOURCE_ROUTE,
  symmyDemoCustomerEnvironment,
  symmyDemoNativeReaderNeedsEnrollment,
  symmyDemoCustomerRetentionRefs,
  symmyDemoMembershipRouteId,
  symmyDemoCustomerWriteKey,
  SYMMY_DEMO_MEMBERSHIP_POLICY_ID,
  selectSymmyDemoSourceWriter,
  symmyDemoReceiverCandidates,
  symmyDemoReceiverWorkloadsForPhase,
  symmyDemoDiscoveryFailure,
  symmyDemoCustomerInternalWorkloadDeclarations,
  safeSymmyDemoEnrollmentFailure,
  SymmyDemoCustomerAuthorityError,
  symmyDemoCustomerBindingDatabase,
  symmyDemoCompanyBindingNeedsCreate,
  symmyDemoExternalReceiverBindingsToRevoke,
  symmyDemoCustomerWorkloadRequirements,
} from './symmy-demo-customer-authority.mts';

const partyReaderWorkload = 'party.registry.source-read';
const createPurposePath = '/privacy/actions/create-processing-purpose';
const foreignCompany = '72000000-0000-4000-8000-000000000099';
const PartyBindingsEnvironmentSchema = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      authMethod: Schema.Literals(['api_key', 'system']),
      issuer: Schema.String,
      namespace: Schema.String,
      principalId: PrincipalIdSchema,
      recordType: Schema.String,
      routeRef: Schema.String.check(Schema.isUUID()).pipe(Schema.brand('SymmyDemoRouteId')),
      tenantId: TenantIdSchema,
    }),
  ),
);

const identities = {
  commerceWriterId: '72000000-0000-4000-8000-000000000023',
  integrationPrincipalId: '72000000-0000-4000-8000-000000000021',
  partyReaderId: '72000000-0000-4000-8000-000000000025',
  partyWriterId: '72000000-0000-4000-8000-000000000022',
  privacyReceiverId: '72000000-0000-4000-8000-000000000026',
};

it.effect('external integrations keep admit/poll only and retire only exact bootstrap-owned receiver aliases', () =>
  Effect.gen(function* test() {
    expect(symmyDemoCustomerWorkloadRequirements.integration).toEqual([
      'integration.symmy-admit',
      'integration.symmy-poll',
    ]);
    const principalId = identities.integrationPrincipalId;
    const ids = stageWorkloadBindingIds(SYMMY_DEMO_CUSTOMER_TENANT, principalId, partyReaderWorkload);
    const owned = {
      bindingId: ids.bindingId,
      foreignCompany: false,
      incarnation: ids.bindingIncarnation,
      kind: 'integration',
      principalId,
      status: 'active',
      tenantId: SYMMY_DEMO_CUSTOMER_TENANT,
      workloadKey: partyReaderWorkload,
    };
    expect(
      yield* symmyDemoExternalReceiverBindingsToRevoke(principalId, [
        owned,
        { ...owned, kind: 'service' },
        { ...owned, kind: 'system' },
        { ...owned, principalId: identities.partyWriterId },
        { ...owned, tenantId: identities.partyWriterId },
        { ...owned, workloadKey: 'integration.symmy-admit' },
        { ...owned, bindingId: identities.partyReaderId },
        { ...owned, incarnation: identities.partyReaderId },
        { ...owned, status: 'revoked' },
      ]),
    ).toEqual([ids.bindingId]);
    expect(
      Result.isFailure(
        yield* symmyDemoExternalReceiverBindingsToRevoke(principalId, [{ ...owned, foreignCompany: true }]).pipe(
          Effect.result,
        ),
      ),
    ).toBe(true);
  }),
);

it.effect('retires exact bootstrap-owned source-writer aliases without touching foreign writer registrations', () =>
  Effect.gen(function* test() {
    const principalId = identities.integrationPrincipalId;
    for (const workloadKey of symmyDemoCustomerWorkloadRequirements.existingSystemWriters) {
      const ids = stageWorkloadBindingIds(SYMMY_DEMO_CUSTOMER_TENANT, principalId, workloadKey);
      const owned = {
        bindingId: ids.bindingId,
        foreignCompany: false,
        incarnation: ids.bindingIncarnation,
        kind: 'integration',
        principalId,
        status: 'active',
        tenantId: SYMMY_DEMO_CUSTOMER_TENANT,
        workloadKey,
      };
      expect(
        yield* symmyDemoExternalReceiverBindingsToRevoke(principalId, [
          owned,
          { ...owned, bindingId: identities.commerceWriterId },
          { ...owned, incarnation: identities.commerceWriterId },
          { ...owned, kind: 'system' },
          { ...owned, kind: 'service' },
          { ...owned, status: 'revoked' },
        ]),
      ).toEqual([ids.bindingId]);
    }
  }),
);

it.effect(
  'reuses a native active company epoch regardless of stage-derived ids and refuses foreign or ambiguous rows',
  () =>
    Effect.gen(function* test() {
      expect(yield* symmyDemoCompanyBindingNeedsCreate([])).toBe(true);
      expect(yield* symmyDemoCompanyBindingNeedsCreate([{ legalEntityId: SYMMY_DEMO_CUSTOMER_COMPANY }])).toBe(false);
      for (const active of [
        [{ legalEntityId: foreignCompany }],
        [{ legalEntityId: SYMMY_DEMO_CUSTOMER_COMPANY }, { legalEntityId: SYMMY_DEMO_CUSTOMER_COMPANY }],
      ]) {
        expect(Result.isFailure(yield* symmyDemoCompanyBindingNeedsCreate(active).pipe(Effect.result))).toBe(true);
      }
    }),
);

it.effect(
  'Core binding provisioning succeeds through the enrolled runtime connection and rejects admin scope authority',
  () =>
    Effect.gen(function* test() {
      const scope = {
        ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
          authBindingId: identities.partyReaderId,
          authContextRef: 'bootstrap-runtime-regression',
          authMethod: 'session',
          principalId: identities.integrationPrincipalId,
          tenantId: SYMMY_DEMO_CUSTOMER_TENANT,
        }),
        correlationId: 'bootstrap-runtime-regression',
      };
      for (const role of ['ontos_runtime', 'postgres']) {
        let inserted = false;
        const executor = yield* makeTestDatabase(
          (sql) => {
            if (sql.includes("set_config('ontos.tenant_id'")) {
              return Effect.succeed([
                {
                  legal_entity_id: '',
                  operation_at: new Date('2026-11-23T00:00:00Z'),
                  role,
                  tenant_id: scope.tenantId,
                },
              ]);
            }
            if (sql.startsWith('insert into')) {
              inserted = true;
            }
            return Effect.succeed([]);
          },
          { currentRole: role },
        );
        const database = yield* symmyDemoCustomerBindingDatabase.pipe(
          Effect.provideService(CoreDatabase, { executor }),
        );
        expect(database.executor).toBe(executor);
        const result = yield* writeWorkloadBindings(database, scope, {
          bindings: [
            {
              bindingId: AccessWorkloadBindingIdSchema.make(identities.partyReaderId),
              createdAt: new Date('2026-11-23T00:00:00Z'),
              incarnation: AccessWorkloadBindingIdSchema.make(identities.partyWriterId),
              principalId: PrincipalIdSchema.make(identities.integrationPrincipalId),
              tenantId: TenantIdSchema.make(scope.tenantId),
              workloadKey: WorkloadKeySchema.make(partyReaderWorkload),
            },
          ],
        }).pipe(Effect.result);
        expect(Result.isSuccess(result)).toBe(role === 'ontos_runtime');
        expect(inserted).toBe(role === 'ontos_runtime');
      }
    }),
);

it('retains only typed fixed enrollment categories and strips arbitrary reasons and raw causes', () => {
  for (const error of [
    new SymmyDemoCustomerAuthorityError({ reason: 'enrollment-database-config' }),
    new ReleaseInternalWorkloadError({ reason: 'additive-release-scope' }),
    new ReleaseInternalWorkloadError({ reason: 'additive-step-create-principal' }),
  ]) {
    expect(safeSymmyDemoEnrollmentFailure(error).reason.startsWith(error.reason)).toBe(true);
  }
  for (const error of [
    new Error('credential-bearing driver diagnostic'),
    new ReleaseInternalWorkloadError({ reason: 'raw private diagnostic' }),
    { reason: 'additive-release-scope' },
  ]) {
    const safe = safeSymmyDemoEnrollmentFailure(error);
    expect(safe.reason).toBe('customer-workload-enrollment');
    expect('cause' in safe).toBe(false);
  }
  expect(
    safeSymmyDemoEnrollmentFailure(
      new ReleaseInternalWorkloadError({
        databaseConstraint: 'core_principals_platform_role_ck',
        reason: 'additive-step-create-principal',
        sqlState: '23514',
      }),
    ).reason,
  ).toBe('additive-step-create-principal:23514:core_principals_platform_role_ck');
});

it('plans exactly seven canonical AKROS company registrations without retiring unrelated platform jobs', () => {
  const tenantId = SYMMY_DEMO_CUSTOMER_TENANT;
  const legalEntityId = SYMMY_DEMO_CUSTOMER_COMPANY;
  const plan = planAdditiveCompanyInternalWorkloads(
    {
      activeCompanies: new Set([legalEntityId, foreignCompany]),
      activeModuleKeys: new Set(symmyDemoCustomerInternalWorkloadDeclarations.map(({ moduleKey }) => moduleKey)),
      companyNames: new Map([[legalEntityId, 'AKROS']]),
      registrations: [
        {
          activeCompanyBindingId: identities.partyReaderId,
          activeWorkloadBindingId: identities.partyWriterId,
          companyBindingCount: 1,
          displayName: 'Existing CRM',
          extraCompanyBindingIds: [],
          legalEntityId: foreignCompany,
          principalId: identities.partyWriterId,
          principalStatus: 'active',
          workloadBindingCount: 1,
          workloadKey: 'demo.crm.party-intake',
        },
      ],
      tenantId,
    },
    symmyDemoCustomerInternalWorkloadDeclarations,
    legalEntityId,
  );
  expect(plan.registered).toBe(7);
  expect(plan.retired).toBe(0);
  for (const unit of plan.units) {
    for (const step of unit.steps) {
      expect(['create-principal', 'bind-workload', 'bind-company']).toContain(step.kind);
      if (step.kind === 'create-principal') {
        expect(step.legalEntityId).toBe(legalEntityId);
        expect(step.principalId).toBe(
          internalWorkloadPrincipalId({ legalEntityId, tenantId, workloadKey: step.workloadKey }),
        );
      }
    }
  }
});

it('replaces all discovery causes with fixed phase codes and retains no raw cause', () => {
  for (const phase of ['integration-route', 'party-writer', 'commerce-writer', 'party-reader'] as const) {
    const failure = symmyDemoDiscoveryFailure(phase)();
    expect(failure.reason).toBe(phase);
    expect(Schema.is(SymmyDemoCustomerAuthorityError)(failure)).toBe(true);
    expect('cause' in failure).toBe(false);
  }
});

it('discovers only required receiver identities before owner startup, and the full chain after registration', () => {
  expect(symmyDemoReceiverWorkloadsForPhase('pre-owner')).toEqual([partyReaderWorkload]);
  const registered = symmyDemoReceiverWorkloadsForPhase('post-registration');
  expect(registered).toHaveLength(8);
  for (const key of symmyDemoReceiverWorkloadsForPhase('pre-owner')) {
    expect(registered).toContain(key);
  }
  expect(registered).toContain('privacy.core.organization-profile-ico-check');
  expect(registered).toContain('pricing.price-group-catalog.source-read');
});
const group = {
  code: 'B2B',
  groupId: '72000000-0000-4000-8000-000000000024',
  recordId: 'actual-erp-group-record',
};
const workloadKey = 'party.registry.source-write';
const serviceWriter = {
  kind: 'service',
  legalEntityId: SYMMY_DEMO_CUSTOMER_COMPANY,
  platformRole: 'internal_workload',
  principalId: internalWorkloadPrincipalId({
    legalEntityId: SYMMY_DEMO_CUSTOMER_COMPANY,
    tenantId: SYMMY_DEMO_CUSTOMER_TENANT,
    workloadKey,
  }),
  tenantId: SYMMY_DEMO_CUSTOMER_TENANT,
  workloadKey,
};
const legacyWriter = { ...serviceWriter, kind: 'system', platformRole: null, principalId: identities.partyWriterId };

it.effect('accepts the authentic release service writer without a legacy system identity', () =>
  Effect.gen(function* test() {
    expect(yield* selectSymmyDemoSourceWriter(workloadKey, [serviceWriter])).toBe(serviceWriter.principalId);
  }),
);

it.effect('preserves a uniquely bound legacy writer independently of candidate order', () =>
  Effect.gen(function* test() {
    for (const candidates of [
      [legacyWriter, serviceWriter],
      [serviceWriter, legacyWriter],
    ]) {
      expect(yield* selectSymmyDemoSourceWriter(workloadKey, candidates)).toBe(legacyWriter.principalId);
    }
  }),
);

it.effect('preserves the native tenant-wide SYSTEM writer before any company registration exists', () =>
  Effect.gen(function* test() {
    const nativeSystem = { ...legacyWriter, legalEntityId: null };
    expect(yield* selectSymmyDemoSourceWriter(workloadKey, [nativeSystem])).toBe(legacyWriter.principalId);
    expect(yield* selectSymmyDemoSourceWriter(workloadKey, [serviceWriter, nativeSystem])).toBe(
      legacyWriter.principalId,
    );
    expect(
      Result.isFailure(
        yield* selectSymmyDemoSourceWriter(workloadKey, [
          {
            ...serviceWriter,
            legalEntityId: null,
          },
        ]).pipe(Effect.result),
      ),
    ).toBe(true);
  }),
);

it.effect('rejects foreign company, unmarked or falsely identified service writers and ambiguous legacy bindings', () =>
  Effect.gen(function* test() {
    for (const candidates of [
      [{ ...serviceWriter, legalEntityId: '71000000-0000-4000-8000-000000000024' }],
      [{ ...serviceWriter, platformRole: null }],
      [{ ...serviceWriter, principalId: identities.commerceWriterId }],
      [legacyWriter, { ...legacyWriter, principalId: identities.commerceWriterId }, serviceWriter],
      [],
    ]) {
      expect(Result.isFailure(yield* selectSymmyDemoSourceWriter(workloadKey, candidates).pipe(Effect.result))).toBe(
        true,
      );
    }
  }),
);

it.effect('enrolls a complete PERSON and ORGANIZATION plan with real contact/address/ICO operations', () =>
  Effect.gen(function* test() {
    const routes = yield* buildSymmyDemoCustomerRoutes(identities.integrationPrincipalId, [group]);
    const { symmyRouteInventoryOf, symmyRouteRequestRefusals } = yield* Effect.promise(
      () => import('../../verticals/symmy-integration/src/ops/symmy-route-enrollment.ts'),
    );
    expect(routes).toHaveLength(3);
    const customer = routes.find(({ routeKey }) => routeKey === 'customersBatch');
    expect(customer?.routeId).toBe(SYMMY_DEMO_CUSTOMERS_ROUTE);
    expect(customer?.configuration.items[0].effects.map(({ operation }) => operation.entrypointKey)).toEqual([
      'party.registry.create-party',
      'party.registry.add-contact-point',
      'party.registry.counterparty-customer-onboard',
      'commerce.customer-context.ensure-retail-customer-profile',
      'commerce.customer-context.create-counterparty-purchasing-profile',
      'commerce.customer-context.add-saved-address',
      'commerce.customer-context.change-organization-customer-profile-ico',
    ]);
    for (const route of routes) {
      const inventory = symmyRouteInventoryOf(route.routeKey);
      expect(Option.isSome(inventory)).toBe(true);
      if (Option.isSome(inventory)) {
        expect(symmyRouteRequestRefusals(route, inventory.value)).toEqual([]);
      }
      expect(route.tenantId).toBe(SYMMY_DEMO_CUSTOMER_TENANT);
      expect(route.legalEntityId).toBe(SYMMY_DEMO_CUSTOMER_COMPANY);
      expect(
        route.configuration.items.every(({ effects }) => effects.every(({ intent }) => intent === undefined)),
      ).toBe(true);
    }
    const read = routes.find(({ routeKey }) => routeKey === 'adminCustomers');
    expect(read?.routeId).toBe(SYMMY_DEMO_CUSTOMERS_READ_ROUTE);
    expect(read?.configuration.sourceRouteId).toBe(SYMMY_DEMO_CUSTOMERS_ROUTE);
    expect(read?.lifecyclePolicy).toBeUndefined();
    const membership = routes.find(({ routeKey }) => routeKey === 'customerGroupCustomersBatch');
    expect(membership?.configuration.sourceRouteId).toBe(SYMMY_DEMO_GROUPS_SOURCE_ROUTE);
    expect(membership?.configuration.selector?.source.sourceRecordId).toBe(group.recordId);
    expect(membership?.configuration.selector?.target?.resourceId).toBe(group.groupId);
    expect(membership?.routeCode).toBe(group.code);
  }),
);

it('replays deterministic selected routes without deriving a native group identity from its code', () => {
  expect(symmyDemoMembershipRouteId(group.groupId)).toBe(symmyDemoMembershipRouteId(group.groupId));
  expect(symmyDemoMembershipRouteId(group.groupId)).not.toBe(group.groupId);
  expect(Schema.is(Schema.String.check(Schema.isUUID()))(symmyDemoMembershipRouteId(group.groupId))).toBe(true);
  expect(symmyDemoCustomerRetentionRefs()).toEqual([
    { policyId: 'akros-symmy-customers', revision: 'v1', routeId: SYMMY_DEMO_CUSTOMERS_ROUTE },
    {
      policyId: SYMMY_DEMO_MEMBERSHIP_POLICY_ID,
      revision: 'v1',
      routeId: SYMMY_DEMO_GROUPS_ROUTE,
    },
  ]);
});

it('merges only exact tenant-local Party source bindings and never fabricates Privacy authority', () => {
  const first = symmyDemoCustomerEnvironment(identities);
  const entries = Schema.decodeUnknownSync(PartyBindingsEnvironmentSchema)(first.ONTOS_PARTY_CLIENT_SOURCE_BINDINGS);
  expect(entries).toHaveLength(4);
  expect(symmyDemoCustomerEnvironment(identities, entries)).toEqual(first);
  expect(Object.keys(first)).toEqual([
    'ONTOS_PARTY_CLIENT_SOURCE_BINDINGS',
    'ONTOS_PRIVACY_SOURCE_SYNC_PROCESSING_ENABLED',
  ]);
  expect(entries.map(({ principalId }) => principalId)).toEqual([
    identities.integrationPrincipalId,
    identities.partyWriterId,
    identities.commerceWriterId,
    identities.partyReaderId,
  ]);
  expect(
    entries.every(
      ({ routeRef, tenantId }) => tenantId === SYMMY_DEMO_CUSTOMER_TENANT && routeRef === SYMMY_DEMO_CUSTOMERS_ROUTE,
    ),
  ).toBe(true);
});

it.effect('rejects invented integration identities before any deployment I/O', () =>
  buildSymmyDemoCustomerRoutes('not-a-principal', []).pipe(
    Effect.flip,
    Effect.map((failure) => expect(Schema.isSchemaError(failure)).toBe(true)),
  ),
);

it.effect('reuses a native Action key after a lost response and separates changed approved commands', () =>
  Effect.gen(function* test() {
    const key = yield* symmyDemoCustomerWriteKey('privacy', createPurposePath, '{"a":1}');
    expect(key).toBe(yield* symmyDemoCustomerWriteKey('privacy', createPurposePath, '{"a":1}'));
    expect(key).not.toBe(yield* symmyDemoCustomerWriteKey('privacy', createPurposePath, '{"a":2}'));
    expect(key).not.toBe(
      yield* symmyDemoCustomerWriteKey('privacy', '/privacy/actions/create-privacy-subject', '{"a":1}'),
    );
    expect(key.length).toBeLessThanOrEqual(200);
  }),
);

it.effect('authorizes the actual switched Privacy receiver, not merely upstream source writers', () =>
  Effect.gen(function* test() {
    const policy = yield* buildSymmySourceSyncProcessingPolicy(identities);
    expect(policy.callers).toContainEqual({ authMethod: 'system', principalId: identities.privacyReceiverId });
    expect(policy.callers).toHaveLength(4);
    expect(policy.groupRouteId).toBe(SYMMY_DEMO_GROUPS_SOURCE_ROUTE);
    expect(policy.groupRouteId).not.toBe(SYMMY_DEMO_GROUPS_ROUTE);
    expect(policy.policyId).toBe('akros-symmy-source-sync-v2');
    expect(policy.revision).toBe('v2');
  }),
);

it.effect('retires only explicitly identified duplicate aliases, preserving a unique legacy SYSTEM', () =>
  Effect.gen(function* test() {
    const alias = { ...legacyWriter, bindingId: '72000000-0000-4000-8000-000000000031' };
    const other = {
      ...legacyWriter,
      bindingId: '72000000-0000-4000-8000-000000000032',
      principalId: identities.commerceWriterId,
    };
    expect(yield* symmyDemoReceiverCandidates([alias, serviceWriter], [alias.bindingId])).toEqual([
      alias,
      serviceWriter,
    ]);
    expect(yield* symmyDemoReceiverCandidates([alias, other, serviceWriter], [alias.bindingId])).toEqual([
      other,
      serviceWriter,
    ]);
    expect(yield* symmyDemoReceiverCandidates([alias, other, serviceWriter], [])).toHaveLength(3);
  }),
);

it.effect(
  'adds only the distinct Commerce reader, preserves existing readers, and never overrides a managed route',
  () =>
    Effect.gen(function* test() {
      const external = identities.integrationPrincipalId;
      const reader = '72000000-0000-4000-8000-000000000027';
      expect(
        yield* symmyDemoNativeReaderNeedsEnrollment({ managed: false, readers: [external] }, external, reader),
      ).toBe(true);
      expect(
        yield* symmyDemoNativeReaderNeedsEnrollment({ managed: true, readers: [external, reader] }, external, reader),
      ).toBe(false);
      expect(yield* symmyDemoNativeReaderNeedsEnrollment({ managed: true, readers: [reader] }, external, reader)).toBe(
        false,
      );
      for (const [readers, managed, receiver] of [
        [[external], true, reader],
        [[], false, reader],
        [[external], false, external],
      ] as const) {
        expect(
          Result.isFailure(
            yield* symmyDemoNativeReaderNeedsEnrollment({ managed, readers }, external, receiver).pipe(Effect.result),
          ),
        ).toBe(true);
      }
    }),
);
