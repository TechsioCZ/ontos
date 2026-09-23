import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { and, eq } from 'drizzle-orm';
import { Effect, Schema } from 'effect';

import type {
  VariantReactivationRequiredPackageOption,
  VariantUseChangeDecision,
} from '../../shared/domain/variant-use-change.ts';
import { revalidateVariantReactivation, VariantUseChangeConflict } from '../../shared/domain/variant-use-change.ts';
import type {
  CartOpenSelectionPopulationPort,
  CatalogSelectionEvidenceReader,
} from '../../shared/domain/catalog-open-selection-population.ts';
import {
  openSelectionReferencesProduct,
  readCartOpenSelectionPopulation,
} from '../../shared/domain/catalog-open-selection-population.ts';
import type { ProductRef } from '../../shared/resources/product.ts';
import type { VariantRef } from '../../shared/resources/variant.ts';
import { packageDefinitions, packageOptionRoleRevisions, products } from '../database/schema.ts';
import { catalogSelectionEvidenceForScope } from './catalog-selection-evidence-service.ts';
import { axisFreeCombinationKey } from './variant-current-basis.ts';
import { CatalogPersistenceUnavailable } from './errors.ts';
import type {
  CurrentAxisAllowedValues,
  CurrentVariantAxes,
  CurrentVariantAxisValue,
  RecordedVariantCombination,
  VariantAxisPersistence,
} from './variant-axis-persistence.ts';
import {
  effectiveValueItemKeyHash,
  recordedVariantCombinationKey,
  variantAxisPersistenceForScope,
} from './variant-axis-persistence.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];

const catalogModuleId = 'commerce.catalog';
const productResourceType = 'commerce.catalog.product';
const variantResourceType = 'commerce.catalog.variant';

export class VariantUseChangeBasisUnavailable extends Schema.TaggedError<VariantUseChangeBasisUnavailable>()(
  'VariantUseChangeBasisUnavailable',
  { code: Schema.Literal('variant_use_change_basis_unavailable'), reason: Schema.String },
) {}

interface VariantReactivationAssessmentInput {
  readonly productRef: ProductRef;
  readonly variantRef: VariantRef;
}

export interface VariantReactivationBasis {
  readonly parentProductLifecycle: 'ACTIVE' | 'DRAFT' | 'RETIRED';
  readonly requiredPackageOptions: readonly VariantReactivationRequiredPackageOption[];
}

/** Owner-issued lifecycle facts for rule 10: a retired parent or required Package Option blocks reactivation. */
export interface VariantReactivationBasisPersistence {
  readonly read: (
    input: VariantReactivationAssessmentInput,
  ) => Effect.Effect<VariantReactivationBasis, CatalogPersistenceUnavailable | VariantUseChangeBasisUnavailable>;
}

/**
 * A proven reactivation: the decision plus the Current combination identity the Variant must be
 * written back as. The identity is recomputed from the same effective values and allowed set that
 * `confirm-variant-combination` validates, so a reactivation can never flip ACTIVE under an
 * unvalidated or stale combination.
 */
interface VariantReactivationAssessment {
  readonly combinationAxisRevision: number;
  readonly combinationKey: string;
  readonly decision: VariantUseChangeDecision;
}

export interface VariantUseChangePersistence {
  /**
   * Reconstruct a retired Variant's recorded combination from its Current effective values,
   * revalidate the Product-specific allowed set exactly as `confirm-variant-combination` does, and
   * compare the result with the recorded ACTIVE combinations. A collision is a definite conflict. A
   * clean identity is still confirmed against the injected Cart open-selection owner contract and
   * Catalog's own #479 Current evidence; without that contract the result stays typed fail-closed.
   */
  readonly assessReactivation: (
    input: VariantReactivationAssessmentInput,
  ) => Effect.Effect<
    VariantReactivationAssessment,
    CatalogPersistenceUnavailable | VariantUseChangeBasisUnavailable | VariantUseChangeConflict
  >;
}

/**
 * The two owner halves of open-selection revalidation: Catalog's own #479 evidence reader and the
 * injected Cart population contract. Neither is derived from the other, and both must be present
 * before a reactivation can be called collision-free.
 */
