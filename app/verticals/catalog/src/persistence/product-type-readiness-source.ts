import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { and, desc, eq } from 'drizzle-orm';
import { DateTime, Effect, Option, Schema } from 'effect';

import {
  ProductTypeCurrentBasisSchema,
  ProductTypeCurrentRulesRevisionSchema,
} from '../../shared/domain/product-type-rules.ts';
import type {
  ProductTypeCurrentBasis,
  ProductTypeCurrentRulesRevision,
} from '../../shared/domain/product-type-rules.ts';
import type { ProductRef } from '../../shared/resources/product.ts';
import type { ProductTypeRef } from '../../shared/resources/product-type.ts';
import type { VariantRef } from '../../shared/resources/variant.ts';
import type { CatalogSelection } from '../../shared/domain/catalog-selection-evidence.ts';
import {
  CatalogSelectionBasisSchema,
  sameCatalogSelectionBasis,
} from '../../shared/domain/catalog-selection-evidence.ts';
import type { CatalogSelectionCurrentFacts } from '../../shared/domain/catalog-selection-assessment.ts';
import { CatalogRevisionNumberSchema } from '../../shared/domain/catalog-revision-reference.ts';
import { effectiveValueItemKeyHash, variantAxisPersistenceForScope } from './variant-axis-persistence.ts';
import type { CurrentVariantAxes, CurrentVariantAxisValue } from './variant-axis-persistence.ts';
import { evaluateCurrentProductTypeReadiness } from './product-type-readiness-evaluator.ts';
import type { ProductTypeReadinessEvaluation } from './product-type-readiness-evaluator.ts';
import {
  productVariantAxes,
  productVariants,
  productTypeAssignments,
  productTypeUntypedDecisions,
  productVariantAxisEvents,
  productTypeRevisionAttributes,
  productTypeRevisions,
  productTypes,
  products,
} from '../database/schema.ts';
import { CatalogPersistenceUnavailable } from './errors.ts';
import { effectiveAttributeValueReadsForScope } from './effective-attribute-value-reads.ts';
import type {
  AttributeValueSetValidityEntry,
  AttributeValueSetValidityBasis,
  EffectiveAttributeValueReads,
} from './effective-attribute-value-reads.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];

class ProductTypeReadinessSourceInvalid extends Schema.TaggedError<ProductTypeReadinessSourceInvalid>()(
  'ProductTypeReadinessSourceInvalid',
  { code: Schema.Literal('product_type_readiness_source_invalid'), reason: Schema.String },
) {}

export type ProductTypeReadinessSource =
  | { readonly productRef: ProductRef; readonly status: 'UNTYPED' }
  | {
      readonly assignmentRevision: number;
      readonly basis: ProductTypeCurrentBasis;
      readonly productRef: ProductRef;
      readonly rulesRevision: ProductTypeCurrentRulesRevision;
      readonly status: 'VERIFIED';
    };

const invalid = (reason: string) =>
  new ProductTypeReadinessSourceInvalid({ code: 'product_type_readiness_source_invalid', reason });
const malformedRulesReason = 'Current Product Type rules are malformed';
const catalogModuleId = 'commerce.catalog' as const;
const attributeDefinitionResourceType = 'commerce.catalog.attribute-definition' as const;
const sameTokens = (actual: readonly string[], expected: readonly string[]): boolean =>
  actual.length === expected.length && actual.every((token, index) => token === expected[index]);

interface UntypedDecisionCheck {
  readonly reason?: string;
  readonly revision?: number;
}

const confirmedDecisionRevision = (
  decision: typeof productTypeUntypedDecisions.$inferSelect | undefined,
  basis: {
    readonly axisRevision: number;
    readonly hasCurrentStructuredValues: boolean;
    readonly productId: string;
    readonly productRevision: number;
    readonly tenantId: string;
    readonly valueTokens: readonly string[];
    readonly variantTokens: readonly string[];
  },
): UntypedDecisionCheck => {
  if (decision === undefined) {
    return {};
  }
  if (
    decision.tenantId !== basis.tenantId ||
    decision.productId !== basis.productId ||
    !Number.isSafeInteger(decision.decisionRevision) ||
    decision.decisionRevision < 1
  ) {
    return { reason: 'Untyped decision provenance or state is invalid' };
  }
  if (decision.decisionState === 'REVOKED') {
    return {};
  }
  if (decision.decisionState !== 'CONFIRMED') {
    return { reason: 'Untyped decision state is invalid' };
  }
  if (
    decision.structuredAttributesRequired ||
    decision.variantAxesRequired ||
    decision.productRevision !== basis.productRevision ||
    decision.axisRevision !== basis.axisRevision ||
    !sameTokens(basis.valueTokens, decision.valueRevisionTokens) ||
    !sameTokens(basis.variantTokens, decision.variantRevisionTokens) ||
    basis.hasCurrentStructuredValues
  ) {
    return {
      reason: 'Confirmed untyped decision no longer matches Current Product, axis, value, or Variant inventory',
    };
  }
  return { revision: decision.decisionRevision };
};

