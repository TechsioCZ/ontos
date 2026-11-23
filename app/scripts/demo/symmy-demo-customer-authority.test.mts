import { Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { internalWorkloadPrincipalId } from '../../packages/core-runtime/src/auth/module-credentials.ts';
import { planAdditiveCompanyInternalWorkloads } from '../../packages/core-runtime/src/install/release-internal-workloads.ts';
import { ReleaseInternalWorkloadError } from '../../packages/core-runtime/src/install/release-internal-workloads.ts';

import {
  buildSymmyDemoCustomerRoutes,
  buildSymmyDemoSourceProcessingPolicy,
  SYMMY_DEMO_CUSTOMERS_READ_ROUTE,
  SYMMY_DEMO_CUSTOMERS_ROUTE,
  SYMMY_DEMO_CUSTOMER_COMPANY,
  SYMMY_DEMO_CUSTOMER_TENANT,
  SYMMY_DEMO_GROUPS_ROUTE,
  symmyDemoCustomerEnvironment,
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
} from './symmy-demo-customer-authority.mts';

const identities = {
  partyReaderId: '72000000-0000-4000-8000-000000000025',
  privacyReceiverId: '72000000-0000-4000-8000-000000000026',
  commerceWriterId: '72000000-0000-4000-8000-000000000023',
  integrationPrincipalId: '72000000-0000-4000-8000-000000000021',
  partyWriterId: '72000000-0000-4000-8000-000000000022',
};

it('retains only typed fixed enrollment categories and strips arbitrary reasons and raw causes', () => {
  for (const error of [
    new SymmyDemoCustomerAuthorityError({ reason: 'enrollment-database-config' }),
    new ReleaseInternalWorkloadError({ reason: 'additive-release-scope' }),
    new ReleaseInternalWorkloadError({ reason: 'additive-step-create-principal' }),
  ])
    expect(safeSymmyDemoEnrollmentFailure(error).reason).toBe(error.reason);
  for (const error of [
    new Error('credential-bearing driver diagnostic'),
    new ReleaseInternalWorkloadError({ reason: 'raw private diagnostic' }),
    { reason: 'additive-release-scope' },
  ]) {
    const safe = safeSymmyDemoEnrollmentFailure(error);
    expect(safe.reason).toBe('customer-workload-enrollment');
    expect('cause' in safe).toBe(false);
  }
});

it('plans exactly seven canonical AKROS company registrations without retiring unrelated platform jobs', () => {
  const tenantId = SYMMY_DEMO_CUSTOMER_TENANT;
  const legalEntityId = SYMMY_DEMO_CUSTOMER_COMPANY;
  const foreignCompany = '72000000-0000-4000-8000-000000000099';
  const plan = planAdditiveCompanyInternalWorkloads(
    {
      tenantId,
      activeCompanies: new Set([legalEntityId, foreignCompany]),
      activeModuleKeys: new Set(symmyDemoCustomerInternalWorkloadDeclarations.map(({ moduleKey }) => moduleKey)),
      companyNames: new Map([[legalEntityId, 'AKROS']]),
      registrations: [
        {
          principalId: identities.partyWriterId,
          legalEntityId: foreignCompany,
          workloadKey: 'demo.crm.party-intake',
          principalStatus: 'active',
          displayName: 'Existing CRM',
          activeWorkloadBindingId: identities.partyWriterId,
          activeCompanyBindingId: identities.partyReaderId,
          companyBindingCount: 1,
          workloadBindingCount: 1,
          extraCompanyBindingIds: [],
        },
      ],
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
          internalWorkloadPrincipalId({ tenantId, legalEntityId, workloadKey: step.workloadKey }),
        );
      }
    }
  }
});

it('replaces all discovery causes with fixed phase codes and retains no raw cause', () => {
  for (const phase of ['integration-route', 'party-writer', 'commerce-writer', 'party-reader'] as const) {
    const failure = symmyDemoDiscoveryFailure(phase)();
    expect(failure.reason).toBe(phase);
    expect(failure._tag).toBe('SymmyDemoCustomerAuthorityError');
    expect('cause' in failure).toBe(false);
  }
});

