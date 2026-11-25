import { Effect, Layer, ManagedRuntime, Option, Result, Schema } from 'effect';
import assert from 'node:assert/strict';
import { test } from 'node:test';
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
import { LegalEntityIdSchema, TenantIdSchema, PrincipalIdSchema } from '../../packages/core-runtime/src/access/ids.ts';
import { WorkloadKeySchema } from '../../packages/core-runtime/src/authorization/access-declaration.ts';
import { stageWorkloadBindingIds } from './register-stage-workloads.mts';

import {
  SymmyDemoPartyBindingSchema,
  SymmyDemoSourceWriterCandidateSchema,
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

await using runtime = ManagedRuntime.make(Layer.empty);

const partyReaderWorkload = 'party.registry.source-read';
const createPurposePath = '/privacy/actions/create-processing-purpose';

const identities = {
  commerceWriterId: '72000000-0000-4000-8000-000000000023',
  integrationPrincipalId: '72000000-0000-4000-8000-000000000021',
  partyReaderId: '72000000-0000-4000-8000-000000000025',
  partyWriterId: '72000000-0000-4000-8000-000000000022',
  privacyReceiverId: '72000000-0000-4000-8000-000000000026',
};

await test('external integrations keep admit/poll only and retire only exact bootstrap-owned receiver aliases', () =>
  runtime.runPromise(
    Effect.gen(function* scenario() {
      assert.deepStrictEqual(symmyDemoCustomerWorkloadRequirements.integration, [
        'integration.symmy-admit',
        'integration.symmy-poll',
      ]);
      const principalId = identities.integrationPrincipalId;
      const workloadKey = partyReaderWorkload;
      const ids = stageWorkloadBindingIds(SYMMY_DEMO_CUSTOMER_TENANT, principalId, workloadKey);
      const owned = {
        bindingId: ids.bindingId,
        foreignCompany: false,
        incarnation: ids.bindingIncarnation,
        kind: 'integration' as const,
        principalId,
        status: 'active',
        tenantId: SYMMY_DEMO_CUSTOMER_TENANT,
        workloadKey,
      };
      assert.deepStrictEqual(
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
        [ids.bindingId],
      );
      assert.strictEqual(
        Result.isFailure(
          yield* symmyDemoExternalReceiverBindingsToRevoke(principalId, [{ ...owned, foreignCompany: true }]).pipe(
            Effect.result,
          ),
        ),
        true,
      );
    }),
  ));

await test('retires exact bootstrap-owned source-writer aliases without touching foreign writer registrations', () =>
  runtime.runPromise(
    Effect.gen(function* scenario() {
      const principalId = identities.integrationPrincipalId;
      for (const workloadKey of symmyDemoCustomerWorkloadRequirements.existingSystemWriters) {
        const ids = stageWorkloadBindingIds(SYMMY_DEMO_CUSTOMER_TENANT, principalId, workloadKey);
        const owned = {
          bindingId: ids.bindingId,
          foreignCompany: false,
          incarnation: ids.bindingIncarnation,
          kind: 'integration' as const,
          principalId,
          status: 'active',
          tenantId: SYMMY_DEMO_CUSTOMER_TENANT,
          workloadKey,
        };
        assert.deepStrictEqual(
          yield* symmyDemoExternalReceiverBindingsToRevoke(principalId, [
            owned,
            { ...owned, bindingId: identities.commerceWriterId },
            { ...owned, incarnation: identities.commerceWriterId },
            { ...owned, kind: 'system' },
            { ...owned, kind: 'service' },
            { ...owned, status: 'revoked' },
          ]),
          [ids.bindingId],
        );
      }
    }),
  ));

await test('reuses a native active company epoch regardless of stage-derived ids and refuses foreign or ambiguous rows', () =>
  runtime.runPromise(
    Effect.gen(function* scenario() {
      assert.strictEqual(yield* symmyDemoCompanyBindingNeedsCreate([]), true);
      assert.strictEqual(
        yield* symmyDemoCompanyBindingNeedsCreate([{ legalEntityId: SYMMY_DEMO_CUSTOMER_COMPANY }]),
        false,
      );
      for (const active of [
        [{ legalEntityId: '72000000-0000-4000-8000-000000000099' }],
        [{ legalEntityId: SYMMY_DEMO_CUSTOMER_COMPANY }, { legalEntityId: SYMMY_DEMO_CUSTOMER_COMPANY }],
      ]) {
        assert.strictEqual(
          Result.isFailure(yield* symmyDemoCompanyBindingNeedsCreate(active).pipe(Effect.result)),
          true,
        );
      }
    }),
  ));

await test('Core binding provisioning succeeds through the enrolled runtime connection and rejects admin scope authority', () =>
  runtime.runPromise(
    Effect.gen(function* scenario() {
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
        assert.strictEqual(database.executor, executor);
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
        assert.strictEqual(Result.isSuccess(result), role === 'ontos_runtime');
        assert.strictEqual(inserted, role === 'ontos_runtime');
      }
    }),
  ));

