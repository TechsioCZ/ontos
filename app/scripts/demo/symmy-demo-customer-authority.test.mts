import { Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  buildSymmyDemoCustomerRoutes,
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
} from './symmy-demo-customer-authority.mts';

const identities = {
  commerceWriterId: '72000000-0000-4000-8000-000000000023',
  integrationPrincipalId: '72000000-0000-4000-8000-000000000021',
  partyWriterId: '72000000-0000-4000-8000-000000000022',
};
const group = {
  code: 'B2B',
  groupId: '72000000-0000-4000-8000-000000000024',
  recordId: 'actual-erp-group-record',
};

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
  expect(entries).toHaveLength(3);
  expect(symmyDemoCustomerEnvironment(identities, entries)).toEqual(first);
  expect(Object.keys(first)).toEqual([
    'ONTOS_PARTY_CLIENT_SOURCE_BINDINGS',
    'ONTOS_PRIVACY_DEMO_SOURCE_PROCESSING_ENABLED',
  ]);
  expect(entries.map((entry: { principalId: string }) => entry.principalId)).toEqual([
    identities.integrationPrincipalId,
    identities.partyWriterId,
    identities.commerceWriterId,
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
