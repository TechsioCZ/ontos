import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { createHash } from 'node:crypto';
import { and, asc, desc, eq, isNull, or } from 'drizzle-orm';
import { Effect, Option, Schema } from 'effect';

import type { ProductRef } from '../../shared/resources/product.ts';
import type { VariantRef } from '../../shared/resources/variant.ts';
import {
  AttributeDefinitionSchema,
  AttributeValueSchema,
  validateAttributeValues,
} from '../../shared/domain/attribute-values.ts';
import type { AttributeDefinition, AttributeValue } from '../../shared/domain/attribute-values.ts';
import type { ProductTypeAttributeRule } from '../../shared/domain/product-type-rules.ts';
import type {
  VariantAxis,
  VariantAxisCandidate,
  VariantAxisDefinitionSnapshot,
} from '../../shared/domain/variant-axes.ts';
import { stableCombinationKeyContent, stableParts, valueKey } from '../../shared/domain/variant-axes.ts';
import type { VariantUseChangeOperation } from '../../shared/domain/variant-use-change.ts';
import { decideVariantUseChange, revalidateVariantAxisChange } from '../../shared/domain/variant-use-change.ts';
import {
  attributeDefinitions,
  attributeDefinitionRevisions,
  attributeValueItems,
  attributeValueSets,
  controlledAttributeValues,
  productTypeAssignments,
  productTypeRevisions,
  productTypeRevisionAttributes,
  productTypes,
  productAttributeApplicability,
  productAttributeApplicabilityRevisions,
  productVariantAxes,
  productVariantAxisAllowanceEvents,
  productVariantAxisAllowedValues,
  productVariantAxisEvents,
  productVariants,
  products,
} from '../database/schema.ts';
import { CatalogPersistenceUnavailable } from './errors.ts';
import { effectiveAttributeValueReadsForScope } from './effective-attribute-value-reads.ts';
import { VariantAxisWriteConflict } from './variant-axis-write-conflict.ts';

export { VariantAxisWriteConflict } from './variant-axis-write-conflict.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];
const catalogModuleId = 'commerce.catalog';
const productResourceType = 'commerce.catalog.product';
const variantResourceType = 'commerce.catalog.variant';
const attributeDefinitionResourceType = 'commerce.catalog.attribute-definition';
const variantAxisBasisUnavailableCode = 'variant_axis_basis_unavailable';
const productTypeRevisionUnavailableReason = 'Product Type revision cannot be verified';

export class VariantAxisBasisUnavailable extends Schema.TaggedError<VariantAxisBasisUnavailable>()(
  'VariantAxisBasisUnavailable',
  { code: Schema.Literal(variantAxisBasisUnavailableCode), reason: Schema.String },
) {}

export interface GovernVariantAxesInput {
  readonly actionInvocationId: string;
  readonly axes: readonly {
    readonly attributeDefinitionId: string;
    readonly definitionRevision: number;
    readonly expectedAllowanceRevision: number;
  }[];
  readonly change: VariantUseChangeOperation;
  readonly expectedAxisRevision: number;
  readonly principalId: string;
  readonly productRef: ProductRef;
  readonly reason: string;
}

interface CurrentVariantAxis {
  readonly attributeDefinitionId: string;
  readonly controlledValueKind: string | null;
  readonly definitionRevision: number;
  readonly inheritable: boolean;
  readonly multiplicity: string;
  readonly ordinal: number;
  readonly valueKind: string;
}

export interface CurrentVariantAxes {
  readonly axes: readonly CurrentVariantAxis[];
  readonly axisRevision: number;
  readonly productId: string;
  readonly productTypeRevision: number | null;
}

export interface VariantAxisPersistence {
  readonly govern: (
    input: GovernVariantAxesInput,
  ) => Effect.Effect<
    { readonly axisRevision: number; readonly changed: boolean },
    CatalogPersistenceUnavailable | VariantAxisWriteConflict
  >;
  /** Appends an explicit replacement allowed-value snapshot for one axis; never creates a Variant. */
  readonly governAllowedValues: (
    input: GovernVariantAllowedValuesInput,
  ) => Effect.Effect<GovernVariantAllowedValuesOutcome, CatalogPersistenceUnavailable | VariantAxisBasisUnavailable>;
  readonly readCurrent: (
    productRef: ProductRef,
  ) => Effect.Effect<CurrentVariantAxes, CatalogPersistenceUnavailable | VariantAxisBasisUnavailable>;
  /** The Current Product-specific allowed set for every declared axis; never inferred from vocabulary. */
  readonly readCurrentAllowedValues: (
    productRef: ProductRef,
    axes: CurrentVariantAxes,
  ) => Effect.Effect<readonly CurrentAxisAllowedValues[], CatalogPersistenceUnavailable | VariantAxisBasisUnavailable>;
  /** Complete source-qualified value rows for the declared Current axes, not allowed-set proof. */
  readonly readEffectiveValues: (
    productRef: ProductRef,
    variantRef: VariantRef,
    axes: CurrentVariantAxes,
  ) => Effect.Effect<readonly CurrentVariantAxisValue[], CatalogPersistenceUnavailable | VariantAxisBasisUnavailable>;
  /** Only explicit ACTIVE rows are combinations; values never imply a Cartesian product. */
  readonly readRecordedCombinations: (
    productRef: ProductRef,
    axes: CurrentVariantAxes,
  ) => Effect.Effect<
    readonly RecordedVariantCombination[],
    CatalogPersistenceUnavailable | VariantAxisBasisUnavailable
  >;
  /**
   * Recorded ACTIVE forms with the effective values that still hash to their stored
   * combination identity. Never a Cartesian expansion or purchase proof; fails closed
   * when Current values no longer reproduce the recorded combination.
   */
  readonly readRecordedVariants: (
    productRef: ProductRef,
    axes: CurrentVariantAxes,
  ) => Effect.Effect<readonly RecordedVariantWithValues[], CatalogPersistenceUnavailable | VariantAxisBasisUnavailable>;
}

export interface RecordedVariantCombination {
  readonly axisRevision: number;
  readonly combinationKey: string;
  readonly variantId: string;
}

export interface RecordedVariantWithValues extends RecordedVariantCombination {
  readonly values: readonly CurrentVariantAxisValue[];
}

export interface CurrentVariantAxisValue {
  readonly attributeDefinitionId: string;
  readonly definitionRevision: number;
  readonly items: readonly (typeof attributeValueItems.$inferSelect)[];
  readonly source: 'PRODUCT' | 'VARIANT' | 'MISSING';
  readonly sourceRevision: number | null;
  readonly sourceValueSetRef: { readonly attributeValueSetId: string; readonly tenantId: string } | null;
}

/** The Current Product-specific allowed-value snapshot for exactly one declared axis. */
export interface CurrentAxisAllowedValues {
  readonly allowanceRevision: number;
  readonly attributeDefinitionId: string;
  readonly definitionRevision: number;
  /** Canonical value-identity hashes; display labels never participate. */
  readonly valueKeys: readonly string[];
}

export interface GovernVariantAllowedValuesInput {
  readonly actionInvocationId: string;
  readonly attributeDefinitionId: string;
  readonly definitionRevision: number;
  readonly evidenceRefs: readonly string[];
  readonly expectedAllowanceRevision: number;
  readonly expectedAxisRevision: number;
  readonly principalId: string;
  readonly productRef: ProductRef;
  readonly reason: string;
  readonly values: readonly AttributeValue[];
}

export const GovernVariantAllowedValuesGovernedSchema = Schema.TaggedStruct('governed', {
  allowanceRevision: Schema.Int,
  changed: Schema.Boolean,
});
const GovernVariantAllowedValuesNotFoundSchema = Schema.TaggedStruct('not_found', {});
export const GovernVariantAllowedValuesRevisionConflictSchema = Schema.TaggedStruct('revision_conflict', {
  actualAllowanceRevision: Schema.Int,
});
export const GovernVariantAllowedValuesAxisConflictSchema = Schema.TaggedStruct('axis_conflict', {
  actualAxisRevision: Schema.Int,
});
export const GovernVariantAllowedValuesInvalidInputSchema = Schema.TaggedStruct('invalid_input', {
  reason: Schema.String,
});
export const GovernVariantAllowedValuesOutcomeSchema = Schema.Union([
  GovernVariantAllowedValuesGovernedSchema,
  GovernVariantAllowedValuesNotFoundSchema,
  GovernVariantAllowedValuesRevisionConflictSchema,
  GovernVariantAllowedValuesAxisConflictSchema,
  GovernVariantAllowedValuesInvalidInputSchema,
]);
type GovernVariantAllowedValuesOutcome = typeof GovernVariantAllowedValuesOutcomeSchema.Type;