await test('retains only typed fixed enrollment categories and strips arbitrary reasons and raw causes', () => {
  for (const error of [
    new SymmyDemoCustomerAuthorityError({ reason: 'enrollment-database-config' }),
    new ReleaseInternalWorkloadError({ reason: 'additive-release-scope' }),
    new ReleaseInternalWorkloadError({ reason: 'additive-step-create-principal' }),
  ]) {
    assert.strictEqual(safeSymmyDemoEnrollmentFailure(error).reason.startsWith(error.reason), true);
  }
  for (const error of [
    new Error('credential-bearing driver diagnostic'),
    new ReleaseInternalWorkloadError({ reason: 'raw private diagnostic' }),
    { reason: 'additive-release-scope' },
  ]) {
    const safe = safeSymmyDemoEnrollmentFailure(error);
    assert.strictEqual(safe.reason, 'customer-workload-enrollment');
    assert.strictEqual('cause' in safe, false);
  }
  assert.strictEqual(
    safeSymmyDemoEnrollmentFailure(
      new ReleaseInternalWorkloadError({
        databaseConstraint: 'core_principals_platform_role_ck',
        reason: 'additive-step-create-principal',
        sqlState: '23514',
      }),
    ).reason,
    'additive-step-create-principal:23514:core_principals_platform_role_ck',
  );
});

await test('plans exactly seven canonical AKROS company registrations without retiring unrelated platform jobs', () => {
  const tenantId = SYMMY_DEMO_CUSTOMER_TENANT;
  const legalEntityId = SYMMY_DEMO_CUSTOMER_COMPANY;
  const foreignCompany = '72000000-0000-4000-8000-000000000099';
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
  assert.strictEqual(plan.registered, 7);
  assert.strictEqual(plan.retired, 0);
  for (const unit of plan.units) {
    for (const step of unit.steps) {
      assert.ok(['create-principal', 'bind-workload', 'bind-company'].includes(step.kind));
      if (step.kind === 'create-principal') {
        assert.strictEqual(step.legalEntityId, legalEntityId);
        assert.strictEqual(
          step.principalId,
          internalWorkloadPrincipalId({ legalEntityId, tenantId, workloadKey: step.workloadKey }),
        );
      }
    }
  }
});

await test('replaces all discovery causes with fixed phase codes and retains no raw cause', () => {
  for (const phase of ['integration-route', 'party-writer', 'commerce-writer', 'party-reader'] as const) {
    const failure = symmyDemoDiscoveryFailure(phase)();
    assert.strictEqual(failure.reason, phase);
    assert.strictEqual(Schema.is(SymmyDemoCustomerAuthorityError)(failure), true);
    assert.strictEqual('cause' in failure, false);
  }
});

