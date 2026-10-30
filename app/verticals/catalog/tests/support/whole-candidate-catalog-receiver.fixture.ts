import {
  ActionRuntime,
  ActionTransactionError,
  ContextAccessLive,
  CorePersistenceLive,
  DatabaseConfig,
  GatewayAssertionRedemptionService,
  GatewayAssertionReplayError,
  ReadRuntimeLive,
  TenantModuleStateServiceLive,
  TrustedPrincipalContextSchema,
  makeActionRuntimeLive,
  parseDatabaseConfig,
  defineDatabaseIdentityEnrollment,
  makeDatabaseIdentityEnrollmentLive,
} from '@app/core-runtime';
import type { ActionRegistration, DomainEventContractMap } from '@app/core-runtime';
import {
  ActionPermissionLive,
  ActionRepositoryLive,
  ModuleEntrypointGatewayLive,
  ModuleStateGateLive,
  OperationalScopeResolverLive,
} from '@app/core-runtime/actions/runtime-wiring';
import {
  ActiveApplicationCompositionSnapshotSchema,
  makeActiveApplicationCompositionLayer,
} from '@app/core-runtime/modules/active-application-composition';
import { ActiveApplicationCompositionSource } from '@app/core-runtime/testing/application-composition-source';
import { staffAuthenticationNamespaceRegistryLayer } from '@app/core-runtime/auth/staff-authentication-namespace';
import { NodeCrypto, NodeHttpServer, NodeRuntime, NodeServices, NodeSink, NodeStream } from '@effect/platform-node';
import { Socket } from 'node:net';
import { HttpApi, HttpApiBuilder, HttpRouter, HttpServer } from '@modern-js/bff-effect/effect-edge';
import {
  ConfigProvider,
  Context,
  Crypto,
  DateTime,
  Deferred,
  Effect,
  Layer,
  Queue,
  Redacted,
  Schema,
  Stream,
} from 'effect';
import { FetchHttpClient, HttpServerRequest, HttpServerResponse } from 'effect/http';

import { ActionPrincipalVerifierLive } from '../../api/auth/action-principal.ts';
import { catalogMediaCurrentReadApiLive } from '../../api/catalog-media-current-read-server.ts';
import { pricingPurposeEquivalenceReadApiLive } from '../../api/pricing-purpose-equivalence-read-server.ts';
import { productVariantSnapshotReadApiLive } from '../../api/product-variant-snapshot-read-server.ts';
import { quantityBasisCompatibilityReadApiLive } from '../../api/quantity-basis-compatibility-read-server.ts';
import { quantityPreparationReadApiLive } from '../../api/quantity-preparation-read-server.ts';
import { selectionEvidenceReadApiLive } from '../../api/selection-evidence-read-server.ts';
import { createProductAction } from '../../src/actions/create-product.action.ts';
import { createAttributeDefinitionAction } from '../../src/actions/create-attribute-definition.action.ts';
import { createProductTypeAction } from '../../src/actions/create-product-type.action.ts';
import { setProductTypeAction } from '../../src/actions/set-product-type.action.ts';
import { createVariantAction } from '../../src/actions/create-variant.action.ts';
import { governProductAttributeApplicabilityAction } from '../../src/actions/govern-product-attribute-applicability.action.ts';
import { setVariantAttributeOverrideAction } from '../../src/actions/set-variant-attribute-override.action.ts';
import { governVariantAxesAction } from '../../src/actions/govern-variant-axes.action.ts';
import { governVariantAllowedValuesAction } from '../../src/actions/govern-variant-allowed-values.action.ts';
import { confirmVariantCombinationAction } from '../../src/actions/confirm-variant-combination.action.ts';
import { setProductLocalizedFactsAction } from '../../src/actions/set-product-localized-facts.action.ts';
import { updateProductAction } from '../../src/actions/update-product.action.ts';
import { publishProductConfigurationAction } from '../../src/actions/publish-product-configuration.action.ts';
import { createProductUnitAction } from '../../src/actions/create-product-unit.action.ts';
import { setProductUnitTargetDivisibilityAction } from '../../src/actions/set-product-unit-target-divisibility.action.ts';
import { createProductCategoryAction } from '../../src/actions/create-product-category.action.ts';
import { addProductCategoryAssignmentAction } from '../../src/actions/add-product-category-assignment.action.ts';
import { reviseProductUnitAction } from '../../src/actions/revise-product-unit.action.ts';
import { executeQuantityPreparationWithAuthorization } from '../../src/api/quantity-preparation-client.ts';
import { CatalogQuantityHandoffReadySchema } from '../../shared/domain/catalog-quantity-handoff.ts';
import { CatalogSelectionSchema } from '../../shared/domain/catalog-selection-evidence.ts';
import { CartOpenSelectionPopulationService } from '../../shared/domain/catalog-open-selection-population.ts';
import { ProductUnitRefSchema } from '../../shared/resources/product-unit.ts';
import { VariantRefSchema } from '../../shared/resources/variant.ts';
import { catalogApi } from '../../shared/api.ts';
import { ultramodernApiMarker, ultramodernDeliveryUnit } from '../../shared/ultramodern-build.ts';