const controlledValueResourceType = 'commerce.catalog.controlled-attribute-value';

const itemValueKey = (item: typeof attributeValueItems.$inferSelect): string => {
  if (item.valueKind === 'CONTROLLED') {
    return stableParts([
      'controlled',
      catalogModuleId,
      controlledValueResourceType,
      item.tenantId,
      item.controlledAttributeValueId ?? '',
    ]);
  }
  if (item.valueKind === 'MEASUREMENT') {
    return stableParts(['measurement', String(Number(item.numericValue)), item.unit ?? '']);
  }
  if (item.valueKind === 'SPECIAL') {
    return stableParts(['special', item.specialState ?? '']);
  }
  return stableParts(['text', item.textValue ?? '']);
};

/** Canonical hash of an explicit allowed value; the same encoding as stored effective items. */
export const allowedValueKeyHash = (value: AttributeValue): string =>
  createHash('sha256').update(valueKey(value)).digest('hex');

/** Canonical hash of a stored effective value item, matched against governed allowed values. */
export const effectiveValueItemKeyHash = (item: typeof attributeValueItems.$inferSelect): string =>
  createHash('sha256').update(itemValueKey(item)).digest('hex');

/** Decodes a retained effective value item into its public, label-independent form. */
export const effectiveItemToAttributeValue = (
  item: typeof attributeValueItems.$inferSelect,
): AttributeValue | undefined => {
  if (item.valueKind === 'CONTROLLED') {
    return item.controlledAttributeValueId === null
      ? undefined
      : Option.getOrUndefined(
          Schema.decodeOption(AttributeValueSchema)({
            kind: 'CONTROLLED',
            valueRef: {
              moduleId: catalogModuleId,
              resourceId: item.controlledAttributeValueId,
              resourceType: controlledValueResourceType,
              tenantId: item.tenantId,
            },
          }),
        );
  }
  if (item.valueKind === 'MEASUREMENT') {
    return Option.getOrUndefined(
      Schema.decodeUnknownOption(AttributeValueSchema)({
        amount: Number(item.numericValue),
        kind: 'MEASUREMENT',
        unit: item.unit,
      }),
    );
  }
  if (item.valueKind === 'SPECIAL') {
    return Option.getOrUndefined(
      Schema.decodeUnknownOption(AttributeValueSchema)({ kind: 'SPECIAL', state: item.specialState }),
    );
  }
  return Option.getOrUndefined(
    Schema.decodeUnknownOption(AttributeValueSchema)({ kind: 'TEXT', text: item.textValue }),
  );
};

/**
 * Canonical identity of an effective axis selection vector. This is the value the
 * stored `combinationKey` must equal for Current value rows to be presented as the
 * recorded form. The vector is encoded through `stableCombinationKeyContent`, whose
 * empty vector encodes as `[]`, matching the existing `axisFreeCombinationKey`
 * (sha256 of `[]`), so a no-axis Variant stays verifiable. `confirm-variant-combination`
 * must produce the stored key with the same canonical encoding.
 */
export const recordedVariantCombinationKey = (
  selections: readonly CurrentVariantAxisValue[],
  tenantId: string,
): string =>
  createHash('sha256')
    .update(
      stableCombinationKeyContent(
        selections
          .map((selection) => [
            tenantId,
            selection.attributeDefinitionId,
            ...selection.items.map((item) => itemValueKey(item)).toSorted(),
          ])
          .toSorted((left, right) => (stableParts(left) < stableParts(right) ? -1 : 1)),
      ),
    )
    .digest('hex');

const unavailable = (cause: unknown): CatalogPersistenceUnavailable => {
  const error = new CatalogPersistenceUnavailable({
    code: 'catalog_persistence_unavailable',
    reason: 'Catalog persistence is temporarily unavailable',
  });
  Object.defineProperty(error, 'cause', { configurable: true, value: cause });
  return error;
};

const basisUnavailable = () =>
  new VariantAxisBasisUnavailable({
    code: variantAxisBasisUnavailableCode,
    reason: 'Current Product axes or allowed values cannot be verified',
  });

const definitionFromRevision = (
  row: typeof attributeDefinitionRevisions.$inferSelect,
  definitionRef: AttributeDefinition['ref'],
): AttributeDefinition | undefined => {
  const definition = {
    label: row.name,
    levels: row.applicableLevels,
    meaning: row.meaning,
    multiplicity: row.multiplicity,
    ref: definitionRef,
    specialStates: [
      ...(row.allowsUnknown === 1 ? (['UNKNOWN'] as const) : []),
      ...(row.allowsNone === 1 ? (['NONE'] as const) : []),
      ...(row.allowsNotApplicable === 1 ? (['NOT_APPLICABLE'] as const) : []),
    ],
    valueKind: row.valueKind,
  };
  const measurement = {
    canonicalUnit: row.canonicalUnit ?? '',
    decimalPlaces: row.decimalPlaces ?? 0,
    quantity: row.measuredQuantity ?? '',
  };
  const withMaximum = row.maximumValue === null ? measurement : { ...measurement, maximum: Number(row.maximumValue) };
  const completeMeasurement =
    row.minimumValue === null ? withMaximum : { ...withMaximum, minimum: Number(row.minimumValue) };
  const candidate = row.valueKind === 'MEASUREMENT' ? { ...definition, measurement: completeMeasurement } : definition;
  const decoded = Schema.decodeUnknownOption(AttributeDefinitionSchema)(candidate);
  return Option.isSome(decoded) ? decoded.value : undefined;
};

const writeConflict = (kind: VariantAxisWriteConflict['conflict'], reason: string) =>
  new VariantAxisWriteConflict({ code: 'variant_axis_write_conflict', conflict: kind, reason });

const invalidGovernInput = (input: GovernVariantAxesInput, tenantId: string): boolean =>
  input.productRef.tenantId !== tenantId ||
  input.productRef.moduleId !== catalogModuleId ||
  input.productRef.resourceType !== productResourceType ||
  !Number.isSafeInteger(input.expectedAxisRevision) ||
  input.expectedAxisRevision < 0 ||
  input.axes.length > 32 ||
  new Set(input.axes.map((axis) => axis.attributeDefinitionId)).size !== input.axes.length ||
  input.axes.some(
    (axis) =>
      !Number.isSafeInteger(axis.definitionRevision) ||
      axis.definitionRevision < 1 ||
      !Number.isSafeInteger(axis.expectedAllowanceRevision) ||
      axis.expectedAllowanceRevision < 0,
  ) ||
  (input.change.kind !== 'AXIS_ADDITION' && input.change.kind !== 'AXIS_REMOVAL') ||
  input.change.reason !== input.reason;

const validAllowedValuesEvidence = (input: GovernVariantAllowedValuesInput): boolean =>
  input.reason === input.reason.trim() &&
  input.reason.length > 0 &&
  input.reason.length <= 1000 &&
  input.evidenceRefs.every((ref) => ref === ref.trim() && ref.length > 0 && ref.length <= 300);

const validGovernAllowedValuesInput = (input: GovernVariantAllowedValuesInput, tenantId: string): boolean =>
  input.productRef.tenantId === tenantId &&
  input.productRef.moduleId === catalogModuleId &&
  input.productRef.resourceType === productResourceType &&
  Number.isSafeInteger(input.expectedAxisRevision) &&
  input.expectedAxisRevision >= 0 &&
  Number.isSafeInteger(input.expectedAllowanceRevision) &&
  input.expectedAllowanceRevision >= 0 &&
  Number.isSafeInteger(input.definitionRevision) &&
  input.definitionRevision >= 1 &&
  input.values.length <= 1000 &&
  validAllowedValuesEvidence(input);

const validateAllowedValuesSnapshot = (
  definition: AttributeDefinition,
  values: readonly AttributeValue[],
):
  | { readonly reason: string; readonly valid: false }
  | {
      readonly hashes: readonly string[];
      readonly normalized: readonly AttributeValue[];
      readonly valid: true;
    } => {
  const checked = validateAttributeValues(definition, values);
  if (!checked.valid || checked.normalized.length !== values.length) {
    return { reason: checked.reasons.join('; ') || 'Allowed values are not permissible for this axis', valid: false };
  }
  const hashes = checked.normalized.map(allowedValueKeyHash);
  if (new Set(hashes).size !== hashes.length) {
    return { reason: 'Allowed values repeat the same value identity', valid: false };
  }
  if (checked.normalized.some((value) => value.kind === 'SPECIAL' && value.state === 'UNKNOWN')) {
    return { reason: 'An unknown special state cannot be a permissible Current value', valid: false };
  }
  return { hashes, normalized: checked.normalized, valid: true };
};