const inventoryProblem = (
  inventory: AttributeValueSetValidityBasis,
  variants: readonly {
    readonly lifecycleState: string;
    readonly productId: string;
    readonly tenantId: string;
    readonly variantId: string;
  }[],
  productRef: ProductRef,
): string | null => {
  if (
    !inventory.complete ||
    inventory.tenantId !== productRef.tenantId ||
    inventory.entries.some((entry) => entry.productId !== productRef.resourceId)
  ) {
    return 'Complete Current attribute value inventory is unavailable';
  }
  if (variants.some((row) => row.tenantId !== productRef.tenantId || row.productId !== productRef.resourceId)) {
    return 'Current Variant inventory is foreign';
  }
  // Retained direct sets belong to the full owner inventory, including retired siblings.
  // Current applicability is evaluated separately below.
  const ids = new Set(variants.map((row) => row.variantId));
  return ids.size !== variants.length ||
    inventory.entries.some((entry) => entry.variantId !== null && !ids.has(entry.variantId))
    ? 'Current Variant value inventory is incomplete or inconsistent'
    : null;
};

interface ProductTypeReadinessService {
  readonly evaluate: (
    productRef: ProductRef,
    evaluatedAt: DateTime.Utc,
    selectedVariantRef?: VariantRef,
  ) => Effect.Effect<ProductTypeReadinessEvaluation, ProductTypeReadinessSourceInvalid | CatalogPersistenceUnavailable>;
  readonly load: (
    productRef: ProductRef,
    evaluatedAt: DateTime.Utc,
  ) => Effect.Effect<ProductTypeReadinessSource, ProductTypeReadinessSourceInvalid | CatalogPersistenceUnavailable>;
}

const unavailable = (cause: unknown): CatalogPersistenceUnavailable => {
  const failure = new CatalogPersistenceUnavailable({
    code: 'catalog_persistence_unavailable',
    reason: 'Catalog persistence is temporarily unavailable',
  });
  Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  return failure;
};

const validProductReference = (productRef: ProductRef, tenantId: string): boolean =>
  productRef.tenantId === tenantId &&
  productRef.moduleId === catalogModuleId &&
  productRef.resourceType === 'commerce.catalog.product';

const validAssignment = (
  assignment: typeof productTypeAssignments.$inferSelect,
  productRef: ProductRef,
  tenantId: string,
): boolean =>
  assignment.tenantId === tenantId &&
  assignment.productId === productRef.resourceId &&
  Number.isInteger(assignment.assignmentRevision) &&
  assignment.assignmentRevision >= 1;

const readVariantSnapshot = Effect.fn('ProductTypeReadinessSource.readVariantSnapshot')(function* readVariantSnapshot(
  reads: EffectiveAttributeValueReads,
  inventory: AttributeValueSetValidityBasis,
  source: ProductTypeReadinessSource,
  productRef: ProductRef,
  variantRef: VariantRef,
) {
  const directEntries = inventory.entries.filter((entry) => entry.variantId === variantRef.resourceId);
  const directIds: string[] = [];
  for (const entry of directEntries) {
    if (entry.currentState === 'SET') {
      directIds.push(entry.attributeDefinitionId);
    }
  }
  const effectiveValues =
    source.status === 'VERIFIED'
      ? yield* Effect.forEach(
          source.rulesRevision.rules.filter((rule) => rule.level === 'VARIANT'),
          (rule) =>
            reads
              .resolveVariant({
                attributeDefinitionRef: {
                  ...rule.attributeDefinitionRef,
                  resourceType: attributeDefinitionResourceType,
                },
                productRef,
                variantRef,
              })
              .pipe(
                Effect.map((result) => ({ attributeDefinitionId: rule.attributeDefinitionRef.resourceId, result })),
              ),
          { concurrency: 1 },
        )
      : [];
  return {
    currentAttributeDefinitionIds: directIds,
    currentValueSource: {
      complete: true as const,
      revisionTokens: directEntries.map((entry) => entry.sourceRevisionToken).toSorted(),
    },
    effectiveValues,
    variantRef,
  };
});

