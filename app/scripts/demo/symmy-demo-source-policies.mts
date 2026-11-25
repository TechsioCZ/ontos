#!/usr/bin/env node
/**
 * Noninteractive stage release bootstrap; run after migrations and Symmy's original enrollment,
 * before publication: `node scripts/demo/symmy-demo-source-policies.mts`.
 *
 * Environment: ULTRAMODERN_DEPLOYMENT_ENVIRONMENT=stage and DATABASE_ADMIN_URL only.
 * The admin login must read the enrolled routes and SET ROLE ontos_runtime. The latter is the
 * existing session-scoped owner writer, not a new principal, API key or workload. No HTTP services,
 * composition publication, operator cookies, input plans or SKU lists are required.
 *
 * Existing owner records supply the backend, unit, locations and commercial dimensions. Existing
 * per-key price authority supplies dimensions only on the first upgrade; subsequent releases also
 * read standing policies, so retiring the old grants does not remove bootstrap input.
 * All policy creation uses Inventory's domain operation and Pricing's governed domain operation.
 * A single transaction rolls back both owners on any conflict; neither owner overwrites a policy.
 * Replaces product/stock source enrollment under the native enrollment locks and outstanding-work
 * fence, records the change, and lets the database publish its execution gate. Only the stock
 * route retired by the legacy-scope migration is automatically reactivated.
 */
import { NodeCrypto, NodeServices } from '@effect/platform-node';
import { isDeepStrictEqual } from 'node:util';
import { PgClient } from '@effect/sql-pg';
import { sql } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Config, Console, Context, DateTime, Effect, Exit, Layer, Option, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';

import { defineDatabaseIdentityEnrollment } from '../../packages/core-runtime/src/db/database-identity-manifest.ts';
import { stableUuid } from '../../packages/core-runtime/src/access/catalog/stable-id.ts';
import { coreRelations } from '../../packages/core-runtime/src/db/schema.ts';
import type { CoreTransaction } from '../../packages/core-runtime/src/db/types.ts';
import { installOperationalScope } from '../../packages/core-runtime/src/db/scoped-transaction.ts';
import { stageScopeOf } from '../../packages/core-runtime/src/install/stage-context-bootstrap.ts';
import { DefineSourceProvisioningPolicyPayloadSchema } from '../../verticals/inventory/shared/actions/define-source-provisioning-policy.ts';
import { ExternalStockCorrelationLifecycle } from '../../verticals/inventory/shared/domain/external-stock-correlation.ts';
import { externalStockCorrelationPersistenceForScope } from '../../verticals/inventory/src/persistence/external-stock-correlation-repository.ts';
import { inventoryBackendConfigurationPersistenceForScope } from '../../verticals/inventory/src/persistence/inventory-backend-configuration-repository.ts';
import { sourceProvisioningPolicyPersistenceForScope } from '../../verticals/inventory/src/persistence/source-provisioning-repository.ts';
import { stockLocationPersistenceForScope } from '../../verticals/inventory/src/persistence/stock-location-repository.ts';
import { recordSourceProvisioningPolicy } from '../../verticals/inventory/src/services/source-provisioning.service.ts';
import { ExternalPriceSourcePolicyTermsSchema } from '../../verticals/pricing/shared/domain/external-price-source-policy.ts';
import { applyManageExternalPriceSourcePolicy } from '../../verticals/pricing/src/actions/manage-external-price-source-policy.action.ts';
import { externalPriceSourceAuthorityForScope } from '../../verticals/pricing/src/persistence/external-price-source-authority-persistence.ts';
import { SymmyPriceSourceSchema } from '../../verticals/symmy-integration/shared/domain/symmy-price-list-batch.ts';
import { SymmyInventorySourceSchema } from '../../verticals/symmy-integration/shared/domain/symmy-stock-batch.ts';
import { SymmyJobLifecyclePolicyRefSchema } from '../../verticals/symmy-integration/shared/domain/symmy-job-notification.ts';
import { SymmyFixtureExecutionPlanSchema } from '../../verticals/symmy-integration/shared/domain/symmy-job-execution.ts';
import {
  provisionStockItemOperation,
  readinessOperations,
} from '../../verticals/symmy-integration/src/persistence/symmy-product-plan.ts';
import type {
  SymmyRouteEnrollmentRequest,
  SymmyRouteEnrollmentRequestSchema,
  symmyRouteEnrollmentLockKey,
} from '../../verticals/symmy-integration/src/ops/symmy-route-enrollment.ts';

