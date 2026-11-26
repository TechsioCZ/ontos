import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { sql } from 'drizzle-orm';
import { expect, it } from 'effect-rstest';
import { ConfigProvider, Effect, Layer, Redacted } from 'effect';
import { Reactivity } from 'effect/reactivity';

import { APP_DATABASE_IDENTITY_ENROLLMENT } from '../../database/identity-enrollment.ts';
import { AccessReleaseStoreLive } from '../../packages/core-runtime/src/access/changes/persistence/drizzle-store.ts';
import { AccessReleaseStore } from '../../packages/core-runtime/src/access/changes/persistence/release-store.ts';
import { AccessWorkloadBindingSourceLive } from '../../packages/core-runtime/src/access/workloads/bindings.ts';
import { CoreDatabase } from '../../packages/core-runtime/src/db/client.ts';
import { DatabaseIdentityEnrollmentContext } from '../../packages/core-runtime/src/db/database-identities.ts';
import { makeIsolatedNativeDatabaseFixture } from '../../packages/core-runtime/src/testing/isolated-native-database.ts';
import { ApplicationCompositionAuthorityAdminDatabaseLive } from '../application-composition-authority-publication.mts';
import {
  bootstrapSymmyDemoCustomerAuthority,
  readSymmyDemoCustomerEnvironment,
  SYMMY_DEMO_CUSTOMERS_ROUTE,
  SYMMY_DEMO_GROUPS_ROUTE,
  SYMMY_DEMO_GROUPS_SOURCE_ROUTE,
  symmyDemoCustomerInternalWorkloadDeclarations,
  SymmyDemoCustomerAuthorityLive,
  SymmyDemoCustomerDiscoveryLive,
} from '../demo/symmy-demo-customer-authority.mts';
import {
  bootstrapSymmyDemoExchangeAuthority,
  SYMMY_DEMO_EXCHANGE_PRODUCTS_ROUTE,
  SymmyDemoExchangeAuthorityLive,
  symmyDemoExchangeScope,
} from '../demo/symmy-demo-exchange-authority.mts';
import {
  bootstrapSymmyDemoInventoryAuthority,
  SymmyDemoInventoryAuthorityLive,
} from '../demo/symmy-demo-inventory-authority.mts';

const { legalEntityId, principalId, tenantId } = symmyDemoExchangeScope;
const ownerId = 'b0000000-0000-4000-8000-000000000001';
const scopeId = 'b0000000-0000-4000-8000-000000000002';
const membershipId = 'b0000000-0000-4000-8000-000000000003';
const productSourceId = 'b0000000-0000-4000-8000-000000000004';
const productReadRouteId = 'b0000000-0000-4000-8000-000000000005';
const revision = 'v1';

const seedScope = Effect.fn('SymmyDemoBootstrap.seedScope')(function* seedScope(admin: PgClient.PgClient) {
  yield* admin`insert into core.tenants (tenant_id,name,slug,status,default_locale)
    values (${tenantId},'Stage bootstrap fixture','stage-bootstrap-fixture','active','en')`;
  yield* admin`insert into core.legal_entities (legal_entity_id,tenant_id,legal_name,registration_country,registration_number,status)
    values (${legalEntityId},${tenantId},'Stage bootstrap fixture','CZ','STAGE_BOOTSTRAP_FIXTURE','active')`;
  yield* admin`insert into core.principals (principal_id,tenant_id,kind,status,display_name)
    values (${ownerId},${tenantId},'human','active','Stage fixture owner'),
      (${principalId},${tenantId},'integration','active','Stage fixture integration')`;
  yield* admin`insert into core.access_scopes (scope_id,tenant_id,tenant_context_id)
    values (${scopeId},${tenantId},${tenantId})`;
  yield* admin`insert into core.access_scope_fences (scope_id,tenant_id,state,revision)
    values (${scopeId},${tenantId},'Ready',1)`;
  yield* admin`insert into core.access_memberships
    (membership_id,tenant_id,scope_id,principal_id,recorded_by,kind,status,valid_from)
    values (${membershipId},${tenantId},${scopeId},${ownerId},${ownerId},'owner','active',clock_timestamp())`;
  const modules = new Set([
    'commerce.inventory',
    ...symmyDemoCustomerInternalWorkloadDeclarations.map(({ moduleKey }) => moduleKey),
  ]);
  for (const moduleKey of modules) {
    yield* admin`insert into core.tenant_module_states (tenant_id,module_key,state)
      values (${tenantId},${moduleKey},'active')`;
  }
  // These three workloads are published by the normal release, not registered additively by customer bootstrap.
  for (const key of [
    'commerce.customer-context.source-read',
    'commerce.customer-context.source-write',
    'pricing.price-group-catalog.source-read',
  ]) {
    yield* admin`with holder as (
      insert into core.principals (principal_id,tenant_id,kind,status,display_name)
      values (gen_random_uuid(),${tenantId},'system','active',${key}) returning principal_id
    ) insert into core.access_workload_bindings (binding_id,incarnation,tenant_id,principal_id,workload_key,status)
      select gen_random_uuid(),gen_random_uuid(),${tenantId},principal_id,${key},'active' from holder`;
  }
  return yield* Effect.void;
});

