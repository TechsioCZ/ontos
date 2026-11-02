import { randomUUID } from 'node:crypto';
import { readSync, writeSync } from 'node:fs';
import { inspect } from 'node:util';

import { parseDatabaseConfig } from '@app/core-runtime';
import { NodeHttpServer, NodeRuntime } from '@effect/platform-node';
import { Clock, Config, Effect, Exit, Layer, Redacted, Schema, Tracer } from 'effect';
import { defineEffectBff } from '@modern-js/bff-effect/effect-edge';
import { HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/http';

import { executeAddProductCategoryAssignmentWithAuthorization } from '../../src/api/add-product-category-assignment-action-client.ts';
import { executePublishProductConfigurationWithAuthorization } from '../../src/api/publish-product-configuration-action-client.ts';
import { executeCreateProductCategoryWithAuthorization } from '../../src/api/create-product-category-action-client.ts';
import { executeCreateProductWithAuthorization } from '../../src/api/create-product-action-client.ts';
import { executeConfirmVariantCombinationWithAuthorization } from '../../src/api/confirm-variant-combination-action-client.ts';
import { executeCreateAttributeDefinitionWithAuthorization } from '../../src/api/create-attribute-definition-action-client.ts';
import { executeCreateProductTypeWithAuthorization } from '../../src/api/create-product-type-action-client.ts';
import { executeGovernProductAttributeApplicabilityWithAuthorization } from '../../src/api/govern-product-attribute-applicability-action-client.ts';
import { executeGovernVariantAllowedValuesWithAuthorization } from '../../src/api/govern-variant-allowed-values-action-client.ts';
import { executeGovernVariantAxesWithAuthorization } from '../../src/api/govern-variant-axes-action-client.ts';
import { executeSetProductTypeWithAuthorization } from '../../src/api/set-product-type-action-client.ts';
import { executeSetVariantAttributeOverrideWithAuthorization } from '../../src/api/set-variant-attribute-override-action-client.ts';
import { executeCreateProductUnitWithAuthorization } from '../../src/api/create-product-unit-action-client.ts';
import { executeQuantityPreparationWithAuthorization } from '../../src/api/quantity-preparation-client.ts';
import { executeSetProductLocalizedFactsWithAuthorization } from '../../src/api/set-product-localized-facts-action-client.ts';
import { executeSetProductUnitTargetDivisibilityWithAuthorization } from '../../src/api/set-product-unit-target-divisibility-action-client.ts';
import { executeUpdateProductWithAuthorization } from '../../src/api/update-product-action-client.ts';
import { executeVariantHistoryWithAuthorization } from '../../src/api/variant-history-client.ts';
import { PublishProductConfigurationPayloadSchema } from '../../shared/actions/publish-product-configuration.ts';
import { CatalogRevisionNumberSchema } from '../../shared/domain/catalog-revision-reference.ts';
import { ProductConfigurationSelectionSchema } from '@app/catalog-selection-contracts/catalog-selection';
import { ProductUnitRefSchema } from '../../shared/resources/product-unit.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';

const catalogModule = 'commerce.catalog' as const;
const protocol = 'ontos.catalog.preproposal-basis.receiver.v1' as const;
const producerProtocol = 'ontos.catalog.preproposal-basis.producer.v1' as const;
const producerSteps = [
  'createProduct',
  'variantCreatedHistory',
  'createAttributeDefinition',
  'createProductType',
  'setProductType',
  'governApplicability',
  'setVariantOverride',
  'governAxes',
  'governAllowedValues',
  'confirmCombination',
  'createUnit',
  'localizedFacts',
  'activateProduct',
  'variantActivatedHistory',
  'setDivisibility',
  'createCategory',
  'assignCategory',
  'publishConfigurationCurrent',
  'publishConfigurationSuccessor',
  'pricingQuantityPreparation',
  'quantityPreparation',
] as const;
type ProducerStep = (typeof producerSteps)[number];
const assertion = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32_768));
const producerInputSchema = Schema.Struct({
  baseUrl: Schema.String.check(
    Schema.isPattern(/^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):[1-9][0-9]{0,4}\/catalog-api$/u),
  ),
  compositionRevision: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
  credentials: Schema.Struct({
    activateProduct: assertion,
    assignCategory: assertion,
    confirmCombination: assertion,
    createAttributeDefinition: assertion,
    createCategory: assertion,
    createProduct: assertion,
    createProductType: assertion,
    createUnit: assertion,
    governAllowedValues: assertion,
    governApplicability: assertion,
    governAxes: assertion,
    localizedFacts: assertion,
    pricingQuantityPreparation: assertion,
    publishConfigurationCurrent: assertion,
    publishConfigurationSuccessor: assertion,
    quantityPreparation: assertion,
    setDivisibility: assertion,
    setProductType: assertion,
    setVariantOverride: assertion,
    variantActivatedHistory: assertion,
    variantCreatedHistory: assertion,
  })
    .check(
      Schema.makeFilter((credentials) =>
        new Set(Object.values(credentials)).size === producerSteps.length
          ? undefined
          : 'Each fixed operation requires a distinct assertion',
      ),
    )
    .annotate({ parseOptions: { onExcessProperty: 'error' } }),
  impactBasis: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  protocol: Schema.Literal(producerProtocol),
  runKey: Schema.String.check(Schema.isPattern(/^[a-z0-9-]{1,64}$/u)).pipe(Schema.brand('PreproposalCatalogRunKey')),
  tenantId: ProductUnitRefSchema.fields.tenantId,
  unitId: ProductUnitRefSchema.fields.resourceId,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });

class PreproposalCatalogReceiverUnavailable extends Schema.TaggedError<PreproposalCatalogReceiverUnavailable>()(
  'PreproposalCatalogReceiverUnavailable',
  { stage: Schema.String },
) {}

const unavailable = (stage: string) => new PreproposalCatalogReceiverUnavailable({ stage });

const isolatedRuntimeDatabase = Effect.gen(function* isolatedCatalogRuntimeDatabase() {
  const connection = yield* Config.Redacted('DATABASE_URL');
  const database = yield* parseDatabaseConfig({ DATABASE_URL: Redacted.value(connection) });
  if (
    !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(database.host) ||
    !/^ontos_test_[a-z0-9_]+$/u.test(database.database) ||
    database.user !== 'ontos_runtime'
  ) {
    yield* unavailable('isolated-runtime-database');
  }
});

const describe = Effect.sync(() =>
  process.stdout.write(
    `${JSON.stringify({
      marker: ultramodernApiMarker,
      operations: [
        'registered-product-unit-variant-actions',
        'quantity-preparation',
        'selection-evidence',
        'cart-population-client',
      ],
      producer: {
        flag: '--produce-preproposal-basis',
        inputFd: 4,
        outputFd: 3,
        protocol: producerProtocol,
        steps: producerSteps,
      },
      protocol,
      type: 'description',
    })}\n`,
  ),
);

/**
 * Closed owner executable: all handlers, registration, policies and persistence stay in Catalog.
 * The parent supplies its isolated runtime configuration and uses published HTTP clients only. Catalog keeps its real Cart population client.
 * No business setup, assertion substitution or grant override is installed by this receiver.
 */