export const symmyDemoPolicyScope = {
  legalEntityId: 'c0c78a3e-6e2a-57e0-9d0d-86253499fee7',
  namespace: 'akros-erp',
  principalId: '90620f06-db0a-41ae-be48-4866258f6ea0',
  tenantId: 'bceaa540-13eb-5508-9ac0-9ed7e40a2ee9',
} as const;
export const symmyDemoStockSourceRouteId = stableUuid('ontos:stage:akros-symmy:source-stock-route:v1');
export const symmyDemoStockSourceRetention = {
  governanceLegalEntityId: symmyDemoPolicyScope.legalEntityId,
  policyId: 'akros-symmy-stock-source-v1',
  retentionMs: 2_592_000_000,
  revision: 'v1',
  routeId: symmyDemoStockSourceRouteId,
  targetLegalEntityId: null,
  tenantId: symmyDemoPolicyScope.tenantId,
} as const;
const enrollment = defineDatabaseIdentityEnrollment([]);
const openDatabase = makeWithDefaults({ relations: coreRelations });
const uuid = Schema.String.check(Schema.isUUID());
const text = Schema.String.check(Schema.isMinLength(1));
const RouteSchema = Schema.Struct({
  active: Schema.Boolean,
  change_token: Schema.Int,
  fixture_plan: Schema.Struct({
    inventoryBackendId: SymmyFixtureExecutionPlanSchema.fields.inventoryBackendId,
    priceSource: Schema.optionalKey(SymmyPriceSourceSchema),
  }),
  legal_entity_id: Schema.OptionFromNullOr(uuid),
  lifecycle_policy: Schema.Unknown,
  mapping_version: text,
  route_id: uuid,
  route_key: text,
  route_revision: text,
});
const RouteConfigurationSchema = Schema.Record(Schema.String, Schema.Unknown);
export const SymmyDemoSourceConfigurationSchema = Schema.StructWithRest(
  Schema.Struct({
    ...SymmyFixtureExecutionPlanSchema.fields,
    // Historical JSON key presence only; its retired SKU list is never authority for new work.
    stockScope: Schema.optionalKey(Schema.Unknown),
  }),
  [RouteConfigurationSchema],
);
const LegacyStockScopeMarkerSchema = Schema.Struct({ stockScope: Schema.optionalKey(Schema.Unknown) });
const inventoryModule = 'commerce.inventory';
const BackendSchema = Schema.Struct({
  backend_id: text,
  configuration_id: uuid,
  customer_configuration_id: text,
});
const LocationSchema = Schema.Struct({
  external_scope: text,
  external_value: text,
  stock_location_id: uuid,
});
const UnitSchema = Schema.Struct({ unit_id: uuid });
export const SymmyDemoPriceDimensionSchema = Schema.Struct({
  channel_id: Schema.Literals(['B2C', 'B2B']),
  currency_code: text,
  effective_from: text,
  market_id: text,
  unit_id: uuid,
  unit_quantity: text,
});
const routes = [
  '1a24b716-0542-40d5-8906-c78554b7436d',
  '042ef863-a837-48d6-81de-59a239148312',
  '9e355544-4242-4704-a9d3-0ef0832fc328',
  '3276fa39-f868-4be3-942c-501a6996a74a',
] as const;

export class SymmyDemoSourcePolicyFailure extends Schema.TaggedError<SymmyDemoSourcePolicyFailure>()(
  'SymmyDemoSourcePolicyFailure',
  { reason: Schema.String },
) {}
const fail = (reason: string) => new SymmyDemoSourcePolicyFailure({ reason });
export const requireSymmyDemoStage = (environment: string) =>
  environment === 'stage'
    ? Effect.void
    : Effect.fail(fail('Symmy demo source policies require the stage deployment environment'));
const only = <A,>(values: readonly A[], reason: string) => {
  const [value] = values;
  return values.length === 1 && value !== undefined ? Effect.succeed(value) : Effect.fail(fail(reason));
};

/** Validate native authority without attempting to re-enroll the exchange's separately approved operations.
 * This projection is validation-only: the complete original configuration is what we compare and persist.
 */
export const validateSymmyDemoSourceEnrollment = (request: SymmyRouteEnrollmentRequest) =>
  Effect.gen(function* validate() {
    const { SymmyRouteEnrollmentRequestSchema, symmyRouteInventoryOf, symmyRouteRequestRefusals } =
      yield* Effect.promise(
        async () => await import('../../verticals/symmy-integration/src/ops/symmy-route-enrollment.ts'),
      );
    const demoEffects = request.configuration.items.flatMap((item) =>
      item.effects.filter(({ operation }) => operation.moduleId === 'demo.merchandise'),
    );
    let nativeRequest = request;
    if (demoEffects.length > 0) {
      const { SYMMY_DEMO_EXCHANGE_PRODUCTS_ROUTE, symmyDemoExchangeRouteOperations } = yield* Effect.promise(
        async () => await import('./symmy-demo-exchange-authority.mts'),
      );
      const approved = symmyDemoExchangeRouteOperations('productsBatch');
      if (
        request.routeKey !== 'productsBatch' ||
        request.routeId !== SYMMY_DEMO_EXCHANGE_PRODUCTS_ROUTE ||
        request.tenantId !== symmyDemoPolicyScope.tenantId ||
        request.principalId !== symmyDemoPolicyScope.principalId ||
        request.legalEntityId !== symmyDemoPolicyScope.legalEntityId ||
        request.routeCode !== undefined ||
        request.configuration.sourceRouteId === undefined ||
        request.configuration.items.some(
          ({ source }) =>
            source.issuerId !== 'symmy-akros' || source.sourceNamespace !== symmyDemoPolicyScope.namespace,
        ) ||
        demoEffects.some(
          (effect) =>
            !approved.some((addition) =>
              isDeepStrictEqual(effect, { effectKey: addition.effectKey, operation: addition.operation }),
            ),
        ) ||
        new Set(demoEffects.map(({ effectKey }) => effectKey)).size !== demoEffects.length
      ) {
        return yield* fail(
          'Source-policy replay refuses demo operations outside the exact approved AKROS exchange enrollment',
        );
      }
      nativeRequest = yield* Schema.decodeUnknownEffect(SymmyRouteEnrollmentRequestSchema)({
        ...request,
        configuration: {
          ...request.configuration,
          items: request.configuration.items.map((item) => ({
            ...item,
            effects: item.effects.filter(({ operation }) => operation.moduleId !== 'demo.merchandise'),
          })),
        },
      });
    }
    const inventory = symmyRouteInventoryOf(nativeRequest.routeKey);
    if (!Option.isOption(inventory) || Option.isNone(inventory)) {
      return yield* fail('The native owner does not support this declared source route');
    }
    if (symmyRouteRequestRefusals(nativeRequest, inventory.value).length > 0) {
      return yield* fail('Native Symmy route validation refused source-policy enrollment');
    }
    return yield* Effect.void;
  });