it('discovers only required receiver identities before owner startup, and the full chain after registration', () => {
  expect(symmyDemoReceiverWorkloadsForPhase('pre-owner')).toEqual(['party.registry.source-read']);
  const registered = symmyDemoReceiverWorkloadsForPhase('post-registration');
  expect(registered).toHaveLength(8);
  for (const key of symmyDemoReceiverWorkloadsForPhase('pre-owner')) expect(registered).toContain(key);
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
      (yield* selectSymmyDemoSourceWriter(workloadKey, [
        {
          ...serviceWriter,
          legalEntityId: null,
        },
      ]).pipe(Effect.result))._tag,
    ).toBe('Failure');
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
      expect((yield* selectSymmyDemoSourceWriter(workloadKey, candidates).pipe(Effect.result))._tag).toBe('Failure');
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
    expect(membership?.configuration.sourceRouteId).toBe(SYMMY_DEMO_GROUPS_ROUTE);
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
  const entries = JSON.parse(first.ONTOS_PARTY_CLIENT_SOURCE_BINDINGS);
  expect(entries).toHaveLength(4);
  expect(symmyDemoCustomerEnvironment(identities, entries)).toEqual(first);
  expect(Object.keys(first)).toEqual([
    'ONTOS_PARTY_CLIENT_SOURCE_BINDINGS',
    'ONTOS_PRIVACY_DEMO_SOURCE_PROCESSING_ENABLED',
  ]);
  expect(entries.map((entry: { principalId: string }) => entry.principalId)).toEqual([
    identities.integrationPrincipalId,
    identities.partyWriterId,
    identities.commerceWriterId,
    identities.partyReaderId,
  ]);
  expect(
    entries.every(
      (entry: { tenantId: string; routeRef: string }) =>
        entry.tenantId === SYMMY_DEMO_CUSTOMER_TENANT && entry.routeRef === SYMMY_DEMO_CUSTOMERS_ROUTE,
    ),
  ).toBe(true);
});

it.effect('rejects invented integration identities before any deployment I/O', () =>
  buildSymmyDemoCustomerRoutes('not-a-principal', []).pipe(
    Effect.flip,
    Effect.map((failure) => expect(failure._tag).toBe('SchemaError')),
  ),
);

it.effect('reuses a native Action key after a lost response and separates changed approved commands', () =>
  Effect.gen(function* test() {
    const key = yield* symmyDemoCustomerWriteKey('privacy', '/privacy/actions/create-processing-purpose', '{"a":1}');
    expect(key).toBe(
      yield* symmyDemoCustomerWriteKey('privacy', '/privacy/actions/create-processing-purpose', '{"a":1}'),
    );
    expect(key).not.toBe(
      yield* symmyDemoCustomerWriteKey('privacy', '/privacy/actions/create-processing-purpose', '{"a":2}'),
    );
    expect(key).not.toBe(
      yield* symmyDemoCustomerWriteKey('privacy', '/privacy/actions/create-privacy-subject', '{"a":1}'),
    );
    expect(key.length).toBeLessThanOrEqual(200);
  }),
);

it.effect('authorizes the actual switched Privacy receiver, not merely upstream source writers', () =>
  Effect.gen(function* test() {
    const policy = yield* buildSymmyDemoSourceProcessingPolicy(identities);
    expect(policy.callers).toContainEqual({ authMethod: 'system', principalId: identities.privacyReceiverId });
    expect(policy.callers).toHaveLength(4);
  }),
);

it.effect('retires only explicitly identified duplicate aliases, preserving a unique legacy SYSTEM', () =>
  Effect.gen(function* test() {
    const alias = { ...legacyWriter, bindingId: '72000000-0000-4000-8000-000000000031' };
    const other = {
      ...legacyWriter,
      principalId: identities.commerceWriterId,
      bindingId: '72000000-0000-4000-8000-000000000032',
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
