import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { findPostgresFailure } from '@app/core-runtime';
import { and, eq, isNull } from 'drizzle-orm';
import { Effect, Option, Schema } from 'effect';
import { randomUUID } from 'node:crypto';

import type { AttributeValue, UnitConversion } from '../../shared/domain/attribute-values.ts';
import type { VariantAttributeChangeClassification } from '../../shared/actions/attribute-value-mutations.ts';
import { AttributeDefinitionSchema, validateAttributeValues } from '../../shared/domain/attribute-values.ts';
import type { AttributeDefinitionRef } from '../../shared/resources/attribute-definition.ts';
import type { ProductRef } from '../../shared/resources/product.ts';
import type { VariantRef } from '../../shared/resources/variant.ts';
import {
  attributeDefinitions,
  attributeValueItems,
  attributeValueRevisions,
  attributeValueSets,
  controlledAttributeValues,
  productAttributeApplicability,
  productTypeAssignments,
  productTypeRevisionAttributes,
  productTypes,
  productVariantAxes,
  productVariants,
  products,
} from '../database/schema.ts';
import { CatalogPersistenceUnavailable } from './errors.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];

export class AttributeValuesConflict extends Schema.TaggedError<AttributeValuesConflict>()('AttributeValuesConflict', {
  code: Schema.Literal('attribute_values_conflict'),
  conflict: Schema.Literals([
    'INVALID_INPUT',
    'NOT_FOUND',
    'REVISION',
    'INVALID_STATE',
    'INAPPLICABLE',
    'INVALID_VALUE',
    'REQUIRED',
    'CONTROLLED_RETIRED',
    'BASIS_CHANGED',
    'IDENTITY_IMPACT',
    'ACTION_INVOCATION_ID',
  ]),
  reason: Schema.String,
}) {}

const conflict = (kind: AttributeValuesConflict['conflict'], reason: string) =>
  new AttributeValuesConflict({ code: 'attribute_values_conflict', conflict: kind, reason });
const unavailable = (cause: unknown): CatalogPersistenceUnavailable => {
  const error = new CatalogPersistenceUnavailable({
    code: 'catalog_persistence_unavailable',
    reason: 'Catalog persistence is temporarily unavailable',
  });
  Object.defineProperty(error, 'cause', { configurable: true, value: cause });
  return error;
};

export const mapAttributeValuesWriteError = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Core's PostgreSQL classifier reads an opaque driver cause; only typed failures escape. expires: 2027-03-31.
  error: unknown,
): AttributeValuesConflict | CatalogPersistenceUnavailable => {
  const uniqueViolationSqlState = ['23', '505'].join('');
  const unique = findPostgresFailure(
    error,
    ({ code, constraint }) =>
      code === uniqueViolationSqlState && constraint === 'catalog_attribute_value_revisions_invocation_uk',
  );
  return Option.isSome(unique)
    ? conflict('ACTION_INVOCATION_ID', 'Action invocation already recorded')
    : unavailable(error);
};

export interface ChangeInput {
  readonly actionInvocationId: string;
  readonly attributeDefinitionRef: AttributeDefinitionRef;
  readonly evidenceRefs?: readonly string[];
  readonly expectedRevision: number | null;
  readonly principalId: string;
  readonly productRef: ProductRef;
  readonly reason: string;
}
export interface SetInput extends ChangeInput {
  readonly conversions?: readonly UnitConversion[];
  readonly values: readonly AttributeValue[];
}
export interface VariantChangeInput extends ChangeInput {
  readonly classification: VariantAttributeChangeClassification;
  readonly variantRef: VariantRef;
}
export interface RemoveVariantInput extends VariantChangeInput {
  readonly expectedProductValueRevision: number | null;
}
type SetProductValuesInput = SetInput;
type RemoveProductValuesInput = ChangeInput;
type SetVariantOverrideInput = SetInput & VariantChangeInput;
type RemoveVariantOverrideInput = RemoveVariantInput;
export interface AttributeValuesChangeResult {
  readonly affectedVariantRefs?: readonly VariantRef[];
  readonly attributeValueSetId: string;
  readonly revision: number;
  readonly state: 'SET' | 'REMOVED';
}
export interface AttributeValuesPersistence {
  readonly removeProductValues: (
    input: RemoveProductValuesInput,
  ) => Effect.Effect<AttributeValuesChangeResult, AttributeValuesConflict | CatalogPersistenceUnavailable>;
  readonly removeVariantOverride: (
    input: RemoveVariantOverrideInput,
  ) => Effect.Effect<AttributeValuesChangeResult, AttributeValuesConflict | CatalogPersistenceUnavailable>;
  readonly setProductValues: (
    input: SetProductValuesInput,
  ) => Effect.Effect<AttributeValuesChangeResult, AttributeValuesConflict | CatalogPersistenceUnavailable>;
  readonly setVariantOverride: (
    input: SetVariantOverrideInput,
  ) => Effect.Effect<AttributeValuesChangeResult, AttributeValuesConflict | CatalogPersistenceUnavailable>;
}