const invalidAxisDefinitionPointer = (
  definition: typeof attributeDefinitions.$inferSelect,
  row: typeof productVariantAxes.$inferSelect,
  tenantId: string,
): boolean =>
  definition.tenantId !== tenantId ||
  definition.attributeDefinitionId !== row.attributeDefinitionId ||
  !Number.isSafeInteger(definition.currentRevision) ||
  definition.currentRevision < 1 ||
  !Number.isSafeInteger(row.definitionRevision) ||
  (row.definitionRevision ?? 0) < 1 ||
  definition.currentRevision < (row.definitionRevision ?? 0);

const invalidProductAxisApplicability = (
  applicability: typeof productAttributeApplicability.$inferSelect | undefined,
  tenantId: string,
  productId: string,
  attributeDefinitionId: string,
): boolean =>
  applicability === undefined ||
  applicability.tenantId !== tenantId ||
  applicability.productId !== productId ||
  applicability.attributeDefinitionId !== attributeDefinitionId ||
  !applicability.variantLevel ||
  !Number.isSafeInteger(applicability.currentRevision) ||
  applicability.currentRevision < 1;

const invalidProductAxisApplicabilityRevision = (
  revision: typeof productAttributeApplicabilityRevisions.$inferSelect | undefined,
  applicability: typeof productAttributeApplicability.$inferSelect,
): boolean =>
  revision === undefined ||
  revision.tenantId !== applicability.tenantId ||
  revision.productId !== applicability.productId ||
  revision.attributeDefinitionId !== applicability.attributeDefinitionId ||
  revision.revision !== applicability.currentRevision ||
  !revision.variantLevel ||
  revision.productLevel !== applicability.productLevel;

const malformedAxisSnapshot = (
  event: typeof productVariantAxisEvents.$inferSelect | undefined,
  rows: readonly (typeof productVariantAxes.$inferSelect)[],
  tenantId: string,
  productId: string,
): boolean =>
  (event !== undefined && (event.tenantId !== tenantId || event.productId !== productId)) ||
  (event !== undefined &&
    (event.attributeDefinitionRevisions === null ||
      event.attributeDefinitionRevisions.length !== event.attributeDefinitionIds.length ||
      event.attributeDefinitionRevisions.some((revision) => !Number.isSafeInteger(revision) || revision < 1))) ||
  rows.some((row) => row.tenantId !== tenantId || row.productId !== productId) ||
  (event === undefined && rows.length !== 0) ||
  (event !== undefined &&
    (rows.length !== event.attributeDefinitionIds.length ||
      rows.some(
        (row, index) =>
          row.axisRevision !== event.axisRevision ||
          row.ordinal !== index ||
          row.attributeDefinitionId !== event.attributeDefinitionIds[index] ||
          row.definitionRevision !== event.attributeDefinitionRevisions?.[index] ||
          !Number.isSafeInteger(row.definitionRevision) ||
          (row.definitionRevision ?? 0) < 1,
      )));