/** Private source for #424; this proves rules provenance, not attribute or overall Catalog readiness. */
export const productTypeReadinessSourceForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
): ProductTypeReadinessService => ({
  evaluate: Effect.fn('ProductTypeReadinessSource.evaluate')(function* evaluate(
    productRef: ProductRef,
    evaluatedAt: DateTime.Utc,
    selectedVariantRef?: VariantRef,
  ) {
    const [source, reads] = yield* Effect.all(
      [
        productTypeReadinessSourceForScope(transaction, scope).load(productRef, evaluatedAt),
        effectiveAttributeValueReadsForScope(transaction, scope),
      ],
      { concurrency: 2 },
    );
    const [inventory, variantRows] = yield* Effect.all(
      [
        reads.readProductTypeValidity([productRef.resourceId]),
        transaction
          .select({
            currentRevision: productVariants.currentRevision,
            lifecycleState: productVariants.lifecycleState,
            productId: productVariants.productId,
            tenantId: productVariants.tenantId,
            variantId: productVariants.variantId,
          })
          .from(productVariants)
          .where(
            and(eq(productVariants.tenantId, scope.tenantId), eq(productVariants.productId, productRef.resourceId)),
          )
          .for('share')
          .pipe(Effect.mapError(unavailable)),
      ],
      { concurrency: 1 },
    );
    const problem = inventoryProblem(inventory, variantRows, productRef);
    if (problem !== null) {
      return { reason: problem, status: 'INDETERMINATE' };
    }
    const currentVariants = variantRows.filter((row) => row.lifecycleState !== 'RETIRED');
    const productEntries = inventory.entries.filter((entry) => entry.variantId === null);
    const requiredProductDefinitionIds = new Set<string>();
    if (source.status === 'VERIFIED') {
      for (const rule of source.rulesRevision.rules) {
        if (rule.level === 'PRODUCT' && rule.required) {
          requiredProductDefinitionIds.add(rule.attributeDefinitionRef.resourceId);
        }
      }
    }
    const productValues = [];
    for (const entry of productEntries) {
      if (entry.currentState === 'SET') {
        productValues.push({
          attributeDefinitionRef: {
            moduleId: catalogModuleId,
            resourceId: entry.attributeDefinitionId,
            resourceType: attributeDefinitionResourceType,
            tenantId: scope.tenantId,
          },
          valid:
            entry.valid &&
            (!requiredProductDefinitionIds.has(entry.attributeDefinitionId) || entry.confirmsRequiredFact),
        });
      }
    }
    const evaluationVariants =
      source.status === 'VERIFIED' && selectedVariantRef !== undefined
        ? currentVariants.filter((row) => row.variantId === selectedVariantRef.resourceId)
        : currentVariants;
    const variantRefs = evaluationVariants.map((row) => ({
      moduleId: catalogModuleId,
      resourceId: row.variantId,
      resourceType: 'commerce.catalog.variant' as const,
      tenantId: scope.tenantId,
    }));
    const variants = yield* Effect.forEach(
      variantRefs,
      (variantRef) => readVariantSnapshot(reads, inventory, source, productRef, variantRef),
      { concurrency: 1 },
    );
    let confirmedUntypedDecisionRevision: number | undefined;
    if (source.status === 'UNTYPED') {
      const axes = yield* transaction
        .select({ attributeDefinitionId: productVariantAxes.attributeDefinitionId })
        .from(productVariantAxes)
        .where(
          and(eq(productVariantAxes.tenantId, scope.tenantId), eq(productVariantAxes.productId, productRef.resourceId)),
        )
        .for('share')
        .pipe(Effect.mapError(unavailable));
      if (axes.length > 0) {
        return { reason: 'Untyped Product still has Variant Axes', status: 'INDETERMINATE' };
      }
      const [productRows, decisions, axisEvents] = yield* Effect.all(
        [
          transaction
            .select({
              currentRevision: products.currentRevision,
              productId: products.productId,
              tenantId: products.tenantId,
            })
            .from(products)
            .where(and(eq(products.tenantId, scope.tenantId), eq(products.productId, productRef.resourceId)))
            .for('share')
            .limit(1)
            .pipe(Effect.mapError(unavailable)),
          transaction
            .select()
            .from(productTypeUntypedDecisions)
            .where(
              and(
                eq(productTypeUntypedDecisions.tenantId, scope.tenantId),
                eq(productTypeUntypedDecisions.productId, productRef.resourceId),
              ),
            )
            .orderBy(desc(productTypeUntypedDecisions.decisionRevision))
            .limit(1)
            .pipe(Effect.mapError(unavailable)),
          transaction
            .select()
            .from(productVariantAxisEvents)
            .where(
              and(
                eq(productVariantAxisEvents.tenantId, scope.tenantId),
                eq(productVariantAxisEvents.productId, productRef.resourceId),
              ),
            )
            .orderBy(desc(productVariantAxisEvents.axisRevision))
            .limit(1)
            .pipe(Effect.mapError(unavailable)),
        ],
        { concurrency: 1 },
      );
      const [product] = productRows;
      const [decision] = decisions;
      if (product === undefined || product.tenantId !== scope.tenantId || product.productId !== productRef.resourceId) {
        return { reason: 'Current Product revision is unavailable', status: 'INDETERMINATE' };
      }
      const decisionCheck = confirmedDecisionRevision(decision, {
        axisRevision: axisEvents[0]?.axisRevision ?? 0,
        hasCurrentStructuredValues: inventory.entries.some((entry) => entry.currentState === 'SET'),
        productId: productRef.resourceId,
        productRevision: product.currentRevision,
        tenantId: scope.tenantId,
        valueTokens: productEntries.map((entry) => entry.sourceRevisionToken).toSorted(),
        variantTokens: [
          ...currentVariants.map((variant) => `${variant.variantId}:${variant.currentRevision}`),
          ...inventory.entries
            .filter((entry) => entry.variantId !== null)
            .map((entry) => `${entry.variantId}:${entry.sourceRevisionToken}`),
        ].toSorted(),
      });
      if (decisionCheck.reason !== undefined) {
        return { reason: decisionCheck.reason, status: 'INDETERMINATE' };
      }
      confirmedUntypedDecisionRevision = decisionCheck.revision;
    }
    return evaluateCurrentProductTypeReadiness(
      {
        confirmedUntypedDecisionRevision,
        productValues,
        productValueSource: {
          complete: true,
          revisionTokens: productEntries.map((entry) => entry.sourceRevisionToken).toSorted(),
        },
        source,
        variantRefs,
        variants,
      },
      selectedVariantRef,
    );
  }),
  load: Effect.fn('ProductTypeReadinessSource.load')(function* load(productRef: ProductRef, evaluatedAt: DateTime.Utc) {
    const { tenantId } = scope;
    if (!validProductReference(productRef, tenantId) || !DateTime.isDateTime(evaluatedAt)) {
      return yield* invalid('Invalid Product or evaluation instant');
    }
    const [product] = yield* transaction
      .select({ productId: products.productId })
      .from(products)
      .where(and(eq(products.tenantId, tenantId), eq(products.productId, productRef.resourceId)))
      .for('share')
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    if (product === undefined) {
      return yield* invalid('Product not found in Tenant');
    }
    const [assignment] = yield* transaction
      .select()
      .from(productTypeAssignments)
      .where(
        and(eq(productTypeAssignments.tenantId, tenantId), eq(productTypeAssignments.productId, productRef.resourceId)),
      )
      .for('share')
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    if (assignment === undefined) {
      return { productRef, status: 'UNTYPED' } as const;
    }
    if (!validAssignment(assignment, productRef, tenantId)) {
      return yield* invalid('Product Type assignment is malformed');
    }
    const [type] = yield* transaction
      .select()
      .from(productTypes)
      .where(and(eq(productTypes.tenantId, tenantId), eq(productTypes.productTypeId, assignment.productTypeId)))
      .for('share')
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    if (type === undefined || type.tenantId !== tenantId || type.productTypeId !== assignment.productTypeId) {
      return yield* invalid('Assigned Product Type is missing');
    }
    const [revision] = yield* transaction
      .select()
      .from(productTypeRevisions)
      .where(
        and(
          eq(productTypeRevisions.tenantId, tenantId),
          eq(productTypeRevisions.productTypeId, type.productTypeId),
          eq(productTypeRevisions.revision, type.currentRevision),
        ),
      )
      .for('share')
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    if (
      revision === undefined ||
      revision.tenantId !== tenantId ||
      revision.productTypeId !== type.productTypeId ||
      revision.revision !== type.currentRevision
    ) {
      return yield* invalid('Current Product Type revision is missing');
    }
    const rules = yield* transaction
      .select()
      .from(productTypeRevisionAttributes)
      .where(
        and(
          eq(productTypeRevisionAttributes.tenantId, tenantId),
          eq(productTypeRevisionAttributes.productTypeId, type.productTypeId),
          eq(productTypeRevisionAttributes.revision, type.currentRevision),
        ),
      )
      .pipe(Effect.mapError(unavailable));
    if (
      rules.some(
        (rule) =>
          rule.tenantId !== tenantId ||
          rule.productTypeId !== type.productTypeId ||
          rule.revision !== type.currentRevision,
      )
    ) {
      return yield* invalid(malformedRulesReason);
    }
    const productTypeRef: ProductTypeRef = {
      moduleId: catalogModuleId,
      resourceId: type.productTypeId,
      resourceType: 'commerce.catalog.product-type' as const,
      tenantId,
    };
    const decodedRules = Schema.decodeUnknownOption(ProductTypeCurrentRulesRevisionSchema)({
      effectiveFrom: DateTime.formatIso(DateTime.fromDateUnsafe(revision.effectiveAt)),
      productTypeRef,
      revision: revision.revision,
      revisionId: revision.productTypeRevisionId,
      rules: rules.map((rule) => ({
        attributeDefinitionRef: {
          moduleId: catalogModuleId,
          resourceId: rule.attributeDefinitionId,
          resourceType: 'commerce.catalog.attribute-definition',
          tenantId,
        },
        level: rule.level,
        required: rule.requirement === 'REQUIRED',
      })),
    });
    if (Option.isNone(decodedRules)) {
      return yield* invalid(malformedRulesReason);
    }
    const rulesRevision = decodedRules.value;
    const decodedBasis = Schema.decodeOption(ProductTypeCurrentBasisSchema)({
      currentRevision: type.currentRevision,
      effectiveFrom: rulesRevision.effectiveFrom,
      evaluatedAt: DateTime.formatIso(evaluatedAt),
      productTypeRef,
      revision: rulesRevision.revision,
      revisionId: rulesRevision.revisionId,
    });
    if (Option.isNone(decodedBasis)) {
      return yield* invalid('Current Product Type basis is malformed');
    }
    if (DateTime.toEpochMillis(evaluatedAt) < DateTime.toEpochMillis(DateTime.fromDateUnsafe(revision.effectiveAt))) {
      return yield* invalid('Product Type revision is not yet effective');
    }
    return {
      assignmentRevision: assignment.assignmentRevision,
      basis: decodedBasis.value,
      productRef,
      rulesRevision,
      status: 'VERIFIED',
    } as const;
  }),
});