const readOnlyBootstrapType = 'bootstrap-read-only' as const;
const configurationChoiceKey = 'fixture-finish';
const protocolVersion = 'ontos.catalog.whole-candidate.fixture.v1' as const;
const catalogModule = 'commerce.catalog' as const;
const legalEntityIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('LegalEntityId'));
const actionKeySchema = Schema.String.pipe(Schema.brand('ActionKey'));
const reason = 'Observe distinct sample forms for the native whole-candidate acceptance fixture';
const evidenceRefs: readonly [string, ...string[]] = ['TEST:1225:physical-sample-observation'];
const populationToken = 'TEST:1225:owned-empty-open-selection-population';
const nextId = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());

/** Fixed fixture setup catalog only; this never discovers or grants the application catalog. */
export const wholeCandidateCatalogActionKeys = [
  createProductAction.descriptor.actionKey,
  createAttributeDefinitionAction.descriptor.actionKey,
  createProductTypeAction.descriptor.actionKey,
  setProductTypeAction.descriptor.actionKey,
  createVariantAction.descriptor.actionKey,
  governProductAttributeApplicabilityAction.descriptor.actionKey,
  setVariantAttributeOverrideAction.descriptor.actionKey,
  governVariantAxesAction.descriptor.actionKey,
  governVariantAllowedValuesAction.descriptor.actionKey,
  confirmVariantCombinationAction.descriptor.actionKey,
  setProductLocalizedFactsAction.descriptor.actionKey,
  updateProductAction.descriptor.actionKey,
  createProductUnitAction.descriptor.actionKey,
  setProductUnitTargetDivisibilityAction.descriptor.actionKey,
  createProductCategoryAction.descriptor.actionKey,
  addProductCategoryAssignmentAction.descriptor.actionKey,
  reviseProductUnitAction.descriptor.actionKey,
  publishProductConfigurationAction.descriptor.actionKey,
] as const;