export interface VariantReactivationSelectionAuthority {
  readonly evidence: CatalogSelectionEvidenceReader;
  readonly openSelections: CartOpenSelectionPopulationPort;
}

const basisUnavailable = () =>
  new VariantUseChangeBasisUnavailable({
    code: 'variant_use_change_basis_unavailable',
    reason: 'Current axes or recorded Variant forms cannot be verified',
  });

const unavailable = (cause: unknown): CatalogPersistenceUnavailable => {
  const error = new CatalogPersistenceUnavailable({
    code: 'catalog_persistence_unavailable',
    reason: 'Catalog reactivation basis is temporarily unavailable',
  });
  Object.defineProperty(error, 'cause', { configurable: true, value: cause });
  return error;
};

const unavailableOwnerAssessment = Schema.Struct({ kind: Schema.Literal('UNAVAILABLE'), reason: Schema.String });

/**
 * Refine a Catalog-owned reactivation decision with the Cart open-selection population. Without
 * the injected owner contract the decision stays incomplete; a supplied population is confirmed
 * against Catalog's own Current evidence, and an open selection for this exact Variant blocks the
 * reactivation instead of being silently dropped.
 */
const revalidateReactivationOpenSelections = Effect.fn(
  'VariantUseChangePersistence.revalidateReactivationOpenSelections',
)(function* revalidateReactivationOpenSelections(
  authority: VariantReactivationSelectionAuthority | undefined,
  assessment: VariantReactivationAssessment,
  input: VariantReactivationAssessmentInput,
  tenantId: string,
) {
  if (assessment.decision.revalidation === 'NOT_REQUIRED') {
    return assessment;
  }
  if (authority === undefined) {
    return yield* basisUnavailable();
  }
  const population = yield* readCartOpenSelectionPopulation(authority.openSelections, tenantId).pipe(
    Effect.catchTag('CartOpenSelectionPopulationUnavailable', () => Effect.fail(basisUnavailable())),
  );
  const matching = population.selections.filter(
    ({ selection }) =>
      openSelectionReferencesProduct(selection, input.productRef) &&
      selection.variantRef.tenantId === tenantId &&
      selection.variantRef.resourceId === input.variantRef.resourceId,
  );
  const assessments = yield* Effect.forEach(
    matching,
    ({ selection }) => authority.evidence.assess({ purpose: 'PURCHASE_ACCEPTANCE', selection }),
    { concurrency: 1 },
  );
  if (assessments.some(({ evidence }) => Schema.is(unavailableOwnerAssessment)(evidence))) {
    return yield* basisUnavailable();
  }
  if (matching.length > 0) {
    return yield* new VariantUseChangeConflict({
      code: 'variant_use_change_conflict',
      conflict: 'OPEN_SELECTION_REVALIDATION_REQUIRED',
      reason: 'Open Cart selections still reference this Variant; reactivation requires explicit reselection',
    });
  }
  return { ...assessment, decision: { ...assessment.decision, revalidation: 'NOT_REQUIRED' as const } };
});

const productLifecycle = (value: string): VariantReactivationBasis['parentProductLifecycle'] | undefined =>
  value === 'ACTIVE' || value === 'DRAFT' || value === 'RETIRED' ? value : undefined;

const requiredOptionBasis = Effect.fn('VariantReactivationBasis.requiredOption')(function* requiredOption(
  transaction: ScopedTransaction,
  tenantId: string,
  definition: {
    readonly currentOptionRevision: number;
    readonly lifecycleState: string;
    readonly optionState: string;
    readonly packageDefinitionId: string;
  },
) {
  if (!Number.isSafeInteger(definition.currentOptionRevision) || definition.currentOptionRevision < 0) {
    return yield* basisUnavailable();
  }
  if (definition.currentOptionRevision === 0) {
    return null;
  }
  const [role] = yield* transaction
    .select({
      independentlyRequested: packageOptionRoleRevisions.independentlyRequested,
      looseUnitsSubstitutable: packageOptionRoleRevisions.looseUnitsSubstitutable,
      state: packageOptionRoleRevisions.state,
    })
    .from(packageOptionRoleRevisions)
    .where(
      and(
        eq(packageOptionRoleRevisions.tenantId, tenantId),
        eq(packageOptionRoleRevisions.packageDefinitionId, definition.packageDefinitionId),
        eq(packageOptionRoleRevisions.revision, definition.currentOptionRevision),
      ),
    )
    .limit(1)
    .pipe(Effect.mapError(unavailable));
  if (role === undefined || (role.state !== 'ACTIVE' && role.state !== 'RETIRED')) {
    return yield* basisUnavailable();
  }
  // Loose Variant quantity already satisfies the same legitimate request; it is not a required Option.
  if (!role.independentlyRequested || role.looseUnitsSubstitutable) {
    return null;
  }
  const active =
    definition.lifecycleState === 'ACTIVE' && definition.optionState === 'ACTIVE' && role.state === 'ACTIVE';
  return { lifecycle: active ? ('ACTIVE' as const) : ('RETIRED' as const) };
});