/** Replaces the old finite stock scope, never copying an ERP item key into the new enrollment. */
export const symmyDemoInventoryConfiguration = (
  original: typeof SymmyDemoSourceConfigurationSchema.Type,
  inventorySource: typeof SymmyInventorySourceSchema.Type,
  products: boolean,
) =>
  Effect.gen(function* sourceConfiguration() {
    const { stockScope: _legacyScope, ...fields } = original;
    const configuration = yield* Schema.decodeUnknownEffect(SymmyFixtureExecutionPlanSchema)({
      ...fields,
      inventoryBackendId: inventorySource.issuer.backendId,
      inventorySource,
    });
    if (!products) {
      const [first] = configuration.items;
      return yield* Schema.decodeUnknownEffect(SymmyFixtureExecutionPlanSchema)({
        ...configuration,
        items: [
          {
            effects: [
              {
                effectKey: 'source-stock-import',
                operation: {
                  entrypointKey: 'commerce.inventory.import-source-assertion',
                  moduleId: inventoryModule,
                  schemaVersion: '1',
                },
              },
              {
                effectKey: 'source-stock-resolution',
                operation: {
                  entrypointKey: 'commerce.inventory.api.source-stock-position-resolution',
                  moduleId: inventoryModule,
                  schemaVersion: '1',
                },
              },
            ],
            itemKey: 'source-stock',
            source: { ...first.source, entityKind: 'STOCK', sourceRecordId: 'source-stock' },
          },
        ],
      });
    }
    if (
      configuration.items.some((item) =>
        item.effects.some((effect) => effect.operation.entrypointKey === provisionStockItemOperation.entrypointKey),
      )
    ) {
      return configuration;
    }
    const product = configuration.items.find((item) => item.source.entityKind === 'PRODUCT');
    if (product === undefined) {
      return yield* fail('The product route has no PRODUCT enrollment to provision stock under');
    }
    return yield* Schema.decodeUnknownEffect(SymmyFixtureExecutionPlanSchema)({
      ...configuration,
      items: configuration.items.map((item) =>
        item === product
          ? {
              ...item,
              effects: [
                ...item.effects,
                {
                  effectKey: 'source-stock-provision',
                  operation: provisionStockItemOperation,
                },
              ],
            }
          : item,
      ),
    });
  });

/** Standing demo approval covers one axis-free, untyped ACTIVE Product, never unsupported structured variants. */
export const symmyDemoCatalogReadinessConfiguration = (
  original: typeof SymmyFixtureExecutionPlanSchema.Type,
  inventorySource: typeof SymmyInventorySourceSchema.Type,
) =>
  Effect.gen(function* catalogReadinessConfiguration() {
    const configuration = original;
    const products = configuration.items.filter(({ source }) => source.entityKind === 'PRODUCT');
    const product = yield* only(products, 'Catalog readiness requires exactly one approved PRODUCT source template');
    if (
      inventorySource.unitRef.tenantId !== symmyDemoPolicyScope.tenantId ||
      inventorySource.issuer.backendId !== configuration.inventoryBackendId ||
      inventorySource.namespace !== symmyDemoPolicyScope.namespace ||
      product.source.issuerId !== 'symmy-akros' ||
      product.source.sourceNamespace !== symmyDemoPolicyScope.namespace ||
      !isDeepStrictEqual(configuration.inventorySource, inventorySource)
    ) {
      return yield* fail('Catalog readiness is restricted to the approved AKROS Inventory source and its exact Unit');
    }
    const catalogReadiness = {
      divisible: false,
      kind: 'AXIS_FREE_UNTYPED',
      locale: 'en',
      unitRef: inventorySource.unitRef,
    } as const;
    if (
      configuration.catalogReadiness !== undefined &&
      !isDeepStrictEqual(configuration.catalogReadiness, catalogReadiness)
    ) {
      return yield* fail('An existing different Catalog readiness policy is never overwritten');
    }
    const additions = readinessOperations.flatMap((operation, index) =>
      product.effects.some((effect) => isDeepStrictEqual(effect.operation, operation))
        ? []
        : [{ effectKey: `source-catalog-readiness-${index}`, operation }],
    );
    return yield* Schema.decodeUnknownEffect(SymmyFixtureExecutionPlanSchema)({
      ...configuration,
      catalogReadiness,
      items: configuration.items.map((item) =>
        item === product
          ? {
              ...item,
              effects: [...item.effects, ...additions],
            }
          : item,
      ),
    });
  });