interface MeasurementRow {
  canonicalUnit: string | null;
  decimalPlaces: number | null;
  maximum?: number;
  minimum?: number;
  quantity: string | null;
}

interface DefinitionRow {
  label: string;
  levels: string[];
  meaning: string;
  measurement?: MeasurementRow;
  multiplicity: string;
  ref: AttributeDefinitionRef;
  specialStates: ('UNKNOWN' | 'NONE' | 'NOT_APPLICABLE')[];
  valueKind: string;
}

const validRef = (ref: ProductRef | VariantRef | AttributeDefinitionRef, tenantId: string, type: string) =>
  ref.tenantId === tenantId && ref.moduleId === 'commerce.catalog' && ref.resourceType === type;
const validChange = (input: ChangeInput, tenantId: string) =>
  validRef(input.productRef, tenantId, 'commerce.catalog.product') &&
  validRef(input.attributeDefinitionRef, tenantId, 'commerce.catalog.attribute-definition') &&
  (input.expectedRevision === null || (Number.isInteger(input.expectedRevision) && input.expectedRevision > 0)) &&
  input.reason === input.reason.trim() &&
  input.reason.length > 0 &&
  input.reason.length <= 1000 &&
  (input.evidenceRefs ?? []).every((ref) => ref.length > 0 && ref === ref.trim());

/** Removing an override is conditional on the live inherited source, not a caller's stale preview. */
export const validateOverrideRemovalBasis = (
  expectedSourceRevision: number | null,
  currentSourceRevision: number | null,
  required: boolean,
  inheritancePermitted: boolean,
): AttributeValuesConflict | null => {
  if (currentSourceRevision !== expectedSourceRevision) {
    return conflict('BASIS_CHANGED', 'Inherited Product value source changed');
  }
  if (required && currentSourceRevision === null) {
    return conflict('REQUIRED', 'Required Variant value would become absent');
  }
  if (currentSourceRevision !== null && !inheritancePermitted) {
    return conflict('INAPPLICABLE', 'Product value cannot be inherited at this level');
  }
  return null;
};

interface VariantInheritanceRow {
  readonly lifecycleState: string;
  readonly variantId: string;
}

interface VariantValueSetRow {
  readonly currentState: string;
  readonly variantId: string | null;
}

/** Maps a transactionally locked Product population to the Variants whose effective value is inherited. */
export const resolveAffectedInheritedVariantRefs = (
  tenantId: string,
  variants: readonly VariantInheritanceRow[],
  valueSets: readonly VariantValueSetRow[],
): readonly VariantRef[] => {
  const overriddenVariantIds = new Set(
    valueSets.flatMap(({ currentState, variantId }) =>
      variantId !== null && currentState === 'SET' ? [variantId] : [],
    ),
  );
  return variants.flatMap(({ lifecycleState, variantId }) =>
    lifecycleState === 'RETIRED' || overriddenVariantIds.has(variantId)
      ? []
      : [
          {
            moduleId: 'commerce.catalog',
            resourceId: variantId,
            resourceType: 'commerce.catalog.variant',
            tenantId,
          } satisfies VariantRef,
        ],
  );
};