await test('discovers only required receiver identities before owner startup, and the full chain after registration', () => {
  assert.deepStrictEqual(symmyDemoReceiverWorkloadsForPhase('pre-owner'), [partyReaderWorkload]);
  const registered = symmyDemoReceiverWorkloadsForPhase('post-registration');
  assert.strictEqual(registered.length, 8);
  for (const key of symmyDemoReceiverWorkloadsForPhase('pre-owner')) {
    assert.ok(registered.includes(key));
  }
  assert.ok(registered.includes('privacy.core.organization-profile-ico-check'));
  assert.ok(registered.includes('pricing.price-group-catalog.source-read'));
});
const group = {
  code: 'B2B',
  groupId: '72000000-0000-4000-8000-000000000024',
  recordId: 'actual-erp-group-record',
};
const workloadKey = 'party.registry.source-write';
const serviceWriter = {
  kind: 'service' as const,
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
const legacyWriter = {
  ...serviceWriter,
  kind: 'system' as const,
  platformRole: null,
  principalId: identities.partyWriterId,
};

await test('accepts the authentic release service writer without a legacy system identity', () =>
  runtime.runPromise(
    Effect.gen(function* scenario() {
      assert.strictEqual(yield* selectSymmyDemoSourceWriter(workloadKey, [serviceWriter]), serviceWriter.principalId);
    }),
  ));

await test('preserves a uniquely bound legacy writer independently of candidate order', () =>
  runtime.runPromise(
    Effect.gen(function* scenario() {
      for (const candidates of [
        [legacyWriter, serviceWriter],
        [serviceWriter, legacyWriter],
      ]) {
        assert.strictEqual(yield* selectSymmyDemoSourceWriter(workloadKey, candidates), legacyWriter.principalId);
      }
    }),
  ));

await test('preserves the native tenant-wide SYSTEM writer before any company registration exists', () =>
  runtime.runPromise(
    Effect.gen(function* scenario() {
      const nativeSystem = { ...legacyWriter, legalEntityId: null };
      assert.strictEqual(yield* selectSymmyDemoSourceWriter(workloadKey, [nativeSystem]), legacyWriter.principalId);
      assert.strictEqual(
        yield* selectSymmyDemoSourceWriter(workloadKey, [serviceWriter, nativeSystem]),
        legacyWriter.principalId,
      );
      assert.strictEqual(
        Result.isFailure(
          yield* selectSymmyDemoSourceWriter(workloadKey, [
            {
              ...serviceWriter,
              legalEntityId: null,
            },
          ]).pipe(Effect.result),
        ),
        true,
      );
    }),
  ));

await test('rejects foreign company, unmarked or falsely identified service writers and ambiguous legacy bindings', () =>
  runtime.runPromise(
    Effect.gen(function* scenario() {
      for (const candidates of [
        [{ ...serviceWriter, legalEntityId: '71000000-0000-4000-8000-000000000024' }],
        [{ ...serviceWriter, platformRole: null }],
        [{ ...serviceWriter, principalId: identities.commerceWriterId }],
        [legacyWriter, { ...legacyWriter, principalId: identities.commerceWriterId }, serviceWriter],
        [],
      ]) {
        assert.strictEqual(
          Result.isFailure(yield* selectSymmyDemoSourceWriter(workloadKey, candidates).pipe(Effect.result)),
          true,
        );
      }
    }),
  ));

await test('enrolls a complete PERSON and ORGANIZATION plan with real contact/address/ICO operations', () =>
  runtime.runPromise(
    Effect.gen(function* scenario() {
      const routes = yield* buildSymmyDemoCustomerRoutes(identities.integrationPrincipalId, [group]);
      const { symmyRouteInventoryOf, symmyRouteRequestRefusals } = yield* Effect.promise(
        () => import('../../verticals/symmy-integration/src/ops/symmy-route-enrollment.ts'),
      );
      assert.strictEqual(routes.length, 3);
      const customer = routes.find(({ routeKey }) => routeKey === 'customersBatch');
      assert.strictEqual(customer?.routeId, SYMMY_DEMO_CUSTOMERS_ROUTE);
      assert.deepStrictEqual(
        customer?.configuration.items[0].effects.map(({ operation }) => operation.entrypointKey),
        [
          'party.registry.create-party',
          'party.registry.add-contact-point',
          'party.registry.counterparty-customer-onboard',
          'commerce.customer-context.ensure-retail-customer-profile',
          'commerce.customer-context.create-counterparty-purchasing-profile',
          'commerce.customer-context.add-saved-address',
          'commerce.customer-context.change-organization-customer-profile-ico',
        ],
      );
      for (const route of routes) {
        const inventory = symmyRouteInventoryOf(route.routeKey);
        assert.strictEqual(Option.isSome(inventory), true);
        if (Option.isSome(inventory)) {
          assert.deepStrictEqual(symmyRouteRequestRefusals(route, inventory.value), []);
        }
        assert.strictEqual(route.tenantId, SYMMY_DEMO_CUSTOMER_TENANT);
        assert.strictEqual(route.legalEntityId, SYMMY_DEMO_CUSTOMER_COMPANY);
        assert.strictEqual(
          route.configuration.items.every(({ effects }) => effects.every(({ intent }) => intent === undefined)),
          true,
        );
      }
      const read = routes.find(({ routeKey }) => routeKey === 'adminCustomers');
      assert.strictEqual(read?.routeId, SYMMY_DEMO_CUSTOMERS_READ_ROUTE);
      assert.strictEqual(read?.configuration.sourceRouteId, SYMMY_DEMO_CUSTOMERS_ROUTE);
      assert.strictEqual(read?.lifecyclePolicy, undefined);
      const membership = routes.find(({ routeKey }) => routeKey === 'customerGroupCustomersBatch');
      assert.strictEqual(membership?.configuration.sourceRouteId, SYMMY_DEMO_GROUPS_SOURCE_ROUTE);
      assert.strictEqual(membership?.configuration.selector?.source.sourceRecordId, group.recordId);
      assert.strictEqual(membership?.configuration.selector?.target?.resourceId, group.groupId);
      assert.strictEqual(membership?.routeCode, group.code);
    }),
  ));

await test('replays deterministic selected routes without deriving a native group identity from its code', () => {
  assert.strictEqual(symmyDemoMembershipRouteId(group.groupId), symmyDemoMembershipRouteId(group.groupId));
  assert.notStrictEqual(symmyDemoMembershipRouteId(group.groupId), group.groupId);
  assert.strictEqual(Schema.is(Schema.String.check(Schema.isUUID()))(symmyDemoMembershipRouteId(group.groupId)), true);
  assert.deepStrictEqual(symmyDemoCustomerRetentionRefs(), [
    { policyId: 'akros-symmy-customers', revision: 'v1', routeId: SYMMY_DEMO_CUSTOMERS_ROUTE },
    {
      policyId: SYMMY_DEMO_MEMBERSHIP_POLICY_ID,
      revision: 'v1',
      routeId: SYMMY_DEMO_GROUPS_ROUTE,
    },
  ]);
});

await test('merges only exact tenant-local Party source bindings and never fabricates Privacy authority', () =>
  runtime.runPromise(
    Effect.gen(function* environmentScenario() {
      const first = yield* symmyDemoCustomerEnvironment(identities);
      const entries = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(SymmyDemoPartyBindingSchema)))(
        first.ONTOS_PARTY_CLIENT_SOURCE_BINDINGS,
      );
      assert.strictEqual(entries.length, 4);
      assert.deepStrictEqual(yield* symmyDemoCustomerEnvironment(identities, entries), first);
      assert.deepStrictEqual(Object.keys(first), [
        'ONTOS_PARTY_CLIENT_SOURCE_BINDINGS',
        'ONTOS_PRIVACY_SOURCE_SYNC_PROCESSING_ENABLED',
      ]);
      assert.deepStrictEqual(
        entries.map((entry: { principalId: string }) => entry.principalId),
        [
          identities.integrationPrincipalId,
          identities.partyWriterId,
          identities.commerceWriterId,
          identities.partyReaderId,
        ],
      );
      assert.strictEqual(
        entries.every(
          (entry: { routeRef: string; tenantId: string }) =>
            entry.tenantId === SYMMY_DEMO_CUSTOMER_TENANT && entry.routeRef === SYMMY_DEMO_CUSTOMERS_ROUTE,
        ),
        true,
      );
    }),
  ));