const appendAxisValueBasis = (
  basis: CatalogSelectionCurrentFacts['basis'][number][],
  values: readonly CurrentVariantAxisValue[],
  tenantId: string,
): string | null => {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value.attributeDefinitionId)) {
      return 'Current Variant axes repeat an Attribute Definition';
    }
    seen.add(value.attributeDefinitionId);
    const definitionRevision = Schema.decodeOption(CatalogRevisionNumberSchema)(value.definitionRevision);
    if (Option.isNone(definitionRevision)) {
      return 'Current axis Attribute Definition revision is unavailable';
    }
    basis.push({
      role: 'ATTRIBUTE_DEFINITION',
      source: {
        resourceRef: {
          moduleId: catalogModuleId,
          resourceId: value.attributeDefinitionId,
          resourceType: attributeDefinitionResourceType,
          tenantId,
        },
        revision: definitionRevision.value,
      },
    });
    if (value.source === 'MISSING') {
      if (value.sourceRevision !== null || value.sourceValueSetRef !== null) {
        return 'Missing Current axis value has a contradictory owner source';
      }
      continue;
    }
    const valueRevision = Schema.decodeUnknownOption(CatalogRevisionNumberSchema)(value.sourceRevision);
    if (
      Option.isNone(valueRevision) ||
      value.sourceValueSetRef === null ||
      value.sourceValueSetRef.tenantId !== tenantId
    ) {
      return 'Current axis value has no owner-qualified revision';
    }
    basis.push({
      role: value.source === 'PRODUCT' ? 'INHERITED_VALUE' : 'OTHER_CATALOG_FACT',
      source: {
        resourceRef: {
          moduleId: catalogModuleId,
          resourceId: value.sourceValueSetRef.attributeValueSetId,
          resourceType: 'commerce.catalog.attribute-value-set',
          tenantId,
        },
        revision: valueRevision.value,
      },
    });
  }
  return null;
};

