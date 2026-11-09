import { makeOperationalScopeRepository, makePrincipalResolver, parseDatabaseConfig } from '@app/core-runtime';
import type { OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { stageScopeOf } from '@app/core-runtime/install/stage-context-bootstrap';
import { installOperationalScope } from '@app/core-runtime/testing/actions';
import { testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { requireOwnedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import type { OwnedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { NodeCrypto } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { and, eq, sql } from 'drizzle-orm';
import { Crypto, DateTime, Effect, Layer, Match, Option, Redacted, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { Reactivity } from 'effect/reactivity';

import { ProductRefSchema } from '../../shared/resources/product.ts';
import { ProductUnitRuleRevisionSchema } from '../../shared/resources/product-unit.ts';
import { VariantRefSchema } from '../../shared/resources/variant.ts';
import { CatalogSelectionSchema } from '../../shared/domain/catalog-selection-evidence.ts';
import { assessCatalogSelection } from '../../shared/domain/catalog-selection-assessment.ts';
import { ProductActionInvocationIdSchema } from '../../shared/domain/product.ts';
import { executeSelectionEvidenceWithAuthorization } from '../../src/api/selection-evidence-client.ts';
import {
  productLifecycleEvents,
  productLocalizedFactRevisions,
  productLocalizedFacts,
  productRevisions,
  products,
  productTypeUntypedDecisions,
  productUnitRuleRevisions,
  productUnits,
  productVariantAxisEvents,
  productVariantRevisions,
  productVariants,
  variantUnitDivisibility,
  variantUnitDivisibilityRevisions,
} from '../../src/database/schema.ts';
import { catalogSelectionCurrentBasisForScope } from '../../src/persistence/catalog-selection-current-basis.ts';
import { categoryPersistenceForScope } from '../../src/persistence/category-persistence.ts';
import { axisFreeCombinationKey } from '../../src/persistence/variant-current-basis.ts';

export class InternalC14CatalogPricingReadinessUnavailable extends Schema.TaggedError<InternalC14CatalogPricingReadinessUnavailable>()(
  'InternalC14CatalogPricingReadinessUnavailable',
  {
    cause: Schema.optionalKey(Schema.Redacted(Schema.Defect())),
    errorTag: Schema.optional(Schema.String),
    reason: Schema.String,
    sqlState: Schema.optional(Schema.String),
    stage: Schema.String,
  },
) {}
const diagnosticSchema = Schema.Struct({
  _tag: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9_./-]{0,119}$/u))),
  cause: Schema.optionalKey(Schema.Unknown),
  code: Schema.optionalKey(Schema.String),
  reason: Schema.optionalKey(Schema.Unknown),
});
const failureAt =
  (stage: string) =>
  (cause?: unknown): InternalC14CatalogPricingReadinessUnavailable => {
    if (Schema.is(InternalC14CatalogPricingReadinessUnavailable)(cause)) {
      return cause;
    }
    let cursor = cause;
    let errorTag: string | undefined;
    let sqlState: string | undefined;
    for (let depth = 0; depth < 5; depth += 1) {
      const diagnostic = Schema.decodeUnknownOption(diagnosticSchema)(cursor);
      if (Option.isNone(diagnostic)) {
        break;
      }
      errorTag ??= diagnostic.value._tag;
      if (diagnostic.value.code !== undefined && /^[0-9A-Z]{5}$/u.test(diagnostic.value.code)) {
        sqlState = diagnostic.value.code;
      }
      cursor = diagnostic.value.cause ?? diagnostic.value.reason;
    }
    return new InternalC14CatalogPricingReadinessUnavailable({
      cause: Redacted.make(cause),
      errorTag,
      reason: 'The isolated Catalog pricing readiness fixture could not be verified',
      sqlState,
      stage,
    });
  };
const unavailable = failureAt('bootstrap');
const text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(240), Schema.isTrimmed());
const positive = Schema.Int.check(Schema.isGreaterThan(0));
const requestFacts = Schema.Struct({
  expectedProductRevision: positive,
  expectedUnitRule: ProductUnitRuleRevisionSchema,
  expectedVariantRevision: positive,
  fixtureFacts: Schema.Struct({
    categoryName: text,
    divisible: Schema.Boolean,
    locale: Schema.String.check(Schema.isMinLength(2), Schema.isMaxLength(64), Schema.isTrimmed()),
    localizedName: text,
    structuredAttributesRequired: Schema.Literal(false),
    variantAxesRequired: Schema.Literal(false),
  }),
  originalCreateInvocationId: ProductActionInvocationIdSchema,
  productRef: ProductRefSchema,
  variantRef: VariantRefSchema,
});
type RequestFacts = typeof requestFacts.Type;
const fixturePurpose = 'implementation-1096-registered-workload-gateway';