await test('rejects invented integration identities before any deployment I/O', () =>
  runtime.runPromise(
    buildSymmyDemoCustomerRoutes('not-a-principal', []).pipe(
      Effect.flip,
      Effect.map((failure) => assert.strictEqual(Schema.isSchemaError(failure), true)),
    ),
  ));

await test('reuses a native Action key after a lost response and separates changed approved commands', () =>
  runtime.runPromise(
    Effect.gen(function* scenario() {
      const key = yield* symmyDemoCustomerWriteKey('privacy', createPurposePath, '{"a":1}');
      assert.strictEqual(
        key,
        'akros-customer-authority:e8aa51479a0dca32d46456642b11f4137cff68faa4dbc07350edf0d1c38e6820',
      );
      assert.strictEqual(key, yield* symmyDemoCustomerWriteKey('privacy', createPurposePath, '{"a":1}'));
      assert.notStrictEqual(key, yield* symmyDemoCustomerWriteKey('privacy', createPurposePath, '{"a":2}'));
      assert.notStrictEqual(
        key,
        yield* symmyDemoCustomerWriteKey('privacy', '/privacy/actions/create-privacy-subject', '{"a":1}'),
      );
      assert.ok(key.length <= 200);
    }),
  ));

await test('authorizes the actual switched Privacy receiver, not merely upstream source writers', () =>
  runtime.runPromise(
    Effect.gen(function* scenario() {
      const policy = yield* buildSymmySourceSyncProcessingPolicy(identities);
      assert.ok(
        policy.callers.some(
          (caller) =>
            caller.authMethod === { authMethod: 'system', principalId: identities.privacyReceiverId }.authMethod &&
            caller.principalId === { authMethod: 'system', principalId: identities.privacyReceiverId }.principalId,
        ),
      );
      assert.strictEqual(policy.callers.length, 4);
      assert.strictEqual(policy.groupRouteId, SYMMY_DEMO_GROUPS_SOURCE_ROUTE);
      assert.notStrictEqual(policy.groupRouteId, SYMMY_DEMO_GROUPS_ROUTE);
      assert.strictEqual(policy.policyId, 'akros-symmy-source-sync-v2');
      assert.strictEqual(policy.revision, 'v2');
    }),
  ));