const serve = Effect.scoped(
  Effect.gen(function* servePreproposalCatalog() {
    yield* isolatedRuntimeDatabase;
    // Importing this fixture or describing its protocol never constructs the owner runtime.
    const { default: apiRuntime } = yield* Effect.tryPromise({
      catch: () => unavailable('owner-runtime-import'),
      try: async () => await import('../../api/index.ts'),
    });
    let observedBytes = 0;
    const failureTracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options);
        const end = span.end.bind(span);
        span.end = (endTime, exit) => {
          end(endTime, exit);
          if (Exit.isSuccess(exit) || observedBytes > 0) {
            return;
          }
          const text = `span-failure ${span.name}\n${inspect(exit.cause, { depth: 7, maxStringLength: 400 })}`
            .replaceAll(/eyJ[\w-]+\.[\w-]+\.[\w-]+/gu, '[REDACTED]')
            .replaceAll(/(?<scheme>\w+:\/\/)[^\s/@]+:[^\s/@]+@/gu, '$<scheme>[REDACTED]@')
            .slice(0, 6144);
          observedBytes += text.length;
          process.stderr.write(`${text}\n`);
        };
        return span;
      },
    });
    const observed = defineEffectBff({
      ...apiRuntime,
      layer: apiRuntime.layer.pipe(Layer.provide(Layer.succeed(Tracer.Tracer, failureTracer))),
    });
    const handler = yield* Effect.acquireRelease(
      Effect.sync(() => observed.createHandler()),
      (runtime) => Effect.promise(async () => await runtime.dispose()),
    );
    const server = yield* HttpServer.HttpServer;
    yield* server.serve(
      Effect.gen(function* forwardPublicCatalogRequest() {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const web = yield* HttpServerRequest.toWeb(request);
        const response = yield* Effect.tryPromise({
          catch: () => unavailable('owner-http-adapter'),
          try: async () => await handler.handler(web),
        });
        return HttpServerResponse.fromWeb(response);
      }),
    );
    const address = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ port: Schema.Int.check(Schema.isGreaterThan(0)) }),
    )(server.address);
    yield* Effect.sync(() =>
      process.stdout.write(
        `${JSON.stringify({ marker: ultramodernApiMarker, port: address.port, protocol, type: 'ready' })}\n`,
      ),
    );
    return yield* Effect.never;
  }),
);

let pendingInput = '';
/** Blocking, line-framed read of the private input fd; the parent keeps the fd open for grant acknowledgements. */
const readPrivateLine = () => {
  const chunk = Buffer.alloc(65_536);
  for (;;) {
    const newline = pendingInput.indexOf('\n');
    if (newline !== -1) {
      const line = pendingInput.slice(0, newline);
      pendingInput = pendingInput.slice(newline + 1);
      return line;
    }
    const bytes = readSync(4, chunk, 0, chunk.length, null);
    if (bytes === 0) {
      throw new Error('private input closed');
    }
    pendingInput += chunk.subarray(0, bytes).toString('utf-8');
  }
};