/** Owner-issued rule 10 lifecycle facts; no write authority and no #479 open-selection proof is implied. */
export const variantReactivationBasisForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
): VariantReactivationBasisPersistence => {
  const { tenantId } = scope;
  return {
    read: Effect.fn('VariantReactivationBasis.read')(function* read(input) {
      if (
        input.productRef.tenantId !== tenantId ||
        input.variantRef.tenantId !== tenantId ||
        input.productRef.moduleId !== catalogModuleId ||
        input.variantRef.moduleId !== catalogModuleId ||
        input.productRef.resourceType !== productResourceType ||
        input.variantRef.resourceType !== variantResourceType
      ) {
        return yield* basisUnavailable();
      }
      const [product] = yield* transaction
        .select({ lifecycleState: products.lifecycleState, productId: products.productId })
        .from(products)
        .where(and(eq(products.tenantId, tenantId), eq(products.productId, input.productRef.resourceId)))
        .limit(1)
        .pipe(Effect.mapError(unavailable));
      if (product === undefined || product.productId !== input.productRef.resourceId) {
        return yield* basisUnavailable();
      }
      const lifecycle = productLifecycle(product.lifecycleState);
      if (lifecycle === undefined) {
        return yield* basisUnavailable();
      }
      const definitions = yield* transaction
        .select({
          currentOptionRevision: packageDefinitions.currentOptionRevision,
          lifecycleState: packageDefinitions.lifecycleState,
          optionState: packageDefinitions.optionState,
          packageDefinitionId: packageDefinitions.packageDefinitionId,
        })
        .from(packageDefinitions)
        .where(
          and(
            eq(packageDefinitions.tenantId, tenantId),
            eq(packageDefinitions.productId, input.productRef.resourceId),
            eq(packageDefinitions.variantId, input.variantRef.resourceId),
          ),
        )
        .pipe(Effect.mapError(unavailable));
      const candidates = yield* Effect.forEach(
        definitions,
        (definition) => requiredOptionBasis(transaction, tenantId, definition),
        { concurrency: 1 },
      );
      const requiredPackageOptions = candidates.filter(
        (candidate): candidate is VariantReactivationRequiredPackageOption => candidate !== null,
      );
      return { parentProductLifecycle: lifecycle, requiredPackageOptions };
    }),
  };
};

