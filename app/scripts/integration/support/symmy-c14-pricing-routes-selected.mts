import { bootstrapInternalC14PricingSourceAuthority } from '@app/pricing/testing/c14-source-authority-bootstrap';
import {
  SymmyInternalExecutionPlanSchema,
  SymmyJobLifecyclePolicyRefSchema,
  SymmyRouteExecutionConfigurationSchema,
} from '@app/symmy-integration/symmy-internal-contracts';
import { Effect, Redacted, Schema } from 'effect';

import { SymmyC14ProductFixtureUnavailable } from './symmy-c14-product-runtime.mts';
import type { makeInternalC14PricingRouteFixture } from './symmy-c14-pricing-routes-runtime.mts';
import { internalPricingNativeSourceSystem, internalPricingRouteSource } from './symmy-c14-pricing-routes-plan.mts';
import type { decodeInternalC14SourcePricePlan } from './symmy-c14-pricing-routes-plan.mts';

type Fixture = Effect.Success<ReturnType<typeof makeInternalC14PricingRouteFixture>>;
type PricePlan = Effect.Success<ReturnType<typeof decodeInternalC14SourcePricePlan>>;

/** Operator fixture enrollment pins an existing authoritative source Group, never a caller-selected alias hint. */
export const enrollInternalC14SelectedPriceRoute = Effect.fn('InternalC14PricingRoutes.selectedRoute')(
  function* enrollSelectedPriceRoute(fixture: Fixture, price: PricePlan) {
    const selector = price.payload.identityKey.priceGroupSelector;
    if (selector.kind !== 'PRICE_GROUP') {
      return yield* new SymmyC14ProductFixtureUnavailable({ message: 'The exact selected Price Group is missing' });
    }
    yield* bootstrapInternalC14PricingSourceAuthority({
      grant: price.grant,
      legalEntityId: fixture.legalEntityId,
      operatorPrincipalId: fixture.integration.issuerPrincipalId,
      operatorProviderUserId: fixture.shell.providerUserId,
      ownedDatabase: fixture.isolated,
      purpose: 'implementation-1096-registered-workload-gateway',
      runtimeConnectionString: Redacted.make(fixture.isolated.connections.runtime.connectionString),
      tenantId: fixture.tenantId,
    });
    const encodedPlan = yield* Schema.encodeEffect(SymmyInternalExecutionPlanSchema)(price.plan);
    const configuration = yield* Schema.decodeUnknownEffect(SymmyRouteExecutionConfigurationSchema)({
      ...encodedPlan,
      pricingSourceSystem: internalPricingNativeSourceSystem,
      selector: {
        kind: 'PRICE_GROUP',
        source: {
          entityKind: 'PRICE_GROUP',
          issuerId: internalPricingRouteSource.issuerId,
          route: { integrationRouteId: fixture.sourceRouteId, tenantId: fixture.tenantId },
          sourceNamespace: internalPricingRouteSource.namespace,
          sourceRecordId: fixture.firstRecordId,
        },
        target: selector.priceGroupRef,
      },
      sourceRouteId: fixture.sourceRouteId,
    });
    const planJson = yield* Schema.encodeEffect(Schema.fromJsonString(SymmyRouteExecutionConfigurationSchema))(
      configuration,
    );
    const policyJson = yield* Schema.encodeEffect(Schema.fromJsonString(SymmyJobLifecyclePolicyRefSchema))(
      fixture.lifecyclePolicy,
    );
    yield* fixture.admin`insert into symmy_integration.job_routes(route_id,tenant_id,legal_entity_id,principal_id,active,fixture_ids,fixture_plan,mapping_version,route_key,route_code,route_revision,lifecycle_policy)
      values(${fixture.selectedRouteId},${fixture.tenantId},${fixture.legalEntityId},${fixture.integration.principalId},true,array['INTERNAL_C14'],${planJson}::jsonb,${internalPricingRouteSource.mappingVersion},'priceListPricesBatch',${fixture.firstRecordId},${internalPricingRouteSource.routeRevision},${policyJson}::jsonb)`;
    return yield* Effect.void;
  },
);