/** One fixed owner process, never imported by a foreign deployment. Secrets enter only on fd4. */
const produce = Effect.gen(function* producePreproposalCatalogBasis() {
  const input = yield* Effect.try({
    catch: () => unavailable('producer-input-fd'),
    try: readPrivateLine,
  }).pipe(
    Effect.flatMap(
      Schema.decodeUnknownEffect(Schema.fromJsonString(producerInputSchema), { onExcessProperty: 'error' }),
    ),
    Effect.mapError(() => unavailable('producer-input-schema')),
  );
  yield* isolatedRuntimeDatabase;
  const options = { baseUrl: input.baseUrl, compositionRevision: input.compositionRevision };
  const reason = 'Native preproposal proof: one Catalog-owned simple purchase target';
  const evidenceRefs: readonly [string, ...string[]] = [`preproposal-native:${input.runKey}`];
  const provenance: { idempotencyKey?: string; requestCorrelation: string; step: ProducerStep }[] = [];
  // Server-generated Catalog resources carry no creator grant; the parent owns the Core fixture and seeds it.
  const requestGrants = (resources: readonly { moduleId: string; resourceId: string; resourceType: string }[]) =>
    Effect.try({
      catch: () => unavailable('grant-handshake'),
      try: () => {
        writeSync(
          3,
          `${JSON.stringify({
            protocol: producerProtocol,
            resources: resources.map(({ moduleId, resourceId, resourceType }) => ({
              moduleId,
              resourceId,
              resourceType,
            })),
            type: 'grant',
          })}\n`,
        );
        if (readPrivateLine() !== 'ack-grant-v1') {
          throw new Error('grant not acknowledged');
        }
      },
    });
  const correlation = (step: ProducerStep) => `catalog-native:${input.runKey}:${step}`;
  const actionOptions = (step: ProducerStep) => ({ ...options, idempotencyKey: correlation(step) });
  const credential = (step: ProducerStep) => input.credentials[step];
  const record = <Success, Failure, Requirements>(
    step: ProducerStep,
    operation: Effect.Effect<Success, Failure, Requirements>,
    write = false,
  ) =>
    operation.pipe(
      Effect.mapError((failure) => {
        process.stderr.write(
          `producer-step-failure ${step}: ${inspect(failure, { depth: 5, maxStringLength: 2048 })
            .replaceAll(/eyJ[\w-]+\.[\w-]+\.[\w-]+/gu, '[REDACTED]')
            .replaceAll(/(?<field>Bearer\s+)\S+/gu, '$<field>[REDACTED]')
            .slice(0, 6144)}\n`,
        );
        return unavailable(step);
      }),
      Effect.tap(() =>
        Effect.sync(() => {
          const call: (typeof provenance)[number] = { requestCorrelation: correlation(step), step };
          if (write) {
            call.idempotencyKey = correlation(step);
          }
          provenance.push(call);
        }),
      ),
    );
  const created = yield* record(
    'createProduct',
    executeCreateProductWithAuthorization(
      { name: 'Native preproposal proof product', reason },
      credential('createProduct'),
      correlation('createProduct'),
      actionOptions('createProduct'),
    ),
    true,
  );
  const initialVariant = created.product.variants.find(({ variantId }) => variantId === created.variantId);
  if (created.product.productRef.tenantId !== input.tenantId || initialVariant === undefined) {
    return yield* unavailable('createProduct-identity');
  }
  const selection = { productRef: created.product.productRef, variantRef: initialVariant.variantRef };
  yield* requestGrants([
    selection.productRef,
    selection.variantRef,
    { moduleId: catalogModule, resourceId: input.unitId, resourceType: 'commerce.catalog.product-unit' },
  ]);
  // The closed fresh-product scenario verifies the actual retained creation revision before using it.
  const initialVariantRevision = yield* Schema.decodeUnknownEffect(CatalogRevisionNumberSchema)(1);
  const variantCreated = yield* record(
    'variantCreatedHistory',
    executeVariantHistoryWithAuthorization(
      { reference: { resourceRef: selection.variantRef, revision: initialVariantRevision } },
      credential('variantCreatedHistory'),
      correlation('variantCreatedHistory'),
      options,
    ),
  );
  if (variantCreated.changeKind !== 'CREATED' || variantCreated.productId !== selection.productRef.resourceId) {
    return yield* unavailable('variantCreatedHistory-identity');
  }
  // Typed Catalog path: a Current Variant is only reachable through an attribute-defined axis and a confirmed combination.
  const definition = yield* record(
    'createAttributeDefinition',
    executeCreateAttributeDefinitionWithAuthorization(
      {
        label: 'Native proof finish',
        levels: ['VARIANT'],
        meaning: 'Native proof physical finish distinguishing concrete forms',
        multiplicity: 'SINGLE',
        reason,
        specialStates: [],
        valueKind: 'TEXT',
      },
      credential('createAttributeDefinition'),
      correlation('createAttributeDefinition'),
      actionOptions('createAttributeDefinition'),
    ),
    true,
  );
  yield* requestGrants([definition.attributeDefinitionRef]);
  const productType = yield* record(
    'createProductType',
    executeCreateProductTypeWithAuthorization(
      {
        name: 'Native proof product type',
        reason,
        rules: [{ attributeDefinitionRef: definition.attributeDefinitionRef, level: 'VARIANT', required: true }],
      },
      credential('createProductType'),
      correlation('createProductType'),
      actionOptions('createProductType'),
    ),
    true,
  );
  yield* requestGrants([productType.productTypeRef]);
  const assigned = yield* record(
    'setProductType',
    executeSetProductTypeWithAuthorization(
      {
        expectedProductRevision: created.product.revision,
        impactBasis: input.impactBasis,
        nextProductTypeRef: productType.productTypeRef,
        productRef: selection.productRef,
        reason,
      },
      credential('setProductType'),
      correlation('setProductType'),
      actionOptions('setProductType'),
    ),
    true,
  );
  yield* record(
    'governApplicability',
    executeGovernProductAttributeApplicabilityWithAuthorization(
      {
        attributeDefinitionRef: definition.attributeDefinitionRef,
        expectedRevision: null,
        productLevel: false,
        productRef: selection.productRef,
        reason,
        variantLevel: true,
      },
      credential('governApplicability'),
      correlation('governApplicability'),
      actionOptions('governApplicability'),
    ),
    true,
  );
  yield* record(
    'setVariantOverride',
    executeSetVariantAttributeOverrideWithAuthorization(
      {
        attributeDefinitionRef: definition.attributeDefinitionRef,
        classification: { evidenceRefs, kind: 'NON_MATERIAL', reason },
        expectedRevision: null,
        productRef: selection.productRef,
        reason,
        values: [{ kind: 'TEXT', text: 'matte' }],
        variantRef: selection.variantRef,
      },
      credential('setVariantOverride'),
      correlation('setVariantOverride'),
      actionOptions('setVariantOverride'),
    ),
    true,
  );
  yield* record(
    'governAxes',
    executeGovernVariantAxesWithAuthorization(
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
        productRef: selection.productRef,
        reason,
      },
      credential('governAxes'),
      correlation('governAxes'),
      actionOptions('governAxes'),
    ),
    true,
  );
  yield* record(
    'governAllowedValues',
    executeGovernVariantAllowedValuesWithAuthorization(
      {
        attributeDefinitionRef: definition.attributeDefinitionRef,
        definitionRevision: definition.revision,
        evidenceRefs,
        expectedAllowanceRevision: 0,
        expectedAxisRevision: 1,
        productRef: selection.productRef,
        reason,
        values: [{ kind: 'TEXT', text: 'matte' }],
      },
      credential('governAllowedValues'),
      correlation('governAllowedValues'),
      actionOptions('governAllowedValues'),
    ),
    true,
  );
  yield* record(
    'confirmCombination',
    executeConfirmVariantCombinationWithAuthorization(
      {
        evidenceRefs,
        expectedAxisRevision: 1,
        expectedVariantRevision: 1,
        productRef: selection.productRef,
        reason,
        variantRef: selection.variantRef,
      },
      credential('confirmCombination'),
      correlation('confirmCombination'),
      actionOptions('confirmCombination'),
    ),
    true,
  );
  const unitRef = yield* Schema.decodeUnknownEffect(ProductUnitRefSchema)({
    moduleId: catalogModule,
    resourceId: input.unitId,
    resourceType: 'commerce.catalog.product-unit',
    tenantId: input.tenantId,
  });
  const unit = yield* record(
    'createUnit',
    executeCreateProductUnitWithAuthorization(
      {
        code: `native-${input.runKey}`,
        evidenceRefs,
        label: 'Native proof piece',
        reason,
        rule: { rounding: 'UP', step: '1' },
        unitRef,
      },
      credential('createUnit'),
      correlation('createUnit'),
      actionOptions('createUnit'),
    ),
    true,
  );
  const localized = yield* record(
    'localizedFacts',
    executeSetProductLocalizedFactsWithAuthorization(
      {
        evidenceRefs,
        expectedRevision: 0,
        facts: { name: 'Native preproposal proof product' },
        locale: 'en',
        productRef: selection.productRef,
        reason,
      },
      credential('localizedFacts'),
      correlation('localizedFacts'),
      actionOptions('localizedFacts'),
    ),
    true,
  );
  const activated = yield* record(
    'activateProduct',
    executeUpdateProductWithAuthorization(
      { expectedRevision: assigned.revision, productRef: selection.productRef, reason, targetLifecycle: 'ACTIVE' },
      credential('activateProduct'),
      correlation('activateProduct'),
      actionOptions('activateProduct'),
    ),
    true,
  );
  const activatedVariantRevision = yield* Schema.decodeUnknownEffect(CatalogRevisionNumberSchema)(
    variantCreated.reference.revision + 1,
  );
  const variantActivated = yield* record(
    'variantActivatedHistory',
    executeVariantHistoryWithAuthorization(
      { reference: { resourceRef: selection.variantRef, revision: activatedVariantRevision } },
      credential('variantActivatedHistory'),
      correlation('variantActivatedHistory'),
      options,
    ),
  );
  if (variantActivated.lifecycle !== 'ACTIVE' || variantActivated.productId !== selection.productRef.resourceId) {
    return yield* unavailable('variantActivatedHistory-identity');
  }
  const productSourceRevision = yield* Schema.decodeUnknownEffect(CatalogRevisionNumberSchema)(
    activated.product.revision,
  );
  const divisibility = yield* record(
    'setDivisibility',
    executeSetProductUnitTargetDivisibilityWithAuthorization(
      {
        divisible: false,
        evidenceRefs,
        expectedSources: {
          product: { resourceRef: selection.productRef, revision: productSourceRevision },
          variant: variantActivated.reference,
        },
        reason,
        target: {
          targetId: selection.variantRef.resourceId,
          targetType: 'commerce.catalog.variant',
          tenantId: input.tenantId,
          unit: unit.unit,
        },
      },
      credential('setDivisibility'),
      correlation('setDivisibility'),
      actionOptions('setDivisibility'),
    ),
    true,
  );
  const category = yield* record(
    'createCategory',
    executeCreateProductCategoryWithAuthorization(
      { name: 'Native preproposal proof category', reason },
      credential('createCategory'),
      correlation('createCategory'),
      actionOptions('createCategory'),
    ),
    true,
  );
  yield* requestGrants([category.category.categoryRef]);
  const categoryAssignment = yield* record(
    'assignCategory',
    executeAddProductCategoryAssignmentWithAuthorization(
      { categoryRef: category.category.categoryRef, productRef: selection.productRef, reason },
      credential('assignCategory'),
      correlation('assignCategory'),
      actionOptions('assignCategory'),
    ),
    true,
  );
  // Pricing binds later Pricing time only to finite Catalog material. A scheduled Configuration successor bounds the
  // exact selection; it is the owner-defined source of a finite window, never an invented one.
  const configurationDefinitionId = randomUUID();
  const configurationChoice = { choiceKey: 'packaging', optionKey: 'standard' } as const;
  const configurationPayload = (expectedRevision: number, effectiveFrom: Date, optionLabel: string) =>
    Schema.decodeUnknownSync(PublishProductConfigurationPayloadSchema)({
      choices: [
        {
          choiceKey: configurationChoice.choiceKey,
          kind: 'SINGLE_CHOICE' as const,
          label: 'Packaging',
          meaning: 'Exact packaging of the native proof product',
          options: [{ label: optionLabel, meaning: optionLabel, optionKey: configurationChoice.optionKey }],
          required: true,
        },
      ],
      compatibilityRules: [],
      definitionId: configurationDefinitionId,
      effectiveFrom,
      evidenceRefs: ['native-preproposal-configuration-evidence'],
      expectedRevision,
      measuredRules: [],
      optionAllowances: [
        {
          allowed: true,
          choiceKey: configurationChoice.choiceKey,
          evidenceRefs: ['native-preproposal-configuration-evidence'],
          optionKey: configurationChoice.optionKey,
        },
      ],
      productId: selection.productRef.resourceId,
      reason,
    });
  const nowMillis = yield* Clock.currentTimeMillis;
  const configurationCurrent = yield* record(
    'publishConfigurationCurrent',
    executePublishProductConfigurationWithAuthorization(
      configurationPayload(0, new Date(nowMillis - 60_000), 'Standard packaging'),
      credential('publishConfigurationCurrent'),
      correlation('publishConfigurationCurrent'),
      actionOptions('publishConfigurationCurrent'),
    ),
    true,
  );
  yield* record(
    'publishConfigurationSuccessor',
    executePublishProductConfigurationWithAuthorization(
      configurationPayload(
        configurationCurrent.revision,
        new Date(nowMillis + 86_400_000),
        'Revised standard packaging',
      ),
      credential('publishConfigurationSuccessor'),
      correlation('publishConfigurationSuccessor'),
      actionOptions('publishConfigurationSuccessor'),
    ),
    true,
  );
  const configuredSelection = {
    ...selection,
    configuration: Schema.decodeUnknownSync(ProductConfigurationSelectionSchema)({
      choices: [{ choiceKey: configurationChoice.choiceKey, value: configurationChoice.optionKey }],
      definition: {
        resourceRef: {
          moduleId: catalogModule,
          resourceId: configurationDefinitionId,
          resourceType: 'commerce.catalog.configuration-definition',
          tenantId: input.tenantId,
        },
        revision: configurationCurrent.revision,
      },
      productRef: selection.productRef,
      variantRef: selection.variantRef,
    }),
  };
  // CCC prepares Catalog lines for PRICING, whose genuine owner basis also requires CATEGORY.
  const pricingQuantity = yield* record(
    'pricingQuantityPreparation',
    executeQuantityPreparationWithAuthorization(
      { amount: '1', purpose: 'PRICING', selection: configuredSelection },
      credential('pricingQuantityPreparation'),
      correlation('pricingQuantityPreparation'),
      options,
    ),
  );
  const quantity = yield* record(
    'quantityPreparation',
    executeQuantityPreparationWithAuthorization(
      { amount: '1', purpose: 'PURCHASE_ACCEPTANCE', selection: configuredSelection },
      credential('quantityPreparation'),
      correlation('quantityPreparation'),
      options,
    ),
  );
  return {
    pricingQuantity,
    protocol: producerProtocol,
    provenance,
    quantity,
    selection: configuredSelection,
    setup: {
      activated,
      assigned,
      category,
      categoryAssignment,
      created,
      definition,
      divisibility,
      localized,
      productType,
      unit,
      variantActivated,
      variantCreated,
    },
    type: 'produced' as const,
    unitRef: unit.unit,
  };
});