/** Built on the #438/#440 recorded-variant and effective-value reads; no write authority is implied. */
export const variantUseChangePersistenceForAxes = (
  axes: VariantAxisPersistence,
  reactivationBasis: VariantReactivationBasisPersistence,
  tenantId: string,
  selectionAuthority?: VariantReactivationSelectionAuthority,
): VariantUseChangePersistence => ({
  assessReactivation: Effect.fn('VariantUseChangePersistence.assessReactivation')(function* assessReactivation(input) {
    if (
      input.productRef.tenantId !== tenantId ||
      input.variantRef.tenantId !== tenantId ||
      input.productRef.moduleId !== catalogModuleId ||
      input.variantRef.moduleId !== catalogModuleId ||
      input.productRef.resourceType !== productResourceType ||
      input.variantRef.resourceType !== variantResourceType
    ) {
      return yield* basisUnavailable();
    }
    const current: CurrentVariantAxes = yield* axes
      .readCurrent(input.productRef)
      .pipe(Effect.catchTag('VariantAxisBasisUnavailable', () => Effect.fail(basisUnavailable())));
    if (current.axisRevision < 1) {
      return yield* basisUnavailable();
    }
    const activeRead: Effect.Effect<
      readonly RecordedVariantCombination[],
      CatalogPersistenceUnavailable | VariantUseChangeBasisUnavailable
    > = axes
      .readRecordedCombinations(input.productRef, current)
      .pipe(Effect.catchTag('VariantAxisBasisUnavailable', () => Effect.fail(basisUnavailable())));
    const valuesRead: Effect.Effect<
      readonly CurrentVariantAxisValue[],
      CatalogPersistenceUnavailable | VariantUseChangeBasisUnavailable
    > = axes
      .readEffectiveValues(input.productRef, input.variantRef, current)
      .pipe(Effect.catchTag('VariantAxisBasisUnavailable', () => Effect.fail(basisUnavailable())));
    const basisRead: Effect.Effect<
      VariantReactivationBasis,
      CatalogPersistenceUnavailable | VariantUseChangeBasisUnavailable
    > = reactivationBasis.read(input);
    const [active, values, basis] = yield* Effect.all([activeRead, valuesRead, basisRead] as const, { concurrency: 3 });
    if (values.some((value) => value.source === 'MISSING')) {
      return yield* basisUnavailable();
    }
    // Reactivation revalidates the Product-specific allowed set exactly as
    // `confirm-variant-combination` does, so a value retired from the allowance after the
    // recorded form was taken cannot be silently re-promoted to Current use.
    if (current.axes.length > 0) {
      const allowed: readonly CurrentAxisAllowedValues[] = yield* axes
        .readCurrentAllowedValues(input.productRef, current)
        .pipe(Effect.catchTag('VariantAxisBasisUnavailable', () => Effect.fail(basisUnavailable())));
      const allowedByAxis = new Map(allowed.map((item) => [item.attributeDefinitionId, new Set(item.valueKeys)]));
      const valuesByAxis = new Map(values.map((item) => [item.attributeDefinitionId, item]));
      for (const axis of current.axes) {
        const axisValue = valuesByAxis.get(axis.attributeDefinitionId);
        const allowedKeys = allowedByAxis.get(axis.attributeDefinitionId);
        if (axisValue === undefined || allowedKeys === undefined) {
          return yield* basisUnavailable();
        }
        if (axisValue.items.some((item) => !allowedKeys.has(effectiveValueItemKeyHash(item)))) {
          return yield* new VariantUseChangeConflict({
            code: 'variant_use_change_conflict',
            conflict: 'INVALID_VALUE',
            reason: 'Reactivation would re-promote a value outside the Current Product-specific allowed set',
          });
        }
      }
    }
    const combinationKey =
      current.axes.length === 0 ? axisFreeCombinationKey() : recordedVariantCombinationKey(values, tenantId);
    const decision = yield* revalidateVariantReactivation({
      activeCombinationKeys: active.map((combination) => combination.combinationKey),
      parentProductLifecycle: basis.parentProductLifecycle,
      reactivationCombinationKey: combinationKey,
      requiredPackageOptions: basis.requiredPackageOptions,
    });
    return yield* revalidateReactivationOpenSelections(
      selectionAuthority,
      { combinationAxisRevision: current.axisRevision, combinationKey, decision },
      input,
      tenantId,
    );
  }),
});

/**
 * Constructed only inside Core's already-scoped Action transaction. Catalog's own #479 evidence
 * reader is always available; the Cart population port is injected by the composition boundary
 * and, when absent, keeps the reactivation decision typed fail-closed.
 */
export const variantUseChangePersistenceForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
  openSelections?: CartOpenSelectionPopulationPort,
): VariantUseChangePersistence =>
  variantUseChangePersistenceForAxes(
    variantAxisPersistenceForScope(transaction, scope),
    variantReactivationBasisForScope(transaction, scope),
    scope.tenantId,
    openSelections === undefined
      ? undefined
      : {
          evidence: catalogSelectionEvidenceForScope(transaction, scope),
          openSelections,
        },
  );