const readProductValueValidity = Effect.fn('CatalogSelectionCurrentBasis.readProductValueValidity')(
  function* readProductValueValidity(
    transaction: ScopedTransaction,
    scope: OperationalScope,
    productId: string,
    variantId: string,
  ) {
    const reads = yield* effectiveAttributeValueReadsForScope(transaction, scope);
    const validity = yield* reads.readProductTypeValidity([productId]).pipe(Effect.orElseSucceed(() => null));
    if (validity === null || !validity.complete || validity.tenantId !== scope.tenantId) {
      return { reason: 'Current Product Attribute value inventory is unavailable', status: 'INDETERMINATE' as const };
    }
    if (validity.entries.some((entry) => entry.productId !== productId)) {
      return {
        reason: 'Current Product Attribute inventory contains a foreign Product',
        status: 'INDETERMINATE' as const,
      };
    }
    if (validity.entries.some((entry) => (entry.variantId === null || entry.variantId === variantId) && !entry.valid)) {
      return { reason: 'Current Product Attribute value is invalid', status: 'INVALID' as const };
    }
    return validity.entries.filter((entry) => entry.variantId === null || entry.variantId === variantId);
  },
);

const appendProductValueBasis = (
  basis: CatalogSelectionCurrentFacts['basis'][number][],
  entries: readonly AttributeValueSetValidityEntry[],
  tenantId: string,
): string | null => {
  for (const entry of entries) {
    const revision = Schema.decodeOption(CatalogRevisionNumberSchema)(entry.revision);
    const definitionRevision = Schema.decodeOption(CatalogRevisionNumberSchema)(entry.definitionRevision);
    if (Option.isNone(revision) || Option.isNone(definitionRevision)) {
      return 'Current Attribute value or definition revision is unavailable';
    }
    basis.push(
      {
        role: entry.variantId === null ? 'INHERITED_VALUE' : 'OTHER_CATALOG_FACT',
        source: {
          resourceRef: {
            moduleId: catalogModuleId,
            resourceId: entry.attributeValueSetId,
            resourceType: 'commerce.catalog.attribute-value-set',
            tenantId,
          },
          revision: revision.value,
        },
      },
      {
        role: 'ATTRIBUTE_DEFINITION',
        source: {
          resourceRef: {
            moduleId: catalogModuleId,
            resourceId: entry.attributeDefinitionId,
            resourceType: attributeDefinitionResourceType,
            tenantId,
          },
          revision: definitionRevision.value,
        },
      },
    );
  }
  return null;
};