const seedRoutes = Effect.fn('SymmyDemoBootstrap.seedRoutes')(function* seedRoutes(admin: PgClient.PgClient) {
  for (const [routeKey, routeId, sourceRouteId, company, entityKind, moduleId, entrypointKey] of [
    [
      'customerGroupsBatch',
      SYMMY_DEMO_GROUPS_ROUTE,
      SYMMY_DEMO_GROUPS_SOURCE_ROUTE,
      legalEntityId,
      'CUSTOMER_GROUP',
      'commerce.customer-context',
      'commerce.customer-context.apply-customer-group-definition-source',
    ],
    [
      'productsBatch',
      SYMMY_DEMO_EXCHANGE_PRODUCTS_ROUTE,
      productSourceId,
      legalEntityId,
      'PRODUCT',
      'commerce.catalog',
      'commerce.catalog.create-product',
    ],
    [
      'adminProducts',
      productReadRouteId,
      productSourceId,
      null,
      'PRODUCT',
      'commerce.catalog',
      'commerce.catalog.api.product-source-page',
    ],
  ] as const) {
    const plan = {
      items: [
        {
          effects: [{ effectKey: 'original', operation: { entrypointKey, moduleId, schemaVersion: '1' } }],
          itemKey: 'source-template',
          source: { entityKind, issuerId: 'symmy-akros', sourceNamespace: 'akros-erp', sourceRecordId: 'fixture' },
        },
      ],
      sourceMappingVersion: revision,
      sourceRouteId,
      sourceRouteRevision: revision,
    };
    yield* admin`insert into symmy_integration.job_routes
      (tenant_id, legal_entity_id, principal_id, route_id, route_key, route_revision, mapping_version,
        fixture_ids, fixture_plan, active)
      values (${tenantId},${company},${principalId},${routeId},${routeKey},${revision},${revision},
        array['source-template'],${admin.json(plan)},true)`;
  }
  return yield* Effect.void;
});

const stableAuthority = (admin: PgClient.PgClient) =>
  Effect.all({
    bindings: admin`select * from core.access_workload_bindings where tenant_id=${tenantId} order by binding_id`,
    companies: admin`select * from core.access_workload_company_bindings
      where tenant_id=${tenantId} order by company_binding_id`,
    groupSources: admin`select route_id, generation, source_reader_principal_ids
      from commerce_customer_context.customer_group_definition_source_routes
      where tenant_id=${tenantId} order by route_id`,
    policies: admin`select policy_id, policy_record from privacy.demo_source_processing_policies
      where tenant_id=${tenantId} order by policy_id`,
    profileSources: admin`select route_id, generation, source_reader_principal_ids
      from commerce_customer_context.customer_profile_source_routes
      where tenant_id=${tenantId} order by route_id`,
    routeEpochs: admin`select route_id, change_token, legal_entity_id, fixture_plan from symmy_integration.job_routes
      where tenant_id=${tenantId} order by route_id`,
    routeHistory: admin`select route_id,change_token from symmy_integration.route_enrollment_records
      where tenant_id=${tenantId} order by route_id,change_token`,
  });

const sessionRole = (database: (typeof CoreDatabase)['Service']) =>
  database.executor.execute<{ readonly role: string }>(sql`select current_user as role`, 'objects');
const enrollment = Layer.succeed(DatabaseIdentityEnrollmentContext, APP_DATABASE_IDENTITY_ENROLLMENT);
const hostAdmin = Layer.mergeAll(AccessReleaseStoreLive, AccessWorkloadBindingSourceLive).pipe(
  Layer.provideMerge(ApplicationCompositionAuthorityAdminDatabaseLive),
  Layer.provide(enrollment),
);
const services = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.merge(NodeCrypto.layer),
);