/** Products assert base prices; the price-list routes assert prices of source-created groups. */
export const symmyDemoPricePolicies = (
  sources: readonly {
    readonly coverage: 'NO_GROUP' | 'ANY_PRICE_GROUP';
    readonly source: typeof SymmyPriceSourceSchema.Type;
  }[],
  dimensions: readonly (typeof SymmyDemoPriceDimensionSchema.Type)[],
) =>
  Effect.gen(function* pricePolicies() {
    const policies: (typeof ExternalPriceSourcePolicyTermsSchema.Type)[] = [];
    const seen = new Set<string>();
    for (const { coverage, source } of sources) {
      for (const dimension of dimensions) {
        const policy = yield* Schema.decodeUnknownEffect(ExternalPriceSourcePolicyTermsSchema)({
          authority: source.sourceAuthority,
          commercialScope: {
            channelId: dimension.channel_id,
            marketId: dimension.market_id,
            sellingLegalEntityId: symmyDemoPolicyScope.legalEntityId,
          },
          currencyCode: dimension.currency_code,
          effectivePeriod: { effectiveFrom: dimension.effective_from },
          mapping: source.mapping,
          priceGroupCoverage: { kind: coverage },
          unitBasis: {
            quantity: dimension.unit_quantity,
            unitRef: {
              moduleId: 'commerce.catalog',
              resourceId: dimension.unit_id,
              resourceType: 'commerce.catalog.product-unit',
              tenantId: symmyDemoPolicyScope.tenantId,
            },
          },
        });
        const identity = yield* Schema.encodeEffect(Schema.fromJsonString(ExternalPriceSourcePolicyTermsSchema))(
          policy,
        );
        if (!seen.has(identity)) {
          seen.add(identity);
          policies.push(policy);
        }
      }
    }
    if (policies.length === 0) {
      return yield* fail(
        'No enrolled price mapping or existing commercial dimensions; source policies were not guessed',
      );
    }
    return policies;
  });

interface EnrollmentOwner {
  readonly symmyRouteEnrollmentLockKey: typeof symmyRouteEnrollmentLockKey;
  readonly SymmyRouteEnrollmentRequestSchema: typeof SymmyRouteEnrollmentRequestSchema;
}

