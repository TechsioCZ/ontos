import { expect, it } from 'effect-rstest';
import {
  SelectionEvidenceForbiddenProblemSchema,
  SelectionEvidenceUnavailableProblemSchema,
  SelectionEvidenceAuthenticationProblemSchema,
} from '../../shared/apis/selection-evidence.ts';
import {
  ReviseSetCompositionActionConflictProblemSchema,
  ReviseSetCompositionActionAlreadyCommittedProblemSchema,
  ReviseSetCompositionActionUnavailableProblemSchema,
  ReviseSetCompositionActionInvalidProblemSchema,
  ReviseSetCompositionActionAuthenticationProblemSchema,
  ReviseSetCompositionActionForbiddenProblemSchema,
  ReviseSetCompositionActionNotFoundProblemSchema,
  ReviseSetCompositionActionIneligibleProblemSchema,
  ReviseSetCompositionActionPreconditionProblemSchema,
  ReviseSetCompositionActionCommitIndeterminateProblemSchema,
  ReviseSetCompositionActionInternalProblemSchema,
} from '../../shared/apis/revise-set-composition-action.ts';
import { CreateSetCompositionActionUnavailableProblemSchema } from '../../shared/apis/create-set-composition-action.ts';
import { createSetCompositionAction } from '../../src/actions/create-set-composition.action.ts';
import { reviseSetCompositionAction } from '../../src/actions/revise-set-composition.action.ts';
import { createSetCompositionActionApiLive } from '../../api/create-set-composition-action-server.ts';
import { reviseSetCompositionActionApiLive } from '../../api/revise-set-composition-action-server.ts';
import { setCompositionCurrentReadApiLive } from '../../api/set-composition-current-read-server.ts';
import { setCompositionHistoryReadApiLive } from '../../api/set-composition-history-read-server.ts';
import { reviseSetCompositionRecoveryReadApiLive } from '../../api/revise-set-composition-recovery-read-server.ts';
import { executeCreateSetCompositionWithAuthorization } from '../../src/api/create-set-composition-action-client.ts';
import { executeReviseSetCompositionWithAuthorization } from '../../src/api/revise-set-composition-action-client.ts';
import { executeSetCompositionCurrentWithAuthorization } from '../../src/api/set-composition-current-client.ts';
import { executeSetCompositionHistoryWithAuthorization } from '../../src/api/set-composition-history-client.ts';
import { executeReviseSetCompositionRecoveryWithAuthorization } from '../../src/api/revise-set-composition-recovery-client.ts';
import { SetCompositionMutationPayloadSchema } from '../../shared/actions/set-composition-contract.ts';
import { setCompositionPersistenceForScope } from '../../src/persistence/set-composition-persistence.ts';
import { catalogSelectionPackageUnitBasisForScope } from '../../src/persistence/catalog-selection-package-unit-basis.ts';
import {
  CATALOG_TABLES,
  catalogRelations,
  gatewayAssertionRedemptions,
  setCompositions,
  setCompositionRevisions,
  setCompositionComponents,
} from '../../src/database/schema.ts';
import type { OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import { generateKeyPairSync, sign } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { FileSystem } from 'effect/FileSystem';
import { PgClient } from '@effect/sql-pg';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Reactivity } from 'effect/reactivity';
import { ChildProcess } from 'effect/process';

import {
  findPostgresFailure,
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
import { testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { NodeChildProcessSpawner, NodeCrypto, NodeHttpServer, NodeServices } from '@effect/platform-node';
import { eq, sql } from 'drizzle-orm';
import {
  Array as EffectArray,
  Order,
  ConfigProvider,
  Context,
  Crypto,
  DateTime,
  Effect,
  Exit,
  Layer,
  Match,
  Option,
  Redacted,
  Result,
  Schema,
  Stream,
} from 'effect';

import { ActionPrincipalVerifierLive } from '../../api/auth/action-principal.ts';
import { selectionEvidenceReadApiLive } from '../../api/selection-evidence-read-server.ts';
import { catalogApi } from '../../shared/api.ts';
import { executeSelectionEvidenceWithAuthorization } from '../../src/api/selection-evidence-client.ts';
import { CatalogRevisionNumberSchema } from '../../shared/domain/catalog-revision-reference.ts';
import { AttributeDefinitionRefSchema } from '../../shared/resources/attribute-definition.ts';
import {
  CatalogSelectionSchema,
  CatalogSelectionValidEvidenceSchema,
} from '../../shared/domain/catalog-selection-evidence.ts';
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

class ProductAxisReceiverFailure extends Schema.TaggedError<ProductAxisReceiverFailure>()(
  'ProductAxisReceiverFailure',
  {
    reason: Schema.String,
  },
) {}

const nativeServices = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);
const demand = (condition: boolean, reason: string) =>
  condition ? Effect.void : Effect.fail(new ProductAxisReceiverFailure({ reason }));
const catalogModuleKey = 'commerce.catalog' as const;
const nextId = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());

const produceCatalogSelection = Effect.fn('SetEffectiveRevision.produceSelection')(function* produceSelection(
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
  principalId: string,
  effectiveAt: Date,
  existing?: {
    readonly attributeDefinitionRef: AttributeDefinitionRef;
    readonly definitionRevision: number;
    readonly productTypeRef: ProductTypeRef;
    readonly stagedDefinitionRef: AttributeDefinitionRef;
    readonly stagedDefinitionRevision: number;
  },
) {
  const reason = 'Document observed native fixture product and its permitted configuration';
  const evidenceRefs: readonly [string, ...string[]] = ['fixture:1270:observed-matte-sample'];
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
      Effect.fail(new ProductAxisReceiverFailure({ reason: 'Catalog producer did not return created' })),
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
          applicableLevels: ['VARIANT'],
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
          applicableLevels: ['VARIANT'],
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
        revisionToken: '1270-owned-empty-population',
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
    impactBasis: '1270-owned-empty-population',
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
    productLevel: false,
    productRef,
    reason,
    variantLevel: true,
  });
  yield* applicability.change({
    actionInvocationId: yield* nextId,
    attributeDefinitionRef: stagedDefinitionRef,
    expectedRevision: null,
    principalId,
    productLevel: false,
    productRef,
    reason,
    variantLevel: true,
  });
  const values = yield* attributeValuesPersistenceForScope(transaction, scope);
  for (const [observedVariant, text] of [
    [variantRef, 'matte'],
    [alternateRef, 'gloss'],
  ] as const) {
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
      Effect.fail(new ProductAxisReceiverFailure({ reason: 'Catalog producer did not return confirmed' })),
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
      Effect.fail(new ProductAxisReceiverFailure({ reason: 'Catalog producer did not return confirmed' })),
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
      Effect.fail(new ProductAxisReceiverFailure({ reason: 'Catalog producer did not return updated' })),
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
    selected: yield* Schema.decodeUnknownEffect(CatalogSelectionSchema)({ productRef, variantRef }),
    unitRef,
  };
});