const verifyProductTypeReadiness = Effect.fn('CatalogSelectionCurrentBasis.verifyProductTypeReadiness')(
  function* verifyProductTypeReadiness(
    transaction: ScopedTransaction,
    scope: OperationalScope,
    selection: CatalogSelection,
    now: DateTime.Utc,
    source: { readonly rulesRevision: number; readonly status: 'VERIFIED' } | { readonly status: 'UNTYPED' },
  ) {
    const readiness = yield* productTypeReadinessSourceForScope(transaction, scope)
      .evaluate(selection.productRef, now, selection.variantRef)
      .pipe(Effect.orElseSucceed(() => null));
    if (readiness === null || readiness.status === 'INDETERMINATE') {
      return { reason: 'Current Product Type readiness cannot be proved', status: 'INDETERMINATE' as const };
    }
    if (readiness.status === 'INVALID') {
      return { reason: 'Current Product Type requirements are invalid', status: 'INVALID' as const };
    }
    if (source.status === 'UNTYPED') {
      if (readiness.status !== 'CONFIRMED_UNTYPED_MINIMUM') {
        return {
          reason: 'Current confirmed-untyped decision is not completely attested',
          status: 'INDETERMINATE' as const,
        };
      }
      const revision = Schema.decodeOption(CatalogRevisionNumberSchema)(readiness.decisionRevision);
      return Option.isNone(revision)
        ? { reason: 'Current untyped decision revision is unavailable', status: 'INDETERMINATE' as const }
        : { decisionRevision: revision.value, reason: null };
    }
    if (readiness.status !== 'VERIFIED_TYPE_MINIMUM' || readiness.rulesRevision !== source.rulesRevision) {
      return {
        reason: 'Current Product Type requirements are not completely attested',
        status: 'INDETERMINATE' as const,
      };
    }
    const revision = Schema.decodeOption(CatalogRevisionNumberSchema)(readiness.assignmentRevision);
    return Option.isNone(revision)
      ? { reason: 'Current Product Type assignment revision is unavailable', status: 'INDETERMINATE' as const }
      : { reason: null };
  },
);