type ProducerResult =
  | Effect.Success<typeof produce>
  | { readonly protocol: typeof producerProtocol; readonly stage: string; readonly type: 'failed' };

const writeProducerResult = (result: ProducerResult) =>
  Effect.try({
    catch: () => unavailable('producer-output-fd'),
    try: () => writeSync(3, `${JSON.stringify(result)}\n`),
  });

const runProducer = produce.pipe(
  Effect.match({
    onFailure: (failure): ProducerResult => ({
      protocol: producerProtocol,
      stage: Schema.is(PreproposalCatalogReceiverUnavailable)(failure) ? failure.stage : 'producer-configuration',
      type: 'failed',
    }),
    onSuccess: (result): ProducerResult => result,
  }),
  Effect.flatMap(writeProducerResult),
  Effect.catchCause(() =>
    writeProducerResult({ protocol: producerProtocol, stage: 'producer-defect', type: 'failed' }),
  ),
);

if (process.argv.includes('--describe-preproposal-basis')) {
  NodeRuntime.runMain(describe);
} else if (process.argv.includes('--produce-preproposal-basis')) {
  NodeRuntime.runMain(runProducer);
} else if (process.argv.includes('--serve-preproposal-basis')) {
  NodeRuntime.runMain(serve.pipe(Effect.provide(NodeHttpServer.layerTest)));
}