/** Constructed only inside Core's already-scoped read or Action transaction. */
export const variantAxisPersistenceForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
): VariantAxisPersistence => {
  const { tenantId } = scope;

  const readAxis = Effect.fn('VariantAxisPersistence.readAxis')(function* readAxis(
    row: typeof productVariantAxes.$inferSelect,
    productId: string,
    productTypeId: string,
    productTypeRevision: number,
  ) {
    const [definition] = yield* transaction
      .select()
      .from(attributeDefinitions)
      .where(
        and(
          eq(attributeDefinitions.tenantId, tenantId),
          eq(attributeDefinitions.attributeDefinitionId, row.attributeDefinitionId),
        ),
      )
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    if (definition === undefined || invalidAxisDefinitionPointer(definition, row, tenantId)) {
      return yield* basisUnavailable();
    }
    const [pinned] = yield* transaction
      .select()
      .from(attributeDefinitionRevisions)
      .where(
        and(
          eq(attributeDefinitionRevisions.tenantId, tenantId),
          eq(attributeDefinitionRevisions.attributeDefinitionId, row.attributeDefinitionId),
          eq(attributeDefinitionRevisions.revision, row.definitionRevision ?? 0),
        ),
      )
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    if (
      pinned === undefined ||
      pinned.tenantId !== tenantId ||
      pinned.attributeDefinitionId !== row.attributeDefinitionId ||
      pinned.revision !== row.definitionRevision ||
      !new Set(pinned.applicableLevels).has('VARIANT')
    ) {
      return yield* basisUnavailable();
    }
    if (row.definitionRevision === definition.currentRevision) {
      const attributeReads = yield* effectiveAttributeValueReadsForScope(transaction, scope);
      const definitionProof = yield* attributeReads.readDefinitionCurrent({
        moduleId: catalogModuleId,
        resourceId: row.attributeDefinitionId,
        resourceType: attributeDefinitionResourceType,
        tenantId,
      });
      if (
        !definitionProof.complete ||
        definitionProof.tenantId !== tenantId ||
        definitionProof.attributeDefinitionId !== row.attributeDefinitionId ||
        definitionProof.revision !== definition.currentRevision
      ) {
        return yield* basisUnavailable();
      }
    }
    const [rule] = yield* transaction
      .select({ attributeDefinitionId: productTypeRevisionAttributes.attributeDefinitionId })
      .from(productTypeRevisionAttributes)
      .where(
        and(
          eq(productTypeRevisionAttributes.tenantId, tenantId),
          eq(productTypeRevisionAttributes.productTypeId, productTypeId),
          eq(productTypeRevisionAttributes.revision, productTypeRevision),
          eq(productTypeRevisionAttributes.attributeDefinitionId, row.attributeDefinitionId),
          eq(productTypeRevisionAttributes.level, 'VARIANT'),
        ),
      )
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    if (rule === undefined) {
      return yield* basisUnavailable();
    }
    const [applicability] = yield* transaction
      .select()
      .from(productAttributeApplicability)
      .where(
        and(
          eq(productAttributeApplicability.tenantId, tenantId),
          eq(productAttributeApplicability.productId, productId),
          eq(productAttributeApplicability.attributeDefinitionId, row.attributeDefinitionId),
        ),
      )
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    if (invalidProductAxisApplicability(applicability, tenantId, productId, row.attributeDefinitionId)) {
      return yield* basisUnavailable();
    }
    // The preceding guard establishes the current declaration's presence.
    if (applicability === undefined) {
      return yield* basisUnavailable();
    }
    const [applicabilityRevision] = yield* transaction
      .select()
      .from(productAttributeApplicabilityRevisions)
      .where(
        and(
          eq(productAttributeApplicabilityRevisions.tenantId, tenantId),
          eq(productAttributeApplicabilityRevisions.productId, productId),
          eq(productAttributeApplicabilityRevisions.attributeDefinitionId, row.attributeDefinitionId),
          eq(productAttributeApplicabilityRevisions.revision, applicability.currentRevision),
        ),
      )
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    if (invalidProductAxisApplicabilityRevision(applicabilityRevision, applicability)) {
      return yield* basisUnavailable();
    }
    let inheritable = false;
    if (new Set(pinned.applicableLevels).has('PRODUCT')) {
      const [productRule] = yield* transaction
        .select({ attributeDefinitionId: productTypeRevisionAttributes.attributeDefinitionId })
        .from(productTypeRevisionAttributes)
        .where(
          and(
            eq(productTypeRevisionAttributes.tenantId, tenantId),
            eq(productTypeRevisionAttributes.productTypeId, productTypeId),
            eq(productTypeRevisionAttributes.revision, productTypeRevision),
            eq(productTypeRevisionAttributes.attributeDefinitionId, row.attributeDefinitionId),
            eq(productTypeRevisionAttributes.level, 'PRODUCT'),
          ),
        )
        .limit(1)
        .pipe(Effect.mapError(unavailable));
      inheritable = productRule !== undefined;
    }
    // This is definition/rule evidence only. Shared vocabulary is not a
    // Product-specific allowed set and cannot authorize Current selection.
    return {
      attributeDefinitionId: row.attributeDefinitionId,
      controlledValueKind: pinned.controlledValueKind,
      definitionRevision: pinned.revision,
      inheritable,
      multiplicity: pinned.multiplicity,
      ordinal: row.ordinal,
      valueKind: pinned.valueKind,
    } satisfies CurrentVariantAxis;
  });

  const readCurrent: VariantAxisPersistence['readCurrent'] = Effect.fn('VariantAxisPersistence.readCurrent')(
    function* readCurrent(productRef) {
      if (
        productRef.tenantId !== tenantId ||
        productRef.moduleId !== catalogModuleId ||
        productRef.resourceType !== productResourceType
      ) {
        return yield* basisUnavailable();
      }
      const productId = productRef.resourceId;
      const [product] = yield* transaction
        .select({ productId: products.productId })
        .from(products)
        .where(and(eq(products.tenantId, tenantId), eq(products.productId, productId)))
        .limit(1)
        .pipe(Effect.mapError(unavailable));
      if (product === undefined) {
        return yield* basisUnavailable();
      }

      const events = yield* transaction
        .select()
        .from(productVariantAxisEvents)
        .where(and(eq(productVariantAxisEvents.tenantId, tenantId), eq(productVariantAxisEvents.productId, productId)))
        .orderBy(desc(productVariantAxisEvents.axisRevision))
        .limit(1)
        .pipe(Effect.mapError(unavailable));
      const [event] = events;
      const rows = yield* transaction
        .select()
        .from(productVariantAxes)
        .where(and(eq(productVariantAxes.tenantId, tenantId), eq(productVariantAxes.productId, productId)))
        .orderBy(asc(productVariantAxes.ordinal))
        .pipe(Effect.mapError(unavailable));
      if (malformedAxisSnapshot(event, rows, tenantId, productId)) {
        return yield* basisUnavailable();
      }

      const [assignment] = yield* transaction
        .select()
        .from(productTypeAssignments)
        .where(and(eq(productTypeAssignments.tenantId, tenantId), eq(productTypeAssignments.productId, productId)))
        .limit(1)
        .pipe(Effect.mapError(unavailable));
      let productTypeRevision: number | null = null;
      if (assignment !== undefined) {
        const [type] = yield* transaction
          .select({ currentRevision: productTypes.currentRevision })
          .from(productTypes)
          .where(and(eq(productTypes.tenantId, tenantId), eq(productTypes.productTypeId, assignment.productTypeId)))
          .limit(1)
          .pipe(Effect.mapError(unavailable));
        if (type === undefined || !Number.isInteger(type.currentRevision) || type.currentRevision < 1) {
          return yield* basisUnavailable();
        }
        productTypeRevision = type.currentRevision;
        const [typeRevision] = yield* transaction
          .select({ revision: productTypeRevisions.revision })
          .from(productTypeRevisions)
          .where(
            and(
              eq(productTypeRevisions.tenantId, tenantId),
              eq(productTypeRevisions.productTypeId, assignment.productTypeId),
              eq(productTypeRevisions.revision, type.currentRevision),
            ),
          )
          .limit(1)
          .pipe(Effect.mapError(unavailable));
        if (typeRevision === undefined) {
          return yield* basisUnavailable();
        }
      } else if (rows.length !== 0) {
        return yield* basisUnavailable();
      }

      const axes = yield* Effect.forEach(
        rows,
        (row) => readAxis(row, productId, assignment?.productTypeId ?? '', productTypeRevision ?? 0),
        { concurrency: 1 },
      );
      return { axes, axisRevision: event?.axisRevision ?? 0, productId, productTypeRevision };
    },
  );

  const readOneValue = Effect.fn('VariantAxisPersistence.readOneValue')(function* readOneValue(
    productRef: ProductRef,
    variantRef: VariantRef,
    axis: CurrentVariantAxis,
  ) {
    const sets = yield* transaction
      .select()
      .from(attributeValueSets)
      .where(
        and(
          eq(attributeValueSets.tenantId, tenantId),
          eq(attributeValueSets.productId, productRef.resourceId),
          eq(attributeValueSets.attributeDefinitionId, axis.attributeDefinitionId),
          or(isNull(attributeValueSets.variantId), eq(attributeValueSets.variantId, variantRef.resourceId)),
        ),
      )
      .pipe(Effect.mapError(unavailable));
    if (
      sets.length > 2 ||
      sets.some(
        (set) =>
          set.tenantId !== tenantId ||
          set.productId !== productRef.resourceId ||
          set.attributeDefinitionId !== axis.attributeDefinitionId ||
          (set.variantId !== null && set.variantId !== variantRef.resourceId),
      ) ||
      sets.filter((set) => set.variantId === null).length > 1 ||
      sets.filter((set) => set.variantId === variantRef.resourceId).length > 1
    ) {
      return yield* basisUnavailable();
    }
    const direct = sets.find((set) => set.variantId === variantRef.resourceId);
    const inherited = sets.find((set) => set.variantId === null);
    let selected = direct?.currentState === 'SET' ? direct : null;
    if (selected === null && axis.inheritable && inherited?.currentState === 'SET') {
      selected = inherited;
    }
    if (selected === null) {
      return {
        attributeDefinitionId: axis.attributeDefinitionId,
        definitionRevision: axis.definitionRevision,
        items: [],
        source: 'MISSING',
        sourceRevision: null,
        sourceValueSetRef: null,
      } satisfies CurrentVariantAxisValue;
    }
    if (!Number.isSafeInteger(selected.currentRevision) || selected.currentRevision < 1) {
      return yield* basisUnavailable();
    }
    const items = yield* transaction
      .select()
      .from(attributeValueItems)
      .where(
        and(
          eq(attributeValueItems.tenantId, tenantId),
          eq(attributeValueItems.attributeValueSetId, selected.attributeValueSetId),
        ),
      )
      .orderBy(asc(attributeValueItems.ordinal))
      .pipe(Effect.mapError(unavailable));
    if (
      items.length === 0 ||
      items.some(
        (item, index) =>
          item.tenantId !== tenantId ||
          item.attributeValueSetId !== selected.attributeValueSetId ||
          item.attributeDefinitionId !== axis.attributeDefinitionId ||
          item.ordinal !== index,
      )
    ) {
      return yield* basisUnavailable();
    }
    return {
      attributeDefinitionId: axis.attributeDefinitionId,
      definitionRevision: axis.definitionRevision,
      items,
      source: selected.variantId === null ? 'PRODUCT' : 'VARIANT',
      sourceRevision: selected.currentRevision,
      sourceValueSetRef: { attributeValueSetId: selected.attributeValueSetId, tenantId },
    } satisfies CurrentVariantAxisValue;
  });

  const readEffectiveValues: VariantAxisPersistence['readEffectiveValues'] = Effect.fn(
    'VariantAxisPersistence.readEffectiveValues',
  )(function* readEffectiveValues(productRef, variantRef, axes) {
    if (
      productRef.tenantId !== tenantId ||
      variantRef.tenantId !== tenantId ||
      productRef.moduleId !== catalogModuleId ||
      variantRef.moduleId !== catalogModuleId ||
      productRef.resourceType !== productResourceType ||
      variantRef.resourceType !== variantResourceType ||
      axes.productId !== productRef.resourceId ||
      axes.axisRevision < 1
    ) {
      return yield* basisUnavailable();
    }
    return yield* Effect.forEach(axes.axes, (axis) => readOneValue(productRef, variantRef, axis), { concurrency: 1 });
  });

  const readRecordedCombinations: VariantAxisPersistence['readRecordedCombinations'] = Effect.fn(
    'VariantAxisPersistence.readRecordedCombinations',
  )(function* readRecordedCombinations(productRef, axes) {
    if (
      productRef.tenantId !== tenantId ||
      productRef.moduleId !== catalogModuleId ||
      productRef.resourceType !== productResourceType ||
      axes.productId !== productRef.resourceId ||
      !Number.isSafeInteger(axes.axisRevision) ||
      axes.axisRevision < 1
    ) {
      return yield* basisUnavailable();
    }
    const rows = yield* transaction
      .select({
        axisRevision: productVariants.combinationAxisRevision,
        combinationKey: productVariants.combinationKey,
        lifecycleState: productVariants.lifecycleState,
        productId: productVariants.productId,
        tenantId: productVariants.tenantId,
        variantId: productVariants.variantId,
      })
      .from(productVariants)
      .where(and(eq(productVariants.tenantId, tenantId), eq(productVariants.productId, productRef.resourceId)))
      .pipe(Effect.mapError(unavailable));
    const active = rows.filter((row) => row.lifecycleState === 'ACTIVE');
    if (
      active.some(
        (row) =>
          row.tenantId !== tenantId ||
          row.productId !== productRef.resourceId ||
          row.axisRevision !== axes.axisRevision ||
          row.combinationKey === null ||
          !/^[0-9a-f]{64}$/u.test(row.combinationKey),
      ) ||
      new Set(active.map((row) => row.combinationKey)).size !== active.length
    ) {
      return yield* basisUnavailable();
    }
    return active.map((row) => ({
      axisRevision: axes.axisRevision,
      combinationKey: row.combinationKey ?? '',
      variantId: row.variantId,
    }));
  });

  const readRecordedVariants: VariantAxisPersistence['readRecordedVariants'] = Effect.fn(
    'VariantAxisPersistence.readRecordedVariants',
  )(function* readRecordedVariants(productRef, axes) {
    const recorded = yield* readRecordedCombinations(productRef, axes);
    return yield* Effect.forEach(
      recorded,
      Effect.fn('VariantAxisPersistence.readRecordedVariant')(function* readRecordedVariant(item) {
        const variantRef: VariantRef = {
          moduleId: catalogModuleId,
          resourceId: item.variantId,
          resourceType: variantResourceType,
          tenantId,
        };
        const values = yield* readEffectiveValues(productRef, variantRef, axes);
        if (values.some((value) => value.source === 'MISSING')) {
          return yield* basisUnavailable();
        }
        // The stored combination key is the recorded authority. Current value rows are
        // the recorded form only while they still reproduce it; otherwise a value-set
        // change must fail closed instead of relabelling Current values as recorded.
        if (recordedVariantCombinationKey(values, tenantId) !== item.combinationKey) {
          return yield* basisUnavailable();
        }
        return { ...item, values } satisfies RecordedVariantWithValues;
      }),
      { concurrency: 1 },
    );
  });

  const readCurrentAllowedValues: VariantAxisPersistence['readCurrentAllowedValues'] = Effect.fn(
    'VariantAxisPersistence.readCurrentAllowedValues',
  )(function* readCurrentAllowedValues(productRef, axes) {
    if (
      productRef.tenantId !== tenantId ||
      productRef.moduleId !== catalogModuleId ||
      productRef.resourceType !== productResourceType ||
      axes.productId !== productRef.resourceId ||
      !Number.isSafeInteger(axes.axisRevision) ||
      axes.axisRevision < 1
    ) {
      return yield* basisUnavailable();
    }
    return yield* Effect.forEach(
      axes.axes,
      Effect.fn('VariantAxisPersistence.readAxisAllowedValues')(function* readAxisAllowedValues(axis) {
        const [event] = yield* transaction
          .select()
          .from(productVariantAxisAllowanceEvents)
          .where(
            and(
              eq(productVariantAxisAllowanceEvents.tenantId, tenantId),
              eq(productVariantAxisAllowanceEvents.productId, productRef.resourceId),
              eq(productVariantAxisAllowanceEvents.attributeDefinitionId, axis.attributeDefinitionId),
            ),
          )
          .orderBy(desc(productVariantAxisAllowanceEvents.allowanceRevision))
          .limit(1)
          .pipe(Effect.mapError(unavailable));
        if (
          event === undefined ||
          event.tenantId !== tenantId ||
          event.productId !== productRef.resourceId ||
          event.attributeDefinitionId !== axis.attributeDefinitionId ||
          event.axisRevision > axes.axisRevision ||
          event.definitionRevision !== axis.definitionRevision
        ) {
          return yield* basisUnavailable();
        }
        const values = yield* transaction
          .select({ valueKey: productVariantAxisAllowedValues.valueKey })
          .from(productVariantAxisAllowedValues)
          .where(
            and(
              eq(productVariantAxisAllowedValues.tenantId, tenantId),
              eq(productVariantAxisAllowedValues.productId, productRef.resourceId),
              eq(productVariantAxisAllowedValues.attributeDefinitionId, axis.attributeDefinitionId),
              eq(productVariantAxisAllowedValues.allowanceRevision, event.allowanceRevision),
            ),
          )
          .pipe(Effect.mapError(unavailable));
        const keys = values.map((row) => row.valueKey);
        if (
          keys.length !== event.valueCount ||
          new Set(keys).size !== keys.length ||
          keys.some((key) => !/^[0-9a-f]{64}$/u.test(key))
        ) {
          return yield* basisUnavailable();
        }
        return {
          allowanceRevision: event.allowanceRevision,
          attributeDefinitionId: axis.attributeDefinitionId,
          definitionRevision: axis.definitionRevision,
          valueKeys: keys,
        } satisfies CurrentAxisAllowedValues;
      }),
      { concurrency: 1 },
    );
  });

  const govern: VariantAxisPersistence['govern'] = Effect.fn(
    'VariantAxisPersistence.govern',
    // oxlint-disable-next-line complexity -- One locked transaction preserves the axis, allowance, active-combination, and optimistic-revision decision boundary. expires: 2027-03-31.
  )(function* govern(input) {
    const conflict = writeConflict;
    if (invalidGovernInput(input, tenantId)) {
      return yield* conflict('INVALID_INPUT', 'Invalid Product, change evidence, or axis definitions');
    }
    yield* decideVariantUseChange(input.change, { currentProductRef: input.productRef }).pipe(
      Effect.mapError((failure) => conflict(failure.conflict, failure.reason)),
    );
    const productId = input.productRef.resourceId;
    const [product] = yield* transaction
      .select({ lifecycleState: products.lifecycleState, productId: products.productId })
      .from(products)
      .where(and(eq(products.tenantId, tenantId), eq(products.productId, productId)))
      .for('update')
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    if (product === undefined) {
      return yield* conflict('NOT_FOUND', 'Product not found in trusted Tenant');
    }
    if (product.lifecycleState === 'RETIRED') {
      return yield* conflict('INVALID_INPUT', 'Retired Product cannot change Variant axes');
    }
    const [latest] = yield* transaction
      .select()
      .from(productVariantAxisEvents)
      .where(and(eq(productVariantAxisEvents.tenantId, tenantId), eq(productVariantAxisEvents.productId, productId)))
      .orderBy(desc(productVariantAxisEvents.axisRevision))
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    const currentRevision = latest?.axisRevision ?? 0;
    if (currentRevision !== input.expectedAxisRevision) {
      return yield* conflict('REVISION', 'Product Variant Axis revision changed');
    }
    const current = yield* transaction
      .select()
      .from(productVariantAxes)
      .where(and(eq(productVariantAxes.tenantId, tenantId), eq(productVariantAxes.productId, productId)))
      .orderBy(asc(productVariantAxes.ordinal))
      .pipe(Effect.mapError(unavailable));
    if (malformedAxisSnapshot(latest, current, tenantId, productId)) {
      return yield* conflict('REVISION', 'Current axis snapshot is inconsistent');
    }
    const unchanged =
      current.length === input.axes.length &&
      current.every(
        (axis, index) =>
          axis.attributeDefinitionId === input.axes[index]?.attributeDefinitionId &&
          axis.definitionRevision === input.axes[index]?.definitionRevision,
      );
    if (unchanged && latest !== undefined) {
      return { axisRevision: currentRevision, changed: false };
    }
    const currentIds = new Set(current.map((axis) => axis.attributeDefinitionId));
    const proposedIds = new Set(input.axes.map((axis) => axis.attributeDefinitionId));
    const additions = input.axes.filter((axis) => !currentIds.has(axis.attributeDefinitionId));
    const removals = current.filter((axis) => !proposedIds.has(axis.attributeDefinitionId));
    if (
      (input.change.kind === 'AXIS_ADDITION' && (additions.length === 0 || removals.length > 0)) ||
      (input.change.kind === 'AXIS_REMOVAL' && (removals.length === 0 || additions.length > 0))
    ) {
      return yield* conflict('INVALID_INPUT', 'Axis change classification does not match the proposed replacement');
    }

    const [assignment] = yield* transaction
      .select()
      .from(productTypeAssignments)
      .where(and(eq(productTypeAssignments.tenantId, tenantId), eq(productTypeAssignments.productId, productId)))
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    if (input.axes.length > 0 && assignment === undefined) {
      return yield* conflict('TYPE_RULE', 'Product has no Product Type permitting Variant axes');
    }
    let productTypeRevision: number | null = null;
    if (assignment !== undefined) {
      const [type] = yield* transaction
        .select({ currentRevision: productTypes.currentRevision })
        .from(productTypes)
        .where(and(eq(productTypes.tenantId, tenantId), eq(productTypes.productTypeId, assignment.productTypeId)))
        .limit(1)
        .pipe(Effect.mapError(unavailable));
      if (type === undefined || !Number.isSafeInteger(type.currentRevision) || type.currentRevision < 1) {
        return yield* conflict('TYPE_RULE', productTypeRevisionUnavailableReason);
      }
      const [typeRevision] = yield* transaction
        .select({ revision: productTypeRevisions.revision })
        .from(productTypeRevisions)
        .where(
          and(
            eq(productTypeRevisions.tenantId, tenantId),
            eq(productTypeRevisions.productTypeId, assignment.productTypeId),
            eq(productTypeRevisions.revision, type.currentRevision),
          ),
        )
        .limit(1)
        .pipe(Effect.mapError(unavailable));
      if (typeRevision === undefined) {
        return yield* conflict('TYPE_RULE', productTypeRevisionUnavailableReason);
      }
      productTypeRevision = type.currentRevision;
    }

    const verified = yield* Effect.forEach(
      input.axes,
      Effect.fn('VariantAxisPersistence.verifyProposedAxis')(function* verifyProposedAxis(axis, ordinal) {
        if (assignment === undefined || productTypeRevision === null) {
          return yield* conflict('TYPE_RULE', productTypeRevisionUnavailableReason);
        }
        const [definition] = yield* transaction
          .select({ currentRevision: attributeDefinitions.currentRevision })
          .from(attributeDefinitions)
          .where(
            and(
              eq(attributeDefinitions.tenantId, tenantId),
              eq(attributeDefinitions.attributeDefinitionId, axis.attributeDefinitionId),
            ),
          )
          .limit(1)
          .pipe(Effect.mapError(unavailable));
        if (definition?.currentRevision !== axis.definitionRevision) {
          return yield* conflict('DEFINITION', 'Axis must pin the current Attribute Definition revision');
        }
        const [revision] = yield* transaction
          .select()
          .from(attributeDefinitionRevisions)
          .where(
            and(
              eq(attributeDefinitionRevisions.tenantId, tenantId),
              eq(attributeDefinitionRevisions.attributeDefinitionId, axis.attributeDefinitionId),
              eq(attributeDefinitionRevisions.revision, axis.definitionRevision),
            ),
          )
          .limit(1)
          .pipe(Effect.mapError(unavailable));
        const definitionValue =
          revision === undefined
            ? undefined
            : definitionFromRevision(revision, {
                moduleId: catalogModuleId,
                resourceId: axis.attributeDefinitionId,
                resourceType: attributeDefinitionResourceType,
                tenantId,
              });
        if (
          revision === undefined ||
          definitionValue === undefined ||
          !new Set(definitionValue.levels).has('VARIANT')
        ) {
          return yield* conflict('DEFINITION', 'Definition is not applicable to Variants');
        }
        const [rule] = yield* transaction
          .select()
          .from(productTypeRevisionAttributes)
          .where(
            and(
              eq(productTypeRevisionAttributes.tenantId, tenantId),
              eq(productTypeRevisionAttributes.productTypeId, assignment.productTypeId),
              eq(productTypeRevisionAttributes.revision, productTypeRevision),
              eq(productTypeRevisionAttributes.attributeDefinitionId, axis.attributeDefinitionId),
              eq(productTypeRevisionAttributes.level, 'VARIANT'),
            ),
          )
          .limit(1)
          .pipe(Effect.mapError(unavailable));
        if (rule === undefined) {
          return yield* conflict('TYPE_RULE', 'Definition is not permitted on Variants by Product Type');
        }
        const [applicability] = yield* transaction
          .select()
          .from(productAttributeApplicability)
          .where(
            and(
              eq(productAttributeApplicability.tenantId, tenantId),
              eq(productAttributeApplicability.productId, productId),
              eq(productAttributeApplicability.attributeDefinitionId, axis.attributeDefinitionId),
            ),
          )
          .limit(1)
          .pipe(Effect.mapError(unavailable));
        if (invalidProductAxisApplicability(applicability, tenantId, productId, axis.attributeDefinitionId)) {
          return yield* conflict('TYPE_RULE', 'Definition is not declared applicable to this Product at Variant level');
        }
        if (applicability === undefined) {
          return yield* conflict('TYPE_RULE', 'Current Product applicability cannot be verified');
        }
        const [applicabilityRevision] = yield* transaction
          .select()
          .from(productAttributeApplicabilityRevisions)
          .where(
            and(
              eq(productAttributeApplicabilityRevisions.tenantId, tenantId),
              eq(productAttributeApplicabilityRevisions.productId, productId),
              eq(productAttributeApplicabilityRevisions.attributeDefinitionId, axis.attributeDefinitionId),
              eq(productAttributeApplicabilityRevisions.revision, applicability.currentRevision),
            ),
          )
          .limit(1)
          .pipe(Effect.mapError(unavailable));
        if (invalidProductAxisApplicabilityRevision(applicabilityRevision, applicability)) {
          return yield* conflict('TYPE_RULE', 'Current Product applicability revision cannot be verified');
        }
        const [productRule] = new Set(definitionValue.levels).has('PRODUCT')
          ? yield* transaction
              .select({ attributeDefinitionId: productTypeRevisionAttributes.attributeDefinitionId })
              .from(productTypeRevisionAttributes)
              .where(
                and(
                  eq(productTypeRevisionAttributes.tenantId, tenantId),
                  eq(productTypeRevisionAttributes.productTypeId, assignment.productTypeId),
                  eq(productTypeRevisionAttributes.revision, productTypeRevision),
                  eq(productTypeRevisionAttributes.attributeDefinitionId, axis.attributeDefinitionId),
                  eq(productTypeRevisionAttributes.level, 'PRODUCT'),
                ),
              )
              .limit(1)
              .pipe(Effect.mapError(unavailable))
          : [];
        return {
          axis: {
            attributeDefinitionId: axis.attributeDefinitionId,
            controlledValueKind: revision.controlledValueKind,
            definitionRevision: axis.definitionRevision,
            inheritable: productRule !== undefined,
            multiplicity: revision.multiplicity,
            ordinal,
            valueKind: revision.valueKind,
          } satisfies CurrentVariantAxis,
          definition: {
            definition: definitionValue,
            revision: axis.definitionRevision,
          } satisfies VariantAxisDefinitionSnapshot,
          rule: {
            attributeDefinitionRef: definitionValue.ref,
            level: 'VARIANT',
            required: rule.requirement === 'REQUIRED',
          } satisfies ProductTypeAttributeRule,
        };
      }),
      { concurrency: 1 },
    );
    const axisRevision = currentRevision + 1;
    const proposed: CurrentVariantAxes = {
      axes: verified.map((item) => item.axis),
      axisRevision,
      productId,
      productTypeRevision,
    };
    const variants = yield* transaction
      .select({
        combinationAxisRevision: productVariants.combinationAxisRevision,
        lifecycleState: productVariants.lifecycleState,
        productId: productVariants.productId,
        tenantId: productVariants.tenantId,
        variantId: productVariants.variantId,
      })
      .from(productVariants)
      .where(and(eq(productVariants.tenantId, tenantId), eq(productVariants.productId, productId)))
      .for('update')
      .pipe(Effect.mapError(unavailable));
    const active = variants.filter((variant) => variant.lifecycleState === 'ACTIVE');
    let proposedValues = new Map<string, readonly CurrentVariantAxisValue[]>();
    if (active.length > 0) {
      if (currentRevision < 1 || active.some((variant) => variant.combinationAxisRevision !== currentRevision)) {
        return yield* conflict('REVISION', 'Active Variant combination basis is stale');
      }
      const allowed = yield* readCurrentAllowedValues(input.productRef, proposed).pipe(
        Effect.mapError((failure) =>
          Schema.is(VariantAxisBasisUnavailable)(failure) ? conflict('UNVERIFIABLE_VALUE', failure.reason) : failure,
        ),
      );
      if (
        allowed.some(
          (item) =>
            item.allowanceRevision !==
            input.axes.find((axis) => axis.attributeDefinitionId === item.attributeDefinitionId)
              ?.expectedAllowanceRevision,
        )
      ) {
        return yield* conflict('REVISION', 'Product Variant Axis allowance revision changed');
      }
      proposedValues = new Map(
        yield* Effect.forEach(
          active,
          Effect.fn('VariantAxisPersistence.readProposedVariantValues')(function* readProposedVariantValues(row) {
            const values = yield* readEffectiveValues(
              input.productRef,
              {
                moduleId: catalogModuleId,
                resourceId: row.variantId,
                resourceType: variantResourceType,
                tenantId,
              },
              proposed,
            ).pipe(
              Effect.mapError((failure) =>
                Schema.is(VariantAxisBasisUnavailable)(failure)
                  ? conflict('UNVERIFIABLE_VALUE', failure.reason)
                  : failure,
              ),
            );
            return [row.variantId, values] as const;
          }),
          { concurrency: 1 },
        ),
      );
      const allowedByAxis = new Map(allowed.map((item) => [item.attributeDefinitionId, new Set(item.valueKeys)]));
      const candidates: VariantAxisCandidate[] = [];
      for (const row of active) {
        const values = proposedValues.get(row.variantId) ?? [];
        const effectiveAxisValues: VariantAxisCandidate['effectiveAxisValues'][number][] = [];
        for (const value of values) {
          const decoded = value.items.map(effectiveItemToAttributeValue);
          if (decoded.some((item) => item === undefined)) {
            return yield* conflict('UNVERIFIABLE_VALUE', 'Stored Variant axis values cannot be decoded');
          }
          effectiveAxisValues.push({
            attributeDefinitionRef: {
              moduleId: catalogModuleId,
              resourceId: value.attributeDefinitionId,
              resourceType: attributeDefinitionResourceType,
              tenantId,
            },
            values: decoded.filter((item): item is AttributeValue => item !== undefined),
          });
        }
        candidates.push({
          effectiveAxisValues,
          variant: {
            lifecycle: 'ACTIVE',
            productRef: input.productRef,
            variantId: row.variantId,
            variantRef: {
              moduleId: catalogModuleId,
              resourceId: row.variantId,
              resourceType: variantResourceType,
              tenantId,
            },
          },
        });
      }
      const proposedAxes: VariantAxis[] = verified.map(({ definition }) => ({
        attributeDefinitionRef: definition.definition.ref,
        definitionRevision: definition.revision,
      }));
      yield* revalidateVariantAxisChange({
        candidates,
        definitions: verified.map((item) => item.definition),
        isAllowedValue: (definition, value) =>
          allowedByAxis.get(definition.ref.resourceId)?.has(allowedValueKeyHash(value)),
        isRecordedCombination: (candidate) => active.some((row) => row.variantId === candidate.variantRef.resourceId),
        productRef: input.productRef,
        productTypeRules: verified.map((item) => item.rule),
        proposedAxes,
      }).pipe(Effect.mapError((failure) => conflict(failure.conflict, failure.reason)));
    }

    yield* transaction
      .delete(productVariantAxes)
      .where(and(eq(productVariantAxes.tenantId, tenantId), eq(productVariantAxes.productId, productId)))
      .pipe(Effect.mapError(unavailable));
    yield* transaction
      .insert(productVariantAxisEvents)
      .values({
        actingPrincipalId: input.principalId,
        actionInvocationId: input.actionInvocationId,
        attributeDefinitionIds: input.axes.map((axis) => axis.attributeDefinitionId),
        attributeDefinitionRevisions: input.axes.map((axis) => axis.definitionRevision),
        axisRevision,
        evidenceRefs: [...input.change.evidenceRefs],
        productId,
        reason: input.reason,
        tenantId,
      })
      .pipe(Effect.mapError(unavailable));
    if (input.axes.length > 0) {
      yield* transaction
        .insert(productVariantAxes)
        .values(
          input.axes.map((axis, ordinal) => ({
            attributeDefinitionId: axis.attributeDefinitionId,
            axisRevision,
            definitionRevision: axis.definitionRevision,
            ordinal,
            productId,
            tenantId,
          })),
        )
        .pipe(Effect.mapError(unavailable));
    }
    yield* Effect.forEach(
      active,
      Effect.fn('VariantAxisPersistence.advanceRecordedVariant')(function* advanceRecordedVariant(row) {
        const values = proposedValues.get(row.variantId) ?? [];
        const [updated] = yield* transaction
          .update(productVariants)
          .set({
            combinationAxisRevision: axisRevision,
            combinationKey: recordedVariantCombinationKey(values, tenantId),
          })
          .where(
            and(
              eq(productVariants.tenantId, tenantId),
              eq(productVariants.variantId, row.variantId),
              eq(productVariants.combinationAxisRevision, currentRevision),
            ),
          )
          .returning({ variantId: productVariants.variantId })
          .pipe(Effect.mapError(unavailable));
        if (updated?.variantId !== row.variantId) {
          return yield* conflict('REVISION', 'Active Variant combination changed during axis governance');
        }
        return null;
      }),
      { concurrency: 1 },
    );
    return { axisRevision, changed: true };
  });

  const lockProduct = Effect.fn('VariantAxisPersistence.lockAllowedValuesProduct')(function* lockProduct(
    productId: string,
  ) {
    const [product] = yield* transaction
      .select({ lifecycleState: products.lifecycleState, productId: products.productId })
      .from(products)
      .where(and(eq(products.tenantId, tenantId), eq(products.productId, productId)))
      .for('update')
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    return product;
  });

  const readLatestAllowance = Effect.fn('VariantAxisPersistence.readLatestAllowance')(function* readLatestAllowance(
    productId: string,
    attributeDefinitionId: string,
  ) {
    const [latest] = yield* transaction
      .select()
      .from(productVariantAxisAllowanceEvents)
      .where(
        and(
          eq(productVariantAxisAllowanceEvents.tenantId, tenantId),
          eq(productVariantAxisAllowanceEvents.productId, productId),
          eq(productVariantAxisAllowanceEvents.attributeDefinitionId, attributeDefinitionId),
        ),
      )
      .orderBy(desc(productVariantAxisAllowanceEvents.allowanceRevision))
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    return latest;
  });

  const readAllowanceByInvocation = Effect.fn('VariantAxisPersistence.readAllowanceByInvocation')(
    function* readAllowanceByInvocation(actionInvocationId: string) {
      const [invocation] = yield* transaction
        .select()
        .from(productVariantAxisAllowanceEvents)
        .where(
          and(
            eq(productVariantAxisAllowanceEvents.tenantId, tenantId),
            eq(productVariantAxisAllowanceEvents.actionInvocationId, actionInvocationId),
          ),
        )
        .limit(1)
        .pipe(Effect.mapError(unavailable));
      return invocation;
    },
  );

  const readPinnedDefinition = Effect.fn('VariantAxisPersistence.readAllowedValuesDefinition')(
    function* readPinnedDefinition(attributeDefinitionId: string, definitionRevision: number) {
      const [revisionRow] = yield* transaction
        .select()
        .from(attributeDefinitionRevisions)
        .where(
          and(
            eq(attributeDefinitionRevisions.tenantId, tenantId),
            eq(attributeDefinitionRevisions.attributeDefinitionId, attributeDefinitionId),
            eq(attributeDefinitionRevisions.revision, definitionRevision),
          ),
        )
        .limit(1)
        .pipe(Effect.mapError(unavailable));
      return revisionRow === undefined
        ? undefined
        : definitionFromRevision(revisionRow, {
            moduleId: catalogModuleId,
            resourceId: attributeDefinitionId,
            resourceType: attributeDefinitionResourceType,
            tenantId,
          });
    },
  );

  const allControlledValuesActive = Effect.fn('VariantAxisPersistence.allControlledValuesActive')(
    function* allControlledValuesActive(attributeDefinitionId: string, normalized: readonly AttributeValue[]) {
      const controlled = normalized.filter(
        (value): value is Extract<AttributeValue, { readonly kind: 'CONTROLLED' }> => value.kind === 'CONTROLLED',
      );
      if (controlled.length === 0) {
        return true;
      }
      const states = yield* Effect.forEach(
        controlled,
        (value) =>
          transaction
            .select({ lifecycleState: controlledAttributeValues.lifecycleState })
            .from(controlledAttributeValues)
            .where(
              and(
                eq(controlledAttributeValues.tenantId, tenantId),
                eq(controlledAttributeValues.attributeDefinitionId, attributeDefinitionId),
                eq(controlledAttributeValues.controlledAttributeValueId, value.valueRef.resourceId),
              ),
            )
            .limit(1)
            .pipe(Effect.mapError(unavailable)),
        { concurrency: 1 },
      );
      return states.every((rows) => rows[0]?.lifecycleState === 'ACTIVE');
    },
  );

  const allowedSetUnchanged = Effect.fn('VariantAxisPersistence.allowedSetUnchanged')(function* allowedSetUnchanged(
    productId: string,
    attributeDefinitionId: string,
    allowanceRevision: number,
    hashes: readonly string[],
  ) {
    const existing = yield* transaction
      .select({ valueKey: productVariantAxisAllowedValues.valueKey })
      .from(productVariantAxisAllowedValues)
      .where(
        and(
          eq(productVariantAxisAllowedValues.tenantId, tenantId),
          eq(productVariantAxisAllowedValues.productId, productId),
          eq(productVariantAxisAllowedValues.attributeDefinitionId, attributeDefinitionId),
          eq(productVariantAxisAllowedValues.allowanceRevision, allowanceRevision),
        ),
      )
      .pipe(Effect.mapError(unavailable));
    const existingKeys = existing.map((row) => row.valueKey).toSorted();
    const sorted = hashes.toSorted();
    return existingKeys.length === sorted.length && existingKeys.every((key, index) => key === sorted[index]);
  });

  const appendAllowedValuesSnapshot = Effect.fn('VariantAxisPersistence.appendAllowedValuesSnapshot')(
    function* appendAllowedValuesSnapshot(
      input: GovernVariantAllowedValuesInput,
      productId: string,
      axisRevision: number,
      allowanceRevision: number,
      hashes: readonly string[],
      normalized: readonly AttributeValue[],
    ) {
      yield* transaction.insert(productVariantAxisAllowanceEvents).values({
        actingPrincipalId: input.principalId,
        actionInvocationId: input.actionInvocationId,
        allowanceRevision,
        attributeDefinitionId: input.attributeDefinitionId,
        axisRevision,
        definitionRevision: input.definitionRevision,
        evidenceRefs: [...input.evidenceRefs],
        productId,
        reason: input.reason,
        tenantId,
        valueCount: hashes.length,
      });
      if (normalized.length === 0) {
        return;
      }
      yield* transaction.insert(productVariantAxisAllowedValues).values(
        normalized.map((value, index) => ({
          allowanceRevision,
          attributeDefinitionId: input.attributeDefinitionId,
          axisRevision,
          productId,
          tenantId,
          valueKey: hashes[index] ?? '',
          valueSnapshot: value,
        })),
      );
    },
    Effect.mapError(unavailable),
  );

  const governAllowedValues: VariantAxisPersistence['governAllowedValues'] = Effect.fn(
    'VariantAxisPersistence.governAllowedValues',
    // oxlint-disable-next-line complexity -- Allowed-value governance verifies axis revision, allowance revision, definition pin, value identity, controlled-value lifecycle, and idempotency in one transaction. expires: 2027-03-31.
  )(function* governAllowedValues(input) {
    if (!validGovernAllowedValuesInput(input, tenantId)) {
      return { _tag: 'invalid_input', reason: 'Invalid allowed-value governance input' } as const;
    }
    const productId = input.productRef.resourceId;
    const product = yield* lockProduct(productId);
    if (product === undefined) {
      return { _tag: 'not_found' } as const;
    }
    if (product.lifecycleState === 'RETIRED') {
      return { _tag: 'invalid_input', reason: 'Retired Product cannot govern Variant allowed values' } as const;
    }
    const current = yield* readCurrent(input.productRef);
    if (current.axisRevision !== input.expectedAxisRevision) {
      return { _tag: 'axis_conflict', actualAxisRevision: current.axisRevision } as const;
    }
    if (current.axisRevision < 1) {
      return {
        _tag: 'invalid_input',
        reason: 'A Product needs an established axis revision before allowed values can be staged',
      } as const;
    }
    const axis = current.axes.find((item) => item.attributeDefinitionId === input.attributeDefinitionId);
    if (axis !== undefined && axis.definitionRevision !== input.definitionRevision) {
      return {
        _tag: 'invalid_input',
        reason: 'Allowed values must pin the Current declared axis definition revision',
      } as const;
    }
    if (axis === undefined) {
      const [definition] = yield* transaction
        .select({ currentRevision: attributeDefinitions.currentRevision })
        .from(attributeDefinitions)
        .where(
          and(
            eq(attributeDefinitions.tenantId, tenantId),
            eq(attributeDefinitions.attributeDefinitionId, input.attributeDefinitionId),
          ),
        )
        .limit(1)
        .pipe(Effect.mapError(unavailable));
      // oxlint-disable-next-line effect-native/no-sequential-independent-yields -- Preserve deterministic authorization reads inside the locked staging transaction. expires: 2027-03-31.
      const [assignment] = yield* transaction
        .select()
        .from(productTypeAssignments)
        .where(and(eq(productTypeAssignments.tenantId, tenantId), eq(productTypeAssignments.productId, productId)))
        .limit(1)
        .pipe(Effect.mapError(unavailable));
      if (definition?.currentRevision !== input.definitionRevision || assignment === undefined) {
        return { _tag: 'invalid_input', reason: 'Proposed axis definition is not Current for this Product' } as const;
      }
      const [type] = yield* transaction
        .select({ currentRevision: productTypes.currentRevision })
        .from(productTypes)
        .where(and(eq(productTypes.tenantId, tenantId), eq(productTypes.productTypeId, assignment.productTypeId)))
        .limit(1)
        .pipe(Effect.mapError(unavailable));
      if (type === undefined || !Number.isSafeInteger(type.currentRevision) || type.currentRevision < 1) {
        return { _tag: 'invalid_input', reason: productTypeRevisionUnavailableReason } as const;
      }
      const [rule] = yield* transaction
        .select({ attributeDefinitionId: productTypeRevisionAttributes.attributeDefinitionId })
        .from(productTypeRevisionAttributes)
        .where(
          and(
            eq(productTypeRevisionAttributes.tenantId, tenantId),
            eq(productTypeRevisionAttributes.productTypeId, assignment.productTypeId),
            eq(productTypeRevisionAttributes.revision, type.currentRevision),
            eq(productTypeRevisionAttributes.attributeDefinitionId, input.attributeDefinitionId),
            eq(productTypeRevisionAttributes.level, 'VARIANT'),
          ),
        )
        .limit(1)
        .pipe(Effect.mapError(unavailable));
      // oxlint-disable-next-line effect-native/no-sequential-independent-yields -- Keep staged allowance authorization reads ordered inside the Product lock transaction. expires: 2027-03-31.
      const [applicability] = yield* transaction
        .select()
        .from(productAttributeApplicability)
        .where(
          and(
            eq(productAttributeApplicability.tenantId, tenantId),
            eq(productAttributeApplicability.productId, productId),
            eq(productAttributeApplicability.attributeDefinitionId, input.attributeDefinitionId),
          ),
        )
        .limit(1)
        .pipe(Effect.mapError(unavailable));
      if (
        rule === undefined ||
        invalidProductAxisApplicability(applicability, tenantId, productId, input.attributeDefinitionId)
      ) {
        return { _tag: 'invalid_input', reason: 'Proposed axis is not permitted for this Product' } as const;
      }
      if (applicability === undefined) {
        return { _tag: 'invalid_input', reason: 'Proposed axis applicability cannot be verified' } as const;
      }
      const [applicabilityRevision] = yield* transaction
        .select()
        .from(productAttributeApplicabilityRevisions)
        .where(
          and(
            eq(productAttributeApplicabilityRevisions.tenantId, tenantId),
            eq(productAttributeApplicabilityRevisions.productId, productId),
            eq(productAttributeApplicabilityRevisions.attributeDefinitionId, input.attributeDefinitionId),
            eq(productAttributeApplicabilityRevisions.revision, applicability.currentRevision),
          ),
        )
        .limit(1)
        .pipe(Effect.mapError(unavailable));
      if (invalidProductAxisApplicabilityRevision(applicabilityRevision, applicability)) {
        return { _tag: 'invalid_input', reason: 'Proposed axis applicability revision cannot be verified' } as const;
      }
    }
    const latest = yield* readLatestAllowance(productId, input.attributeDefinitionId);
    if ((latest?.allowanceRevision ?? 0) !== input.expectedAllowanceRevision) {
      return { _tag: 'revision_conflict', actualAllowanceRevision: latest?.allowanceRevision ?? 0 } as const;
    }
    const invocation = yield* readAllowanceByInvocation(input.actionInvocationId);
    if (invocation !== undefined) {
      return { _tag: 'governed', allowanceRevision: invocation.allowanceRevision, changed: false } as const;
    }
    const definition = yield* readPinnedDefinition(input.attributeDefinitionId, input.definitionRevision);
    if (definition === undefined) {
      return { _tag: 'invalid_input', reason: 'Pinned definition revision cannot be verified' } as const;
    }
    const validated = validateAllowedValuesSnapshot(definition, input.values);
    if (!validated.valid) {
      return { _tag: 'invalid_input', reason: validated.reason } as const;
    }
    if (!(yield* allControlledValuesActive(input.attributeDefinitionId, validated.normalized))) {
      return { _tag: 'invalid_input', reason: 'Allowed controlled value is not Active in this Tenant' } as const;
    }
    if (
      latest !== undefined &&
      latest.definitionRevision === input.definitionRevision &&
      latest.axisRevision === current.axisRevision &&
      (yield* allowedSetUnchanged(productId, input.attributeDefinitionId, latest.allowanceRevision, validated.hashes))
    ) {
      return { _tag: 'governed', allowanceRevision: latest.allowanceRevision, changed: false } as const;
    }
    const allowanceRevision = (latest?.allowanceRevision ?? 0) + 1;
    yield* appendAllowedValuesSnapshot(
      input,
      productId,
      current.axisRevision,
      allowanceRevision,
      validated.hashes,
      validated.normalized,
    );
    return { _tag: 'governed', allowanceRevision, changed: true } as const;
  });

  return {
    govern,
    governAllowedValues,
    readCurrent,
    readCurrentAllowedValues,
    readEffectiveValues,
    readRecordedCombinations,
    readRecordedVariants,
  };
};
