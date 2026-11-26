import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { ConfigProvider, Effect, Layer, Redacted } from 'effect';
import { assert, expect, it } from 'effect-rstest';
import { Reactivity } from 'effect/reactivity';

import {
  bootstrapSymmyDemoSourcePolicies,
  symmyDemoPolicyScope,
  symmyDemoStockSourceRetention,
  symmyDemoStockSourceRouteId,
} from '../demo/symmy-demo-source-policies.mts';
import { priceKey } from '../../verticals/pricing/tests/support/standing-price-source-policy.fixture.ts';

const { legalEntityId, namespace, principalId, tenantId } = symmyDemoPolicyScope;
const productRouteId = '1a24b716-0542-40d5-8906-c78554b7436d';
const legacyStockRouteId = '042ef863-a837-48d6-81de-59a239148312';
const unitId = '11111111-1111-4111-8111-111111111111';
const effectiveFrom = '2020-01-01T00:00:00.000Z';
const mainLocation = 'MAIN';
const oldSku = 'ONLY-THE-OLD-SKU';
const authorityRef = 'symmy-akros';
const mappingRef = 'source-policy-fixture';
const version = 'v1';
const priceSource = {
  mapping: { mappingContractRef: mappingRef, mappingContractVersion: version },
  sourceAuthority: { sourceAuthorityRef: authorityRef, sourceAuthorityVersion: version },
};
const lifecyclePolicy = { policyId: 'original-stage-enrollment', revision: version };

const item = (entityKind: string, moduleId: string, entrypointKey: string, schemaVersion: string) => ({
  effects: [{ effectKey: entrypointKey, operation: { entrypointKey, moduleId, schemaVersion } }],
  itemKey: entityKind,
  source: { entityKind, issuerId: authorityRef, sourceNamespace: namespace, sourceRecordId: entityKind },
});
const legacyPlan = {
  inventoryBackendId: namespace,
  items: [item('STOCK', 'commerce.inventory', 'commerce.inventory.import-source-assertion', '1')],
  stockScope: [{ itemKey: oldSku, locationKey: mainLocation }],
};
const productsPlan = {
  inventoryBackendId: namespace,
  items: [
    item('PRODUCT', 'commerce.catalog', 'commerce.catalog.create-product', '2'),
    item('VARIANT', 'commerce.catalog', 'commerce.catalog.create-variant', '2'),
    item('PRICE', 'commerce.pricing', 'commerce.pricing.define-price', '2'),
  ],
  priceSource,
  pricingSourceSystem: { ownerModuleId: 'external.symmy', sourceSystemRef: authorityRef },
};
const services = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(Reactivity.layer),
);
const stage = bootstrapSymmyDemoSourcePolicies.pipe(
  Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'stage' }))),
);

type Admin = PgClient.PgClient;

const seedInventory = Effect.fn('SymmyDemoSourcePolicyTest.seedInventory')(function* seedInventory(admin: Admin) {
  const locationId = '22222222-2222-4222-8222-222222222222';
  const stockItemId = '33333333-3333-4333-8333-333333333333';
  const customerConfiguration = 'demo-source-policy';
  yield* admin`
    insert into inventory.backend_configurations
      (configuration_id, tenant_id, customer_configuration_id, backend_id, backend_kind,
       exact_reservation_capability, stock_correction_capability, selected_at)
    values (gen_random_uuid(), ${tenantId}, ${customerConfiguration}, ${namespace}, 'external_business_system',
      'UNSUPPORTED', 'UNSUPPORTED', ${effectiveFrom})`;
  yield* admin`
    insert into inventory.stock_locations
      (stock_location_id, tenant_id, display_name, scope_kind, physical_site_keys, lifecycle_state)
    values (${locationId}, ${tenantId}, ${mainLocation}, 'PHYSICAL_SITE', '["main-site"]'::jsonb, 'ACTIVE')`;
  yield* admin`
    insert into inventory.stock_items
      (stock_item_id, tenant_id, exact_selection_kind, exact_selection_meaning_id, stock_unit_resource_id,
       stock_unit_module_id, stock_unit_resource_type, stock_unit_tenant_id)
    values (${stockItemId}, ${tenantId}, 'PRODUCT_VARIANT', 'prior-selection', ${unitId},
      'commerce.catalog', 'commerce.catalog.product-unit', ${tenantId})`;
  yield* admin`
    insert into inventory.external_stock_correlations
      (correlation_id, tenant_id, customer_configuration_id, issuer_backend_kind, issuer_backend_id, namespace,
       external_scope, identifier_kind, external_value, stock_location_id, stock_item_id, effective_from,
       confirmed_at, owner_evidence_ref)
    values
      (gen_random_uuid(), ${tenantId}, ${customerConfiguration}, 'external_business_system', ${namespace},
        ${namespace}, 'demo-stock', 'LOCATION', ${mainLocation}, ${locationId}, null, ${effectiveFrom},
        ${effectiveFrom}, 'source-policy-seed'),
      (gen_random_uuid(), ${tenantId}, ${customerConfiguration}, 'external_business_system', ${namespace},
        ${namespace}, 'demo-stock', 'ITEM', ${oldSku}, null, ${stockItemId}, ${effectiveFrom}, ${effectiveFrom},
        'source-policy-seed')`;
});