/** Narrow Catalog-owned native receiver; no production provider is activated. */
const makeSetEffectiveFixture = Effect.fn('SetEffectiveRevision.makeFixture')(function* makeFixture(verification?: {
  readonly issuer: string;
  readonly jwks: string;
}) {
  const composition = yield* makeApplicationCompositionSnapshotFixture(['catalog'], ultramodernApiMarker.buildMarker);
  const isolated = yield* makeIsolatedNativeDatabaseFixture({
    mode: 'empty',
    purpose: 'stabilization-1270-set-effective-revision',
  });
  const { admin, runtime } = isolated.connections;
  yield* demand(
    admin.database.startsWith('ontos_test_party_gateway_') &&
      admin.database === runtime.database &&
      admin.host === runtime.host &&
      admin.port === runtime.port &&
      ['localhost', '127.0.0.1'].includes(admin.host) &&
      admin.user !== runtime.user,
    'Core-created database address is not an isolated owner target',
  );
  const adminContext = yield* Layer.build(
    PgClient.layer({ maxConnections: 1, url: Redacted.make(admin.connectionString) }).pipe(
      Layer.provideMerge(Reactivity.layer),
    ),
  );
  const coreEvidenceExecutor = yield* testCoreDatabase.pipe(Effect.provide(adminContext));
  const adminClient = Context.get(adminContext, PgClient.PgClient);
  const runtimeContext = yield* Layer.build(
    PgClient.layer({ maxConnections: 1, url: Redacted.make(runtime.connectionString) }),
  );
  const runtimeClient = Context.get(runtimeContext, PgClient.PgClient);
  const [created] = yield* adminClient<{
    database_name: string;
    database_oid: number;
    database_owner: string;
    server_address: string;
    server_port: number;
  }>`select current_database() as database_name,d.oid::int as database_oid,
    pg_get_userbyid(d.datdba) as database_owner,inet_server_addr()::text as server_address,
    inet_server_port() as server_port from pg_database d where d.datname=current_database()`;
  if (created === undefined) {
    return yield* new ProductAxisReceiverFailure({ reason: 'Core-created database identity is absent' });
  }
  const guardOwned = Effect.fn('SetEffectiveRevision.guardCreatedDatabase')(function* guardCreatedDatabase() {
    for (const [kind, client] of [
      ['admin', adminClient],
      ['runtime', runtimeClient],
    ] as const) {
      const identities = yield* client<{
        bypass_rls: boolean;
        database_name: string;
        database_oid: number;
        database_owner: string;
        effective_role: string;
        server_address: string;
        server_port: number;
        session_role: string;
        superuser: boolean;
      }>`select current_database() as database_name,d.oid::int as database_oid,
        pg_get_userbyid(d.datdba) as database_owner,session_user::text as session_role,
        current_user::text as effective_role,inet_server_addr()::text as server_address,
        inet_server_port() as server_port,r.rolsuper as superuser,r.rolbypassrls as bypass_rls
        from pg_database d join pg_roles r on r.rolname=current_user where d.datname=current_database()`;
      const [actual] = identities;
      const role = kind === 'admin' ? admin.user : runtime.user;
      yield* demand(
        identities.length === 1 &&
          actual !== undefined &&
          actual.database_name === admin.database &&
          actual.database_oid === created.database_oid &&
          actual.database_owner === admin.user &&
          actual.database_owner === created.database_owner &&
          actual.session_role === role &&
          actual.effective_role === role &&
          actual.server_address === created.server_address &&
          actual.server_port === created.server_port &&
          (kind === 'admin' || (!actual.superuser && !actual.bypass_rls)),
        'Core-created database identity or runtime RLS role changed',
      );
    }
  });
  yield* guardOwned();
  yield* isolated.migrateCoreSchema();
  const bootstrapFs = yield* FileSystem;
  const directory = fileURLToPath(new URL('../../', import.meta.url));
  const temporary = yield* bootstrapFs.makeTempDirectoryScoped({ prefix: 'ontos-1270-migration-' });
  const configuration = `${temporary}/drizzle.config.mjs`;
  yield* bootstrapFs.writeFileString(
    configuration,
    "export default { dialect:'postgresql', out:process.env.ONTOS_1270_HISTORY, dbCredentials:{url:process.env.DATABASE_ADMIN_URL}, migrations:{schema:'drizzle',table:'__drizzle_migrations_catalog'} };\n",
  );
  const runOwnerBootstrap = Effect.fn('SetEffectiveRevision.runOwnerBootstrap')(function* runOwnerBootstrap(
    mode: 'migrate' | 'verify',
  ) {
    yield* guardOwned();
    const child = yield* ChildProcess.make(
      process.execPath,
      mode === 'migrate'
        ? [`${directory}/node_modules/drizzle-kit/bin.cjs`, 'migrate', '--config', configuration]
        : [`${directory}/scripts/verify-db-schema.mts`],
      {
        cwd: directory,
        env: {
          APP_ENV_PATH: '/dev/null',
          DATABASE_ADMIN_URL: admin.connectionString,
          DATABASE_URL: runtime.connectionString,
          ONTOS_1270_HISTORY: `${directory}/drizzle`,
        },
        extendEnv: false,
        stderr: 'pipe',
        stdin: 'ignore',
        stdout: 'pipe',
      },
    );
    const [code] = yield* Effect.all([child.exitCode, Stream.runDrain(child.stdout), Stream.runDrain(child.stderr)], {
      concurrency: 3,
    }).pipe(
      Effect.timeoutOrElse({
        duration: '20 seconds',
        orElse: () => Effect.fail(new ProductAxisReceiverFailure({ reason: 'Owned Catalog bootstrap timed out' })),
      }),
    );
    yield* demand(code === 0, 'Owned normal Catalog migration or verification failed');
    yield* guardOwned();
  });
  yield* runOwnerBootstrap('migrate');
  const firstJournal = yield* adminClient<{ hash: string; name: string }>`
    select name,hash from drizzle.__drizzle_migrations_catalog order by id`;
  const historyFolders = (yield* bootstrapFs.readDirectory(`${directory}/drizzle`)).filter((name) =>
    /^\d{14}_.+$/u.test(name),
  );
  expect(
    EffectArray.sort(
      firstJournal.map(({ name }) => name),
      Order.String,
    ),
  ).toEqual(EffectArray.sort(historyFolders, Order.String));
  yield* runOwnerBootstrap('migrate');
  expect(
    yield* adminClient<{ hash: string; name: string }>`
    select name,hash from drizzle.__drizzle_migrations_catalog order by id`,
  ).toEqual(firstJournal);
  yield* guardOwned();
  const catalogAdmin = yield* makeWithDefaults({ relations: catalogRelations }).pipe(Effect.provide(adminContext));
  const runtimeRole = sql.identifier(runtime.user);
  // TEST-ONLY finite owner ACLs, inside the creator-bound disposable database only.
  // No global roles, passwords, default privileges, RLS settings or source database are changed.
  yield* catalogAdmin.execute(sql`grant usage on schema catalog to ${runtimeRole}`, 'objects');
  const tenantTables = CATALOG_TABLES.filter((table) => table !== gatewayAssertionRedemptions);
  yield* Effect.forEach(
    tenantTables,
    (table) =>
      catalogAdmin.execute(sql`grant select,insert,update,delete on table ${table} to ${runtimeRole}`, 'objects'),
    { concurrency: 1, discard: true },
  );
  yield* catalogAdmin.execute(sql`grant usage,select on all sequences in schema catalog to ${runtimeRole}`, 'objects');
  const [acl] = yield* adminClient<{
    can_create: boolean;
    can_use: boolean;
    complete: number;
    forced: number;
    tables: number;
  }>`select count(*)::integer as tables,
    count(*) filter (where c.relrowsecurity and c.relforcerowsecurity)::integer as forced,
    count(*) filter (where c.relname <> 'gateway_assertion_redemptions'
      and has_table_privilege(${runtime.user},c.oid,'SELECT')
      and has_table_privilege(${runtime.user},c.oid,'INSERT')
      and has_table_privilege(${runtime.user},c.oid,'UPDATE')
      and has_table_privilege(${runtime.user},c.oid,'DELETE'))::integer as complete,
    has_schema_privilege(${runtime.user},'catalog','USAGE') as can_use,
    has_schema_privilege(${runtime.user},'catalog','CREATE') as can_create
    from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='catalog' and c.relkind='r'`;
  // Global replay evidence retains migration-installed S/I/D privileges and has no tenant RLS.
  expect(acl).toEqual({
    can_create: false,
    can_use: true,
    complete: tenantTables.length,
    forced: tenantTables.length,
    tables: CATALOG_TABLES.length,
  });
  const [replay] = yield* adminClient<{ valid: boolean }>`select
    (count(*) = 1 and bool_and(
      not c.relrowsecurity and not c.relforcerowsecurity
      and has_table_privilege(${runtime.user},c.oid,'SELECT')
      and has_table_privilege(${runtime.user},c.oid,'INSERT')
      and has_table_privilege(${runtime.user},c.oid,'DELETE')
      and not has_table_privilege(${runtime.user},c.oid,'UPDATE')
      and not has_table_privilege(${runtime.user},c.oid,'REFERENCES')
      and not has_table_privilege(${runtime.user},c.oid,'TRUNCATE')
      and not has_table_privilege(${runtime.user},c.oid,'TRIGGER')
      and not exists (select 1
        from pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) acl
        where acl.grantee=0)
    )) as valid
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='catalog' and c.relname='gateway_assertion_redemptions' and c.relkind='r'`;
  expect(replay?.valid).toBe(true);
  const [sequences] = yield* adminClient<{ missing: number }>`select count(*)::integer as missing
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='catalog' and c.relkind='S'
      and not (has_sequence_privilege(${runtime.user},c.oid,'USAGE')
        and has_sequence_privilege(${runtime.user},c.oid,'SELECT'))`;
  expect(sequences?.missing).toBe(0);
  yield* guardOwned();
  yield* runOwnerBootstrap('verify');
  yield* isolated.publishInitialComposition(composition);
  const fixture = yield* Effect.acquireRelease(
    makeLiveOperationFixture({
      actionExecutor: 'manager-only',
      actionKeys: [createSetCompositionAction.descriptor.actionKey, reviseSetCompositionAction.descriptor.actionKey],
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
  const fs = yield* FileSystem;
  const setHeadMigration = yield* fs.readFileString(
    fileURLToPath(
      new URL('../../drizzle/20261020103114_set_successor_publication_head/migration.sql', import.meta.url),
    ),
  );
  const [, functionSource] = setHeadMigration.split('AS $$');
  const [expectedFunctionBody] = functionSource?.split('$$;') ?? [];
  // TEST-ONLY metadata read verifies the installed owner function, not just a journal substring.
  const headGuards = yield* fixture
    .prepareOwner((transaction) =>
      transaction.select({
        body: sql<string>`p.prosrc`,
        retained_trigger: sql<boolean>`t.tgdeferrable and t.tginitdeferred and t.tgenabled='O' and t.tgtype=21
          and t.tgconstraint<>0 and not t.tgisinternal and not p.prosecdef
          and p.proconfig is null and p.prorettype='trigger'::regtype
          and p.pronargs=0 and l.lanname='plpgsql'`,
      }).from(sql`pg_proc p join pg_namespace n on n.oid=p.pronamespace
        join pg_language l on l.oid=p.prolang
        join pg_trigger t on t.tgfoid=p.oid
        join pg_class c on c.oid=t.tgrelid
        join pg_namespace tn on tn.oid=c.relnamespace`)
        .where(sql`n.nspname='catalog' and p.proname='validate_set_composition_current'
          and tn.nspname='catalog' and c.relname='set_compositions'
          and t.tgname='catalog_set_compositions_current_revision_valid'`),
    )
    .pipe(Effect.provideContext(fixtureContext));
  expect(expectedFunctionBody).toBeDefined();
  expect(headGuards).toHaveLength(1);
  const [headGuard] = headGuards;
  expect(headGuard?.retained_trigger).toBe(true);
  expect(headGuard?.body.trim()).toBe(expectedFunctionBody?.trim());
  const permissions = yield* makeContextPermissionRelationshipMutationLive();
  const principal = { principalId: fixture.manager.principalId, tenantId: fixture.tenantId };
  const targets = [
    { moduleId: catalogModuleKey, permission: 'module.access' as const },
    { moduleId: catalogModuleKey, permission: 'commerce.catalog.read.selection-evidence' as const },
    { moduleId: catalogModuleKey, permission: 'commerce.catalog.read.set-composition-current' as const },
    { moduleId: catalogModuleKey, permission: 'commerce.catalog.read.set-composition-history' as const },
    { moduleId: catalogModuleKey, permission: 'commerce.catalog.read.revise-set-composition-recovery' as const },
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
  const produce = (existing?: Parameters<typeof produceCatalogSelection>[4]) =>
    fixture
      .prepareOwner((transaction, scope) =>
        produceCatalogSelection(
          transaction,
          scope,
          fixture.manager.principalId,
          DateTime.toDateUtc(composition.observedAt),
          existing,
        ),
      )
      .pipe(Effect.provideContext(fixtureContext));
  const produced = yield* produce();
  const otherProduct = yield* produce(produced.ownerDefinitions);
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
  const handlers = Layer.mergeAll(
    selectionEvidenceReadApiLive,
    createSetCompositionActionApiLive,
    reviseSetCompositionActionApiLive,
    setCompositionCurrentReadApiLive,
    setCompositionHistoryReadApiLive,
    reviseSetCompositionRecoveryReadApiLive,
  ).pipe(
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
            .add(catalogApi.groups.createSetCompositionAction)
            .add(catalogApi.groups.reviseSetCompositionAction)
            .add(catalogApi.groups.setCompositionCurrent)
            .add(catalogApi.groups.setCompositionHistory)
            .add(catalogApi.groups.reviseSetCompositionRecovery),
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
        catch: () => new ProductAxisReceiverFailure({ reason: 'The Catalog test HTTP adapter failed' }),
        try: async () => await app.handler(webRequest, emptyContext),
      });
      return HttpServerResponse.fromWeb(response);
    }),
  );
  if (!Schema.is(Schema.Struct({ port: Schema.Number }))(server.address)) {
    return yield* new ProductAxisReceiverFailure({ reason: 'A loopback receiver address is required' });
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
  const owner = <Value, Failure, Requirements>(
    program: (
      transaction: ScopedTransactionExecutor,
      scope: OperationalScope,
    ) => Effect.Effect<Value, Failure, Requirements>,
  ) => fixture.prepareOwner(program).pipe(Effect.provideContext(fixtureContext));
  return {
    alternate,
    authorization,
    baseUrl,
    composition,
    coreEvidenceExecutor,
    fixture,
    fixtureContext,
    nativeFetch,
    nativeRead,
    otherProduct,
    owner,
    produced,
    read,
    selected,
  };
});

it.live('keeps effective R1 through public future R2 publication and preserves exact history, CAS and recovery', () =>
  Effect.gen(function* setEffectiveRevisionNative() {
    const owner = yield* makeSetEffectiveFixture();
    const { composition, fixture, otherProduct, produced } = owner;
    const options = { baseUrl: owner.baseUrl, compositionRevision: composition.composition.revision };
    const ref = {
      moduleId: 'commerce.catalog',
      resourceId: yield* nextId,
      resourceType: 'commerce.catalog.set-composition',
      tenantId: fixture.tenantId,
    };
    const componentIds = [yield* nextId, yield* nextId];
    const revision = yield* Schema.decodeUnknownEffect(SetCompositionMutationPayloadSchema.fields.revision)({
      components: [otherProduct.selected, otherProduct.alternate].map((selection, index) => ({
        componentId: componentIds[index],
        quantity: { amount: '1', unitRef: otherProduct.unitRef },
        selection,
      })),
      productRef: produced.selected.productRef,
      provenance: {
        changeKind: 'INITIAL',
        evidenceRefs: ['test:1270-actual-set'],
        reason: 'Observed two fixed atomic component needs',
      },
      reference: { resourceRef: ref, revision: 1 },
      variantRef: produced.selected.variantRef,
    });
    const componentOrder = Order.make<(typeof revision.components)[number]>((left, right) => {
      const comparison = left.componentId.localeCompare(right.componentId);
      if (comparison < 0) {
        return -1;
      }
      if (comparison > 0) {
        return 1;
      }
      return 0;
    });
    const canonicalRevision = (value: typeof revision) => ({
      ...value,
      components: EffectArray.sort(value.components, componentOrder),
    });
    const canonicalR1 = canonicalRevision(revision);
    const canonicalStored = <Stored extends { readonly revision: typeof revision }>(stored: Stored) => ({
      ...stored,
      revision: canonicalRevision(stored.revision),
    });
    const initial = yield* Schema.decodeUnknownEffect(SetCompositionMutationPayloadSchema)({
      effectiveFrom: DateTime.formatIso(composition.observedAt),
      expectedRevision: 0,
      lifecycleState: 'ACTIVE',
      revision,
    });
    const created = yield* executeCreateSetCompositionWithAuthorization(
      initial,
      yield* owner.authorization(),
      yield* nextId,
      { ...options, idempotencyKey: yield* nextId },
    ).pipe(Effect.provideService(FetchHttpClient.Fetch, owner.nativeFetch));
    expect(created.revision).toEqual(revision.reference);
    const selected = (number: number) =>
      Schema.decodeUnknownSync(CatalogSelectionSchema)({
        ...owner.selected,
        setComposition: { resourceRef: ref, revision: number },
      });
    const original = yield* owner.owner((transaction, scope) =>
      setCompositionPersistenceForScope(transaction, scope)
        .readRevision({
          compositionId: ref.resourceId,
          revision: 1,
        })
        .pipe(Effect.map(Option.map(canonicalStored))),
    );
    expect(Option.isSome(original)).toBe(true);
    const t2 = DateTime.toEpochMillis(yield* DateTime.now) + 4000;
    const at2 = new Date(t2);
    const next = yield* Schema.decodeUnknownEffect(SetCompositionMutationPayloadSchema)({
      effectiveFrom: at2.toISOString(),
      expectedRevision: 1,
      lifecycleState: 'ACTIVE',
      revision: {
        ...revision,
        components: revision.components.map((component, index) =>
          index === 0 ? { ...component, quantity: { ...component.quantity, amount: '2' } } : component,
        ),
        predecessor: revision.reference,
        provenance: {
          changeKind: 'MATERIAL_CHANGE',
          evidenceRefs: ['test:1270-material-assortment'],
          reason: 'Deliver two units of the first fixed need',
        },
        reference: { resourceRef: ref, revision: 2 },
      },
    });
    const requestKeys = [yield* nextId, yield* nextId];
    const attempts = yield* Effect.all(
      requestKeys.map((idempotencyKey) =>
        Effect.gen(function* competingSuccessor() {
          const result = yield* executeReviseSetCompositionWithAuthorization(
            next,
            yield* owner.authorization(),
            yield* nextId,
            { ...options, idempotencyKey },
          ).pipe(Effect.provideService(FetchHttpClient.Fetch, owner.nativeFetch), Effect.result);
          return { idempotencyKey, result };
        }),
      ),
      { concurrency: 2 },
    );
    // Only finite labels and schema-validated literal codes may enter diagnostic output.
    // Never log the captured failure, request, response, credential, or private cause.
    const outcomeClasses = attempts.map(({ result }) => {
      if (Result.isSuccess(result)) {
        return 'SUCCESS';
      }
      const failure: unknown = result.failure;
      if (Schema.is(ReviseSetCompositionActionInvalidProblemSchema)(failure)) {
        return 'INVALID';
      }
      if (Schema.is(ReviseSetCompositionActionAuthenticationProblemSchema)(failure)) {
        return 'AUTHENTICATION';
      }
      if (Schema.is(ReviseSetCompositionActionForbiddenProblemSchema)(failure)) {
        return `FORBIDDEN:${failure.code}`;
      }
      if (Schema.is(ReviseSetCompositionActionNotFoundProblemSchema)(failure)) {
        return `NOT_FOUND:${failure.code}`;
      }
      if (Schema.is(ReviseSetCompositionActionConflictProblemSchema)(failure)) {
        return `CONFLICT:${failure.code}`;
      }
      if (Schema.is(ReviseSetCompositionActionIneligibleProblemSchema)(failure)) {
        return `INELIGIBLE:${failure.code}`;
      }
      if (Schema.is(ReviseSetCompositionActionPreconditionProblemSchema)(failure)) {
        return 'PRECONDITION';
      }
      if (Schema.is(ReviseSetCompositionActionUnavailableProblemSchema)(failure)) {
        return `UNAVAILABLE:${failure.code}`;
      }
      if (Schema.is(ReviseSetCompositionActionAlreadyCommittedProblemSchema)(failure)) {
        return 'ALREADY_COMMITTED';
      }
      if (Schema.is(ReviseSetCompositionActionCommitIndeterminateProblemSchema)(failure)) {
        return 'COMMIT_INDETERMINATE';
      }
      if (Schema.is(ReviseSetCompositionActionInternalProblemSchema)(failure)) {
        return 'INTERNAL';
      }
      return 'UNKNOWN_FAILURE';
    });
    yield* Effect.logInfo('1270_COMPETING_SUCCESSOR_OUTCOMES', outcomeClasses);
    const successes = attempts.filter(({ result }) => Result.isSuccess(result));
    const failures = attempts.filter(({ result }) => Result.isFailure(result));
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    const winning = Option.getOrThrow(Option.fromUndefinedOr(successes[0]));
    const key2 = winning.idempotencyKey;
    const published = Result.getOrThrow(winning.result);
    const losing = Option.getOrThrow(Option.fromUndefinedOr(failures[0]));
    if (Result.isFailure(losing.result)) {
      expect(Schema.is(ReviseSetCompositionActionConflictProblemSchema)(losing.result.failure)).toBe(true);
    }
    expect(published.revision.revision).toBe(2);
    const state = () =>
      owner.owner((transaction) =>
        Effect.all({
          components: transaction
            .select()
            .from(setCompositionComponents)
            .where(eq(setCompositionComponents.compositionId, ref.resourceId))
            .orderBy(setCompositionComponents.revision, setCompositionComponents.componentId),
          owner: transaction.select().from(setCompositions).where(eq(setCompositions.compositionId, ref.resourceId)),
          revisions: transaction
            .select()
            .from(setCompositionRevisions)
            .where(eq(setCompositionRevisions.compositionId, ref.resourceId))
            .orderBy(setCompositionRevisions.revision),
        }),
      );
    const afterPublication = yield* state();
    expect(afterPublication.owner[0]?.currentRevision).toBe(2);
    expect(afterPublication.revisions).toHaveLength(2);
    expect(afterPublication.components).toHaveLength(4);
    expect(DateTime.toEpochMillis(yield* DateTime.now)).toBeLessThan(t2);
    const beforeAt = DateTime.toDateUtc(yield* DateTime.now);
    const beforeOwner = yield* owner.owner((transaction, scope) =>
      setCompositionPersistenceForScope(transaction, scope).readCurrent({
        at: beforeAt,
        compositionId: ref.resourceId,
      }),
    );
    expect(Option.getOrThrow(beforeOwner).revision.reference.revision).toBe(1);
    const beforeUnit = yield* owner.owner((transaction, scope) =>
      catalogSelectionPackageUnitBasisForScope(transaction, scope).read(selected(1), beforeAt),
    );
    expect(beforeUnit).toMatchObject({ setCompositionRevision: 1, status: 'CURRENT' });
    const beforePublic = yield* owner.read(selected(1));
    expect(beforePublic.evidence).toMatchObject({ selection: selected(1), status: 'VALID' });
    if (Schema.is(CatalogSelectionValidEvidenceSchema)(beforePublic.evidence)) {
      expect(
        beforePublic.evidence.basis.filter(({ role }) => role === 'SET_COMPOSITION').map(({ source }) => source),
      ).toEqual([revision.reference]);
      expect(DateTime.toEpochMillis(DateTime.makeUnsafe(beforePublic.evidence.assessedAt))).toBeLessThan(t2);
    }
    expect((yield* owner.read(selected(2))).evidence).toMatchObject({ status: 'INVALID' });
    const beforeCurrent = yield* executeSetCompositionCurrentWithAuthorization(
      { resourceRef: revision.reference.resourceRef },
      yield* owner.authorization(),
      yield* nextId,
      options,
    ).pipe(Effect.provideService(FetchHttpClient.Fetch, owner.nativeFetch));
    expect(beforeCurrent.revision.reference.revision).toBe(1);
    for (const at of [at2, new Date(t2 + 1)]) {
      const current = yield* owner.owner((transaction, scope) =>
        setCompositionPersistenceForScope(transaction, scope).readCurrent({ at, compositionId: ref.resourceId }),
      );
      expect(Option.getOrThrow(current).revision.reference.revision).toBe(2);
      expect(
        yield* owner.owner((transaction, scope) =>
          catalogSelectionPackageUnitBasisForScope(transaction, scope).read(selected(2), at),
        ),
      ).toMatchObject({ setCompositionRevision: 2, status: 'CURRENT' });
      expect(
        yield* owner.owner((transaction, scope) =>
          catalogSelectionPackageUnitBasisForScope(transaction, scope).read(selected(1), at),
        ),
      ).toMatchObject({ status: 'INVALID' });
    }
    const stale = yield* Effect.result(
      executeReviseSetCompositionWithAuthorization(next, yield* owner.authorization(), yield* nextId, {
        ...options,
        idempotencyKey: yield* nextId,
      }).pipe(Effect.provideService(FetchHttpClient.Fetch, owner.nativeFetch)),
    );
    expect(Result.isFailure(stale)).toBe(true);
    if (Result.isFailure(stale)) {
      expect(Schema.is(ReviseSetCompositionActionConflictProblemSchema)(stale.failure)).toBe(true);
    }
    const repeated = yield* Effect.result(
      executeReviseSetCompositionWithAuthorization(next, yield* owner.authorization(), yield* nextId, {
        ...options,
        idempotencyKey: key2,
      }).pipe(Effect.provideService(FetchHttpClient.Fetch, owner.nativeFetch)),
    );
    expect(Result.isFailure(repeated)).toBe(true);
    if (Result.isFailure(repeated)) {
      expect(Schema.is(ReviseSetCompositionActionAlreadyCommittedProblemSchema)(repeated.failure)).toBe(true);
    }
    // The public route observes actual wall-clock time. Explicit-at owner checks above prove exact boundary equality separately.
    const remaining = t2 - DateTime.toEpochMillis(yield* DateTime.now);
    if (remaining > 0) {
      yield* Effect.sleep(remaining + 1);
    }
    const afterPublic = yield* owner.read(selected(2));
    expect(afterPublic.evidence).toMatchObject({ selection: selected(2), status: 'VALID' });
    if (Schema.is(CatalogSelectionValidEvidenceSchema)(afterPublic.evidence)) {
      expect(
        afterPublic.evidence.basis.filter(({ role }) => role === 'SET_COMPOSITION').map(({ source }) => source),
      ).toEqual([next.revision.reference]);
      expect(DateTime.toEpochMillis(DateTime.makeUnsafe(afterPublic.evidence.assessedAt))).toBeGreaterThanOrEqual(t2);
    }
    for (const invalidSelection of [
      Schema.decodeUnknownSync(CatalogSelectionSchema)({
        ...selected(2),
        setComposition: { ...selected(2).setComposition, revisionId: yield* nextId },
      }),
      Schema.decodeUnknownSync(CatalogSelectionSchema)({
        ...selected(2),
        setComposition: { ...selected(2).setComposition, resourceRef: { ...ref, resourceId: yield* nextId } },
      }),
      Schema.decodeUnknownSync(CatalogSelectionSchema)({
        ...selected(2),
        productRef: otherProduct.selected.productRef,
        variantRef: otherProduct.selected.variantRef,
      }),
      Schema.decodeUnknownSync(CatalogSelectionSchema)({
        ...selected(2),
        variantRef: otherProduct.selected.variantRef,
      }),
    ]) {
      expect((yield* owner.read(invalidSelection)).evidence).not.toMatchObject({ status: 'VALID' });
    }
    expect((yield* owner.read(selected(1))).evidence).toMatchObject({ status: 'INVALID' });
    const history = yield* executeSetCompositionHistoryWithAuthorization(
      { reference: { resourceRef: revision.reference.resourceRef, revision: revision.reference.revision } },
      yield* owner.authorization(),
      yield* nextId,
      options,
    ).pipe(Effect.provideService(FetchHttpClient.Fetch, owner.nativeFetch));
    expect(history.revision).toEqual(canonicalR1);
    expect(history.historical).toBe(true);
    const evidence = yield* fixture.evidence(owner.coreEvidenceExecutor);
    const invocation = evidence.invocations.find((item) => item.idempotencyKey === key2);
    expect(invocation?.status).toBe('succeeded');
    const recovered = yield* executeReviseSetCompositionRecoveryWithAuthorization(
      { invocationId: Option.getOrThrow(Option.fromUndefinedOr(invocation)).actionInvocationId },
      yield* owner.authorization(),
      yield* nextId,
      options,
    ).pipe(Effect.provideService(FetchHttpClient.Fetch, owner.nativeFetch));
    expect(recovered).toEqual(published);
    expect(yield* state()).toEqual(afterPublication);
    expect(
      yield* owner.owner((transaction, scope) =>
        setCompositionPersistenceForScope(transaction, scope)
          .readRevision({
            compositionId: ref.resourceId,
            revision: 1,
          })
          .pipe(Effect.map(Option.map(canonicalStored))),
      ),
    ).toEqual(original);
    const t3 = DateTime.toEpochMillis(yield* DateTime.now) + 1500;
    const draft = yield* Schema.decodeUnknownEffect(SetCompositionMutationPayloadSchema)({
      effectiveFrom: new Date(t3).toISOString(),
      expectedRevision: 2,
      lifecycleState: 'DRAFT',
      revision: {
        ...next.revision,
        components: next.revision.components.map((component, index) =>
          index === 0 ? { ...component, quantity: { ...component.quantity, amount: '3' } } : component,
        ),
        predecessor: next.revision.reference,
        provenance: {
          changeKind: 'MATERIAL_CHANGE',
          evidenceRefs: ['test:1270-draft-successor'],
          reason: 'Future draft replacement must not resurrect old Active composition',
        },
        reference: { resourceRef: ref, revision: 3 },
      },
    });
    yield* executeReviseSetCompositionWithAuthorization(draft, yield* owner.authorization(), yield* nextId, {
      ...options,
      idempotencyKey: yield* nextId,
    }).pipe(Effect.provideService(FetchHttpClient.Fetch, owner.nativeFetch));
    expect((yield* owner.read(selected(2))).evidence).toMatchObject({ status: 'VALID' });
    const untilDraft = t3 - DateTime.toEpochMillis(yield* DateTime.now);
    if (untilDraft > 0) {
      yield* Effect.sleep(untilDraft + 1);
    }
    for (const number of [2, 1, 3]) {
      const refused = yield* owner.read(selected(number));
      expect(refused.evidence).toMatchObject({
        purpose: 'PRICING',
        reason: 'Set Composition Current revision is unavailable or missing',
        selection: selected(number),
        status: 'INDETERMINATE',
      });
      expect(refused.validity).toBeUndefined();
    }
    expect(
      Option.isNone(
        yield* owner.owner((transaction, scope) =>
          setCompositionPersistenceForScope(transaction, scope).readCurrent({
            at: new Date(t3),
            compositionId: ref.resourceId,
          }),
        ),
      ),
    ).toBe(true);
    expect(
      (yield* executeSetCompositionHistoryWithAuthorization(
        { reference: { resourceRef: revision.reference.resourceRef, revision: revision.reference.revision } },
        yield* owner.authorization(),
        yield* nextId,
        options,
      ).pipe(Effect.provideService(FetchHttpClient.Fetch, owner.nativeFetch))).revision,
    ).toEqual(canonicalR1);
    expect(
      yield* executeReviseSetCompositionRecoveryWithAuthorization(
        { invocationId: Option.getOrThrow(Option.fromUndefinedOr(invocation)).actionInvocationId },
        yield* owner.authorization(),
        yield* nextId,
        options,
      ).pipe(Effect.provideService(FetchHttpClient.Fetch, owner.nativeFetch)),
    ).toEqual(published);
    expect((yield* state()).revisions).toHaveLength(3);
    // TEST-ONLY invalid final-state witnesses: every injected owner row must roll back.
    // No injected revision, invocation marker, or business head is accepted as producer evidence.
    const integrityBefore = yield* state();
    const integrityEvidence = yield* fixture.evidence(owner.coreEvidenceExecutor);
    const latestRevision = Option.getOrThrow(Option.fromUndefinedOr(integrityBefore.revisions.at(-1)));
    const retainedComponent = Option.getOrThrow(Option.fromUndefinedOr(integrityBefore.components[0]));
    for (const control of ['ABSENT_HEAD', 'WRONG_IDENTITY', 'INCOMPLETE_ACTIVE_HEAD'] as const) {
      const result = yield* Effect.exit(
        owner.owner((transaction) =>
          Effect.gen(function* rejectedSetFinalState() {
            if (control === 'WRONG_IDENTITY') {
              yield* transaction
                .update(setCompositions)
                .set({ productId: otherProduct.selected.productRef.resourceId })
                .where(eq(setCompositions.compositionId, ref.resourceId));
              return;
            }
            if (control === 'INCOMPLETE_ACTIVE_HEAD') {
              yield* transaction.insert(setCompositionRevisions).values({
                ...latestRevision,
                actionInvocationId: yield* nextId,
                effectiveFrom: new Date(t3 + 1),
                effectiveTo: null,
                lifecycleState: 'ACTIVE',
                predecessorRevision: 3,
                revision: 4,
              });
              yield* transaction.insert(setCompositionComponents).values({ ...retainedComponent, revision: 4 });
            }
            yield* transaction
              .update(setCompositions)
              .set({ currentRevision: control === 'ABSENT_HEAD' ? 99 : 4 })
              .where(eq(setCompositions.compositionId, ref.resourceId));
          }),
        ),
      );
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        expect(Option.map(findPostgresFailure(result.cause), ({ code }) => code)).toEqual(
          Option.some(control === 'WRONG_IDENTITY' ? '55000' : '23514'),
        );
      }
      expect(yield* state()).toEqual(integrityBefore);
    }
    const afterIntegrity = yield* fixture.evidence(owner.coreEvidenceExecutor);
    expect(afterIntegrity.events).toHaveLength(integrityEvidence.events.length);
    expect(afterIntegrity.outbox).toHaveLength(integrityEvidence.outbox.length);
    expect(afterIntegrity.invocations).toHaveLength(integrityEvidence.invocations.length);
    const t4 = DateTime.toEpochMillis(yield* DateTime.now) + 60_000;
    const endedSuccessor = yield* Schema.decodeUnknownEffect(SetCompositionMutationPayloadSchema)({
      effectiveFrom: new Date(t4).toISOString(),
      effectiveTo: new Date(t4 + 1).toISOString(),
      expectedRevision: 3,
      lifecycleState: 'ACTIVE',
      revision: {
        ...next.revision,
        predecessor: draft.revision.reference,
        provenance: {
          changeKind: 'MATERIAL_CHANGE',
          evidenceRefs: ['test:1270-ended-successor'],
          reason: 'A future bounded successor must not resurrect earlier Active history after its end',
        },
        reference: { resourceRef: ref, revision: 4 },
      },
    });
    yield* executeReviseSetCompositionWithAuthorization(endedSuccessor, yield* owner.authorization(), yield* nextId, {
      ...options,
      idempotencyKey: yield* nextId,
    }).pipe(Effect.provideService(FetchHttpClient.Fetch, owner.nativeFetch));
    const atEndedBoundary = (at: number) =>
      owner.owner((transaction, scope) =>
        setCompositionPersistenceForScope(transaction, scope).readCurrent({
          at: new Date(at),
          compositionId: ref.resourceId,
        }),
      );
    const effectiveFourth = yield* atEndedBoundary(t4);
    expect(effectiveFourth.pipe(Option.map(({ revision: value }) => value.reference.revision))).toEqual(Option.some(4));
    expect(Option.isNone(yield* atEndedBoundary(t4 + 1))).toBe(true);
    expect(
      yield* owner.owner((transaction, scope) =>
        setCompositionPersistenceForScope(transaction, scope)
          .readRevision({
            compositionId: ref.resourceId,
            revision: 1,
          })
          .pipe(Effect.map(Option.map(canonicalStored))),
      ),
    ).toEqual(original);
  }).pipe(Effect.provide(nativeServices)),
);