/** The service is constructed only on Core's tenant-scoped Action transaction. */
export const attributeValuesPersistenceForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
): Effect.Effect<AttributeValuesPersistence> => {
  const { tenantId } = scope;

  const change = Effect.fn('AttributeValuesPersistence.change')(function* change(
    input: ChangeInput & {
      readonly classification?: VariantAttributeChangeClassification;
      readonly conversions?: readonly UnitConversion[];
      readonly expectedProductValueRevision?: number | null;
      readonly values?: readonly AttributeValue[];
      readonly variantRef?: VariantRef;
    },
    state: 'SET' | 'REMOVED',
  ) {
    if (
      !validChange(input, tenantId) ||
      (input.variantRef !== undefined && !validRef(input.variantRef, tenantId, 'commerce.catalog.variant')) ||
      (state === 'SET' && (input.values === undefined || input.values.length === 0)) ||
      (state === 'REMOVED' && input.values !== undefined)
    ) {
      return yield* conflict('INVALID_INPUT', 'Malformed or cross-Tenant attribute value change');
    }
    const productId = input.productRef.resourceId;
    const definitionId = input.attributeDefinitionRef.resourceId;
    const variantId = input.variantRef?.resourceId;
    const validateSubject = Effect.fn('AttributeValuesPersistence.validateSubject')(function* validateSubject() {
      const [product] = yield* transaction
        .select()
        .from(products)
        .where(and(eq(products.tenantId, tenantId), eq(products.productId, productId)))
        .for('update')
        .limit(1)
        .pipe(Effect.mapError(unavailable));
      if (product === undefined) {
        return yield* conflict('NOT_FOUND', 'Product not found');
      }
      if (product.lifecycleState === 'RETIRED') {
        return yield* conflict('INVALID_STATE', 'Retired Product cannot change values');
      }
      if (variantId !== undefined) {
        const [variant] = yield* transaction
          .select()
          .from(productVariants)
          .where(
            and(
              eq(productVariants.tenantId, tenantId),
              eq(productVariants.productId, productId),
              eq(productVariants.variantId, variantId),
            ),
          )
          .for('update')
          .limit(1)
          .pipe(Effect.mapError(unavailable));
        if (variant === undefined) {
          return yield* conflict('NOT_FOUND', 'Variant does not belong to Product');
        }
        if (variant.lifecycleState === 'RETIRED') {
          return yield* conflict('INVALID_STATE', 'Retired Variant cannot change values');
        }
      }
      return null;
    });
    yield* validateSubject();
    const validateBasis = Effect.fn('AttributeValuesPersistence.validateBasis')(function* validateBasis() {
      const [definition] = yield* transaction
        .select()
        .from(attributeDefinitions)
        .where(
          and(
            eq(attributeDefinitions.tenantId, tenantId),
            eq(attributeDefinitions.attributeDefinitionId, definitionId),
          ),
        )
        .for('share')
        .limit(1)
        .pipe(Effect.mapError(unavailable));
      if (definition === undefined) {
        return yield* conflict('NOT_FOUND', 'Attribute Definition not found');
      }
      const level = variantId === undefined ? 'PRODUCT' : 'VARIANT';
      if (!definition.applicableLevels.includes(level)) {
        return yield* conflict('INAPPLICABLE', 'Definition does not permit this level');
      }

      const [assignment] = yield* transaction
        .select()
        .from(productTypeAssignments)
        .where(and(eq(productTypeAssignments.tenantId, tenantId), eq(productTypeAssignments.productId, productId)))
        .for('share')
        .limit(1)
        .pipe(Effect.mapError(unavailable));
      if (assignment === undefined) {
        return yield* conflict('INAPPLICABLE', 'Product has no authoritative Product Type');
      }
      const [productType] = yield* transaction
        .select()
        .from(productTypes)
        .where(and(eq(productTypes.tenantId, tenantId), eq(productTypes.productTypeId, assignment.productTypeId)))
        .for('share')
        .limit(1)
        .pipe(Effect.mapError(unavailable));
      if (productType === undefined) {
        return yield* conflict('INAPPLICABLE', 'Product Type basis is missing');
      }
      const [rule] = yield* transaction
        .select()
        .from(productTypeRevisionAttributes)
        .where(
          and(
            eq(productTypeRevisionAttributes.tenantId, tenantId),
            eq(productTypeRevisionAttributes.productTypeId, assignment.productTypeId),
            eq(productTypeRevisionAttributes.revision, productType.currentRevision),
            eq(productTypeRevisionAttributes.attributeDefinitionId, definitionId),
            eq(productTypeRevisionAttributes.level, level),
          ),
        )
        .limit(1)
        .pipe(Effect.mapError(unavailable));
      if (rule === undefined) {
        return yield* conflict('INAPPLICABLE', 'Attribute is not allowed by Current Product Type');
      }

      const [applicability] = yield* transaction
        .select()
        .from(productAttributeApplicability)
        .where(
          and(
            eq(productAttributeApplicability.tenantId, tenantId),
            eq(productAttributeApplicability.productId, productId),
            eq(productAttributeApplicability.attributeDefinitionId, definitionId),
          ),
        )
        .for('share')
        .limit(1)
        .pipe(Effect.mapError(unavailable));
      if (
        applicability === undefined ||
        (level === 'PRODUCT' ? !applicability.productLevel : !applicability.variantLevel)
      ) {
        return yield* conflict('INAPPLICABLE', 'Attribute is not declared for this Product at this level');
      }

      const [axis] = yield* transaction
        .select()
        .from(productVariantAxes)
        .where(
          and(
            eq(productVariantAxes.tenantId, tenantId),
            eq(productVariantAxes.productId, productId),
            eq(productVariantAxes.attributeDefinitionId, definitionId),
          ),
        )
        .limit(1)
        .pipe(Effect.mapError(unavailable));
      if (axis !== undefined) {
        return yield* conflict('IDENTITY_IMPACT', 'Variant Axis needs explicit identity revalidation');
      }
      let inheritedVariantRule: typeof productTypeRevisionAttributes.$inferSelect | undefined;
      if (variantId === undefined && definition.applicableLevels.includes('VARIANT') && applicability.variantLevel) {
        [inheritedVariantRule] = yield* transaction
          .select()
          .from(productTypeRevisionAttributes)
          .where(
            and(
              eq(productTypeRevisionAttributes.tenantId, tenantId),
              eq(productTypeRevisionAttributes.productTypeId, assignment.productTypeId),
              eq(productTypeRevisionAttributes.revision, productType.currentRevision),
              eq(productTypeRevisionAttributes.attributeDefinitionId, definitionId),
              eq(productTypeRevisionAttributes.level, 'VARIANT'),
            ),
          )
          .limit(1)
          .pipe(Effect.mapError(unavailable));
      }
      return { assignment, definition, inheritedVariantRule, productType, rule };
    });
    const { assignment, definition, inheritedVariantRule, productType, rule } = yield* validateBasis();

    const [current] = yield* transaction
      .select()
      .from(attributeValueSets)
      .where(
        and(
          eq(attributeValueSets.tenantId, tenantId),
          eq(attributeValueSets.productId, productId),
          eq(attributeValueSets.attributeDefinitionId, definitionId),
          variantId === undefined ? isNull(attributeValueSets.variantId) : eq(attributeValueSets.variantId, variantId),
        ),
      )
      .for('update')
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    if (
      current?.currentRevision !== input.expectedRevision &&
      !(current === undefined && input.expectedRevision === null)
    ) {
      return yield* conflict('REVISION', 'Attribute value revision changed');
    }
    const validateRemoval = Effect.fn('AttributeValuesPersistence.validateRemoval')(function* validateRemoval() {
      if (current === undefined || current.currentState === 'REMOVED') {
        return yield* conflict('INVALID_STATE', 'No direct value exists to remove');
      }
      if (variantId === undefined && rule.requirement === 'REQUIRED') {
        return yield* conflict('REQUIRED', 'Required Product value cannot be removed');
      }
      // Without complete per-Variant evidence, removal cannot prove that a required inherited value survives.
      if (variantId === undefined && inheritedVariantRule?.requirement === 'REQUIRED') {
        return yield* conflict('REQUIRED', 'Required Variant inheritance may depend on this Product value');
      }
      if (variantId !== undefined) {
        if (input.expectedProductValueRevision === undefined) {
          return yield* conflict('INVALID_INPUT', 'Source revision is required');
        }
        const [source] = yield* transaction
          .select()
          .from(attributeValueSets)
          .where(
            and(
              eq(attributeValueSets.tenantId, tenantId),
              eq(attributeValueSets.productId, productId),
              eq(attributeValueSets.attributeDefinitionId, definitionId),
              isNull(attributeValueSets.variantId),
            ),
          )
          .for('share')
          .limit(1)
          .pipe(Effect.mapError(unavailable));
        const sourceRevision = source?.currentState === 'SET' ? source.currentRevision : null;
        let inheritancePermitted = false;
        if (sourceRevision !== null) {
          const [productRule] = yield* transaction
            .select()
            .from(productTypeRevisionAttributes)
            .where(
              and(
                eq(productTypeRevisionAttributes.tenantId, tenantId),
                eq(productTypeRevisionAttributes.productTypeId, assignment.productTypeId),
                eq(productTypeRevisionAttributes.revision, productType.currentRevision),
                eq(productTypeRevisionAttributes.attributeDefinitionId, definitionId),
                eq(productTypeRevisionAttributes.level, 'PRODUCT'),
              ),
            )
            .limit(1)
            .pipe(Effect.mapError(unavailable));
          inheritancePermitted = productRule !== undefined && definition.applicableLevels.includes('PRODUCT');
        }
        const removalConflict = validateOverrideRemovalBasis(
          input.expectedProductValueRevision,
          sourceRevision,
          rule.requirement === 'REQUIRED',
          inheritancePermitted,
        );
        if (removalConflict !== null) {
          return yield* removalConflict;
        }
      }
      return null;
    });
    if (state === 'REMOVED') {
      yield* validateRemoval();
    }

    const normalizeValues = Effect.fn('AttributeValuesPersistence.normalizeValues')(function* normalizeValues() {
      let values: readonly AttributeValue[] = [];
      if (state === 'SET') {
        const domainDefinition: DefinitionRow = {
          label: definition.name,
          levels: definition.applicableLevels,
          meaning: definition.meaning,
          multiplicity: definition.multiplicity,
          ref: input.attributeDefinitionRef,
          specialStates: [
            ...(definition.allowsUnknown === 1 ? ['UNKNOWN' as const] : []),
            ...(definition.allowsNone === 1 ? ['NONE' as const] : []),
            ...(definition.allowsNotApplicable === 1 ? ['NOT_APPLICABLE' as const] : []),
          ],
          valueKind: definition.valueKind,
        };
        if (definition.valueKind === 'MEASUREMENT') {
          const measurement: MeasurementRow = {
            canonicalUnit: definition.canonicalUnit,
            decimalPlaces: definition.decimalPlaces,
            quantity: definition.measuredQuantity,
          };
          if (definition.minimumValue !== null) {
            measurement.minimum = Number(definition.minimumValue);
          }
          if (definition.maximumValue !== null) {
            measurement.maximum = Number(definition.maximumValue);
          }
          domainDefinition.measurement = measurement;
        }
        const decoded = Schema.decodeUnknownOption(AttributeDefinitionSchema)(domainDefinition);
        if (Option.isNone(decoded)) {
          return yield* conflict('INVALID_VALUE', 'Current Attribute Definition is invalid');
        }
        const checked = validateAttributeValues(decoded.value, input.values ?? [], input.conversions ?? []);
        if (!checked.valid) {
          return yield* conflict('INVALID_VALUE', checked.reasons.join('; '));
        }
        values = checked.normalized;
        yield* Effect.forEach(
          values.filter((value) => value.kind === 'CONTROLLED'),
          Effect.fn('AttributeValuesPersistence.validateControlled')(function* validateControlled(value) {
            if (value.kind !== 'CONTROLLED') {
              return null;
            }
            const [controlled] = yield* transaction
              .select()
              .from(controlledAttributeValues)
              .where(
                and(
                  eq(controlledAttributeValues.tenantId, tenantId),
                  eq(controlledAttributeValues.attributeDefinitionId, definitionId),
                  eq(controlledAttributeValues.controlledAttributeValueId, value.valueRef.resourceId),
                ),
              )
              .for('share')
              .limit(1)
              .pipe(Effect.mapError(unavailable));
            if (controlled === undefined || controlled.lifecycleState !== 'ACTIVE') {
              return yield* conflict('CONTROLLED_RETIRED', 'Controlled value is missing or retired');
            }
            return null;
          }),
          { concurrency: 1 },
        );
      }
      return values;
    });
    const values = yield* normalizeValues();
    const proveAffectedVariants = Effect.fn('AttributeValuesPersistence.proveAffectedVariants')(
      function* proveAffectedVariants() {
        if (variantId !== undefined) {
          return null;
        }
        if (inheritedVariantRule === undefined) {
          return [];
        }
        const [variants, valueSets] = yield* Effect.all(
          [
            transaction
              .select({
                lifecycleState: productVariants.lifecycleState,
                variantId: productVariants.variantId,
              })
              .from(productVariants)
              .where(and(eq(productVariants.tenantId, tenantId), eq(productVariants.productId, productId)))
              .for('update')
              .pipe(Effect.mapError(unavailable)),
            transaction
              .select({
                currentState: attributeValueSets.currentState,
                variantId: attributeValueSets.variantId,
              })
              .from(attributeValueSets)
              .where(
                and(
                  eq(attributeValueSets.tenantId, tenantId),
                  eq(attributeValueSets.productId, productId),
                  eq(attributeValueSets.attributeDefinitionId, definitionId),
                ),
              )
              .for('update')
              .pipe(Effect.mapError(unavailable)),
          ] as const,
          { concurrency: 1 },
        );
        return resolveAffectedInheritedVariantRefs(tenantId, variants, valueSets);
      },
    );
    const affectedVariantRefs = yield* proveAffectedVariants();
    const setId = current?.attributeValueSetId ?? randomUUID();
    const revision = (current?.currentRevision ?? 0) + 1;
    const persist = Effect.fn('AttributeValuesPersistence.persist')(function* persist() {
      if (current === undefined) {
        yield* transaction.insert(attributeValueSets).values({
          attributeDefinitionId: definitionId,
          attributeValueSetId: setId,
          currentRevision: revision,
          currentState: state,
          productId,
          tenantId,
          variantId: variantId ?? null,
        });
      } else {
        yield* transaction
          .update(attributeValueSets)
          .set({ currentRevision: revision, currentState: state })
          .where(and(eq(attributeValueSets.tenantId, tenantId), eq(attributeValueSets.attributeValueSetId, setId)));
        yield* transaction
          .delete(attributeValueItems)
          .where(and(eq(attributeValueItems.tenantId, tenantId), eq(attributeValueItems.attributeValueSetId, setId)));
      }
      if (state === 'SET') {
        yield* transaction.insert(attributeValueItems).values(
          values.map((value, ordinal) => ({
            attributeDefinitionId: definitionId,
            attributeValueSetId: setId,
            controlledAttributeValueId: value.kind === 'CONTROLLED' ? value.valueRef.resourceId : null,
            numericValue: value.kind === 'MEASUREMENT' ? String(value.amount) : null,
            ordinal,
            specialState: value.kind === 'SPECIAL' ? value.state : null,
            tenantId,
            textValue: value.kind === 'TEXT' ? value.text : null,
            unit: value.kind === 'MEASUREMENT' ? value.unit : null,
            valueKind: value.kind,
          })),
        );
      }
      yield* transaction.insert(attributeValueRevisions).values({
        actingPrincipalId: input.principalId,
        actionInvocationId: input.actionInvocationId,
        attributeValueSetId: setId,
        changeKind: state,
        evidenceRefs: [...(input.evidenceRefs ?? [])],
        reason: input.reason,
        revision,
        tenantId,
        valueSnapshot: {
          attributeDefinitionRevision: definition.currentRevision,
          classification: input.classification ?? null,
          productTypeId: assignment.productTypeId,
          productTypeRevision: productType.currentRevision,
          sourceProductValueRevision: variantId === undefined ? null : (input.expectedProductValueRevision ?? null),
          values,
        },
      });
      const result = { attributeValueSetId: setId, revision, state };
      return affectedVariantRefs === null ? result : { ...result, affectedVariantRefs };
    }, Effect.mapError(mapAttributeValuesWriteError));
    return yield* persist();
  });

  return Effect.succeed({
    removeProductValues: (input) => change(input, 'REMOVED'),
    removeVariantOverride: (input) =>
      input.classification.kind === 'NEW_REALIZATION'
        ? Effect.fail(conflict('IDENTITY_IMPACT', 'A new realization requires a distinct Variant'))
        : change(input, 'REMOVED'),
    setProductValues: (input) => change(input, 'SET'),
    setVariantOverride: (input) =>
      input.classification.kind === 'NEW_REALIZATION'
        ? Effect.fail(conflict('IDENTITY_IMPACT', 'A new realization requires a distinct Variant'))
        : change(input, 'SET'),
  });
};