const exactAxisValueInventory = (
  axes: CurrentVariantAxes,
  values: readonly Pick<CurrentVariantAxisValue, 'attributeDefinitionId' | 'definitionRevision'>[],
): boolean =>
  values.length === axes.axes.length &&
  axes.axes.every((axis) =>
    values.some(
      (value) =>
        value.attributeDefinitionId === axis.attributeDefinitionId &&
        value.definitionRevision === axis.definitionRevision,
    ),
  );

const readSelectionAxisAllowances = Effect.fn('ProductTypeReadinessSource.readSelectionAxisAllowances')(
  function* readSelectionAxisAllowances(
    axisReader: ReturnType<typeof variantAxisPersistenceForScope>,
    axes: CurrentVariantAxes,
    axisValues: readonly CurrentVariantAxisValue[],
    productRef: ProductRef,
    basis: CatalogSelectionCurrentFacts['basis'][number][],
  ) {
    const allowances = yield* axisReader
      .readCurrentAllowedValues(productRef, axes)
      .pipe(Effect.orElseSucceed(() => null));
    if (allowances === null || !exactAxisValueInventory(axes, allowances)) {
      return {
        reason: 'Current Product-specific axis allowances are unavailable or incomplete',
        status: 'INDETERMINATE' as const,
      };
    }
    const axisProof = yield* Schema.decodeUnknownEffect(CatalogSelectionBasisSchema)({
      axisAllowances: allowances.map((allowed) => ({
        allowanceRevision: allowed.allowanceRevision,
        attributeDefinition: {
          resourceRef: {
            moduleId: catalogModuleId,
            resourceId: allowed.attributeDefinitionId,
            resourceType: attributeDefinitionResourceType,
            tenantId: productRef.tenantId,
          },
          revision: allowed.definitionRevision,
        },
      })),
      role: 'VARIANT_AXIS',
      source: { resourceRef: productRef, revision: axes.axisRevision },
    }).pipe(Effect.orElseSucceed(() => null));
    if (axisProof === null) {
      return {
        reason: 'Current Product-specific axis allowance proof is malformed',
        status: 'INDETERMINATE' as const,
      };
    }
    basis.push(axisProof);
    const allowedByDefinition = new Map(
      allowances.map((allowed) => [allowed.attributeDefinitionId, new Set(allowed.valueKeys)]),
    );
    for (const value of axisValues) {
      if (value.source === 'MISSING' || value.items.length === 0) {
        return { reason: 'Current Variant axis value is missing', status: 'INVALID' as const };
      }
      const allowed = allowedByDefinition.get(value.attributeDefinitionId);
      if (allowed === undefined) {
        return { reason: 'Current Product-specific axis allowance is unavailable', status: 'INDETERMINATE' as const };
      }
      if (value.items.some((item) => !allowed.has(effectiveValueItemKeyHash(item)))) {
        return { reason: 'Current Variant axis value is not permitted for this Product', status: 'INVALID' as const };
      }
    }
    return null;
  },
);