it.live(
  'keeps public Set trust boundaries and rolls back a failed successor without partial owner history or events',
  () =>
    Effect.gen(function* setTrustAndRollback() {
      const owner = yield* makeSetEffectiveFixture();
      const { fixture, otherProduct, produced } = owner;
      const options = { baseUrl: owner.baseUrl, compositionRevision: owner.composition.composition.revision };
      const compositionRef = {
        moduleId: 'commerce.catalog',
        resourceId: yield* nextId,
        resourceType: 'commerce.catalog.set-composition',
        tenantId: fixture.tenantId,
      };
      const payload = yield* Schema.decodeUnknownEffect(SetCompositionMutationPayloadSchema)({
        effectiveFrom: DateTime.formatIso(owner.composition.observedAt),
        expectedRevision: 0,
        lifecycleState: 'ACTIVE',
        revision: {
          components: yield* Effect.all(
            [otherProduct.selected, otherProduct.alternate].map((selection) =>
              nextId.pipe(
                Effect.map((componentId) => ({
                  componentId,
                  quantity: { amount: '1', unitRef: otherProduct.unitRef },
                  selection,
                })),
              ),
            ),
          ),
          productRef: produced.selected.productRef,
          provenance: {
            changeKind: 'INITIAL',
            evidenceRefs: ['test:1270-trust-control'],
            reason: 'Record two actual atomic components',
          },
          reference: { resourceRef: compositionRef, revision: 1 },
          variantRef: produced.selected.variantRef,
        },
      });
      // #1270 permits future successors, preserving the existing initial-future refusal.
      const initialState = () =>
        owner.owner((transaction) =>
          Effect.all({
            components: transaction.select().from(setCompositionComponents),
            heads: transaction.select().from(setCompositions),
            revisions: transaction.select().from(setCompositionRevisions),
          }),
        );
      const beforeFutureInitial = yield* initialState();
      const beforeFutureEvidence = yield* fixture.evidence(owner.coreEvidenceExecutor);
      const futureInitial = yield* executeCreateSetCompositionWithAuthorization(
        { ...payload, effectiveFrom: new Date(DateTime.toEpochMillis(yield* DateTime.now) + 60_000).toISOString() },
        yield* owner.authorization(),
        yield* nextId,
        { ...options, idempotencyKey: yield* nextId },
      ).pipe(Effect.provideService(FetchHttpClient.Fetch, owner.nativeFetch), Effect.flip);
      expect(Schema.is(CreateSetCompositionActionUnavailableProblemSchema)(futureInitial)).toBe(true);
      expect(yield* initialState()).toEqual(beforeFutureInitial);
      const afterFutureEvidence = yield* fixture.evidence(owner.coreEvidenceExecutor);
      expect(afterFutureEvidence.events).toHaveLength(beforeFutureEvidence.events.length);
      expect(afterFutureEvidence.outbox).toHaveLength(beforeFutureEvidence.outbox.length);
      expect(afterFutureEvidence.invocations.filter(({ status }) => status === 'succeeded')).toHaveLength(
        beforeFutureEvidence.invocations.filter(({ status }) => status === 'succeeded').length,
      );
      yield* executeCreateSetCompositionWithAuthorization(payload, yield* owner.authorization(), yield* nextId, {
        ...options,
        idempotencyKey: yield* nextId,
      }).pipe(Effect.provideService(FetchHttpClient.Fetch, owner.nativeFetch));
      const selection = yield* Schema.decodeUnknownEffect(CatalogSelectionSchema)({
        ...owner.selected,
        setComposition: payload.revision.reference,
      });
      expect((yield* owner.read(selection)).evidence).toMatchObject({ status: 'VALID' });
      const state = () =>
        owner.owner((transaction) =>
          Effect.all({
            components: transaction
              .select()
              .from(setCompositionComponents)
              .where(eq(setCompositionComponents.compositionId, compositionRef.resourceId))
              .orderBy(setCompositionComponents.revision, setCompositionComponents.componentId),
            owner: transaction
              .select()
              .from(setCompositions)
              .where(eq(setCompositions.compositionId, compositionRef.resourceId)),
            revisions: transaction
              .select()
              .from(setCompositionRevisions)
              .where(eq(setCompositionRevisions.compositionId, compositionRef.resourceId))
              .orderBy(setCompositionRevisions.revision),
          }),
        );
      const before = yield* state();
      const beforeEvidence = yield* fixture.evidence(owner.coreEvidenceExecutor);
      const successor = yield* Schema.decodeUnknownEffect(SetCompositionMutationPayloadSchema)({
        effectiveFrom: new Date(DateTime.toEpochMillis(yield* DateTime.now) + 60_000).toISOString(),
        expectedRevision: 1,
        lifecycleState: 'ACTIVE',
        revision: {
          ...payload.revision,
          components: payload.revision.components.map((component, index) =>
            index === 0 ? { ...component, quantity: { ...component.quantity, amount: '2' } } : component,
          ),
          predecessor: payload.revision.reference,
          provenance: {
            changeKind: 'MATERIAL_CHANGE',
            evidenceRefs: ['test:1270-rollback'],
            reason: 'This simulated failed transaction must leave no partial successor',
          },
          reference: { resourceRef: compositionRef, revision: 2 },
        },
      });
      fixture.faultNextTransaction('rollback');
      const failed = yield* executeReviseSetCompositionWithAuthorization(
        successor,
        yield* owner.authorization(),
        yield* nextId,
        { ...options, idempotencyKey: yield* nextId },
      ).pipe(Effect.provideService(FetchHttpClient.Fetch, owner.nativeFetch), Effect.flip);
      expect(Schema.is(ReviseSetCompositionActionUnavailableProblemSchema)(failed)).toBe(true);
      expect(yield* state()).toEqual(before);
      const afterFailure = yield* fixture.evidence(owner.coreEvidenceExecutor);
      expect(afterFailure.events).toHaveLength(beforeEvidence.events.length);
      expect(afterFailure.outbox).toHaveLength(beforeEvidence.outbox.length);
      expect(afterFailure.invocations.filter(({ status }) => status === 'succeeded')).toHaveLength(
        beforeEvidence.invocations.filter(({ status }) => status === 'succeeded').length,
      );
      const forbiddenLegalEntity = { ...fixture.manager, legalEntityId: fixture.legalEntityId };
      expect(
        Schema.is(SelectionEvidenceForbiddenProblemSchema)(
          yield* owner.read(selection, forbiddenLegalEntity).pipe(Effect.flip),
        ),
      ).toBe(true);
      expect(
        Schema.is(SelectionEvidenceForbiddenProblemSchema)(
          yield* owner.read(selection, fixture.denied).pipe(Effect.flip),
        ),
      ).toBe(true);
      const foreignTenant = yield* nextId;
      const foreignSelection = yield* Schema.decodeUnknownEffect(CatalogSelectionSchema)({
        productRef: { ...selection.productRef, tenantId: foreignTenant },
        setComposition: {
          ...payload.revision.reference,
          resourceRef: { ...payload.revision.reference.resourceRef, tenantId: foreignTenant },
        },
        variantRef: { ...selection.variantRef, tenantId: foreignTenant },
      });
      expect(
        Schema.is(SelectionEvidenceUnavailableProblemSchema)(yield* owner.read(foreignSelection).pipe(Effect.flip)),
      ).toBe(true);
      const token = yield* owner.authorization();
      yield* executeSelectionEvidenceWithAuthorization(
        { purpose: 'PRICING', selection },
        token,
        yield* nextId,
        options,
      ).pipe(Effect.provideService(FetchHttpClient.Fetch, owner.nativeFetch));
      expect(
        Schema.is(SelectionEvidenceAuthenticationProblemSchema)(
          yield* executeSelectionEvidenceWithAuthorization(
            { purpose: 'PRICING', selection },
            token,
            yield* nextId,
            options,
          ).pipe(Effect.provideService(FetchHttpClient.Fetch, owner.nativeFetch), Effect.flip),
        ),
      ).toBe(true);
      expect(
        Schema.is(SelectionEvidenceAuthenticationProblemSchema)(
          yield* executeSelectionEvidenceWithAuthorization(
            { purpose: 'PRICING', selection },
            'Bearer unusable',
            yield* nextId,
            options,
          ).pipe(Effect.provideService(FetchHttpClient.Fetch, owner.nativeFetch), Effect.flip),
        ),
      ).toBe(true);
      const permissions = yield* makeContextPermissionRelationshipMutationLive();
      const principal = { principalId: fixture.manager.principalId, tenantId: fixture.tenantId };
      const target = { moduleId: 'commerce.catalog', permission: 'commerce.catalog.read.selection-evidence' };
      yield* permissions.mutate({ operation: 'revoke', principal, target, tenantId: fixture.tenantId });
      expect(Schema.is(SelectionEvidenceForbiddenProblemSchema)(yield* owner.read(selection).pipe(Effect.flip))).toBe(
        true,
      );
      yield* permissions.mutate({ operation: 'grant', principal, target, tenantId: fixture.tenantId });
      expect((yield* owner.read(selection)).evidence).toMatchObject({ status: 'VALID' });
      expect(yield* state()).toEqual(before);
    }).pipe(Effect.provide(nativeServices)),
);
