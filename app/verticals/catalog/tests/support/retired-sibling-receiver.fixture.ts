import type { OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import { generateKeyPairSync, sign } from 'node:crypto';

import {
  TrustedPrincipalContextSchema,
  GatewayAssertionRedemptionService,
  GatewayAssertionReplayError,
  makeContextPermissionRelationshipMutationLive,
} from '@app/core-runtime';
import { makeActiveApplicationCompositionLayer } from '@app/core-runtime/modules/active-application-composition';
import { ActiveApplicationCompositionSourceLive } from '@app/core-runtime/modules/active-application-composition-source';
import { EXTERNAL_GATEWAY_ASSERTION_VERSION } from '@app/shared-contracts';
import { HttpApi, HttpApiBuilder, HttpRouter, HttpServer } from '@modern-js/bff-effect/effect-edge';
import { HttpServerRequest, HttpServerResponse, FetchHttpClient } from 'effect/http';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { NodeChildProcessSpawner, NodeCrypto, NodeHttpServer, NodeRuntime, NodeServices } from '@effect/platform-node';
import { eq } from 'drizzle-orm';
import {
  Config,
  ConfigProvider,
  Context,
  Crypto,
  DateTime,
  Effect,
  Layer,
  Match,
  Option,
  Redacted,
  Schema,
} from 'effect';

import { ActionPrincipalVerifierLive } from '../../api/auth/action-principal.ts';
import { retireVariantActionApiLive } from '../../api/retire-variant-action-server.ts';
import { retireVariantAction } from '../../src/actions/retire-variant.action.ts';
import { executeRetireVariantWithAuthorization } from '../../src/api/retire-variant-action-client.ts';
import { RetireVariantPayloadSchema } from '../../shared/actions/retire-variant.ts';
import {
  productVariants,
  productVariantRevisions,
  attributeDefinitions,
  attributeValueSets,
  attributeValueRevisions,
  attributeValueItems,
} from '../../src/database/schema.ts';
import { selectionEvidenceReadApiLive } from '../../api/selection-evidence-read-server.ts';
import { catalogApi } from '../../shared/api.ts';
import { executeSelectionEvidenceWithAuthorization } from '../../src/api/selection-evidence-client.ts';
import { CatalogRevisionNumberSchema } from '../../shared/domain/catalog-revision-reference.ts';
import { AttributeDefinitionRefSchema } from '../../shared/resources/attribute-definition.ts';
import { CatalogSelectionSchema } from '../../shared/domain/catalog-selection-evidence.ts';
import type { CartOpenSelectionPopulationPort } from '../../shared/domain/catalog-open-selection-population.ts';
import type { ProductTypeRef } from '../../shared/resources/product-type.ts';
import type { AttributeDefinitionRef } from '../../shared/resources/attribute-definition.ts';
import { ProductUnitRefSchema } from '../../shared/resources/product-unit.ts';
import { VariantRefSchema } from '../../shared/resources/variant.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { attributeApplicabilityPersistenceForScope } from '../../src/persistence/attribute-applicability-persistence.ts';
import { attributePersistenceForScope } from '../../src/persistence/attribute-persistence.ts';
import { attributeValuesPersistenceForScope } from '../../src/persistence/attribute-values-persistence.ts';
import { catalogPersistenceForScope } from '../../src/persistence/catalog-persistence.ts';
import { catalogSelectionEvidenceForScope } from '../../src/persistence/catalog-selection-evidence-service.ts';
import { categoryPersistenceForScope } from '../../src/persistence/category-persistence.ts';
import { localizedProductFactsPersistenceForScope } from '../../src/persistence/localized-product-facts-persistence.ts';
import { productTypeAssignmentPersistenceForScope } from '../../src/persistence/product-type-assignment-persistence.ts';
import { productTypeCreatePersistenceForScope } from '../../src/persistence/product-type-create-persistence.ts';
import { productUnitPersistenceForScope } from '../../src/persistence/product-unit-persistence.ts';
import { productUnitTargetBasisForScope } from '../../src/persistence/product-unit-target-basis.ts';
import {
  GovernVariantAllowedValuesGovernedSchema,
  variantAxisPersistenceForScope,
} from '../../src/persistence/variant-axis-persistence.ts';
import { variantPersistenceForScope } from '../../src/persistence/variant-persistence.ts';

import { packagePersistenceForScope } from '../../src/persistence/package-persistence.ts';
import { packageContentBasisForTransaction } from '../../src/persistence/package-content-basis.ts';
import { packageActivationPersistenceForScope } from '../../src/persistence/package-activation-persistence.ts';
import { packageOptionPersistenceForScope } from '../../src/persistence/package-option-persistence.ts';
import { CreatePackageDefinitionPayloadSchema } from '../../shared/actions/create-package-definition.ts';

class RetiredSiblingReceiverFailure extends Schema.TaggedError<RetiredSiblingReceiverFailure>()(
  'RetiredSiblingReceiverFailure',
  {
    reason: Schema.String,
  },
) {}

export const retiredSiblingTestServices = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);
const demand = (condition: boolean, reason: string) =>
  condition ? Effect.void : Effect.fail(new RetiredSiblingReceiverFailure({ reason }));