const readSelectionAxisBasis = Effect.fn('ProductTypeReadinessSource.readSelectionAxisBasis')(
  function* readSelectionAxisBasis(
    transaction: ScopedTransaction,
    scope: OperationalScope,
    selection: CatalogSelection,
    typeSource: ProductTypeReadinessSource,
    basis: CatalogSelectionCurrentFacts['basis'][number][],
  ) {
    const axisReader = variantAxisPersistenceForScope(transaction, scope);
    const axes = yield* axisReader.readCurrent(selection.productRef).pipe(Effect.orElseSucceed(() => null));
    if (axes === null || axes.productId !== selection.productRef.resourceId) {
      return { reason: 'Current Variant axes are unavailable', status: 'INDETERMINATE' as const };
    }
    if (typeSource.status === 'VERIFIED') {
      if (axes.productTypeRevision !== typeSource.basis.revision) {
        return { reason: 'Current Variant axes are stale against Product Type', status: 'INDETERMINATE' as const };
      }
      if (!Number.isSafeInteger(axes.axisRevision) || axes.axisRevision < 1) {
        return { reason: 'Current Variant axis revision is not owner-attested', status: 'INDETERMINATE' as const };
      }
      const axisValues = yield* axisReader
        .readEffectiveValues(selection.productRef, selection.variantRef, axes)
        .pipe(Effect.orElseSucceed(() => null));
      if (axisValues === null || !exactAxisValueInventory(axes, axisValues)) {
        return {
          reason: 'Current Variant axis values are unavailable or incomplete',
          status: 'INDETERMINATE' as const,
        };
      }
      const axisValueProblem = appendAxisValueBasis(basis, axisValues, scope.tenantId);
      if (axisValueProblem !== null) {
        return { reason: axisValueProblem, status: 'INDETERMINATE' as const };
      }
      return yield* readSelectionAxisAllowances(axisReader, axes, axisValues, selection.productRef, basis);
    } else if (axes.productTypeRevision !== null || axes.axes.length !== 0) {
      return { reason: 'Current untyped Product has contradictory Variant axes', status: 'INDETERMINATE' as const };
    }

    return null;
  },
);

/** Type, structured-value and Axis facts for one exact selected Variant in Core's snapshot. */
export const productSelectionTypeValueAxisBasisForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
) => ({
  read: Effect.fn('ProductTypeReadinessSource.readSelectionBasis')(function* readSelectionBasis(
    selection: CatalogSelection,
    now: DateTime.Utc,
  ) {
    const basis: CatalogSelectionCurrentFacts['basis'][number][] = [];
    const unknown = (reason: string) => ({ basis, reason, status: 'INDETERMINATE' as const });
    const typeSource = yield* productTypeReadinessSourceForScope(transaction, scope)
      .load(selection.productRef, now)
      .pipe(Effect.orElseSucceed(() => null));
    if (typeSource === null) {
      return unknown('Current Product Type assignment or untyped decision is not owner-attested');
    }
    if (typeSource.status === 'VERIFIED') {
      const typeRevision = yield* Schema.decodeEffect(CatalogRevisionNumberSchema)(typeSource.basis.revision).pipe(
        Effect.mapError(unavailable),
      );
      basis.push({
        role: 'PRODUCT_TYPE',
        source: {
          resourceRef: typeSource.basis.productTypeRef,
          revision: typeRevision,
          revisionId: typeSource.basis.revisionId,
        },
      });
    }
    const productValues = yield* readProductValueValidity(
      transaction,
      scope,
      selection.productRef.resourceId,
      selection.variantRef.resourceId,
    );
    if (productValues !== null && !Array.isArray(productValues)) {
      return { basis, ...productValues };
    }
    const valueProblem = appendProductValueBasis(basis, productValues, scope.tenantId);
    if (valueProblem !== null) {
      return unknown(valueProblem);
    }
    const axisProblem = yield* readSelectionAxisBasis(transaction, scope, selection, typeSource, basis);
    if (axisProblem !== null) {
      return { basis, ...axisProblem };
    }

    if (typeSource.status === 'UNTYPED') {
      const readiness = yield* verifyProductTypeReadiness(transaction, scope, selection, now, { status: 'UNTYPED' });
      if (readiness.reason !== null) {
        return { basis, reason: readiness.reason, status: readiness.status };
      }
      if (!('decisionRevision' in readiness)) {
        return unknown('Current untyped decision revision is unavailable');
      }
      basis.push({
        provenance: 'CATALOG_OWNER_CONFIRMED_UNTYPED_DECISION',
        role: 'PRODUCT_TYPE_UNTYPED_DECISION',
        source: { resourceRef: selection.productRef, revision: readiness.decisionRevision },
      });
    }

    if (typeSource.status === 'VERIFIED') {
      const readiness = yield* verifyProductTypeReadiness(transaction, scope, selection, now, {
        rulesRevision: typeSource.basis.revision,
        status: 'VERIFIED',
      });
      if (readiness.reason !== null) {
        return { basis, reason: readiness.reason, status: readiness.status };
      }
    }
    return {
      basis: basis.filter(
        (fact, index) => !basis.slice(0, index).some((prior) => sameCatalogSelectionBasis(prior, fact)),
      ),
      reason: null,
    };
  }),
});
