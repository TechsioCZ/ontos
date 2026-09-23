import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { and, eq } from 'drizzle-orm';
import { DateTime, Effect, Match, Schema } from 'effect';
import { isDeepStrictEqual } from 'node:util';

import type { CatalogSelection, CatalogSelectionRevision } from '../../shared/domain/catalog-selection-evidence.ts';
import {
  CatalogSelectionRevisionSchema,
  CatalogSelectionSchema,
} from '../../shared/domain/catalog-selection-evidence.ts';
import type { QuantityNormalization, QuantityPhase } from '../../shared/domain/purchase-quantity.ts';
import { normalizePurchaseQuantity } from '../../shared/domain/purchase-quantity.ts';
import type { CatalogResourceRef } from '../../shared/domain/catalog-revision-reference.ts';
import {
  packageDefinitions,
  packageContentRevisions,
  packageUnitDivisibility,
  productUnitRuleRevisions,
  productUnits,
  productVariants,
  products,
  variantUnitDivisibility,
} from '../database/schema.ts';
import { CatalogPersistenceUnavailable } from './errors.ts';
import { resolveEffectiveRevision } from './package-persistence.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];

export interface CatalogQuantityPreparationRequest {
  readonly amount: string;
  /** The prepared candidate and its observed revisions; mismatch requires re-preparation. */
  readonly expected?: {
    readonly packageDefinitionRevision?: number;
    readonly productRevision: number;
    readonly quantity: Extract<QuantityNormalization, { status: 'VALID' }>;
    readonly selection: CatalogSelection;
    readonly targetDivisibilityRevision: number;
    readonly unitRuleRevision: number;
    readonly variantRevision: number;
  };
  readonly phase: QuantityPhase;
  readonly selection: CatalogSelection;
}

export type CatalogQuantityPreparation =
  | {
      readonly divisible: boolean;
      readonly quantity: Extract<QuantityNormalization, { status: 'VALID' }>;
      readonly selection: CatalogSelection;
      readonly sources: {
        readonly packageDefinition: CatalogSelectionRevision | undefined;
        readonly product: CatalogSelectionRevision;
        readonly targetDivisibilityRevision: number;
        readonly unitRuleRevision: number;
        readonly variant: CatalogSelectionRevision;
      };
      readonly status: 'PREPARED';
      readonly unitRef: CatalogResourceRef;
    }
  | { readonly reason: string; readonly status: 'INVALID' | 'INDETERMINATE' | 'STALE' };

const unavailable = (cause: unknown): CatalogPersistenceUnavailable => {
  const failure = new CatalogPersistenceUnavailable({
    code: 'catalog_persistence_unavailable',
    reason: 'Catalog quantity preparation basis is unavailable',
  });
  Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  return failure;
};

const failure = (status: 'INVALID' | 'INDETERMINATE' | 'STALE', reason: string): CatalogQuantityPreparation => ({
  reason,
  status,
});

const validRevision = (revision: number): boolean =>
  Number.isSafeInteger(revision) && revision > 0 && revision <= 2_147_483_647;

type QuantitySourceRevisions = Pick<
  NonNullable<CatalogQuantityPreparationRequest['expected']>,
  | 'packageDefinitionRevision'
  | 'productRevision'
  | 'targetDivisibilityRevision'
  | 'unitRuleRevision'
  | 'variantRevision'
>;

const changedSources = (
  expected: QuantitySourceRevisions,
  actual: Omit<QuantitySourceRevisions, 'packageDefinitionRevision'> & {
    readonly packageDefinitionRevision: number | undefined;
  },
): boolean =>
  expected.productRevision !== actual.productRevision ||
  expected.variantRevision !== actual.variantRevision ||
  expected.packageDefinitionRevision !== actual.packageDefinitionRevision ||
  expected.unitRuleRevision !== actual.unitRuleRevision ||
  expected.targetDivisibilityRevision !== actual.targetDivisibilityRevision;

const changedCandidateSelection = (
  input: CatalogQuantityPreparationRequest,
  expected: NonNullable<CatalogQuantityPreparationRequest['expected']>,
): boolean => input.phase !== 'PREPARE' && !isDeepStrictEqual(input.selection, expected.selection);

const changedCandidateQuantity = (
  quantity: Extract<QuantityNormalization, { status: 'VALID' }>,
  expected: NonNullable<CatalogQuantityPreparationRequest['expected']>,
): boolean => !isDeepStrictEqual(quantity, expected.quantity);

const missingLaterPhaseBasis = (input: CatalogQuantityPreparationRequest): boolean =>
  input.phase !== 'PREPARE' && input.expected === undefined;

const changedCandidateSources = (
  expected: CatalogQuantityPreparationRequest['expected'],
  actual: Parameters<typeof changedSources>[1],
): boolean => expected !== undefined && changedSources(expected, actual);