const catalogModuleKey = 'commerce.catalog' as const;
const nextId = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());

const produceCatalogSelection = Effect.fn('RetiredSibling.produceSelection')(function* produceSelection(
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
  principalId: string,
  effectiveAt: Date,
  existing:
    | {
        readonly attributeDefinitionRef: AttributeDefinitionRef;
        readonly definitionRevision: number;
        readonly productTypeRef: ProductTypeRef;
        readonly stagedDefinitionRef: AttributeDefinitionRef;
        readonly stagedDefinitionRevision: number;
      }
    | undefined,
  noDirectRetiredSet: boolean,
) {
  const reason = 'Document observed native fixture product and its permitted configuration';
  const evidenceRefs: readonly [string, ...string[]] = ['fixture:1252:observed-matte-sample'];
  const absentText = Option.getOrUndefined(Option.none<string>());
  const catalog = yield* catalogPersistenceForScope(transaction, scope);
  const created = yield* catalog.create({
    actionInvocationId: yield* nextId,
    description: absentText,
    name: 'Observed sample',
    principalId,
    reason,
    tenantId: scope.tenantId,
    variantId: absentText,
  });
  const createdResult = yield* Match.value(created).pipe(
    Match.tag('created', (result) => Effect.succeed(result)),
    Match.orElse(() =>
      Effect.fail(new RetiredSiblingReceiverFailure({ reason: 'Catalog producer did not return created' })),
    ),
  );
  const { productRef } = createdResult.product;
  const variantRef = yield* Schema.decodeUnknownEffect(VariantRefSchema)({
    moduleId: catalogModuleKey,
    resourceId: createdResult.variantId,
    resourceType: 'commerce.catalog.variant',
    tenantId: scope.tenantId,
  });
  const attributes = yield* attributePersistenceForScope(transaction, scope);
  const definition =
    existing === undefined
      ? yield* attributes.createDefinition({
          actionInvocationId: yield* nextId,
          allowsNone: false,
          allowsNotApplicable: false,
          allowsUnknown: false,
          applicableLevels: ['PRODUCT', 'VARIANT'],
          effectiveAt,
          meaning: 'Observed surface finish distinguishing physical variants',
          multiplicity: 'SINGLE',
          name: 'Surface finish',
          principalId,
          reason,
          valueKind: 'TEXT',
        })
      : { attributeDefinitionRef: existing.attributeDefinitionRef, revision: existing.definitionRevision };
  const attributeDefinitionRef = yield* Schema.decodeUnknownEffect(AttributeDefinitionRefSchema)(
    definition.attributeDefinitionRef,
  );
  const stagedDefinition =
    existing === undefined
      ? yield* attributes.createDefinition({
          actionInvocationId: yield* nextId,
          allowsNone: false,
          allowsNotApplicable: false,
          allowsUnknown: false,
          applicableLevels: ['PRODUCT', 'VARIANT'],
          effectiveAt,
          meaning: 'Undeclared sample label dimension prepared for later axis governance',
          multiplicity: 'SINGLE',
          name: 'Staged sample label',
          principalId,
          reason,
          valueKind: 'TEXT',
        })
      : { attributeDefinitionRef: existing.stagedDefinitionRef, revision: existing.stagedDefinitionRevision };
  const stagedDefinitionRef = yield* Schema.decodeUnknownEffect(AttributeDefinitionRefSchema)(
    stagedDefinition.attributeDefinitionRef,
  );
  const types = yield* productTypeCreatePersistenceForScope(transaction, scope);
  const type =
    existing === undefined
      ? yield* types.create({
          actionInvocationId: yield* nextId,
          effectiveAt,
          name: 'Observed sample type',
          principalId,
          reason,
          rules: [
            { attributeDefinitionRef, level: 'VARIANT', required: true },
            { attributeDefinitionRef, level: 'PRODUCT', required: false },
            { attributeDefinitionRef: stagedDefinitionRef, level: 'PRODUCT', required: true },
            { attributeDefinitionRef: stagedDefinitionRef, level: 'VARIANT', required: false },
          ],
        })
      : { productTypeRef: existing.productTypeRef };
  // Explicit bounded Cart TEST population prerequisite. Real Catalog validators consume
  // the token; production's absent Cart provider remains unavailable. No Cart call
  // participates in the eventual PRICING Selection Read.
  const population: CartOpenSelectionPopulationPort = {
    read: () =>
      Effect.succeed({
        complete: true,
        observedAt: effectiveAt.toISOString(),
        revisionToken: '1252-owned-empty-population',
        selections: [],
        tenantId: scope.tenantId,
      }),
  };
  const assignment = yield* productTypeAssignmentPersistenceForScope(transaction, scope, {
    openSelections: population,
  });
  const assigned = yield* assignment.set({
    actionInvocationId: yield* nextId,
    expectedProductRevision: createdResult.product.revision,
    impactBasis: '1252-owned-empty-population',
    nextProductTypeRef: type.productTypeRef,
    principalId,
    productId: productRef.resourceId,
    reason,
  });
  const alternateRef = yield* Schema.decodeUnknownEffect(VariantRefSchema)({
    ...variantRef,
    resourceId: yield* nextId,
  });
  const alternateCreated = yield* variantPersistenceForScope(transaction, scope).create({
    actionInvocationId: yield* nextId,
    evidenceRefs,
    expectedProductRevision: assigned.revision,
    principalId,
    productRef,
    reason,
    variantRef: alternateRef,
  });
  yield* demand(
    Match.value(alternateCreated).pipe(
      Match.tag('created', () => true),
      Match.orElse(() => false),
    ),
    'Catalog producer outcome was not accepted',
  );
  const applicability = yield* attributeApplicabilityPersistenceForScope(transaction, scope);
  yield* applicability.change({
    actionInvocationId: yield* nextId,
    attributeDefinitionRef,
    expectedRevision: null,
    principalId,
    productLevel: true,
    productRef,
    reason,
    variantLevel: true,
  });
  yield* applicability.change({
    actionInvocationId: yield* nextId,
    attributeDefinitionRef: stagedDefinitionRef,
    expectedRevision: null,
    principalId,
    productLevel: true,
    productRef,
    reason,
    variantLevel: true,
  });
  const values = yield* attributeValuesPersistenceForScope(transaction, scope);
  for (const [definitionRef, text] of [
    [attributeDefinitionRef, 'matte'],
    [stagedDefinitionRef, 'shared observed sample'],
  ] as const) {
    yield* values.setProductValues({
      actionInvocationId: yield* nextId,
      attributeDefinitionRef: definitionRef,
      expectedRevision: null,
      principalId,
      productRef,
      reason,
      values: [{ kind: 'TEXT', text }],
    });
  }
  for (const [observedVariant, text] of [
    [variantRef, 'matte'],
    [alternateRef, 'gloss'],
  ] as const) {
    if (noDirectRetiredSet && observedVariant.resourceId === variantRef.resourceId) {
      continue;
    }
    yield* values.setVariantOverride({
      actionInvocationId: yield* nextId,
      attributeDefinitionRef,
      classification: {
        evidenceRefs,
        kind: 'NON_MATERIAL',
        reason: 'First observation of the existing WIP sample; no realization changed',
      },
      expectedRevision: null,
      principalId,
      productRef,
      reason,
      values: [{ kind: 'TEXT', text }],
      variantRef: observedVariant,
    });
  }
  const axes = variantAxisPersistenceForScope(transaction, scope);
  const governed = yield* axes.govern({
    actionInvocationId: yield* nextId,
    axes: [
      {
        attributeDefinitionId: definition.attributeDefinitionRef.resourceId,
        definitionRevision: definition.revision,
        expectedAllowanceRevision: 0,
      },
    ],
    change: { evidenceRefs, kind: 'AXIS_ADDITION', reason },
    expectedAxisRevision: 0,
    principalId,
    productRef,
    reason,
  });
  yield* demand(governed.axisRevision === 1 && governed.changed, 'Catalog initial axis revision was not established');
  const allowed = yield* axes.governAllowedValues({
    actionInvocationId: yield* nextId,
    attributeDefinitionId: definition.attributeDefinitionRef.resourceId,
    definitionRevision: definition.revision,
    evidenceRefs,
    expectedAllowanceRevision: 0,
    expectedAxisRevision: 1,
    principalId,
    productRef,
    reason,
    values: [
      { kind: 'TEXT', text: 'matte' },
      { kind: 'TEXT', text: 'gloss' },
    ],
  });
  const initialAllowanceClassification = Match.value(allowed).pipe(
    Match.tag('governed', () => 'governed'),
    Match.tag('invalid_input', ({ reason: invalidReason }) =>
      invalidReason === 'Single attribute has multiple values'
        ? 'single-assignment-cardinality-rejected'
        : 'invalid-input',
    ),
    Match.tag('axis_conflict', () => 'axis-conflict'),
    Match.tag('revision_conflict', () => 'allowance-conflict'),
    Match.tag('not_found', () => 'not-found'),
    Match.exhaustive,
  );
  yield* demand(
    initialAllowanceClassification === 'governed',
    `Initial allowance result: ${initialAllowanceClassification}`,
  );
  yield* demand(
    Schema.is(GovernVariantAllowedValuesGovernedSchema)(allowed),
    'Catalog initial allowance was not governed',
  );
  yield* demand(
    Match.value(allowed).pipe(
      Match.tag('governed', (result) => result.allowanceRevision === 1 && result.changed),
      Match.orElse(() => false),
    ),
    'Catalog initial allowance revision was not established',
  );
  const stagedAllowance = yield* axes.governAllowedValues({
    actionInvocationId: yield* nextId,
    attributeDefinitionId: stagedDefinition.attributeDefinitionRef.resourceId,
    definitionRevision: stagedDefinition.revision,
    evidenceRefs,
    expectedAllowanceRevision: 0,
    expectedAxisRevision: 1,
    principalId,
    productRef,
    reason,
    values: [{ kind: 'TEXT', text: 'later-label' }],
  });
  yield* demand(
    Match.value(stagedAllowance).pipe(
      Match.tag('governed', () => true),
      Match.orElse(() => false),
    ),
    'Catalog producer outcome was not accepted',
  );
  const confirmed = yield* variantPersistenceForScope(transaction, scope).confirm({
    actionInvocationId: yield* nextId,
    evidenceRefs,
    expectedAxisRevision: 1,
    expectedVariantRevision: 1,
    principalId,
    productRef,
    reason,
    variantRef,
  });
  const confirmedResult = yield* Match.value(confirmed).pipe(
    Match.tag('confirmed', (result) => Effect.succeed(result)),
    Match.orElse(() =>
      Effect.fail(new RetiredSiblingReceiverFailure({ reason: 'Catalog producer did not return confirmed' })),
    ),
  );
  const alternateConfirmed = yield* variantPersistenceForScope(transaction, scope).confirm({
    actionInvocationId: yield* nextId,
    evidenceRefs,
    expectedAxisRevision: 1,
    expectedVariantRevision: 1,
    principalId,
    productRef,
    reason,
    variantRef: alternateRef,
  });
  const alternateResult = yield* Match.value(alternateConfirmed).pipe(
    Match.tag('confirmed', (result) => Effect.succeed(result)),
    Match.orElse(() =>
      Effect.fail(new RetiredSiblingReceiverFailure({ reason: 'Catalog producer did not return confirmed' })),
    ),
  );
  const localized = yield* localizedProductFactsPersistenceForScope(transaction, scope).changeProduct({
    actionInvocationId: yield* nextId,
    evidenceRefs,
    expectedRevision: 0,
    locale: 'en',
    principalId,
    productRef,
    reason,
    value: { facts: { name: 'Observed sample' }, kind: 'SET' },
  });
  yield* demand(
    Match.value(localized).pipe(
      Match.when({ kind: 'CHANGED' }, () => true),
      Match.orElse(() => false),
    ),
    'Catalog localized facts were not changed',
  );
  const activated = yield* catalog.update({
    actionInvocationId: yield* nextId,
    activateVariantId: absentText,
    expectedRevision: assigned.revision,
    principalId,
    productId: productRef.resourceId,
    reason,
    targetLifecycle: 'ACTIVE',
    tenantId: scope.tenantId,
  });
  const activatedResult = yield* Match.value(activated).pipe(
    Match.tag('updated', (result) => Effect.succeed(result)),
    Match.orElse(() =>
      Effect.fail(new RetiredSiblingReceiverFailure({ reason: 'Catalog producer did not return updated' })),
    ),
  );
  const unitRef = yield* Schema.decodeUnknownEffect(ProductUnitRefSchema)({
    moduleId: catalogModuleKey,
    resourceId: yield* nextId,
    resourceType: 'commerce.catalog.product-unit',
    tenantId: scope.tenantId,
  });
  const units = productUnitPersistenceForScope(transaction, scope, productUnitTargetBasisForScope(transaction, scope));
  yield* units.create({
    actionInvocationId: yield* nextId,
    payload: {
      code: `sample-${yield* nextId}`,
      evidenceRefs,
      label: 'Sample piece',
      reason,
      rule: { rounding: 'UP', step: '1' },
      unitRef,
    },
    principalId,
  });
  for (const [unitVariant, unitRevision] of [
    [variantRef, confirmedResult.revision],
    [alternateRef, alternateResult.revision],
  ] as const) {
    yield* units.setTargetDivisibility({
      actionInvocationId: yield* nextId,
      payload: {
        divisible: false,
        evidenceRefs,
        expectedSources: {
          product: {
            resourceRef: productRef,
            revision: yield* Schema.decodeUnknownEffect(CatalogRevisionNumberSchema)(activatedResult.product.revision),
          },
          variant: {
            resourceRef: unitVariant,
            revision: yield* Schema.decodeUnknownEffect(CatalogRevisionNumberSchema)(unitRevision),
          },
        },
        reason,
        target: {
          targetId: unitVariant.resourceId,
          targetType: 'commerce.catalog.variant',
          tenantId: scope.tenantId,
          unit: unitRef,
        },
      },
      principalId,
    });
  }
  const categories = yield* categoryPersistenceForScope(transaction, scope);
  const categoryId = yield* nextId;
  yield* categories.createCategory({
    actionInvocationId: yield* nextId,
    categoryId,
    name: `Samples ${yield* nextId}`,
    principalId,
    reason,
    tenantId: scope.tenantId,
  });
  yield* categories.addAssignment({
    actionInvocationId: yield* nextId,
    categoryId,
    principalId,
    productId: productRef.resourceId,
    reason,
    tenantId: scope.tenantId,
  });
  const contentBasis = packageContentBasisForTransaction(transaction, scope);
  const packagePayload = yield* Schema.decodeUnknownEffect(CreatePackageDefinitionPayloadSchema)({
    content: { amount: '2', effectiveAt: effectiveAt.toISOString(), form: { productRef, variantRef }, unitRef },
    definitionRef: {
      moduleId: catalogModuleKey,
      resourceId: yield* nextId,
      resourceType: 'commerce.catalog.package-definition',
      tenantId: scope.tenantId,
    },
    evidenceRefs,
    reason,
  });
  const createdPackage = yield* packagePersistenceForScope(transaction, scope, contentBasis).create({
    actionInvocationId: yield* nextId,
    payload: packagePayload,
    principalId,
  });
  yield* demand(
    Match.value(createdPackage).pipe(
      Match.tag('created', () => true),
      Match.orElse(() => false),
    ),
    'Package Definition producer failed',
  );
  const packageDefinitionId = packagePayload.definitionRef.resourceId;
  // Explicit bounded TEST prerequisites: no issued selections and independently requested sealed pair.
  // These attestations do not activate a production role/population authority.
  const roleBasis = {
    verify: () =>
      Effect.succeed(
        Option.some({
          evidenceRefs,
          independentlyRequested: true,
          looseUnitsSubstitutable: false,
          validationReason: 'TEST observed sealed pair cannot be replaced by two loose pieces',
        }),
      ),
  };
  const activation = yield* packageActivationPersistenceForScope(transaction, scope, contentBasis, {
    verify: () => Effect.succeed(true),
  }).activate({
    actionInvocationId: yield* nextId,
    evidenceRefs,
    expectedRevision: 1,
    packageDefinitionId,
    principalId,
    reason,
  });
  yield* demand(
    Match.value(activation).pipe(
      Match.tag('activated', () => true),
      Match.orElse(() => false),
    ),
    'Package Definition activation failed',
  );
  const option = yield* packageOptionPersistenceForScope(transaction, scope, roleBasis, {
    verify: () => Effect.succeed(true),
  }).activate({
    actionInvocationId: yield* nextId,
    expectedContentRevision: 2,
    expectedOptionRevision: 0,
    packageDefinitionId,
  });
  yield* demand(
    Match.value(option).pipe(
      Match.tag('changed', () => true),
      Match.orElse(() => false),
    ),
    'Package Option activation failed',
  );
  const packageRevision = {
    resourceRef: packagePayload.definitionRef,
    revision: yield* Schema.decodeUnknownEffect(CatalogRevisionNumberSchema)(2),
  };
  yield* units.setTargetDivisibility({
    actionInvocationId: yield* nextId,
    payload: {
      divisible: false,
      evidenceRefs,
      expectedSources: {
        packageDefinition: packageRevision,
        product: {
          resourceRef: productRef,
          revision: yield* Schema.decodeUnknownEffect(CatalogRevisionNumberSchema)(activatedResult.product.revision),
        },
        variant: {
          resourceRef: variantRef,
          revision: yield* Schema.decodeUnknownEffect(CatalogRevisionNumberSchema)(confirmedResult.revision),
        },
      },
      reason,
      target: {
        targetId: packageDefinitionId,
        targetType: 'commerce.catalog.package-definition',
        tenantId: scope.tenantId,
        unit: unitRef,
      },
    },
    principalId,
  });
  const packageSelection = yield* Schema.decodeUnknownEffect(CatalogSelectionSchema)({
    packageOption: { contentRevision: packageRevision, optionRef: packagePayload.definitionRef },
    productRef,
    variantRef,
  });
  return {
    alternate: yield* Schema.decodeUnknownEffect(CatalogSelectionSchema)({
      productRef,
      variantRef: alternateRef,
    }),
    attributeDefinitionRef,
    definitionRevision: definition.revision,
    ownerDefinitions: {
      attributeDefinitionRef,
      definitionRevision: definition.revision,
      productTypeRef: type.productTypeRef,
      stagedDefinitionRef,
      stagedDefinitionRevision: stagedDefinition.revision,
    },
    packageSelection,
    selected: yield* Schema.decodeUnknownEffect(CatalogSelectionSchema)({ productRef, variantRef }),
    unitRef,
  };
});