await test('retires only explicitly identified duplicate aliases, preserving a unique legacy SYSTEM', () =>
  runtime.runPromise(
    Effect.gen(function* scenario() {
      const alias = { ...legacyWriter, bindingId: '72000000-0000-4000-8000-000000000031' };
      const other = {
        ...legacyWriter,
        bindingId: '72000000-0000-4000-8000-000000000032',
        principalId: identities.commerceWriterId,
      };
      assert.deepStrictEqual(yield* symmyDemoReceiverCandidates([alias, serviceWriter], [alias.bindingId]), [
        alias,
        serviceWriter,
      ]);
      assert.deepStrictEqual(yield* symmyDemoReceiverCandidates([alias, other, serviceWriter], [alias.bindingId]), [
        other,
        serviceWriter,
      ]);
      assert.strictEqual((yield* symmyDemoReceiverCandidates([alias, other, serviceWriter], [])).length, 3);
    }),
  ));

await test('adds only the distinct Commerce reader, preserves existing readers, and never overrides a managed route', () =>
  runtime.runPromise(
    Effect.gen(function* scenario() {
      const external = identities.integrationPrincipalId;
      const reader = '72000000-0000-4000-8000-000000000027';
      assert.strictEqual(
        yield* symmyDemoNativeReaderNeedsEnrollment({ managed: false, readers: [external] }, external, reader),
        true,
      );
      assert.strictEqual(
        yield* symmyDemoNativeReaderNeedsEnrollment({ managed: true, readers: [external, reader] }, external, reader),
        false,
      );
      assert.strictEqual(
        yield* symmyDemoNativeReaderNeedsEnrollment({ managed: true, readers: [reader] }, external, reader),
        false,
      );
      for (const [readers, managed, receiver] of [
        [[external], true, reader],
        [[], false, reader],
        [[external], false, external],
      ] as const) {
        assert.strictEqual(
          Result.isFailure(
            yield* symmyDemoNativeReaderNeedsEnrollment({ managed, readers }, external, receiver).pipe(Effect.result),
          ),
          true,
        );
      }
    }),
  ));

await test('candidate codecs preserve SQL nulls and omitted binding ids without inventing company scope', () =>
  runtime.runPromise(
    Effect.gen(function* candidateCodecScenario() {
      const wire = { ...legacyWriter, legalEntityId: null };
      const candidate = yield* Schema.decodeUnknownEffect(SymmyDemoSourceWriterCandidateSchema)(wire);
      assert.ok(Option.isNone(candidate.legalEntityId));
      assert.ok(Option.isNone(candidate.platformRole));
      const encoded = yield* Schema.encodeEffect(SymmyDemoSourceWriterCandidateSchema)(candidate);
      assert.deepStrictEqual(encoded, wire);
      assert.ok(!('bindingId' in encoded));
      const service = yield* Schema.decodeUnknownEffect(SymmyDemoSourceWriterCandidateSchema)(serviceWriter);
      assert.ok(Option.contains(service.legalEntityId, LegalEntityIdSchema.make(SYMMY_DEMO_CUSTOMER_COMPANY)));
      assert.ok(Option.contains(service.platformRole, 'internal_workload'));
      assert.deepStrictEqual(yield* Schema.encodeEffect(SymmyDemoSourceWriterCandidateSchema)(service), serviceWriter);
    }),
  ));