export interface InternalC14CatalogPricingReadinessRequest extends RequestFacts {
  readonly operatorPrincipalId: string;
  readonly operatorProviderUserId: string;
  readonly ownedDatabase: OwnedNativeDatabaseFixture;
  readonly purpose: typeof fixturePurpose;
  readonly runtimeConnectionString: Redacted.Redacted;
  readonly tenantId: string;
  readonly validation: {
    readonly authorization: Redacted.Redacted;
    readonly baseUrl: string;
    readonly compositionRevision: string;
    readonly requestCorrelation: string;
  };
}
interface ConnectionFacts extends Record<string, unknown> {
  readonly bypassRls: boolean;
  readonly database: string;
  readonly role: string;
  readonly sessionRole: string;
  readonly superuser: boolean;
}
const fixtureReason = 'Explicit INTERNAL C14 pricing route fixture; no external source activation decision';
const fixtureEvidence = ['internal:c14:catalog-pricing-readiness-native'];

const storeReadiness = Effect.fn('InternalC14CatalogPricingReadiness.store')(function* storeReadiness(
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
  input: RequestFacts,
) {
  const { principalId: actingPrincipalId, tenantId } = scope;
  const productId = input.productRef.resourceId;
  const variantId = input.variantRef.resourceId;
  const unitId = input.expectedUnitRule.unit.resourceId;
  if ([input.productRef, input.variantRef, input.expectedUnitRule.unit].some((ref) => ref.tenantId !== tenantId)) {
    return yield* failureAt('verify-reference-scope')();
  }
  const [product] = yield* transaction
    .select()
    .from(products)
    .where(and(eq(products.tenantId, tenantId), eq(products.productId, productId)))
    .for('update')
    .pipe(Effect.mapError(failureAt('native-products')));
  const variants = yield* transaction
    .select()
    .from(productVariants)
    .where(and(eq(productVariants.tenantId, tenantId), eq(productVariants.productId, productId)))
    .for('update')
    .pipe(Effect.mapError(failureAt('native-productVariants')));
  const variant = variants.find((row) => row.variantId === variantId);
  const [createdProduct] = yield* transaction
    .select()
    .from(productRevisions)
    .where(
      and(
        eq(productRevisions.tenantId, tenantId),
        eq(productRevisions.productId, productId),
        eq(productRevisions.revision, 1),
      ),
    )
    .pipe(Effect.mapError(failureAt('native-productRevisions')));
  const [createdVariant] = yield* transaction
    .select()
    .from(productVariantRevisions)
    .where(
      and(
        eq(productVariantRevisions.tenantId, tenantId),
        eq(productVariantRevisions.variantId, variantId),
        eq(productVariantRevisions.revision, 1),
      ),
    )
    .pipe(Effect.mapError(failureAt('native-productVariantRevisions')));
  if (product === undefined || variant === undefined) {
    return yield* failureAt('verify-original-creation-exists')();
  }
  const freshCreationMatches = [
    variants.length === 1,
    product.lifecycleState === 'DRAFT',
    variant.lifecycleState === 'WORK_IN_PROGRESS',
    product.currentRevision === input.expectedProductRevision,
    variant.currentRevision === input.expectedVariantRevision,
    product.currentRevision === 1,
    variant.currentRevision === 1,
    product.createdByActionInvocationId === input.originalCreateInvocationId,
    variant.createdByActionInvocationId === input.originalCreateInvocationId,
    createdProduct?.actionInvocationId === input.originalCreateInvocationId,
    createdVariant?.actionInvocationId === input.originalCreateInvocationId,
    createdProduct?.changeKind === 'CREATED',
    createdVariant?.changeKind === 'CREATED',
  ].every(Boolean);
  if (!freshCreationMatches) {
    return yield* failureAt('verify-original-creation')();
  }
  const [unit] = yield* transaction
    .select()
    .from(productUnits)
    .where(and(eq(productUnits.tenantId, tenantId), eq(productUnits.unitId, unitId)))
    .for('share')
    .pipe(Effect.mapError(failureAt('native-productUnits')));
  const [unitRule] = yield* transaction
    .select()
    .from(productUnitRuleRevisions)
    .where(
      and(
        eq(productUnitRuleRevisions.tenantId, tenantId),
        eq(productUnitRuleRevisions.unitId, unitId),
        eq(productUnitRuleRevisions.revision, input.expectedUnitRule.revision),
      ),
    )
    .for('share')
    .pipe(Effect.mapError(failureAt('native-productUnitRuleRevisions')));
  if (
    unit?.lifecycleState !== 'ACTIVE' ||
    unit.currentRuleRevision !== input.expectedUnitRule.revision ||
    unitRule?.lifecycleState !== 'ACTIVE' ||
    unitRule.step !== input.expectedUnitRule.step ||
    unitRule.rounding !== input.expectedUnitRule.rounding
  ) {
    return yield* failureAt('verify-unit-rule')();
  }
  const crypto = yield* Crypto.Crypto;
  const actionInvocationId = yield* crypto.randomUUIDv4();
  const categoryId = yield* crypto.randomUUIDv4();
  const at = DateTime.toDateUtc(yield* DateTime.now);
  const evidence = {
    actingPrincipalId,
    actionInvocationId,
    evidenceRefs: fixtureEvidence,
    reason: fixtureReason,
    tenantId,
  };
  // These IDs identify sanctioned test setup events, never fabricated Core invocations or source receipts.
  yield* transaction
    .insert(productVariantAxisEvents)
    .values({ ...evidence, attributeDefinitionIds: [], attributeDefinitionRevisions: [], axisRevision: 1, productId })
    .pipe(Effect.mapError(failureAt('native-productVariantAxisEvents')));
  const combinationKey = axisFreeCombinationKey();
  yield* transaction
    .update(productVariants)
    .set({ combinationAxisRevision: 1, combinationKey, currentRevision: 2, lifecycleState: 'ACTIVE', updatedAt: at })
    .where(and(eq(productVariants.tenantId, tenantId), eq(productVariants.variantId, variantId)))
    .pipe(Effect.mapError(failureAt('native-productVariants')));
  yield* transaction
    .insert(productVariantRevisions)
    .values({
      ...evidence,
      changeKind: 'LIFECYCLE',
      combinationAxisRevision: 1,
      combinationKey,
      lifecycleState: 'ACTIVE',
      productId,
      revision: 2,
      variantId,
    })
    .pipe(Effect.mapError(failureAt('native-productVariantRevisions')));
  yield* transaction
    .insert(productLocalizedFacts)
    .values({
      currentRevision: 1,
      locale: input.fixtureFacts.locale,
      name: input.fixtureFacts.localizedName,
      productId,
      state: 'SET',
      tenantId,
    })
    .pipe(Effect.mapError(failureAt('native-productLocalizedFacts')));
  yield* transaction
    .insert(productLocalizedFactRevisions)
    .values({
      ...evidence,
      locale: input.fixtureFacts.locale,
      name: input.fixtureFacts.localizedName,
      productId,
      revision: 1,
      state: 'SET',
    })
    .pipe(Effect.mapError(failureAt('native-productLocalizedFactRevisions')));
  yield* transaction
    .update(products)
    .set({ currentRevision: 2, lifecycleState: 'ACTIVE', updatedAt: at })
    .where(and(eq(products.tenantId, tenantId), eq(products.productId, productId)))
    .pipe(Effect.mapError(failureAt('native-products')));
  yield* transaction
    .insert(productRevisions)
    .values({
      ...evidence,
      changeKind: 'LIFECYCLE',
      description: product.description,
      lifecycleState: 'ACTIVE',
      name: product.name,
      productId,
      revision: 2,
    })
    .pipe(Effect.mapError(failureAt('native-productRevisions')));
  yield* transaction
    .insert(productLifecycleEvents)
    .values({ ...evidence, effectiveAt: at, event: 'ACTIVATED', productId })
    .pipe(Effect.mapError(failureAt('native-productLifecycleEvents')));
  yield* transaction
    .insert(productTypeUntypedDecisions)
    .values({
      ...evidence,
      axisRevision: 1,
      decisionRevision: 1,
      decisionState: 'CONFIRMED',
      productId,
      productRevision: 2,
      structuredAttributesRequired: input.fixtureFacts.structuredAttributesRequired,
      valueRevisionTokens: [],
      variantAxesRequired: input.fixtureFacts.variantAxesRequired,
      variantRevisionTokens: [`${variantId}:2`],
    })
    .pipe(Effect.mapError(failureAt('native-productTypeUntypedDecisions')));
  yield* transaction
    .insert(variantUnitDivisibility)
    .values({ currentRevision: 1, divisible: input.fixtureFacts.divisible, tenantId, unitId, variantId })
    .pipe(Effect.mapError(failureAt('native-variantUnitDivisibility')));
  yield* transaction
    .insert(variantUnitDivisibilityRevisions)
    .values({ ...evidence, divisible: input.fixtureFacts.divisible, revision: 1, unitId, variantId })
    .pipe(Effect.mapError(failureAt('native-variantUnitDivisibilityRevisions')));
  const categories = yield* categoryPersistenceForScope(transaction, scope);
  const createdCategory = yield* categories
    .createCategory({
      actionInvocationId,
      categoryId,
      name: input.fixtureFacts.categoryName,
      principalId: actingPrincipalId,
      reason: fixtureReason,
      tenantId,
    })
    .pipe(Effect.mapError(failureAt('native-category-create')));
  yield* Match.value(createdCategory).pipe(
    Match.tag('created', () => Effect.void),
    Match.orElse((outcome) => Effect.fail(failureAt('native-category-create-outcome')(outcome))),
  );
  const assignedCategory = yield* categories
    .addAssignment({
      actionInvocationId: yield* crypto.randomUUIDv4(),
      categoryId,
      principalId: actingPrincipalId,
      productId,
      reason: fixtureReason,
      tenantId,
    })
    .pipe(Effect.mapError(failureAt('native-category-assign')));
  yield* Match.value(assignedCategory).pipe(
    Match.tag('added', () => Effect.void),
    Match.orElse((outcome) => Effect.fail(failureAt('native-category-assign-outcome')(outcome))),
  );
  const selection = yield* Schema.decodeUnknownEffect(CatalogSelectionSchema)({
    productRef: input.productRef,
    variantRef: input.variantRef,
  });
  const current = yield* catalogSelectionCurrentBasisForScope(transaction, scope)
    .read({
      purpose: 'PRICING',
      selection,
    })
    .pipe(Effect.mapError(failureAt('native-current-basis')));
  const assessment = assessCatalogSelection({ assessedAt: current.assessedAt, current, purpose: 'PRICING', selection });
  if (assessment.status !== 'VALID') {
    return yield* failureAt('native-assessment')(assessment);
  }
  return {
    categoryRef: {
      moduleId: 'commerce.catalog',
      resourceId: categoryId,
      resourceType: 'commerce.catalog.product-category',
      tenantId,
    },
    fixtureEvidence,
    fixtureSetupEventId: actionInvocationId,
    productRevision: 2,
    selection,
    variantRevision: 2,
  };
});