/** Narrow Catalog-owned native receiver; no production provider is activated. */
export const makeRetiredSiblingFixture = Effect.fn('RetiredSibling.makeFixture')(function* makeFixture(verification?: {
  readonly issuer: string;
  readonly jwks: string;
}) {
  const composition = yield* makeApplicationCompositionSnapshotFixture(['catalog'], ultramodernApiMarker.buildMarker);
  const isolated = yield* makeIsolatedNativeDatabaseFixture({
    compositionSnapshot: composition,
    mode: 'schema-only',
    purpose: 'stabilization-1252-retired-sibling',
  });
  yield* isolated.assertClonedSchema();
  const fixture = yield* Effect.acquireRelease(
    makeLiveOperationFixture({
      actionExecutor: 'manager-only',
      actionKeys: [retireVariantAction.descriptor.actionKey],
      adminConnectionString: Redacted.make(isolated.connections.admin.connectionString),
      allowedAudiences: ['catalog'],
      authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
      compositionRevision: composition.composition.revision,
      moduleKeys: ['commerce.catalog'],
      runtimeConnectionString: Redacted.make(isolated.connections.runtime.connectionString),
    }),
    (value) => value.close().pipe(Effect.orDie),
  );
  const fixtureContext = yield* Layer.build(fixture.layer);
  const permissions = yield* makeContextPermissionRelationshipMutationLive();
  const principal = { principalId: fixture.manager.principalId, tenantId: fixture.tenantId };
  const targets = [
    { moduleId: catalogModuleKey, permission: 'module.access' as const },
    { moduleId: catalogModuleKey, permission: 'commerce.catalog.read.selection-evidence' as const },
  ];
  yield* Effect.forEach(
    targets,
    (target) => permissions.mutate({ operation: 'grant', principal, target, tenantId: fixture.tenantId }),
    { concurrency: 1 },
  );
  yield* Effect.addFinalizer(() =>
    Effect.forEach(
      targets,
      (target) => permissions.mutate({ operation: 'revoke', principal, target, tenantId: fixture.tenantId }),
      { concurrency: 1 },
    ).pipe(Effect.asVoid, Effect.orDie),
  );
  const produce = (existing?: Parameters<typeof produceCatalogSelection>[4], noDirectRetiredSet = false) =>
    fixture
      .prepareOwner((transaction, scope) =>
        produceCatalogSelection(
          transaction,
          scope,
          fixture.manager.principalId,
          DateTime.toDateUtc(composition.observedAt),
          existing,
          noDirectRetiredSet,
        ),
      )
      .pipe(Effect.provideContext(fixtureContext));
  const produced = yield* produce();
  const otherProduct = yield* produce(produced.ownerDefinitions);
  const noDirectProduct = yield* produce(produced.ownerDefinitions, true);
  const { alternate, selected } = produced;
  const nativeRead = (selection = selected) =>
    fixture
      .prepareOwner((transaction, scope) =>
        catalogSelectionEvidenceForScope(transaction, scope).assess({ purpose: 'PRICING', selection }),
      )
      .pipe(Effect.provideContext(fixtureContext));
  const initial = yield* nativeRead();
  yield* demand(
    'status' in initial.evidence && initial.evidence.status === 'VALID',
    'Catalog native selection was not valid',
  );
  const keyPair = yield* Effect.sync(() => generateKeyPairSync('ed25519'));
  const kid = 'catalog-optional-configuration';
  const tokenIssuer = verification?.issuer ?? 'https://disposable-shell.ontos.test';
  const jwks =
    verification?.jwks ??
    JSON.stringify({
      keys: [{ ...keyPair.publicKey.export({ format: 'jwk' }), alg: 'EdDSA', kid, use: 'sig' }],
    });
  const now = Math.floor(DateTime.toEpochMillis(composition.observedAt) / 1000);
  const authorization = Effect.fn('OptionalConfiguration.authorization')(function* authorization(
    actor = fixture.manager,
  ) {
    const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', kid, typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        aud: 'catalog',
        compositionRevision: composition.composition.revision,
        exp: now + 300,
        iat: now,
        iss: tokenIssuer,
        jti: yield* nextId,
        principal: actor,
        sub: actor.principalId,
        targetBuildMarker: ultramodernApiMarker.buildMarker,
        ver: EXTERNAL_GATEWAY_ASSERTION_VERSION,
      }),
    ).toString('base64url');
    const content = `${header}.${payload}`;
    return `Bearer ${content}.${sign(null, Buffer.from(content), keyPair.privateKey).toString('base64url')}`;
  });
  // Explicit single-use TEST redemption store validates receiving transport, not
  // Catalog's currently unconfigured default production redemption provider.
  const redeemed = new Set<string>();
  const redemption = Layer.succeed(GatewayAssertionRedemptionService, {
    consume: ({ jti }) =>
      Effect.suspend(() => {
        if (redeemed.has(jti)) {
          return Effect.fail(new GatewayAssertionReplayError({ reason: 'Assertion already redeemed' }));
        }
        redeemed.add(jti);
        return Effect.void;
      }),
  });
  const handlers = Layer.merge(selectionEvidenceReadApiLive, retireVariantActionApiLive).pipe(
    Layer.provide(
      Layer.mergeAll(
        ActionPrincipalVerifierLive,
        makeActiveApplicationCompositionLayer(Effect.succeed(composition)),
      ).pipe(Layer.provide(ActiveApplicationCompositionSourceLive), Layer.provide(FetchHttpClient.layer)),
    ),
    Layer.provide(redemption),
    Layer.provide(fixture.layer),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({ ONTOS_GATEWAY_ISSUER: tokenIssuer, ONTOS_GATEWAY_PUBLIC_JWKS: jwks }),
      ),
    ),
  );
  const app = yield* Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        HttpApiBuilder.layer(
          HttpApi.make('CatalogApi')
            .add(catalogApi.groups.selectionEvidence)
            .add(catalogApi.groups.retireVariantAction),
        ).pipe(
          Layer.provide(handlers),
          Layer.provideMerge(fixture.layer),
          Layer.provide(HttpServer.layerServices),
          Layer.provide(NodeCrypto.layer),
        ),
        { disableLogger: true },
      ),
    ),
    (value) => Effect.promise(value.dispose.bind(value)).pipe(Effect.orDie),
  );
  const emptyContext = Context.makeUnsafe<unknown>(new Map());
  const serverContext = yield* Layer.build(NodeHttpServer.layerTest);
  const server = Context.get(serverContext, HttpServer.HttpServer);
  yield* server.serve(
    Effect.gen(function* forwardCatalogRequest() {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const webRequest = yield* HttpServerRequest.toWeb(request);
      const response = yield* Effect.tryPromise({
        catch: () => new RetiredSiblingReceiverFailure({ reason: 'The Catalog test HTTP adapter failed' }),
        try: async () => await app.handler(webRequest, emptyContext),
      });
      return HttpServerResponse.fromWeb(response);
    }),
  );
  if (!Schema.is(Schema.Struct({ port: Schema.Number }))(server.address)) {
    return yield* new RetiredSiblingReceiverFailure({ reason: 'A loopback receiver address is required' });
  }
  const { port } = server.address;
  const baseUrl = new URL(`http://127.0.0.1:${port}`);
  const nativeFetch = globalThis.fetch;
  const read = Effect.fn('OptionalConfiguration.publicRead')(function* publicRead(
    selection = selected,
    actor = fixture.manager,
  ) {
    return yield* executeSelectionEvidenceWithAuthorization(
      { purpose: 'PRICING', selection },
      yield* authorization(actor),
      yield* nextId,
      {
        baseUrl,
        compositionRevision: composition.composition.revision,
      },
    ).pipe(Effect.provideService(FetchHttpClient.Fetch, nativeFetch));
  });
  const observeHistory = () =>
    fixture
      .prepareOwner((transaction) =>
        Effect.all({
          definitions: transaction
            .select()
            .from(attributeDefinitions)
            .where(eq(attributeDefinitions.tenantId, fixture.tenantId))
            .orderBy(attributeDefinitions.attributeDefinitionId),
          revisions: transaction
            .select()
            .from(productVariantRevisions)
            .where(eq(productVariantRevisions.tenantId, fixture.tenantId))
            .orderBy(productVariantRevisions.variantId, productVariantRevisions.revision),
          valueItems: transaction
            .select()
            .from(attributeValueItems)
            .where(eq(attributeValueItems.tenantId, fixture.tenantId))
            .orderBy(attributeValueItems.attributeValueSetId, attributeValueItems.ordinal),
          valueRevisions: transaction
            .select()
            .from(attributeValueRevisions)
            .where(eq(attributeValueRevisions.tenantId, fixture.tenantId))
            .orderBy(attributeValueRevisions.attributeValueSetId, attributeValueRevisions.revision),
          valueSets: transaction
            .select()
            .from(attributeValueSets)
            .where(eq(attributeValueSets.tenantId, fixture.tenantId))
            .orderBy(attributeValueSets.attributeValueSetId),
          variants: transaction
            .select()
            .from(productVariants)
            .where(eq(productVariants.tenantId, fixture.tenantId))
            .orderBy(productVariants.variantId),
        }),
      )
      .pipe(Effect.provideContext(fixtureContext));
  const retire = Effect.fn('RetiredSibling.retire')(function* retire(selection = selected, actor = fixture.manager) {
    const payload = yield* Schema.decodeUnknownEffect(RetireVariantPayloadSchema)({
      expectedVariantRevision: 2,
      reason: 'Retire only the first physical Variant while preserving its retained attributes',
      variantRef: selection.variantRef,
    });
    return yield* executeRetireVariantWithAuthorization(payload, yield* authorization(actor), yield* nextId, {
      baseUrl,
      compositionRevision: composition.composition.revision,
      idempotencyKey: yield* nextId,
    }).pipe(Effect.provideService(FetchHttpClient.Fetch, nativeFetch));
  });

  return {
    alternate,
    authorization,
    baseUrl,
    composition,
    fixture,
    nativeFetch,
    nativeRead,
    noDirectProduct,
    observeHistory,
    otherProduct,
    packageSelection: produced.packageSelection,
    port,
    produced,
    read,
    retire,
    selected,
  };
});