const seedPricing = (admin: Admin) => {
  const exactKey = priceKey(
    { legalEntityId, tenantId, unitId },
    {
      productId: '44444444-4444-4444-8444-444444444444',
      variantId: '55555555-5555-4555-8555-555555555555',
    },
  );
  return admin`
    insert into pricing.external_price_source_authority_grants
      (tenant_id, legal_entity_id, source_authority_ref, source_authority_version, mapping_contract_ref,
       mapping_contract_version, exact_identity_key, effective_from, verification_ref, verified_at)
    values (${tenantId}, ${legalEntityId}, ${authorityRef}, ${version}, ${mappingRef}, ${version},
      ${admin.json(exactKey)}, ${effectiveFrom}, 'source-policy-seed', ${effectiveFrom})`;
};

const seedRoutes = Effect.fn('SymmyDemoSourcePolicyTest.seedRoutes')(function* seedRoutes(admin: Admin) {
  yield* admin`
    insert into symmy_integration.job_routes
      (route_id, tenant_id, principal_id, legal_entity_id, active, fixture_ids, fixture_plan, mapping_version,
       route_key, route_revision, lifecycle_policy)
    values
      (${productRouteId}, ${tenantId}, ${principalId}, ${legalEntityId}, true, array['stage-fixture'],
        ${admin.json(productsPlan)}, ${version}, 'productsBatch', ${version}, ${admin.json(lifecyclePolicy)}),
      (${legacyStockRouteId}, ${tenantId}, ${principalId}, null, false, array['stage-fixture'],
        ${admin.json(legacyPlan)}, ${version}, 'inventoryStockBatch', ${version}, ${admin.json(lifecyclePolicy)}),
      ('9e355544-4242-4704-a9d3-0ef0832fc328', ${tenantId}, ${principalId}, ${legalEntityId}, true,
        array['stage-fixture'], ${admin.json({ priceSource })}, ${version}, 'priceListsBatchUpsert', ${version},
        ${admin.json(lifecyclePolicy)}),
      ('3276fa39-f868-4be3-942c-501a6996a74a', ${tenantId}, ${principalId}, ${legalEntityId}, true,
        array['stage-fixture'], ${admin.json({ priceSource })}, ${version}, 'priceListPricesBatch', ${version},
        ${admin.json(lifecyclePolicy)})`;
});

const isolatedFixture = Effect.gen(function* makeFixture() {
  const isolated = yield* makeIsolatedNativeDatabaseFixture({
    mode: 'schema-only',
    purpose: 'demo-symmy-source-policy-bootstrap',
  });
  const admin = yield* PgClient.make({ url: Redacted.make(isolated.connections.admin.connectionString) });
  yield* seedInventory(admin);
  yield* seedPricing(admin);
  yield* seedRoutes(admin);
  return { admin, apply: stage.pipe(Effect.provideService(PgClient.PgClient, admin)) };
});

// Heap versions change even when an UPDATE restores the same values. Check all tables this bootstrap can write,
// including the gate and enrollment evidence written by route replacement and the original admissions.
const readWrites = (admin: Admin) => admin`
  select 'gate' as kind, gate_id::text as identity, xmin::text as version
    from core.source_execution_gates where tenant_id=${tenantId}
  union all select 'policy', policy_id::text, xmin::text from inventory.source_provisioning_policies
    where tenant_id=${tenantId}
  union all select 'location', location_key, xmin::text from inventory.source_provisioning_policy_locations
    where tenant_id=${tenantId}
  union all select 'correlation', correlation_id::text, xmin::text from inventory.external_stock_correlations
    where tenant_id=${tenantId}
  union all select 'price', policy_id::text, xmin::text from pricing.external_price_source_policies
    where tenant_id=${tenantId}
  union all select 'route', route_id::text, xmin::text from symmy_integration.job_routes where tenant_id=${tenantId}
  union all select 'enrollment', change_token::text, xmin::text from symmy_integration.route_enrollment_records
    where tenant_id=${tenantId}
  union all select 'admission', admission_id::text, xmin::text from symmy_integration.sync_admissions
    where tenant_id=${tenantId}
  order by kind, identity`;