const selectionsSchema = Schema.Tuple([CatalogSelectionSchema, CatalogSelectionSchema, CatalogSelectionSchema]);
const unitsSchema = Schema.Tuple([ProductUnitRefSchema, ProductUnitRefSchema, ProductUnitRefSchema]);
export const WholeCandidateCatalogBootstrapSchema = Schema.Struct({
  actor: TrustedPrincipalContextSchema,
  composition: ActiveApplicationCompositionSnapshotSchema,
  databaseName: Schema.String.check(Schema.isPattern(/^ontos_test_[a-z0-9_]+$/u)),
  issuer: Schema.String,
  jwks: Schema.String,
  legalEntityId: legalEntityIdSchema,
  runtimeConnectionString: Schema.RedactedFromValue(Schema.String),
  scheduledConfiguration: Schema.optionalKey(Schema.Literal(true)),
  type: Schema.Literal('bootstrap'),
  version: Schema.Literal(protocolVersion),
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
export const WholeCandidateCatalogReadOnlyBootstrapSchema = Schema.Struct({
  ...WholeCandidateCatalogBootstrapSchema.fields,
  selections: selectionsSchema,
  type: Schema.Literal(readOnlyBootstrapType),
  units: unitsSchema,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
export const WholeCandidateCatalogPrepareSchema = Schema.Struct({
  authorizations: Schema.Tuple([
    Schema.RedactedFromValue(Schema.String),
    Schema.RedactedFromValue(Schema.String),
    Schema.RedactedFromValue(Schema.String),
  ]),
  type: Schema.Literal('prepare'),
  version: Schema.Literal(protocolVersion),
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
export const WholeCandidateCatalogReviseSchema = Schema.Struct({
  expectedRevision: Schema.Int.check(Schema.isGreaterThan(0)),
  type: Schema.Literal('revise-first-unit'),
  version: Schema.Literal(protocolVersion),
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
const StopSchema = Schema.Struct({ type: Schema.Literal('stop'), version: Schema.Literal(protocolVersion) }).annotate({
  parseOptions: { onExcessProperty: 'error' },
});
export const WholeCandidateCatalogCommandSchema = Schema.Union([
  WholeCandidateCatalogBootstrapSchema,
  WholeCandidateCatalogReadOnlyBootstrapSchema,
  WholeCandidateCatalogPrepareSchema,
  WholeCandidateCatalogReviseSchema,
  StopSchema,
]);
const publicFields = {
  actor: TrustedPrincipalContextSchema,
  buildMarker: Schema.String,
  compositionRevision: Schema.String,
  legalEntityId: legalEntityIdSchema,
  port: Schema.Int,
  selections: selectionsSchema,
  units: unitsSchema,
  version: Schema.Literal(protocolVersion),
};
export const WholeCandidateCatalogProducedSchema = Schema.Struct({
  ...publicFields,
  type: Schema.Literal('produced'),
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
export const WholeCandidateCatalogReadySchema = Schema.Struct({
  ...publicFields,
  handoffs: Schema.Tuple([
    CatalogQuantityHandoffReadySchema,
    CatalogQuantityHandoffReadySchema,
    CatalogQuantityHandoffReadySchema,
  ]),
  type: Schema.Literal('ready'),
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
const fixtureFailureReasonCodeSchema = Schema.Literals(['RECEIVING_RELEASE_NOT_APPROVED', 'FIXTURE_UNAVAILABLE']);
export const WholeCandidateCatalogFailureSchema = Schema.Struct({
  reasonCode: fixtureFailureReasonCodeSchema,
  stage: Schema.String,
  type: Schema.Literal('failed'),
  version: Schema.Literal(protocolVersion),
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
export const WholeCandidateCatalogResponseSchema = Schema.Union([
  WholeCandidateCatalogFailureSchema,
  WholeCandidateCatalogProducedSchema,
  WholeCandidateCatalogReadySchema,
  Schema.Struct({
    ruleRevision: Schema.Int,
    type: Schema.Literal('revised'),
    version: Schema.Literal(protocolVersion),
  }),
]);
export const WholeCandidateCatalogDescriptionSchema = Schema.Struct({
  actionKeys: Schema.Array(actionKeySchema),
  appId: Schema.Literal('catalog'),
  buildMarker: Schema.String,
  type: Schema.Literal('description'),
  version: Schema.Literal(protocolVersion),
}).annotate({ parseOptions: { onExcessProperty: 'error' } });

class WholeCandidateCatalogFixtureUnavailable extends Schema.TaggedError<WholeCandidateCatalogFixtureUnavailable>()(
  'WholeCandidateCatalogFixtureUnavailable',
  {
    cause: Schema.optionalKey(Schema.Redacted(Schema.Defect())),
    reasonCode: fixtureFailureReasonCodeSchema,
    stage: Schema.String,
  },
) {}
const unavailable = (stage: string, cause?: unknown) =>
  new WholeCandidateCatalogFixtureUnavailable({
    cause: Redacted.make(cause),
    reasonCode:
      Schema.is(ActionTransactionError)(cause) &&
      cause.reason === 'The receiving owner release is not approved by the active Application Composition'
        ? 'RECEIVING_RELEASE_NOT_APPROVED'
        : 'FIXTURE_UNAVAILABLE',
    stage,
  });
const demand = (condition: boolean, stage: string) => (condition ? Effect.void : Effect.fail(unavailable(stage)));

/** Public production layers on the parent's native identity and owned DB; no fixture setup or lock override. */
const wholeCandidateCatalogRuntime = (bootstrap: Omit<typeof WholeCandidateCatalogBootstrapSchema.Type, 'type'>) => {
  const databaseConfig = Layer.effect(
    DatabaseConfig,
    parseDatabaseConfig({ DATABASE_URL: Redacted.value(bootstrap.runtimeConnectionString) }),
  );
  const persistence = CorePersistenceLive.pipe(Layer.provide(databaseConfig));
  const states = TenantModuleStateServiceLive.pipe(Layer.provide(persistence));
  const stateGate = ModuleStateGateLive.pipe(Layer.provide(states));
  const gateway = ModuleEntrypointGatewayLive.pipe(Layer.provide(stateGate));
  const scopes = OperationalScopeResolverLive.pipe(Layer.provide(Layer.mergeAll(persistence, ContextAccessLive)));
  const namespace = staffAuthenticationNamespaceRegistryLayer(['catalog']);
  const composition = makeActiveApplicationCompositionLayer(Effect.succeed(bootstrap.composition));
  const common = Layer.mergeAll(persistence, ContextAccessLive, stateGate, gateway, scopes, namespace, composition);
  const actions = makeActionRuntimeLive(ultramodernDeliveryUnit).pipe(
    Layer.provide(Layer.mergeAll(common, ActionRepositoryLive, ActionPermissionLive)),
    Layer.provide(NodeCrypto.layer),
  );
  const reads = ReadRuntimeLive.pipe(Layer.provide(common), Layer.provide(NodeCrypto.layer));
  return Layer.mergeAll(actions, reads, namespace);
};

const runOwnerAction = <
  Payload extends Schema.ConstraintDecoder<unknown>,
  Result extends Schema.ConstraintDecoder<unknown>,
  DomainError extends Schema.ConstraintDecoder<{ readonly _tag: string }>,
  Events extends DomainEventContractMap,
  Owner extends string,
  Services,
  Requirements,
>(
  registration: ActionRegistration<Payload, Result, DomainError, Events, Owner, Services, Requirements>,
  payload: NoInfer<Payload['Encoded']>,
  actor: typeof TrustedPrincipalContextSchema.Type,
) =>
  Effect.gen(function* runCatalogProducer() {
    const runtime = yield* ActionRuntime;
    return yield* runtime
      .runAction({
        audience: 'catalog',
        payload,
        principal: actor,
        registration,
        transport: { correlationId: yield* nextId, idempotencyKey: yield* nextId, targetModuleKey: catalogModule },
      })
      .pipe(Effect.mapError((cause) => unavailable(registration.descriptor.actionKey, cause)));
  });

const produceProduct = Effect.fn('WholeCandidateCatalog.produceProduct')(function* produceProduct(
  actor: typeof TrustedPrincipalContextSchema.Type,
  suffix: string,
  scheduledConfiguration: boolean | undefined = false,
) {
  const created = yield* runOwnerAction(createProductAction, { name: `Observed sample ${suffix}`, reason }, actor);
  const { productRef } = created.product;
  const first = yield* Schema.decodeUnknownEffect(VariantRefSchema)({
    moduleId: catalogModule,
    resourceId: created.variantId,
    resourceType: 'commerce.catalog.variant',
    tenantId: actor.tenantId,
  });
  const definition = yield* runOwnerAction(
    createAttributeDefinitionAction,
    {
      label: `Sample finish ${suffix}`,
      levels: ['VARIANT'],
      meaning: 'Observed physical finish distinguishing concrete forms',
      multiplicity: 'SINGLE',
      reason,
      specialStates: [],
      valueKind: 'TEXT',
    },
    actor,
  );
  const productType = yield* runOwnerAction(
    createProductTypeAction,
    {
      name: `Sample type ${suffix}`,
      reason,
      rules: [{ attributeDefinitionRef: definition.attributeDefinitionRef, level: 'VARIANT', required: true }],
    },
    actor,
  );
  const assigned = yield* runOwnerAction(
    setProductTypeAction,
    {
      expectedProductRevision: created.product.revision,
      impactBasis: populationToken,
      nextProductTypeRef: productType.productTypeRef,
      productRef,
      reason,
    },
    actor,
  );
  const second = yield* Schema.decodeUnknownEffect(VariantRefSchema)({ ...first, resourceId: yield* nextId });
  yield* runOwnerAction(
    createVariantAction,
    {
      classification: {
        affectsOpenSelection: true,
        evidenceRefs,
        kind: 'NEW_REALIZATION',
        newVariantRef: second,
        productRef,
        reason,
      },
      evidenceRefs,
      expectedProductRevision: assigned.revision,
      productRef,
      reason,
      variantRef: second,
    },
    actor,
  );
  yield* runOwnerAction(
    governProductAttributeApplicabilityAction,
    {
      attributeDefinitionRef: definition.attributeDefinitionRef,
      expectedRevision: null,
      productLevel: false,
      productRef,
      reason,
      variantLevel: true,
    },
    actor,
  );
  for (const [variantRef, text] of [
    [first, 'matte'],
    [second, 'gloss'],
  ] as const) {
    yield* runOwnerAction(
      setVariantAttributeOverrideAction,
      {
        attributeDefinitionRef: definition.attributeDefinitionRef,
        classification: { evidenceRefs, kind: 'NON_MATERIAL', reason },
        expectedRevision: null,
        productRef,
        reason,
        values: [{ kind: 'TEXT', text }],
        variantRef,
      },
      actor,
    );
  }
  yield* runOwnerAction(
    governVariantAxesAction,
    {
      axes: [
        {
          attributeDefinitionRef: definition.attributeDefinitionRef,
          definitionRevision: definition.revision,
          expectedAllowanceRevision: 0,
        },
      ],
      classification: { evidenceRefs, kind: 'AXIS_ADDITION', reason },
      expectedAxisRevision: 0,
      productRef,
      reason,
    },
    actor,
  );
  yield* runOwnerAction(
    governVariantAllowedValuesAction,
    {
      attributeDefinitionRef: definition.attributeDefinitionRef,
      definitionRevision: definition.revision,
      evidenceRefs,
      expectedAllowanceRevision: 0,
      expectedAxisRevision: 1,
      productRef,
      reason,
      values: [
        { kind: 'TEXT', text: 'matte' },
        { kind: 'TEXT', text: 'gloss' },
      ],
    },
    actor,
  );
  for (const variantRef of [first, second]) {
    yield* runOwnerAction(
      confirmVariantCombinationAction,
      { evidenceRefs, expectedAxisRevision: 1, expectedVariantRevision: 1, productRef, reason, variantRef },
      actor,
    );
  }
  yield* runOwnerAction(
    setProductLocalizedFactsAction,
    {
      evidenceRefs,
      expectedRevision: 0,
      facts: { name: `Observed sample ${suffix}` },
      locale: 'en',
      productRef,
      reason,
    },
    actor,
  );
  const activated = yield* runOwnerAction(
    updateProductAction,
    { expectedRevision: assigned.revision, productRef, reason, targetLifecycle: 'ACTIVE' },
    actor,
  );
  const unitRef = yield* Schema.decodeUnknownEffect(ProductUnitRefSchema)({
    moduleId: catalogModule,
    resourceId: yield* nextId,
    resourceType: 'commerce.catalog.product-unit',
    tenantId: actor.tenantId,
  });
  yield* runOwnerAction(
    createProductUnitAction,
    {
      code: `sample-${yield* nextId}`,
      evidenceRefs,
      label: 'Sample piece',
      reason,
      rule: { rounding: 'UP', step: '1' },
      unitRef,
    },
    actor,
  );
  for (const variantRef of [first, second]) {
    yield* runOwnerAction(
      setProductUnitTargetDivisibilityAction,
      {
        divisible: false,
        evidenceRefs,
        expectedSources: {
          product: { resourceRef: productRef, revision: activated.product.revision },
          variant: { resourceRef: variantRef, revision: 2 },
        },
        reason,
        target: {
          targetId: variantRef.resourceId,
          targetType: 'commerce.catalog.variant',
          tenantId: actor.tenantId,
          unit: unitRef,
        },
      },
      actor,
    );
  }
  const category = yield* runOwnerAction(
    createProductCategoryAction,
    { name: `Observed sample category ${suffix}`, reason },
    actor,
  );
  yield* runOwnerAction(
    addProductCategoryAssignmentAction,
    { categoryRef: category.category.categoryRef, productRef, reason },
    actor,
  );
  if (!scheduledConfiguration) {
    return {
      first: yield* Schema.decodeUnknownEffect(CatalogSelectionSchema)({ productRef, variantRef: first }),
      second: yield* Schema.decodeUnknownEffect(CatalogSelectionSchema)({ productRef, variantRef: second }),
      unitRef,
    };
  }
  // A real scheduled successor closes the Current interval; no validity is added to owner evidence.
  const definitionId = yield* nextId;
  const effectiveFrom = yield* DateTime.now;
  const publication = {
    choices: [
      {
        choiceKey: configurationChoiceKey,
        kind: 'SINGLE_CHOICE' as const,
        label: 'Recorded finish',
        meaning: 'Recorded sample finish',
        options: [{ label: 'Standard', meaning: 'Standard finish', optionKey: 'standard' }],
        required: true,
      },
    ],
    compatibilityRules: [],
    definitionId,
    evidenceRefs,
    measuredRules: [],
    optionAllowances: [{ allowed: true, choiceKey: configurationChoiceKey, evidenceRefs, optionKey: 'standard' }],
    productId: productRef.resourceId,
    reason,
  };
  const current = yield* runOwnerAction(
    publishProductConfigurationAction,
    { ...publication, effectiveFrom: DateTime.toDateUtc(effectiveFrom), expectedRevision: 0 },
    actor,
  );
  yield* runOwnerAction(
    publishProductConfigurationAction,
    {
      ...publication,
      effectiveFrom: DateTime.toDateUtc(DateTime.add(effectiveFrom, { hours: 1 })),
      expectedRevision: current.revision,
    },
    actor,
  );
  const selectionFor = (variantRef: typeof first) =>
    Schema.decodeUnknownEffect(CatalogSelectionSchema)({
      configuration: {
        choices: [{ choiceKey: configurationChoiceKey, value: 'standard' }],
        definition: {
          resourceRef: {
            moduleId: catalogModule,
            resourceId: current.definitionId,
            resourceType: 'commerce.catalog.configuration-definition',
            tenantId: actor.tenantId,
          },
          revision: current.revision,
        },
        productRef,
        variantRef,
      },
      productRef,
      variantRef,
    });
  return { first: yield* selectionFor(first), second: yield* selectionFor(second), unitRef };
});

const serveCatalog = Effect.fn('WholeCandidateCatalog.serve')(function* serveCatalog(
  bootstrap:
    | typeof WholeCandidateCatalogBootstrapSchema.Type
    | typeof WholeCandidateCatalogReadOnlyBootstrapSchema.Type,
  send: (
    response: typeof WholeCandidateCatalogResponseSchema.Type,
  ) => Effect.Effect<void, WholeCandidateCatalogFixtureUnavailable>,
) {
  const database = yield* Schema.decodeEffect(Schema.URLFromString)(Redacted.value(bootstrap.runtimeConnectionString));
  yield* demand(
    ['127.0.0.1', 'localhost'].includes(database.hostname) &&
      database.pathname === `/${bootstrap.databaseName}` &&
      database.username !== 'postgres',
    'owned-runtime-address',
  );
  yield* demand(bootstrap.actor.legalEntityId === undefined, 'producer-tenant-only-context');
  const runtime = wholeCandidateCatalogRuntime(bootstrap);
  const population = Layer.succeed(CartOpenSelectionPopulationService, {
    read: () =>
      Effect.succeed({
        complete: true,
        observedAt: DateTime.formatIso(bootstrap.composition.observedAt),
        revisionToken: populationToken,
        selections: [],
        tenantId: bootstrap.actor.tenantId,
      }),
  });
  const runtimeContext = yield* Layer.build(Layer.mergeAll(runtime, population));
  const products =
    bootstrap.type === readOnlyBootstrapType
      ? ([
          { first: bootstrap.selections[0], second: bootstrap.selections[1], unitRef: bootstrap.units[0] },
          { first: bootstrap.selections[2], second: bootstrap.selections[2], unitRef: bootstrap.units[2] },
        ] as const)
      : yield* Effect.all(
          [
            produceProduct(bootstrap.actor, 'P', bootstrap.scheduledConfiguration),
            produceProduct(bootstrap.actor, 'Q', bootstrap.scheduledConfiguration),
          ],
          {
            concurrency: 1,
          },
        ).pipe(Effect.provideContext(runtimeContext), Effect.provide(population));
  const [p, q] = products;
  yield* demand(p !== undefined && q !== undefined, 'product-sequence');
  if (p === undefined || q === undefined) {
    return yield* unavailable('product-sequence');
  }
  const redeemed = new Set<string>();
  const redemption = Layer.succeed(GatewayAssertionRedemptionService, {
    consume: ({ jti }) =>
      Effect.suspend(() => {
        if (redeemed.has(jti)) {
          return Effect.fail(new GatewayAssertionReplayError({ reason: 'TEST single-use Catalog assertion' }));
        }
        redeemed.add(jti);
        return Effect.void;
      }),
  });
  const encodedComposition = yield* Schema.encodeEffect(
    Schema.fromJsonString(ActiveApplicationCompositionSnapshotSchema),
  )(bootstrap.composition);
  const compositionSource = Layer.succeed(ActiveApplicationCompositionSource, {
    load: Effect.succeed(encodedComposition),
  });
  const handlers = Layer.mergeAll(
    productVariantSnapshotReadApiLive,
    selectionEvidenceReadApiLive,
    quantityPreparationReadApiLive,
    pricingPurposeEquivalenceReadApiLive,
    quantityBasisCompatibilityReadApiLive,
    catalogMediaCurrentReadApiLive,
  ).pipe(
    Layer.provide(
      ActionPrincipalVerifierLive.pipe(
        Layer.provide(makeActiveApplicationCompositionLayer(Effect.succeed(bootstrap.composition))),
      ),
    ),
    Layer.provide(compositionSource),
    Layer.provide(redemption),
    Layer.provide(Layer.succeedContext(runtimeContext)),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          ONTOS_GATEWAY_ISSUER: bootstrap.issuer,
          ONTOS_GATEWAY_PUBLIC_JWKS: bootstrap.jwks,
        }),
      ),
    ),
  );
  const app = yield* Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        HttpApiBuilder.layer(
          HttpApi.make('CatalogApi')
            .add(catalogApi.groups.productVariantSnapshot)
            .add(catalogApi.groups.selectionEvidence)
            .add(catalogApi.groups.quantityPreparation)
            .add(catalogApi.groups.pricingPurposeEquivalence)
            .add(catalogApi.groups.quantityBasisCompatibility)
            .add(catalogApi.groups.catalogMediaCurrent),
        ).pipe(
          Layer.provide(handlers),
          Layer.provide(HttpServer.layerServices),
          Layer.provide(NodeServices.layer),
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(NodeCrypto.layer),
        ),
        { disableLogger: true },
      ),
    ),
    (value) => Effect.promise(value.dispose.bind(value)).pipe(Effect.orDie),
  );
  const serverContext = yield* Layer.build(NodeHttpServer.layerTest);
  const server = Context.get(serverContext, HttpServer.HttpServer);
  const emptyContext = Context.makeUnsafe<unknown>(new Map());
  yield* server.serve(
    Effect.gen(function* forwardCatalogHttp() {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const web = yield* HttpServerRequest.toWeb(request);
      const response = yield* Effect.tryPromise({
        catch: (cause) => unavailable('http-adapter', cause),
        try: async () => await app.handler(web, emptyContext),
      });
      return HttpServerResponse.fromWeb(response);
    }),
  );
  const address = yield* Schema.decodeUnknownEffect(Schema.Struct({ port: Schema.Int }))(server.address);
  const fields = {
    actor: bootstrap.actor,
    buildMarker: ultramodernApiMarker.buildMarker,
    compositionRevision: bootstrap.composition.composition.revision,
    legalEntityId: bootstrap.legalEntityId,
    port: address.port,
    selections: [p.first, p.second, q.first] as const,
    units: [p.unitRef, p.unitRef, q.unitRef] as const,
    version: protocolVersion,
  };
  return {
    fields,
    prepare: Effect.fn('WholeCandidateCatalog.prepare')(function* prepare(
      command: typeof WholeCandidateCatalogPrepareSchema.Type,
    ) {
      const handoffs = yield* Effect.forEach(
        fields.selections,
        (selection, index) =>
          Effect.gen(function* preparePublicHandoff() {
            const authorization = command.authorizations[index];
            if (authorization === undefined) {
              return yield* unavailable('prepare-credential-count');
            }
            return yield* executeQuantityPreparationWithAuthorization(
              { amount: '1', purpose: 'PRICING', selection },
              Redacted.value(authorization),
              yield* nextId,
              { baseUrl: new URL(`http://127.0.0.1:${fields.port}`), compositionRevision: fields.compositionRevision },
            );
          }),
        { concurrency: 1 },
      );
      const exact = yield* Schema.decodeUnknownEffect(
        Schema.Tuple([
          CatalogQuantityHandoffReadySchema,
          CatalogQuantityHandoffReadySchema,
          CatalogQuantityHandoffReadySchema,
        ]),
      )(handoffs);
      return { ...fields, handoffs: exact, type: 'ready' as const };
    }),
    revise: (expectedRevision: number) =>
      runOwnerAction(
        reviseProductUnitAction,
        {
          evidenceRefs,
          expectedCurrent: { revision: expectedRevision, unit: p.unitRef },
          reason: 'Explicitly revise only the first Product Unit rule for final-fence currentness proof',
          rule: { rounding: 'UP', step: '0.5' },
        },
        bootstrap.actor,
      ).pipe(Effect.provideContext(runtimeContext)),
    send,
  };
});

const childProgram = Effect.gen(function* wholeCandidateCatalogChild() {
  // Additional stdio descriptors are socket pairs. Blocking fs reads/writes on them occupy libuv
  // threadpool workers that keep the process alive after exit until the parent closes its end,
  // while the parent waits for this exit before closing it.
  const output = yield* Effect.acquireRelease(
    Effect.sync(() => new Socket({ fd: 3, readable: false, writable: true })),
    (socket) => Effect.sync(() => socket.destroy()),
  );
  const send = (response: typeof WholeCandidateCatalogResponseSchema.Type) =>
    Schema.encodeEffect(Schema.fromJsonString(WholeCandidateCatalogResponseSchema))(response).pipe(
      Effect.flatMap((line) =>
        Stream.make(`${line}\n`).pipe(
          Stream.run(
            NodeSink.fromWritable({
              endOnDone: false,
              evaluate: () => output,
              onError: () => unavailable('response-stream-failed'),
            }),
          ),
        ),
      ),
      Effect.mapError((cause) => unavailable('private-response', cause)),
    );
  return yield* Effect.gen(function* receiveCatalogCommands() {
    const commands = yield* Queue.unbounded<typeof WholeCandidateCatalogCommandSchema.Type>();
    const commandFailure = yield* Deferred.make<never, WholeCandidateCatalogFixtureUnavailable>();
    const nextCommand = () => Effect.raceFirst(Queue.take(commands), Deferred.await(commandFailure));
    // Use the inherited descriptor directly; reopening /dev/fd/4 fails ENXIO on Linux.
    const input = yield* Effect.acquireRelease(
      Effect.sync(() => new Socket({ fd: 4, readable: true, writable: false })),
      (socket) => Effect.sync(() => socket.destroy()),
    );
    yield* NodeStream.fromReadable({
      closeOnDone: false,
      evaluate: () => input,
      onError: () => unavailable('command-stream-failed'),
    }).pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.filter((line) => line.length > 0),
      Stream.mapEffect((line) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(WholeCandidateCatalogCommandSchema), {
          onExcessProperty: 'error',
        })(line),
      ),
      Stream.runForEach((command) => Queue.offer(commands, command)),
      Effect.catch(() => Deferred.fail(commandFailure, unavailable('command-codec-or-stream-failed'))),
      Effect.forkScoped,
    );
    const first = yield* nextCommand();
    if (first.type !== 'bootstrap' && first.type !== readOnlyBootstrapType) {
      return yield* unavailable('bootstrap-order');
    }
    const receiver = yield* serveCatalog(first, send);
    yield* receiver.send({ ...receiver.fields, type: 'produced' });
    if (first.type === readOnlyBootstrapType) {
      yield* demand((yield* nextCommand()).type === 'stop', 'read-only-stop-required');
      return yield* Effect.void;
    }
    const prepare = yield* nextCommand();
    if (prepare.type !== 'prepare') {
      return yield* unavailable('prepare-order');
    }
    yield* receiver.send(yield* receiver.prepare(prepare));
    let stopped = false;
    while (!stopped) {
      const command = yield* nextCommand();
      if (command.type === 'revise-first-unit') {
        const result = yield* receiver.revise(command.expectedRevision);
        yield* receiver.send({ ruleRevision: result.ruleRevision.revision, type: 'revised', version: protocolVersion });
      } else if (command.type === 'stop') {
        stopped = true;
      } else {
        return yield* unavailable('unsupported-command-order');
      }
    }
    return yield* Effect.void;
  }).pipe(
    Effect.catch((error) =>
      send({
        reasonCode: Schema.is(WholeCandidateCatalogFixtureUnavailable)(error)
          ? error.reasonCode
          : 'FIXTURE_UNAVAILABLE',
        stage: Schema.is(WholeCandidateCatalogFixtureUnavailable)(error) ? error.stage : 'owned-catalog-child',
        type: 'failed',
        version: protocolVersion,
      }),
    ),
  );
});
const services = NodeServices.layer.pipe(
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(FetchHttpClient.layer),
  Layer.provideMerge(makeDatabaseIdentityEnrollmentLive(defineDatabaseIdentityEnrollment([]))),
);
if (process.argv.includes('--describe-whole-candidate')) {
  NodeRuntime.runMain(
    Schema.encodeEffect(Schema.fromJsonString(WholeCandidateCatalogDescriptionSchema))({
      actionKeys: wholeCandidateCatalogActionKeys.map((actionKey) => actionKeySchema.make(actionKey)),
      appId: 'catalog',
      buildMarker: ultramodernApiMarker.buildMarker,
      type: 'description',
      version: protocolVersion,
    }).pipe(
      Effect.flatMap((line) => Effect.sync(() => process.stdout.write(`${line}\n`))),
      Effect.provide(services),
    ),
  );
}
if (process.argv.includes('--serve-whole-candidate')) {
  NodeRuntime.runMain(
    childProgram.pipe(
      Effect.mapError((cause) =>
        unavailable(Schema.is(WholeCandidateCatalogFixtureUnavailable)(cause) ? cause.stage : 'owned-catalog-child'),
      ),
      Effect.scoped,
      Effect.provide(services),
    ),
  );
}