const ReceiverReadySchema = Schema.Struct({
  actor: TrustedPrincipalContextSchema,
  alternate: CatalogSelectionSchema,
  attributeDefinitionRef: AttributeDefinitionRefSchema,
  buildMarker: Schema.String,
  compositionRevision: Schema.String,
  definitionRevision: CatalogRevisionNumberSchema,
  legalEntityId: Schema.String.check(Schema.isUUID()).pipe(Schema.brand('LegalEntityId')),
  observedAt: Schema.DateTimeUtcFromString,
  otherSelection: CatalogSelectionSchema,
  port: Schema.Int,
  selected: CatalogSelectionSchema,
  type: Schema.Literal('ready'),
  unitRef: ProductUnitRefSchema,
});
const serveReceiver = Effect.gen(function* serveProductAxisReceiver() {
  const issuer = yield* Config.String('ONTOS_TEST_CATALOG_RETIRED_ISSUER');
  const jwks = yield* Config.String('ONTOS_TEST_CATALOG_RETIRED_JWKS');
  const receiver = yield* makeRetiredSiblingFixture({ issuer, jwks });
  // Bounded stdout protocol contains only non-secret fixture identities/public references.
  // Pricing owns its signing key; credentials never enter stdout or diagnostics.
  const document = yield* Schema.decodeUnknownEffect(ReceiverReadySchema)({
    actor: receiver.fixture.manager,
    alternate: receiver.alternate,
    attributeDefinitionRef: receiver.produced.attributeDefinitionRef,
    buildMarker: ultramodernApiMarker.buildMarker,
    compositionRevision: receiver.composition.composition.revision,
    definitionRevision: receiver.produced.definitionRevision,
    legalEntityId: receiver.fixture.legalEntityId,
    observedAt: DateTime.formatIso(receiver.composition.observedAt),
    otherSelection: receiver.otherProduct.selected,
    port: receiver.port,
    selected: receiver.selected,
    type: 'ready',
    unitRef: receiver.produced.unitRef,
  });
  const ready = yield* Schema.encodeEffect(Schema.fromJsonString(ReceiverReadySchema))(document);
  yield* Effect.sync(() => process.stdout.write(`${ready}\n`));
  return yield* Effect.never;
});
if (process.argv.includes('--serve-retired-sibling')) {
  NodeRuntime.runMain(serveReceiver.pipe(Effect.scoped, Effect.provide(retiredSiblingTestServices)));
}