const readRoute = (admin: Admin, routeId: string) => admin`
  select active, change_token, fixture_plan, lifecycle_policy
    from symmy_integration.job_routes where tenant_id=${tenantId} and route_id=${routeId}`;

const readAdmission = (admin: Admin, admissionId: string) => admin`
  select admission.*, admission.xmin::text as row_version
    from symmy_integration.sync_admissions as admission
    where tenant_id=${tenantId} and admission_id=${admissionId}`;

it.live('applies owner policies and re-enrolls source routes once, with no writes on replay', () =>
  Effect.gen(function* applyAndReplay() {
    const { admin, apply } = yield* isolatedFixture;
    const first = yield* apply;
    expect(first.inventoryOutcome).toBe('DEFINED');
    expect(first.pricePolicies.map(({ outcome }) => outcome)).toEqual(['STORED', 'STORED']);
    expect(first.routes).toEqual([
      { outcome: 'REPLACED', routeId: legacyStockRouteId },
      { outcome: 'REPLACED', routeId: productRouteId },
    ]);
    const [products] = yield* readRoute(admin, productRouteId);
    const [stock] = yield* readRoute(admin, legacyStockRouteId);
    assert.isDefined(products);
    assert.isDefined(stock);
    expect(products.fixture_plan).toMatchObject({
      catalogReadiness: { kind: 'AXIS_FREE_UNTYPED' },
      inventorySource: first.inventorySource,
    });
    expect(stock.active).toBe(true);
    expect(stock.fixture_plan).toMatchObject({ inventorySource: first.inventorySource });
    expect(stock.fixture_plan).not.toHaveProperty('stockScope');
    const beforeReplay = yield* readWrites(admin);
    const replay = yield* apply;
    expect(replay.inventoryOutcome).toBe('EXACT_REPLAY');
    expect(replay.pricePolicies).toEqual(first.pricePolicies.map((policy) => ({ ...policy, outcome: 'REUSED' })));
    expect(replay.routes).toEqual(first.routes.map((route) => ({ ...route, outcome: 'UNCHANGED' })));
    expect(yield* readWrites(admin)).toEqual(beforeReplay);
  }).pipe(Effect.scoped, Effect.provide(services)),
);

it.live('upgrades a stored legacy stock plan without replacing the route that holds retained admissions', () =>
  Effect.gen(function* upgradeLegacy() {
    const { admin, apply } = yield* isolatedFixture;
    const admissionId = '66666666-6666-4666-8666-666666666666';
    yield* admin`
      insert into symmy_integration.sync_admissions
        (admission_id, tenant_id, principal_id, route_id, route_key, route_revision, mapping_version,
         idempotency_digest, intent_digest, execution_plan)
      values (${admissionId}, ${tenantId}, ${principalId}, ${legacyStockRouteId}, 'inventoryStockBatch', ${version},
        ${version}, repeat('a', 64), repeat('b', 64), '{"items": []}'::jsonb)`;
    const legacyBefore = yield* readRoute(admin, legacyStockRouteId);
    const [admissionBefore] = yield* readAdmission(admin, admissionId);
    assert.isDefined(admissionBefore);
    expect(admissionBefore.route_id).toBe(legacyStockRouteId);
    const applied = yield* apply;
    expect(applied.routes).toContainEqual({
      outcome: 'ENROLLED',
      retainedRouteId: legacyStockRouteId,
      routeId: symmyDemoStockSourceRouteId,
    });
    expect(yield* readRoute(admin, legacyStockRouteId)).toEqual(legacyBefore);
    const [replacement] = yield* readRoute(admin, symmyDemoStockSourceRouteId);
    assert.isDefined(replacement);
    expect(replacement.active).toBe(true);
    expect(replacement.fixture_plan).toMatchObject({
      inventorySource: applied.inventorySource,
      sourceMappingVersion: version,
      sourceRouteId: legacyStockRouteId,
      sourceRouteRevision: version,
    });
    expect(replacement.fixture_plan).not.toHaveProperty('stockScope');
    expect(replacement.lifecycle_policy).toEqual({
      policyId: symmyDemoStockSourceRetention.policyId,
      revision: symmyDemoStockSourceRetention.revision,
    });
    expect(yield* readAdmission(admin, admissionId)).toEqual([admissionBefore]);
    const beforeReplay = yield* readWrites(admin);
    const replay = yield* apply;
    expect(replay.routes).toContainEqual({
      outcome: 'UNCHANGED',
      retainedRouteId: legacyStockRouteId,
      routeId: symmyDemoStockSourceRouteId,
    });
    expect(yield* readWrites(admin)).toEqual(beforeReplay);
  }).pipe(Effect.scoped, Effect.provide(services)),
);