/**
 * INTERNAL, explicit test facts for a real fresh public Product and public Unit in an owned local clone.
 * It neither changes source correlation/creation evidence nor infers external business meaning.
 * The actual protected HTTP read must independently accept the resulting PRICING selection.
 */
export const bootstrapInternalC14CatalogPricingReadiness = Effect.fn('InternalC14CatalogPricingReadiness.bootstrap')(
  function* bootstrapInternalC14CatalogPricingReadiness(input: InternalC14CatalogPricingReadinessRequest) {
    const purpose = yield* Schema.decodeUnknownEffect(Schema.Literal(fixturePurpose))(input.purpose).pipe(
      Effect.mapError(failureAt('owned-database-purpose')),
    );
    const { connections } = input.ownedDatabase;
    const requireOwnership = requireOwnedNativeDatabaseFixture(input.ownedDatabase, {
      adminConnectionString: Redacted.make(connections.admin.connectionString),
      purpose,
      runtimeConnectionString: input.runtimeConnectionString,
    }).pipe(Effect.mapError(failureAt('owned-database')));
    yield* requireOwnership;
    const configuration = yield* parseDatabaseConfig({
      DATABASE_URL: Redacted.value(input.runtimeConnectionString),
    }).pipe(Effect.mapError(unavailable));
    const validationUrl = yield* Effect.try({ catch: unavailable, try: () => new URL(input.validation.baseUrl) });
    if (
      !['127.0.0.1', 'localhost', '::1'].includes(configuration.host) ||
      !/^ontos_test_party_gateway_[a-z0-9_]+$/u.test(configuration.database) ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(validationUrl.hostname) ||
      !['http:', 'https:'].includes(validationUrl.protocol)
    ) {
      return yield* unavailable('Expected the local owned fixture database and receiver');
    }
    const facts = yield* Schema.decodeUnknownEffect(requestFacts)({
      expectedProductRevision: input.expectedProductRevision,
      expectedUnitRule: input.expectedUnitRule,
      expectedVariantRevision: input.expectedVariantRevision,
      fixtureFacts: input.fixtureFacts,
      originalCreateInvocationId: input.originalCreateInvocationId,
      productRef: input.productRef,
      variantRef: input.variantRef,
    }).pipe(Effect.mapError(unavailable));
    const scope = yield* stageScopeOf({ principalId: input.operatorPrincipalId, tenantId: input.tenantId }).pipe(
      Effect.mapError(unavailable),
    );
    const reactivity = yield* Reactivity.make;
    const client = yield* PgClient.make({ url: input.runtimeConnectionString }).pipe(
      Effect.provideService(Reactivity.Reactivity, reactivity),
      Effect.mapError(unavailable),
    );
    const database = yield* testCoreDatabase.pipe(
      Effect.provideService(PgClient.PgClient, client),
      Effect.mapError(unavailable),
    );
    const fixture = yield* database
      .transaction(
        Effect.fn('InternalC14CatalogPricingReadiness.transaction')(function* readinessTransaction(transaction) {
          const [connection] = yield* transaction.execute<ConnectionFacts>(
            sql`select current_database()::text as database, current_user::text as role, session_user::text as "sessionRole", rolsuper as superuser, rolbypassrls as "bypassRls" from pg_roles where rolname=current_user`,
            'objects',
          );
          if (
            connection === undefined ||
            connection.database !== configuration.database ||
            connection.role !== connections.runtime.user ||
            connection.sessionRole !== connections.runtime.user ||
            connection.superuser ||
            connection.bypassRls
          ) {
            return yield* unavailable('Expected the actual non-superuser runtime clone');
          }
          const scoped = yield* installOperationalScope(transaction, scope);
          const identity = yield* makePrincipalResolver(
            { executor: database },
            { authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID },
          ).resolveBetterAuthUserForTenant(input.operatorProviderUserId, input.tenantId);
          const persisted = yield* makeOperationalScopeRepository({ executor: transaction }).load(scope);
          if (
            identity.principalId !== input.operatorPrincipalId ||
            identity.principalKind !== 'human' ||
            identity.tenantId !== input.tenantId ||
            persisted.tenantStatus !== 'active' ||
            persisted.principalStatus !== 'active' ||
            persisted.principalTenantId !== input.tenantId
          ) {
            return yield* unavailable('Expected the actual current human and active Tenant');
          }
          yield* requireOwnership;
          return yield* storeReadiness(scoped, scope, facts);
        }),
      )
      .pipe(Effect.mapError(unavailable));
    const evidence = yield* executeSelectionEvidenceWithAuthorization(
      { purpose: 'PRICING', selection: fixture.selection },
      Redacted.value(input.validation.authorization),
      input.validation.requestCorrelation,
      { baseUrl: input.validation.baseUrl, compositionRevision: input.validation.compositionRevision },
    ).pipe(Effect.mapError(failureAt('governed-http-read')));
    if (
      !('status' in evidence.evidence) ||
      evidence.evidence.status !== 'VALID' ||
      evidence.missingRoles.length !== 0
    ) {
      return yield* failureAt('governed-http-assessment')(evidence);
    }
    return { ...fixture, evidence };
  },
  Effect.scoped,
  Effect.provide(Layer.merge(NodeCrypto.layer, FetchHttpClient.layer)),
);