it.live('bootstraps AKROS twice under a prebuilt admin database and preserves native grants and route epochs', () =>
  Effect.gen(function* bootstraps() {
    const { connections } = yield* makeIsolatedNativeDatabaseFixture({
      databaseIdentities: APP_DATABASE_IDENTITY_ENROLLMENT,
      mode: 'schema-only',
      purpose: 'demo-symmy-authority-bootstrap',
    });
    const admin = yield* PgClient.make({ url: Redacted.make(connections.admin.connectionString) });
    yield* seedScope(admin);
    yield* seedRoutes(admin);
    yield* Effect.gen(function* runStageAuthority() {
      const adminDatabase = yield* CoreDatabase;
      const adminStore = yield* AccessReleaseStore;
      expect(yield* sessionRole(adminDatabase)).toEqual([{ role: connections.admin.user }]);
      // App Host discovers the customer environment before migrations and owners start: it only reads.
      const discover = readSymmyDemoCustomerEnvironment.pipe(Effect.provide(SymmyDemoCustomerDiscoveryLive));
      const inventoryBoot = Effect.gen(function* inventoryBoot() {
        expect(yield* sessionRole(yield* CoreDatabase)).toEqual([{ role: connections.runtime.user }]);
        expect(yield* AccessReleaseStore).not.toBe(adminStore);
        return yield* bootstrapSymmyDemoInventoryAuthority;
      }).pipe(Effect.provide(SymmyDemoInventoryAuthorityLive));
      const customerBoot = Effect.gen(function* customerBoot() {
        expect(yield* sessionRole(yield* CoreDatabase)).toEqual([{ role: connections.runtime.user }]);
        expect(yield* AccessReleaseStore).not.toBe(adminStore);
        return yield* bootstrapSymmyDemoCustomerAuthority('apply');
      }).pipe(Effect.provide(SymmyDemoCustomerAuthorityLive));
      const exchangeBoot = bootstrapSymmyDemoExchangeAuthority('apply').pipe(
        Effect.provide(SymmyDemoExchangeAuthorityLive),
      );
      // Run their entry-point effects in host order, sharing the memo map to exercise the collision case.
      const firstInventory = yield* inventoryBoot;
      const firstCustomer = yield* customerBoot;
      // The next boot discovers the writers this boot's post-migration enrollment registered.
      const firstDiscovery = yield* discover;
      expect(firstDiscovery.identities.integrationPrincipalId).toBe(principalId);
      // The enclosing reader cannot see the first exchange grants until the exchange transaction commits.
      const firstExchange = yield* exchangeBoot;
      const firstState = yield* stableAuthority(admin);
      expect(firstInventory.outcome).toBe('ENROLLED');
      expect(firstExchange.routes.map(({ outcome }) => outcome)).toEqual(['replaced', 'replaced']);
      expect(firstCustomer.receipts).toHaveLength(2);
      // The customers route's retention is route data the bootstrap recorded with it.
      expect(
        yield* admin`select policy_id as "policyId", retention_ms::float8 as "retentionMs"
          from symmy_integration.route_retention_policies
          where tenant_id=${tenantId} and route_id=${SYMMY_DEMO_CUSTOMERS_ROUTE}`,
      ).toEqual([{ policyId: 'akros-symmy-customers', retentionMs: 2_592_000_000 }]);
      expect(yield* discover).toEqual(firstDiscovery);
      const secondInventory = yield* inventoryBoot;
      expect(secondInventory.outcome).toBe('ALREADY_ENROLLED');
      expect(secondInventory.bindingId).toBe(firstInventory.bindingId);
      expect(yield* customerBoot).toEqual(firstCustomer);
      const secondExchange = yield* exchangeBoot;
      expect(secondExchange.grants).toEqual(firstExchange.grants);
      expect(secondExchange.routes.map(({ outcome }) => outcome)).toEqual(['verified', 'verified']);
      yield* bootstrapSymmyDemoExchangeAuthority('verify').pipe(Effect.provide(SymmyDemoExchangeAuthorityLive));
      expect(yield* stableAuthority(admin)).toEqual(firstState);
      return yield* Effect.void;
    }).pipe(
      Effect.provide(hostAdmin),
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            DATABASE_ADMIN_URL: connections.admin.connectionString,
            DATABASE_URL: connections.runtime.connectionString,
            ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'stage',
          }),
        ),
      ),
    );
    return yield* Effect.void;
  }).pipe(Effect.provide(services), Effect.provide(Reactivity.layer), Effect.scoped),
);