const readSelectionBasis = Effect.fn('CatalogQuantityPreparation.readSelectionBasis')(
  function* readSelectionBasisOperation(transaction: ScopedTransaction, tenantId: string, selection: CatalogSelection) {
    const [product] = yield* transaction
      .select()
      .from(products)
      .where(and(eq(products.tenantId, tenantId), eq(products.productId, selection.productRef.resourceId)))
      .limit(1);
    if (product === undefined) {
      return failure('INDETERMINATE', 'Product basis is missing');
    }
    const [variant] = yield* transaction
      .select()
      .from(productVariants)
      .where(
        and(eq(productVariants.tenantId, tenantId), eq(productVariants.variantId, selection.variantRef.resourceId)),
      )
      .limit(1);
    if (variant === undefined) {
      return failure('INDETERMINATE', 'Variant basis is missing');
    }
    if (variant.productId !== product.productId) {
      return failure('INVALID', 'Variant belongs to another Product');
    }
    if (product.lifecycleState !== 'ACTIVE' || variant.lifecycleState !== 'ACTIVE') {
      return failure('INVALID', 'Product or Variant is not active');
    }
    if (!validRevision(product.currentRevision) || !validRevision(variant.currentRevision)) {
      return failure('INDETERMINATE', 'Product or Variant revision is unusable');
    }
    const packageId = selection.packageOption?.optionRef.resourceId;
    if (packageId === undefined) {
      return { pack: null, product, variant };
    }
    const [pack] = yield* transaction
      .select()
      .from(packageDefinitions)
      .where(and(eq(packageDefinitions.tenantId, tenantId), eq(packageDefinitions.packageDefinitionId, packageId)))
      .limit(1);
    if (pack === undefined) {
      return failure('INDETERMINATE', 'Package Definition basis is missing');
    }
    if (pack.productId !== product.productId || pack.variantId !== variant.variantId) {
      return failure('INVALID', 'Package Definition belongs to another Product or Variant');
    }
    if (pack.lifecycleState !== 'ACTIVE' || pack.optionState !== 'ACTIVE') {
      return failure('INVALID', 'Package Option is not selectable');
    }
    if (!validRevision(pack.currentRevision)) {
      return failure('INDETERMINATE', 'Package Definition revision is unusable');
    }
    const revisions = yield* transaction
      .select()
      .from(packageContentRevisions)
      .where(
        and(eq(packageContentRevisions.tenantId, tenantId), eq(packageContentRevisions.packageDefinitionId, packageId)),
      );
    if (revisions.length !== pack.currentRevision) {
      return failure('INDETERMINATE', 'Package Content revision history is incomplete');
    }
    const effectiveRevision = Match.value(
      resolveEffectiveRevision(revisions, DateTime.toDateUtc(yield* DateTime.now)),
    ).pipe(
      Match.tag('resolved', ({ revision }) => revision),
      Match.tag('invalid', () => null),
      Match.exhaustive,
    );
    if (effectiveRevision === null) {
      return failure('INDETERMINATE', 'Package Content has no unambiguous effective revision');
    }
    if (selection.packageOption?.contentRevision.revision !== effectiveRevision) {
      return failure('STALE', 'Selected Package Content is not Current');
    }
    return { pack, product, variant };
  },
  Effect.mapError(unavailable),
);

const readUnitBasis = Effect.fn('CatalogQuantityPreparation.readUnitBasis')(function* readUnitBasisOperation(
  transaction: ScopedTransaction,
  tenantId: string,
  targetId: string,
  isPackage: boolean,
) {
  const [target] = isPackage
    ? yield* transaction
        .select()
        .from(packageUnitDivisibility)
        .where(
          and(
            eq(packageUnitDivisibility.tenantId, tenantId),
            eq(packageUnitDivisibility.packageDefinitionId, targetId),
          ),
        )
        .limit(1)
    : yield* transaction
        .select()
        .from(variantUnitDivisibility)
        .where(and(eq(variantUnitDivisibility.tenantId, tenantId), eq(variantUnitDivisibility.variantId, targetId)))
        .limit(1);
  if (target === undefined || !validRevision(target.currentRevision)) {
    return failure('INDETERMINATE', 'Target Unit or divisibility revision is missing');
  }
  const [unit] = yield* transaction
    .select()
    .from(productUnits)
    .where(and(eq(productUnits.tenantId, tenantId), eq(productUnits.unitId, target.unitId)))
    .limit(1);
  if (unit === undefined || !validRevision(unit.currentRuleRevision)) {
    return failure('INDETERMINATE', 'Product Unit basis is missing');
  }
  if (unit.lifecycleState !== 'ACTIVE') {
    return failure('INVALID', 'Product Unit is retired');
  }
  const [rule] = yield* transaction
    .select()
    .from(productUnitRuleRevisions)
    .where(
      and(
        eq(productUnitRuleRevisions.tenantId, tenantId),
        eq(productUnitRuleRevisions.unitId, unit.unitId),
        eq(productUnitRuleRevisions.revision, unit.currentRuleRevision),
      ),
    )
    .limit(1);
  if (rule === undefined || (rule.rounding !== 'UP' && rule.rounding !== 'DOWN' && rule.rounding !== 'HALF_UP')) {
    return failure('INDETERMINATE', 'Current Unit rule is missing or unusable');
  }
  const rounding: 'UP' | 'DOWN' | 'HALF_UP' = rule.rounding;
  return { rounding, rule, target, unit };
}, Effect.mapError(unavailable));