const readDemoSourcePolicyInputs = (transaction: CoreTransaction, enrollmentOwner: EnrollmentOwner) =>
  Effect.gen(function* readPolicyInputs() {
    const { legalEntityId, namespace, principalId, tenantId } = symmyDemoPolicyScope;
    const { symmyRouteEnrollmentLockKey, SymmyRouteEnrollmentRequestSchema } = enrollmentOwner;
    yield* transaction.execute(
      sql`select pg_advisory_xact_lock(hashtext('symmy-demo-source-policies'), hashtext(${tenantId}))`,
    );
    for (const routeKey of ['productsBatch', 'inventoryStockBatch'] as const) {
      const lock = symmyRouteEnrollmentLockKey({
        principalId: yield* Schema.decodeUnknownEffect(SymmyRouteEnrollmentRequestSchema.fields.principalId)(
          principalId,
        ),
        routeKey,
        tenantId: yield* Schema.decodeUnknownEffect(SymmyRouteEnrollmentRequestSchema.fields.tenantId)(tenantId),
      });
      yield* transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lock}, 0))`);
    }
    const enrolled = yield* transaction
      .execute(
        sql`select route_id, route_key, legal_entity_id, fixture_plan, active, change_token,
          route_revision, mapping_version, lifecycle_policy from symmy_integration.job_routes
          where tenant_id = ${tenantId}::uuid and principal_id = ${principalId}::uuid
          and route_id in (${routes[0]}::uuid, ${routes[1]}::uuid, ${routes[2]}::uuid, ${routes[3]}::uuid)
          order by route_id for update`,
        'objects',
      )
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(RouteSchema))));
    if (
      enrolled.length !== routes.length ||
      enrolled.some((route) =>
        route.route_key === 'inventoryStockBatch'
          ? Option.isSome(route.legal_entity_id)
          : Option.getOrUndefined(route.legal_entity_id) !== legalEntityId,
      )
    ) {
      return yield* fail('The four declared Symmy demo routes must already be enrolled in their original scopes');
    }
    const stock = yield* only(
      enrolled.filter((route) => route.route_key === 'inventoryStockBatch'),
      'The declared stock route is absent or ambiguous',
    );
    const backendId = stock.fixture_plan.inventoryBackendId;
    if (backendId === undefined) {
      return yield* fail('The enrolled stock route has no backend identity');
    }
    const backendRows = yield* transaction
      .execute(
        sql`select configuration_id, customer_configuration_id, backend_id from inventory.backend_configurations
          where tenant_id = ${tenantId}::uuid and backend_kind = 'external_business_system' and backend_id = ${backendId}
          for update`,
        'objects',
      )
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(BackendSchema))));
    const backend = yield* only(
      backendRows,
      'The enrolled Inventory backend must have exactly one selected configuration',
    );
    const locations = yield* transaction
      .execute(
        sql`select external_scope, external_value, stock_location_id from inventory.external_stock_correlations
          where tenant_id = ${tenantId}::uuid and customer_configuration_id = ${backend.customer_configuration_id}
          and issuer_backend_kind = 'external_business_system' and issuer_backend_id = ${backendId}
          and namespace = ${namespace} and identifier_kind = 'LOCATION'
          and lifecycle_state = 'CURRENT' and effective_to is null order by external_value for share`,
        'objects',
      )
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(LocationSchema))));
    const externalScope = yield* only(
      [...new Set(locations.map((row) => row.external_scope))],
      'Existing source LOCATION correlations must identify one external scope',
    );
    const units = yield* transaction
      .execute(
        sql`select distinct item.stock_unit_resource_id as unit_id from inventory.stock_items item
          join inventory.external_stock_correlations correlation
            on correlation.tenant_id=item.tenant_id and correlation.stock_item_id=item.stock_item_id
          where item.tenant_id = ${tenantId}::uuid and item.lifecycle_state = 'CURRENT'
            and correlation.customer_configuration_id=${backend.customer_configuration_id}
            and correlation.issuer_backend_kind='external_business_system'
            and correlation.issuer_backend_id=${backendId} and correlation.namespace=${namespace}
            and correlation.external_scope=${externalScope} and correlation.identifier_kind='ITEM'
            and correlation.lifecycle_state='CURRENT' and correlation.effective_to is null`,
        'objects',
      )
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(UnitSchema))));
    const unit = yield* only(units, 'Existing demo stock must have exactly one unit; no default unit is invented');
    const input = yield* Schema.decodeUnknownEffect(DefineSourceProvisioningPolicyPayloadSchema)({
      customerConfigurationId: backend.customer_configuration_id,
      externalScope,
      locations: locations.map((row) => ({
        locationKey: row.external_value,
        stockLocationRef: {
          moduleId: inventoryModule,
          resourceId: row.stock_location_id,
          resourceType: 'commerce.inventory.stock-location',
          tenantId,
        },
      })),
      namespace,
      ownerConfigurationRef: {
        moduleId: inventoryModule,
        resourceId: backend.configuration_id,
        resourceType: 'commerce.inventory.inventory-backend-configuration',
        tenantId,
      },
      unitRef: {
        moduleId: 'commerce.catalog',
        resourceId: unit.unit_id,
        resourceType: 'commerce.catalog.product-unit',
        tenantId,
      },
    });
    // Only dimensions, never Product/Variant ids or an enumerated list of external item keys.
    const dimensions = yield* transaction
      .execute(
        sql`select channel_id, market_id, currency_code, unit_id,
          trim_scale(unit_quantity::numeric)::text as unit_quantity, min(effective_from) as effective_from
        from (
          select exact_identity_key #>> '{commercialScope,channelId}' as channel_id,
            exact_identity_key #>> '{commercialScope,marketId}' as market_id,
            exact_identity_key ->> 'currencyCode' as currency_code,
            exact_identity_key #>> '{unitBasis,unitRef,resourceId}' as unit_id,
            exact_identity_key #>> '{unitBasis,quantity}' as unit_quantity,
            to_char(effective_from at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as effective_from
          from pricing.external_price_source_authority_grants
          where tenant_id = ${tenantId}::uuid and legal_entity_id = ${legalEntityId}::uuid
          union all
          select channel_id, market_id, currency_code, unit_id::text, unit_quantity::text,
            to_char(effective_from at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          from pricing.external_price_source_policies
          where tenant_id = ${tenantId}::uuid and legal_entity_id = ${legalEntityId}::uuid
        ) dimensions group by channel_id, market_id, currency_code, unit_id, unit_quantity::numeric`,
        'objects',
      )
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(SymmyDemoPriceDimensionSchema))));
    const sources = enrolled.flatMap((route) =>
      route.fixture_plan.priceSource === undefined
        ? []
        : [
            {
              coverage: route.route_key === 'productsBatch' ? ('NO_GROUP' as const) : ('ANY_PRICE_GROUP' as const),
              source: route.fixture_plan.priceSource,
            },
          ],
    );
    const policies = yield* symmyDemoPricePolicies(sources, dimensions);
    return { enrolled, input, policies };
  });

const establishDemoOwnerPolicies = (
  transaction: CoreTransaction,
  input: typeof DefineSourceProvisioningPolicyPayloadSchema.Type,
  policies: readonly (typeof ExternalPriceSourcePolicyTermsSchema.Type)[],
) =>
  Effect.gen(function* establishOwnerPolicies() {
    const { legalEntityId, principalId, tenantId } = symmyDemoPolicyScope;
    // The installation's canonical scope mechanism, under the already-enrolled session-scoped writer.
    yield* transaction.execute(sql`set local role ontos_runtime`);
    const inventoryScope = yield* stageScopeOf({ principalId, tenantId });
    const inventoryTransaction = yield* installOperationalScope(transaction, inventoryScope, enrollment);
    const correlations = externalStockCorrelationPersistenceForScope(inventoryTransaction, inventoryScope);
    const inventory = yield* recordSourceProvisioningPolicy(
      {
        configurations: inventoryBackendConfigurationPersistenceForScope(inventoryTransaction, inventoryScope),
        correlations: {
          current: correlations,
          lifecycle: {
            establish: ({ correlationResourceId, input: correlationInput }) => {
              const lifecycleLayer = ExternalStockCorrelationLifecycle.layer(correlations, {
                makeCorrelationId: () => correlationResourceId,
              });
              return Effect.scoped(
                Effect.gen(function* establishCorrelation() {
                  const lifecycleContext = yield* Layer.build(lifecycleLayer);
                  const lifecycle = Context.get(lifecycleContext, ExternalStockCorrelationLifecycle);
                  return yield* lifecycle.establish(correlationInput);
                }),
              );
            },
          },
        },
        locations: stockLocationPersistenceForScope(inventoryTransaction, inventoryScope),
        policies: sourceProvisioningPolicyPersistenceForScope(inventoryTransaction, inventoryScope),
      },
      { input, tenantId },
    );
    const pricingScope = yield* stageScopeOf({ legalEntityId, principalId, tenantId });
    const pricingTransaction = yield* installOperationalScope(transaction, pricingScope, enrollment);
    const persistence = yield* externalPriceSourceAuthorityForScope(pricingTransaction, pricingScope);
    const prices = [];
    for (const policy of policies) {
      prices.push(
        yield* applyManageExternalPriceSourcePolicy(
          {
            intent: 'ESTABLISH',
            policy,
            reason: 'Stage AKROS Symmy source-level policy bootstrap; no per-SKU grants',
            verificationRef: 'ontos:stage:akros-symmy:source-policies:v1',
          },
          {
            legalEntityId: pricingScope.legalEntityId,
            tenantId: pricingScope.tenantId,
            trustedOperationAt: yield* DateTime.nowAsDate,
          },
          persistence,
        ),
      );
    }
    const inventorySource = yield* Schema.decodeUnknownEffect(SymmyInventorySourceSchema)(inventory.policy);
    // Route writes belong to the administrative enrollment login, never the owner runtime writer.
    yield* transaction.execute(sql`reset role`);
    return { inventory, inventorySource, prices };
  });

const prepareDemoSourceRoute = (
  transaction: CoreTransaction,
  route: typeof RouteSchema.Type,
  inventorySource: typeof SymmyInventorySourceSchema.Type,
  enrollmentOwner: EnrollmentOwner,
) =>
  Effect.gen(function* prepareSourceRoute() {
    const { principalId, tenantId } = symmyDemoPolicyScope;
    const { SymmyRouteEnrollmentRequestSchema } = enrollmentOwner;
    const rawRows = yield* transaction.execute(
      sql`select fixture_plan from symmy_integration.job_routes
          where tenant_id = ${tenantId}::uuid and route_id = ${route.route_id}::uuid`,
      'objects',
    );
    const raw = yield* only(
      yield* Schema.decodeUnknownEffect(
        Schema.Array(
          Schema.Struct({
            fixture_plan: RouteConfigurationSchema,
          }),
        ),
      )(rawRows),
      'The locked source route disappeared',
    );
    let configuration = yield* symmyDemoInventoryConfiguration(
      yield* Schema.decodeUnknownEffect(SymmyDemoSourceConfigurationSchema)(raw.fixture_plan),
      inventorySource,
      route.route_key === 'productsBatch',
    );
    if (route.route_key === 'productsBatch') {
      configuration = yield* symmyDemoCatalogReadinessConfiguration(configuration, inventorySource);
    }
    const legacyStock =
      (yield* Schema.decodeUnknownEffect(LegacyStockScopeMarkerSchema)(raw.fixture_plan)).stockScope !== undefined;
    const retained =
      route.route_key === 'inventoryStockBatch' && !route.active && legacyStock
        ? yield* transaction.execute(
            sql`select 1 from symmy_integration.sync_admissions
              where tenant_id=${tenantId}::uuid and route_id=${route.route_id}::uuid
                and retention_receipt is null limit 1`,
            'objects',
          )
        : [];
    const rollover = retained.length > 0;
    if (rollover) {
      configuration = yield* Schema.decodeUnknownEffect(SymmyFixtureExecutionPlanSchema)({
        ...configuration,
        sourceMappingVersion: configuration.sourceMappingVersion ?? route.mapping_version,
        sourceRouteId: configuration.sourceRouteId ?? route.route_id,
        sourceRouteRevision: configuration.sourceRouteRevision ?? route.route_revision,
      });
    }
    const targetRouteId = rollover ? symmyDemoStockSourceRouteId : route.route_id;
    const lifecyclePolicy = rollover
      ? { policyId: symmyDemoStockSourceRetention.policyId, revision: symmyDemoStockSourceRetention.revision }
      : route.lifecycle_policy;
    const requestInput = {
      configuration,
      lifecyclePolicy,
      mappingVersion: route.mapping_version,
      principalId,
      routeId: targetRouteId,
      routeKey: route.route_key,
      routeRevision: route.route_revision,
      tenantId,
    };
    const request = yield* Schema.decodeUnknownEffect(SymmyRouteEnrollmentRequestSchema)(
      Option.match(route.legal_entity_id, {
        onNone: () => requestInput,
        onSome: (legalEntityId) => ({ ...requestInput, legalEntityId }),
      }),
    );
    yield* validateSymmyDemoSourceEnrollment(request);
    const encoded = yield* Schema.encodeEffect(SymmyFixtureExecutionPlanSchema)(configuration);
    const configurationJson = yield* Schema.encodeEffect(Schema.fromJsonString(SymmyFixtureExecutionPlanSchema))(
      configuration,
    );
    return { configurationJson, encoded, legacyStock, lifecyclePolicy, raw, request, rollover, route, targetRouteId };
  });

type PreparedSourceRoute = Effect.Success<ReturnType<typeof prepareDemoSourceRoute>>;

const rolloverDemoStockRoute = (transaction: CoreTransaction, prepared: PreparedSourceRoute) =>
  Effect.gen(function* rolloverStockRoute() {
    const { principalId, tenantId } = symmyDemoPolicyScope;
    const { configurationJson, encoded, lifecyclePolicy, request, route, targetRouteId } = prepared;
    const freshRows = yield* transaction
      .execute(
        sql`select fixture_plan, active, principal_id, route_key,
              legal_entity_id, lifecycle_policy from symmy_integration.job_routes
            where tenant_id=${tenantId}::uuid and route_id=${targetRouteId}::uuid for update`,
        'objects',
      )
      .pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Array(
              Schema.Struct({
                active: Schema.Boolean,
                fixture_plan: RouteConfigurationSchema,
                legal_entity_id: Schema.OptionFromNullOr(uuid),
                lifecycle_policy: Schema.Unknown,
                principal_id: uuid,
                route_key: text,
              }),
            ),
          ),
        ),
      );
    if (freshRows.length > 0) {
      const fresh = yield* only(freshRows, 'The deterministic stock route is ambiguous');
      if (
        !fresh.active ||
        fresh.principal_id !== principalId ||
        fresh.route_key !== route.route_key ||
        Option.isSome(fresh.legal_entity_id) ||
        !isDeepStrictEqual(fresh.fixture_plan, encoded) ||
        !isDeepStrictEqual(fresh.lifecycle_policy, lifecyclePolicy)
      ) {
        return yield* fail('The deterministic stock route already exists with different enrollment; no overwrite');
      }
      return { outcome: 'UNCHANGED', retainedRouteId: route.route_id, routeId: targetRouteId };
    }
    const incompatibleUnique = yield* transaction.execute(
      sql`select 1 from pg_constraint
            where conrelid='symmy_integration.job_routes'::regclass
              and conname='symmy_job_routes_scope_selector_uq' and contype='u'`,
      'objects',
    );
    if (incompatibleUnique.length > 0) {
      return yield* fail('Stock history rollover requires the native active-only selector uniqueness migration');
    }
    const lifecycleJson = yield* Schema.encodeEffect(Schema.fromJsonString(SymmyJobLifecyclePolicyRefSchema))(
      yield* Schema.decodeUnknownEffect(SymmyJobLifecyclePolicyRefSchema)(request.lifecyclePolicy),
    );
    const inserted = yield* transaction
      .execute(
        sql`insert into symmy_integration.job_routes
            (active, fixture_ids, fixture_plan, legal_entity_id, lifecycle_policy, mapping_version,
              principal_id, route_code, route_id, route_key, route_revision, tenant_id)
            select true, fixture_ids, ${configurationJson}::jsonb, legal_entity_id,
              ${lifecycleJson}::jsonb, mapping_version, principal_id, route_code,
              ${targetRouteId}::uuid, route_key, route_revision, tenant_id
            from symmy_integration.job_routes
            where tenant_id=${tenantId}::uuid and route_id=${route.route_id}::uuid and not active
              and change_token=${route.change_token}
            returning change_token, active, fixture_plan`,
        'objects',
      )
      .pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Array(
              Schema.Struct({
                active: Schema.Boolean,
                change_token: Schema.Int,
                fixture_plan: RouteConfigurationSchema,
              }),
            ),
          ),
        ),
      );
    const created = yield* only(inserted, 'The locked legacy stock route changed during rollover');
    if (!created.active || !isDeepStrictEqual(created.fixture_plan, encoded)) {
      return yield* fail('The fresh stock route failed its stored enrollment read-back');
    }
    yield* transaction.execute(sql`insert into symmy_integration.route_enrollment_records
            (change, change_token, legal_entity_id, previous_change_token, previous_revision,
              reason, route_id, route_key, route_revision, stated_operator_ref, tenant_id)
            values ('enroll', ${created.change_token}, null, null, null,
              'Stage-approved source-policy stock route; prior inactive route and all retained admissions preserved',
              ${targetRouteId}::uuid, ${route.route_key}, ${route.route_revision},
              'ontos:stage:akros-symmy:source-policies:v1', ${tenantId}::uuid)`);
    return { outcome: 'ENROLLED', retainedRouteId: route.route_id, routeId: targetRouteId };
  });

const replaceDemoSourceRoute = (transaction: CoreTransaction, prepared: PreparedSourceRoute) =>
  Effect.gen(function* replaceSourceRoute() {
    const { tenantId } = symmyDemoPolicyScope;
    const { configurationJson, encoded, legacyStock, raw, route } = prepared;
    const same = isDeepStrictEqual(raw.fixture_plan, encoded);
    if (same && route.active) {
      return { outcome: 'UNCHANGED', routeId: route.route_id };
    }
    if (!route.active && !(route.route_key === 'inventoryStockBatch' && legacyStock)) {
      return yield* fail('An inactive route not retired by the legacy stock migration is never reactivated');
    }
    // Same outstanding-work fence as native enrollment; row locks stop concurrent admissions.
    const outstanding = yield* transaction.execute(
      sql`
          select 1 as present from symmy_integration.import_jobs j
          join symmy_integration.job_effects e on e.tenant_id=j.tenant_id and e.job_id=j.job_id
          where j.tenant_id=${tenantId}::uuid and j.route_id=${route.route_id}::uuid and e.state <> 'settled'
          and not exists (select 1 from symmy_integration.job_retention_tombstones t
            where t.tenant_id=j.tenant_id and t.job_id=j.job_id)
          union all
          select 1 from symmy_integration.sync_admissions a
          where a.tenant_id=${tenantId}::uuid and a.route_id=${route.route_id}::uuid and a.retention_receipt is null
          limit 1`,
      'objects',
    );
    if (outstanding.length > 0) {
      return yield* fail(
        'Source route replacement has outstanding jobs/admissions; resolve them through the owner first',
      );
    }
    const updated = yield* transaction
      .execute(
        sql`update symmy_integration.job_routes
          set fixture_plan=${configurationJson}::jsonb, active=true
          where tenant_id=${tenantId}::uuid and route_id=${route.route_id}::uuid and change_token=${route.change_token}
          returning change_token, active, fixture_plan`,
        'objects',
      )
      .pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Array(
              Schema.Struct({
                active: Schema.Boolean,
                change_token: Schema.Int,
                fixture_plan: RouteConfigurationSchema,
              }),
            ),
          ),
        ),
      );
    const changed = yield* only(updated, 'The locked source route changed concurrently');
    if (!changed.active || !isDeepStrictEqual(changed.fixture_plan, encoded)) {
      return yield* fail('The stored source route did not match its source-policy enrollment');
    }
    yield* transaction.execute(sql`insert into symmy_integration.route_enrollment_records
          (change, change_token, legal_entity_id, previous_change_token, previous_revision,
            reason, route_id, route_key, route_revision, stated_operator_ref, tenant_id)
          values ('replace', ${changed.change_token}, ${Option.getOrNull(route.legal_entity_id)}::uuid, ${route.change_token},
            ${route.route_revision}, ${
              route.route_key === 'productsBatch'
                ? 'Stage-approved AKROS AXIS_FREE_UNTYPED Catalog readiness and Inventory source policy enrollment'
                : 'Stage-approved replacement of finite SKU stock enrollment with the Inventory source policy'
            },
            ${route.route_id}::uuid, ${route.route_key}, ${route.route_revision},
            'ontos:stage:akros-symmy:source-policies:v1', ${tenantId}::uuid)`);
    return { outcome: 'REPLACED', routeId: route.route_id };
  });

/** Stage-only, atomic and convergent; requires the existing administrative PgClient layer. */
export const bootstrapSymmyDemoSourcePolicies = Effect.gen(function* bootstrapSourcePolicies() {
  const environment = yield* Config.String('ULTRAMODERN_DEPLOYMENT_ENVIRONMENT');
  yield* requireSymmyDemoStage(environment);
  const enrollmentOwner = yield* Effect.tryPromise({
    catch: () => fail('The native Symmy route enrollment module could not be loaded'),
    try: async () => await import('../../verticals/symmy-integration/src/ops/symmy-route-enrollment.ts'),
  });
  const database = yield* openDatabase;
  return yield* database.transaction((transaction) =>
    Effect.gen(function* bootstrapTransaction() {
      const { enrolled, input, policies } = yield* readDemoSourcePolicyInputs(transaction, enrollmentOwner);
      const { inventory, inventorySource, prices } = yield* establishDemoOwnerPolicies(transaction, input, policies);
      const routeOutcomes = [];
      for (const route of enrolled.filter(
        (row) => row.route_key === 'productsBatch' || row.route_key === 'inventoryStockBatch',
      )) {
        const prepared = yield* prepareDemoSourceRoute(transaction, route, inventorySource, enrollmentOwner);
        routeOutcomes.push(
          yield* prepared.rollover
            ? rolloverDemoStockRoute(transaction, prepared)
            : replaceDemoSourceRoute(transaction, prepared),
        );
      }
      return {
        inventoryOutcome: inventory.outcome,
        inventorySource,
        pricePolicies: prices,
        routes: routeOutcomes,
        stockSourceRetention: symmyDemoStockSourceRetention,
      };
    }),
  );
}).pipe(
  Effect.mapError((failure) =>
    Schema.is(SymmyDemoSourcePolicyFailure)(failure)
      ? failure
      : fail('Symmy demo source policy bootstrap failed; transaction rolled back (credentials withheld)'),
  ),
);

if (import.meta.main) {
  const admin = Layer.unwrap(
    Config.Redacted('DATABASE_ADMIN_URL').pipe(Effect.map((url) => PgClient.layer({ maxConnections: 1, url }))),
  ).pipe(Layer.provide(Reactivity.layer));
  const exit = await Effect.runPromiseExit(
    bootstrapSymmyDemoSourcePolicies.pipe(
      Effect.tap((result) => Console.log(result)),
      Effect.tapError((failure) => Console.error(failure.reason)),
      Effect.provide(Layer.mergeAll(admin, NodeServices.layer, NodeCrypto.layer)),
    ),
  );
  process.exitCode = Exit.isFailure(exit) ? 1 : 0;
}