/** Owner-local candidate preparation. The caller supplies Core's one scoped transaction. */
export const catalogQuantityPreparationForScope = (transaction: ScopedTransaction, scope: OperationalScope) => ({
  prepare: Effect.fn('CatalogQuantityPreparation.prepare')(function* prepare(
    input: CatalogQuantityPreparationRequest,
  ): Effect.fn.Return<CatalogQuantityPreparation, CatalogPersistenceUnavailable> {
    const { selection } = input;
    const { tenantId } = scope;
    if (!Schema.is(CatalogSelectionSchema)(selection) || selection.productRef.tenantId !== tenantId) {
      return failure('INVALID', 'Selection is malformed or outside the trusted Tenant');
    }
    if (missingLaterPhaseBasis(input)) {
      return failure('INDETERMINATE', 'Later phases require the prepared candidate and revisions');
    }
    if (input.expected !== undefined && changedCandidateSelection(input, input.expected)) {
      return failure('STALE', 'Candidate Catalog selection changed');
    }
    const selectionBasis = yield* readSelectionBasis(transaction, tenantId, selection);
    if ('status' in selectionBasis) {
      return selectionBasis;
    }
    const { pack, product, variant } = selectionBasis;
    const packageId = selection.packageOption?.optionRef.resourceId;
    const targetId = packageId ?? variant.variantId;
    const unitBasis = yield* readUnitBasis(transaction, tenantId, targetId, packageId !== undefined);
    if ('status' in unitBasis) {
      return unitBasis;
    }
    const { rounding, rule, target, unit } = unitBasis;

    const { expected } = input;
    if (
      changedCandidateSources(expected, {
        packageDefinitionRevision: pack?.currentRevision,
        productRevision: product.currentRevision,
        targetDivisibilityRevision: target.currentRevision,
        unitRuleRevision: unit.currentRuleRevision,
        variantRevision: variant.currentRevision,
      })
    ) {
      return failure('STALE', 'Candidate Catalog quantity sources changed');
    }

    const quantity = normalizePurchaseQuantity(
      {
        amount: input.amount,
        divisible: target.divisible,
        targetId,
        tenantId,
        unitId: unit.unitId,
      },
      {
        revision: rule.revision,
        rounding,
        step: rule.step,
        tenantId,
        unitId: unit.unitId,
      },
      'PREPARE',
    );
    if (quantity.status !== 'VALID') {
      if (quantity.status === 'INVALID') {
        return failure('INVALID', quantity.reason);
      }
      if (quantity.status === 'REPREPARE_REQUIRED') {
        return failure('STALE', quantity.reason);
      }
      return failure('INDETERMINATE', quantity.reason);
    }
    if (input.phase !== 'PREPARE' && expected !== undefined && changedCandidateQuantity(quantity, expected)) {
      return failure('STALE', 'Candidate Catalog quantity changed');
    }
    const unitRef = {
      moduleId: 'commerce.catalog',
      resourceId: unit.unitId,
      resourceType: 'commerce.catalog.product-unit',
      tenantId,
    } as const;
    const productSource = yield* Schema.decodeEffect(CatalogSelectionRevisionSchema)({
      resourceRef: selection.productRef,
      revision: product.currentRevision,
    }).pipe(Effect.mapError(unavailable));
    const variantSource = yield* Schema.decodeEffect(CatalogSelectionRevisionSchema)({
      resourceRef: selection.variantRef,
      revision: variant.currentRevision,
    }).pipe(Effect.mapError(unavailable));
    const packageSource =
      pack === null || selection.packageOption === undefined
        ? undefined
        : yield* Schema.decodeEffect(CatalogSelectionRevisionSchema)({
            resourceRef: selection.packageOption.optionRef,
            revision: pack.currentRevision,
          }).pipe(Effect.mapError(unavailable));
    const sources = {
      packageDefinition: packageSource,
      product: productSource,
      targetDivisibilityRevision: target.currentRevision,
      unitRuleRevision: unit.currentRuleRevision,
      variant: variantSource,
    };
    return {
      divisible: target.divisible,
      quantity,
      selection,
      sources,
      status: 'PREPARED',
      unitRef,
    };
  }),
});
