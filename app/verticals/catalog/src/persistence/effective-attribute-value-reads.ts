import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { and, eq, inArray } from 'drizzle-orm';
import { DateTime, Effect, Match, Option, Schema } from 'effect';
import { isDeepStrictEqual } from 'node:util';

import type { AttributeDefinition, AttributeValue } from '../../shared/domain/attribute-values.ts';
import {
  AttributeDefinitionSchema,
  AttributeValueSchema,
  validateAttributeValues,
} from '../../shared/domain/attribute-values.ts';
import type {
  EffectiveAttributeValuesResult,
  AttributeValueSetSnapshot,
} from '../../shared/domain/effective-attribute-values.ts';
import { resolveEffectiveAttributeValues } from '../../shared/domain/effective-attribute-values.ts';
import {
  ProductTypeCurrentBasisSchema,
  ProductTypeCurrentRulesRevisionSchema,
} from '../../shared/domain/product-type-rules.ts';
import type { AttributeDefinitionRef } from '../../shared/resources/attribute-definition.ts';
import { AttributeDefinitionRefSchema } from '../../shared/resources/attribute-definition.ts';
import type { ProductRef } from '../../shared/resources/product.ts';
import { ProductRefSchema } from '../../shared/resources/product.ts';
import type { VariantRef } from '../../shared/resources/variant.ts';
import { VariantRefSchema } from '../../shared/resources/variant.ts';
import {
  attributeDefinitions,
  attributeDefinitionRevisions,
  attributeValueItems,
  attributeValueRevisions,
  attributeValueSets,
  controlledAttributeValues,
  controlledAttributeValueRevisions,
  productAttributeApplicability,
  productAttributeApplicabilityRevisions,
  productTypeAssignments,
  productTypeRevisionAttributes,
  productTypeRevisions,
  productTypes,
  productVariants,
  products,
} from '../database/schema.ts';
import { CatalogPersistenceUnavailable } from './errors.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];

interface EffectiveAttributeValueReadInput {
  readonly attributeDefinitionRef: AttributeDefinitionRef;
  readonly productRef: ProductRef;
  readonly variantRef: VariantRef;
}

export interface EffectiveAttributeValueReads {
  readonly readDefinitionCurrent: (
    attributeDefinitionRef: AttributeDefinitionRef,
  ) => Effect.Effect<AttributeDefinitionCurrentProof, CatalogPersistenceUnavailable>;
  readonly readProductTypeValidity: (
    productIds: readonly string[],
  ) => Effect.Effect<AttributeValueSetValidityBasis, CatalogPersistenceUnavailable>;
  readonly resolveVariant: (
    input: EffectiveAttributeValueReadInput,
  ) => Effect.Effect<EffectiveAttributeValuesResult, CatalogPersistenceUnavailable>;
}

interface AttributeDefinitionCurrentProof {
  readonly attributeDefinitionId: string;
  readonly complete: boolean;
  readonly revision: number | null;
  readonly tenantId: string;
}

export interface AttributeValueSetValidityEntry {
  readonly attributeDefinitionId: string;
  readonly attributeValueSetId: string;
  /** Structurally valid SPECIAL states do not confirm a required measured fact. */
  readonly confirmsRequiredFact: boolean;
  readonly currentState: 'SET' | 'REMOVED';
  readonly definitionRevision: number;
  readonly productId: string;
  readonly revision: number;
  readonly sourceRevisionToken: string;
  readonly valid: boolean;
  readonly variantId: string | null;
}

export interface AttributeValueSetValidityBasis {
  readonly complete: boolean;
  readonly entries: readonly AttributeValueSetValidityEntry[];
  readonly tenantId: string;
}

const CATALOG_MODULE_ID = 'commerce.catalog';
const ref = (tenantId: string, resourceId: string, resourceType: string) => ({
  moduleId: CATALOG_MODULE_ID,
  resourceId,
  resourceType,
  tenantId,
});
const invalid = (reason: string): EffectiveAttributeValuesResult => ({
  reasons: [reason],
  status: 'INVALID_AUTHORITY',
});
const validInput = (input: EffectiveAttributeValueReadInput, tenantId: string): boolean =>
  Schema.is(ProductRefSchema)(input.productRef) &&
  Schema.is(VariantRefSchema)(input.variantRef) &&
  Schema.is(AttributeDefinitionRefSchema)(input.attributeDefinitionRef) &&
  input.productRef.tenantId === tenantId &&
  input.variantRef.tenantId === tenantId &&
  input.attributeDefinitionRef.tenantId === tenantId;
const unavailable = (cause: unknown): CatalogPersistenceUnavailable => {
  const error = new CatalogPersistenceUnavailable({
    code: 'catalog_persistence_unavailable',
    reason: 'Catalog persistence is temporarily unavailable',
  });
  Object.defineProperty(error, 'cause', { configurable: true, value: cause });
  return error;
};

type DefinitionRow = typeof attributeDefinitions.$inferSelect;
type ValueItemRow = typeof attributeValueItems.$inferSelect;
type ValueSetRow = typeof attributeValueSets.$inferSelect;
type ValueRevisionRow = typeof attributeValueRevisions.$inferSelect;
const validSubject = (
  product: typeof products.$inferSelect | undefined,
  variant: typeof productVariants.$inferSelect | undefined,
  tenantId: string,
  productId: string,
  variantId: string,
): boolean =>
  product !== undefined &&
  product.productId === productId &&
  product.tenantId === tenantId &&
  variant !== undefined &&
  variant.variantId === variantId &&
  variant.productId === productId &&
  variant.tenantId === tenantId &&
  product.lifecycleState !== 'RETIRED' &&
  variant.lifecycleState !== 'RETIRED';
const validApplicability = (
  current: typeof productAttributeApplicability.$inferSelect | undefined,
  revision: typeof productAttributeApplicabilityRevisions.$inferSelect | undefined,
  tenantId: string,
  productId: string,
  definitionId: string,
): boolean =>
  current !== undefined &&
  revision !== undefined &&
  current.tenantId === tenantId &&
  current.productId === productId &&
  current.attributeDefinitionId === definitionId &&
  current.variantLevel &&
  revision.tenantId === tenantId &&
  revision.productId === productId &&
  revision.attributeDefinitionId === definitionId &&
  revision.revision === current.currentRevision &&
  revision.productLevel === current.productLevel &&
  revision.variantLevel === current.variantLevel;
const validRelevantSets = (
  sets: readonly ValueSetRow[],
  tenantId: string,
  productId: string,
  definitionId: string,
  variantId: string,
  productLevel: boolean,
): boolean =>
  !sets.some(
    (set) =>
      set.tenantId !== tenantId ||
      set.productId !== productId ||
      set.attributeDefinitionId !== definitionId ||
      (set.variantId !== null && set.variantId !== variantId) ||
      (set.variantId === null && !productLevel),
  ) &&
  sets.filter((set) => set.variantId === null).length <= 1 &&
  sets.filter((set) => set.variantId === variantId).length <= 1;
const ValueRevisionSnapshotSchema = Schema.Struct({
  attributeDefinitionRevision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  productTypeId: Schema.String.pipe(Schema.brand('ProductTypeId')),
  productTypeRevision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  sourceProductValueRevision: Schema.OptionFromNullOr(Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))),
  values: Schema.Array(AttributeValueSchema),
});

const definitionRuleFields = (row: DefinitionRow | typeof attributeDefinitionRevisions.$inferSelect) => ({
  allowsNone: row.allowsNone,
  allowsNotApplicable: row.allowsNotApplicable,
  allowsUnknown: row.allowsUnknown,
  applicableLevels: row.applicableLevels,
  canonicalUnit: row.canonicalUnit,
  controlledValueKind: row.controlledValueKind,
  decimalPlaces: row.decimalPlaces,
  maximumValue: row.maximumValue,
  meaning: row.meaning,
  measuredQuantity: row.measuredQuantity,
  minimumValue: row.minimumValue,
  multiplicity: row.multiplicity,
  name: row.name,
  valueKind: row.valueKind,
});

const malformedSetSnapshot = (
  set: ValueSetRow,
  records: readonly ValueRevisionRow[],
  items: readonly ValueItemRow[],
  tenantId: string,
  productId: string,
  definitionId: string,
  variantId: string,
): boolean =>
  records.length !== 1 ||
  records[0]?.tenantId !== tenantId ||
  records[0].attributeValueSetId !== set.attributeValueSetId ||
  records[0].revision !== set.currentRevision ||
  set.tenantId !== tenantId ||
  set.productId !== productId ||
  set.attributeDefinitionId !== definitionId ||
  (set.variantId !== null && set.variantId !== variantId) ||
  !Number.isInteger(set.currentRevision) ||
  set.currentRevision < 1 ||
  records[0].changeKind !== set.currentState ||
  (set.currentState === 'SET' && items.length === 0) ||
  (set.currentState === 'REMOVED' && items.length !== 0) ||
  items.some(
    (item, index) =>
      item.tenantId !== tenantId ||
      item.attributeValueSetId !== set.attributeValueSetId ||
      item.ordinal !== index ||
      item.attributeDefinitionId !== definitionId,
  );

const decodeDefinition = (
  row: DefinitionRow,
  definitionRef: AttributeDefinitionRef,
): Option.Option<AttributeDefinition> => {
  const measurement =
    row.valueKind === 'MEASUREMENT'
      ? {
          canonicalUnit: row.canonicalUnit,
          decimalPlaces: row.decimalPlaces,
          maximum: row.maximumValue === null ? undefined : Number(row.maximumValue),
          minimum: row.minimumValue === null ? undefined : Number(row.minimumValue),
          quantity: row.measuredQuantity,
        }
      : undefined;
  const definition = {
    label: row.name,
    levels: row.applicableLevels,
    meaning: row.meaning,
    multiplicity: row.multiplicity,
    ref: definitionRef,
    specialStates: [
      ...(row.allowsUnknown === 1 ? ['UNKNOWN'] : []),
      ...(row.allowsNone === 1 ? ['NONE'] : []),
      ...(row.allowsNotApplicable === 1 ? ['NOT_APPLICABLE'] : []),
    ],
    valueKind: row.valueKind,
  };
  return Schema.decodeUnknownOption(AttributeDefinitionSchema)(
    measurement === undefined ? definition : { ...definition, measurement },
  );
};

const readCurrentDefinition = Effect.fn('EffectiveAttributeValueReads.readCurrentDefinition')(
  function* readCurrentDefinition(transaction: ScopedTransaction, tenantId: string, definitionId: string) {
    const [definition] = yield* transaction
      .select()
      .from(attributeDefinitions)
      .where(
        and(eq(attributeDefinitions.tenantId, tenantId), eq(attributeDefinitions.attributeDefinitionId, definitionId)),
      )
      .limit(1);
    if (definition === undefined) {
      return Option.none<DefinitionRow>();
    }
    const [revision] = yield* transaction
      .select()
      .from(attributeDefinitionRevisions)
      .where(
        and(
          eq(attributeDefinitionRevisions.tenantId, tenantId),
          eq(attributeDefinitionRevisions.attributeDefinitionId, definitionId),
          eq(attributeDefinitionRevisions.revision, definition.currentRevision),
        ),
      )
      .limit(2);
    if (
      revision === undefined ||
      !isDeepStrictEqual(definitionRuleFields(definition), definitionRuleFields(revision)) ||
      Option.isNone(
        decodeDefinition(definition, {
          moduleId: CATALOG_MODULE_ID,
          resourceId: definitionId,
          resourceType: 'commerce.catalog.attribute-definition',
          tenantId,
        }),
      )
    ) {
      return Option.none<DefinitionRow>();
    }
    return Option.some(definition);
  },
  Effect.mapError(unavailable),
);

const decodePlainItem = (item: ValueItemRow): Option.Option<AttributeValue> =>
  Match.value(item.valueKind).pipe(
    Match.when('TEXT', () => Schema.decodeUnknownOption(AttributeValueSchema)({ kind: 'TEXT', text: item.textValue })),
    Match.when('MEASUREMENT', () =>
      Schema.decodeUnknownOption(AttributeValueSchema)({
        amount: Number(item.numericValue),
        kind: 'MEASUREMENT',
        unit: item.unit,
      }),
    ),
    Match.when('SPECIAL', () =>
      Schema.decodeUnknownOption(AttributeValueSchema)({ kind: 'SPECIAL', state: item.specialState }),
    ),
    Match.orElse(() => Option.none()),
  );

const decodeItem = Effect.fn('EffectiveAttributeValueReads.decodeItem')(function* decodeItem(
  transaction: ScopedTransaction,
  tenantId: string,
  definitionId: string,
  controlledKind: string | null,
  item: ValueItemRow,
) {
  if (item.valueKind !== 'CONTROLLED') {
    return decodePlainItem(item);
  }
  if (item.controlledAttributeValueId === null) {
    return Option.none<AttributeValue>();
  }
  const [controlled] = yield* transaction
    .select()
    .from(controlledAttributeValues)
    .where(
      and(
        eq(controlledAttributeValues.tenantId, tenantId),
        eq(controlledAttributeValues.attributeDefinitionId, definitionId),
        eq(controlledAttributeValues.controlledAttributeValueId, item.controlledAttributeValueId),
      ),
    )
    .limit(1)
    .pipe(Effect.mapError(unavailable));
  if (
    controlled === undefined ||
    controlled.tenantId !== tenantId ||
    controlled.attributeDefinitionId !== definitionId ||
    controlled.specialization !== controlledKind ||
    controlled.lifecycleState !== 'ACTIVE'
  ) {
    return Option.none<AttributeValue>();
  }
  return Schema.decodeUnknownOption(AttributeValueSchema)({
    kind: 'CONTROLLED',
    valueRef: ref(tenantId, controlled.controlledAttributeValueId, 'commerce.catalog.controlled-attribute-value'),
  });
});

const readControlledDependency = Effect.fn('EffectiveAttributeValueReads.readControlledDependency')(
  function* readControlledDependency(
    transaction: ScopedTransaction,
    tenantId: string,
    definitionId: string,
    controlledId: string | null,
  ) {
    if (controlledId === null) {
      return Option.none<string>();
    }
    const [value] = yield* transaction
      .select()
      .from(controlledAttributeValues)
      .where(
        and(
          eq(controlledAttributeValues.tenantId, tenantId),
          eq(controlledAttributeValues.attributeDefinitionId, definitionId),
          eq(controlledAttributeValues.controlledAttributeValueId, controlledId),
        ),
      )
      .limit(1);
    if (value === undefined) {
      return Option.none<string>();
    }
    const [revision] = yield* transaction
      .select()
      .from(controlledAttributeValueRevisions)
      .where(
        and(
          eq(controlledAttributeValueRevisions.tenantId, tenantId),
          eq(controlledAttributeValueRevisions.controlledAttributeValueId, controlledId),
          eq(controlledAttributeValueRevisions.revision, value.currentRevision),
        ),
      )
      .limit(1);
    if (
      revision === undefined ||
      revision.attributeDefinitionId !== definitionId ||
      revision.lifecycleState !== value.lifecycleState ||
      revision.meaning !== value.meaning ||
      revision.name !== value.name ||
      revision.specialization !== value.specialization ||
      value.lifecycleState !== 'ACTIVE'
    ) {
      return Option.none<string>();
    }
    return Option.some(`${controlledId}@${value.currentRevision}`);
  },
  Effect.mapError(unavailable),
);

const readValidityEntry = Effect.fn('EffectiveAttributeValueReads.readValidityEntry')(function* readValidityEntry(
  transaction: ScopedTransaction,
  tenantId: string,
  set: ValueSetRow,
) {
  const definition = yield* readCurrentDefinition(transaction, tenantId, set.attributeDefinitionId);
  if (Option.isNone(definition) || (set.currentState !== 'SET' && set.currentState !== 'REMOVED')) {
    return Option.none<AttributeValueSetValidityEntry>();
  }
  const [records, items] = yield* Effect.all(
    [
      transaction
        .select()
        .from(attributeValueRevisions)
        .where(
          and(
            eq(attributeValueRevisions.tenantId, tenantId),
            eq(attributeValueRevisions.attributeValueSetId, set.attributeValueSetId),
            eq(attributeValueRevisions.revision, set.currentRevision),
          ),
        )
        .limit(2)
        .pipe(Effect.mapError(unavailable)),
      transaction
        .select()
        .from(attributeValueItems)
        .where(
          and(
            eq(attributeValueItems.tenantId, tenantId),
            eq(attributeValueItems.attributeValueSetId, set.attributeValueSetId),
          ),
        )
        .orderBy(attributeValueItems.ordinal)
        .pipe(Effect.mapError(unavailable)),
    ],
    { concurrency: 2 },
  );
  if (
    malformedSetSnapshot(set, records, items, tenantId, set.productId, set.attributeDefinitionId, set.variantId ?? '')
  ) {
    return Option.none<AttributeValueSetValidityEntry>();
  }
  const snapshot = Schema.decodeUnknownOption(ValueRevisionSnapshotSchema)(records[0]?.valueSnapshot);
  if (Option.isNone(snapshot)) {
    return Option.none<AttributeValueSetValidityEntry>();
  }
  const dependencies = yield* Effect.forEach(
    items.filter((item) => item.valueKind === 'CONTROLLED'),
    (item) =>
      readControlledDependency(transaction, tenantId, set.attributeDefinitionId, item.controlledAttributeValueId),
    { concurrency: 1 },
  );
  if (dependencies.some(Option.isNone)) {
    return Option.none<AttributeValueSetValidityEntry>();
  }
  const decoded = yield* Effect.forEach(
    items,
    (item) => decodeItem(transaction, tenantId, set.attributeDefinitionId, definition.value.controlledValueKind, item),
    { concurrency: 1 },
  );
  if (decoded.some(Option.isNone)) {
    return Option.none<AttributeValueSetValidityEntry>();
  }
  const values = Option.all(decoded);
  const currentDefinition = decodeDefinition(definition.value, {
    moduleId: CATALOG_MODULE_ID,
    resourceId: set.attributeDefinitionId,
    resourceType: 'commerce.catalog.attribute-definition',
    tenantId,
  });
  if (Option.isNone(values) || Option.isNone(currentDefinition)) {
    return Option.none<AttributeValueSetValidityEntry>();
  }
  if (!isDeepStrictEqual(snapshot.value.values, values.value)) {
    return Option.none<AttributeValueSetValidityEntry>();
  }
  const checked =
    set.currentState === 'REMOVED' || validateAttributeValues(currentDefinition.value, values.value).valid;
  const dependencyTokens = dependencies.flatMap((dependency) => (Option.isSome(dependency) ? [dependency.value] : []));
  return Option.some<AttributeValueSetValidityEntry>({
    attributeDefinitionId: set.attributeDefinitionId,
    attributeValueSetId: set.attributeValueSetId,
    confirmsRequiredFact:
      set.currentState === 'SET' && checked && values.value.some((value) => value.kind !== 'SPECIAL'),
    currentState: set.currentState,
    definitionRevision: definition.value.currentRevision,
    productId: set.productId,
    revision: set.currentRevision,
    sourceRevisionToken: [
      set.attributeValueSetId,
      set.currentRevision,
      set.attributeDefinitionId,
      definition.value.currentRevision,
      snapshot.value.attributeDefinitionRevision,
      ...dependencyTokens.toSorted(),
    ].join(':'),
    valid: checked,
    variantId: set.variantId,
  });
});

/** Private owner service; Core supplies the already scoped read transaction and authorizes its caller. */
export const effectiveAttributeValueReadsForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
): Effect.Effect<EffectiveAttributeValueReads> =>
  Effect.succeed({
    readDefinitionCurrent: Effect.fn('EffectiveAttributeValueReads.readDefinitionCurrent')(
      function* readDefinitionCurrent(attributeDefinitionRef) {
        const { tenantId } = scope;
        const attributeDefinitionId = attributeDefinitionRef.resourceId;
        if (
          !Schema.is(AttributeDefinitionRefSchema)(attributeDefinitionRef) ||
          attributeDefinitionRef.tenantId !== tenantId
        ) {
          return { attributeDefinitionId, complete: false, revision: null, tenantId };
        }
        const current = yield* readCurrentDefinition(transaction, tenantId, attributeDefinitionId);
        return {
          attributeDefinitionId,
          complete: Option.isSome(current),
          revision: Option.isSome(current) ? current.value.currentRevision : null,
          tenantId,
        };
      },
    ),
    readProductTypeValidity: Effect.fn('EffectiveAttributeValueReads.readProductTypeValidity')(
      function* readProductTypeValidity(productIds) {
        const { tenantId } = scope;
        const invalidBasis = (): AttributeValueSetValidityBasis => ({ complete: false, entries: [], tenantId });
        if (
          new Set(productIds).size !== productIds.length ||
          productIds.some(
            (id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id),
          )
        ) {
          return invalidBasis();
        }
        if (productIds.length === 0) {
          return { complete: true, entries: [], tenantId };
        }
        const [subjects, sets] = yield* Effect.all(
          [
            transaction
              .select({ productId: products.productId })
              .from(products)
              .where(and(eq(products.tenantId, tenantId), inArray(products.productId, [...productIds])))
              .pipe(Effect.mapError(unavailable)),
            transaction
              .select()
              .from(attributeValueSets)
              .where(
                and(eq(attributeValueSets.tenantId, tenantId), inArray(attributeValueSets.productId, [...productIds])),
              )
              .pipe(Effect.mapError(unavailable)),
          ],
          { concurrency: 2 },
        );
        if (subjects.length !== productIds.length) {
          return invalidBasis();
        }
        const loaded = yield* Effect.forEach(sets, (set) => readValidityEntry(transaction, tenantId, set), {
          concurrency: 1,
        });
        if (loaded.some(Option.isNone)) {
          return invalidBasis();
        }
        const entries = Option.all(loaded);
        return Option.isSome(entries) ? { complete: true, entries: entries.value, tenantId } : invalidBasis();
      },
    ),
    resolveVariant: Effect.fn('EffectiveAttributeValueReads.resolveVariant')(function* resolveVariant(input) {
      const { tenantId } = scope;
      if (!validInput(input, tenantId)) {
        return invalid('Malformed or foreign Catalog reference');
      }
      const productId = input.productRef.resourceId;
      const variantId = input.variantRef.resourceId;
      const definitionId = input.attributeDefinitionRef.resourceId;
      const query = <A, E>(effect: Effect.Effect<A, E>) => effect.pipe(Effect.mapError(unavailable));
      const [[product], [variant], currentDefinition] = yield* Effect.all(
        [
          query(
            transaction
              .select()
              .from(products)
              .where(and(eq(products.tenantId, tenantId), eq(products.productId, productId)))
              .limit(1),
          ),
          query(
            transaction
              .select()
              .from(productVariants)
              .where(
                and(
                  eq(productVariants.tenantId, tenantId),
                  eq(productVariants.productId, productId),
                  eq(productVariants.variantId, variantId),
                ),
              )
              .limit(1),
          ),
          readCurrentDefinition(transaction, tenantId, definitionId),
        ],
        { concurrency: 3 },
      );
      if (!validSubject(product, variant, tenantId, productId, variantId) || Option.isNone(currentDefinition)) {
        return invalid('Product, Variant, or definition is missing or retired');
      }
      const definition = currentDefinition.value;
      const [assignment] = yield* query(
        transaction
          .select()
          .from(productTypeAssignments)
          .where(and(eq(productTypeAssignments.tenantId, tenantId), eq(productTypeAssignments.productId, productId)))
          .limit(1),
      );
      if (assignment === undefined) {
        return invalid('Current Product Type assignment is missing');
      }
      const [productType] = yield* query(
        transaction
          .select()
          .from(productTypes)
          .where(and(eq(productTypes.tenantId, tenantId), eq(productTypes.productTypeId, assignment.productTypeId)))
          .limit(1),
      );
      if (productType === undefined) {
        return invalid('Current Product Type is missing');
      }
      const [revision] = yield* query(
        transaction
          .select()
          .from(productTypeRevisions)
          .where(
            and(
              eq(productTypeRevisions.tenantId, tenantId),
              eq(productTypeRevisions.productTypeId, assignment.productTypeId),
              eq(productTypeRevisions.revision, productType.currentRevision),
            ),
          )
          .limit(1),
      );
      if (revision === undefined) {
        return invalid('Current Product Type revision is missing');
      }
      const rules = yield* query(
        transaction
          .select()
          .from(productTypeRevisionAttributes)
          .where(
            and(
              eq(productTypeRevisionAttributes.tenantId, tenantId),
              eq(productTypeRevisionAttributes.productTypeId, assignment.productTypeId),
              eq(productTypeRevisionAttributes.revision, productType.currentRevision),
              eq(productTypeRevisionAttributes.attributeDefinitionId, definitionId),
            ),
          ),
      );
      const decodedDefinition = decodeDefinition(definition, input.attributeDefinitionRef);
      if (Option.isNone(decodedDefinition)) {
        return invalid('Current Attribute Definition is malformed');
      }
      const [applicability] = yield* query(
        transaction
          .select()
          .from(productAttributeApplicability)
          .where(
            and(
              eq(productAttributeApplicability.tenantId, tenantId),
              eq(productAttributeApplicability.productId, productId),
              eq(productAttributeApplicability.attributeDefinitionId, definitionId),
            ),
          )
          .limit(1),
      );
      if (applicability === undefined) {
        return invalid('Attribute is not declared for this Product at Variant level');
      }
      const [applicabilityRevision] = yield* query(
        transaction
          .select()
          .from(productAttributeApplicabilityRevisions)
          .where(
            and(
              eq(productAttributeApplicabilityRevisions.tenantId, tenantId),
              eq(productAttributeApplicabilityRevisions.productId, productId),
              eq(productAttributeApplicabilityRevisions.attributeDefinitionId, definitionId),
              eq(productAttributeApplicabilityRevisions.revision, applicability.currentRevision),
            ),
          )
          .limit(1),
      );
      if (!validApplicability(applicability, applicabilityRevision, tenantId, productId, definitionId)) {
        return invalid('Current Product attribute applicability is malformed');
      }
      const typeRef = ref(tenantId, assignment.productTypeId, 'commerce.catalog.product-type');
      const effectiveFrom = revision.effectiveAt.toISOString();
      const basis = Schema.decodeUnknownOption(ProductTypeCurrentBasisSchema)({
        currentRevision: productType.currentRevision,
        effectiveFrom,
        evaluatedAt: DateTime.formatIso(yield* DateTime.now),
        productTypeRef: typeRef,
        revision: revision.revision,
        revisionId: revision.productTypeRevisionId,
      });
      const rulesRevision = Schema.decodeUnknownOption(ProductTypeCurrentRulesRevisionSchema)({
        effectiveFrom,
        productTypeRef: typeRef,
        revision: revision.revision,
        revisionId: revision.productTypeRevisionId,
        rules: rules.map((rule) => ({
          attributeDefinitionRef: input.attributeDefinitionRef,
          level: rule.level,
          required: rule.requirement === 'REQUIRED',
        })),
      });
      if (Option.isNone(basis) || Option.isNone(rulesRevision)) {
        return invalid('Current Product Type basis is malformed');
      }
      const allSets = yield* query(
        transaction
          .select()
          .from(attributeValueSets)
          .where(
            and(
              eq(attributeValueSets.tenantId, tenantId),
              eq(attributeValueSets.productId, productId),
              eq(attributeValueSets.attributeDefinitionId, definitionId),
            ),
          ),
      );
      const sets = allSets.filter((set) => set.variantId === null || set.variantId === variantId);
      const loadSet = Effect.fn('EffectiveAttributeValueReads.loadSet')(function* loadSet(
        set: ValueSetRow | undefined,
      ) {
        if (set === undefined) {
          return { snapshot: null, valid: true };
        }
        const [records, items] = yield* Effect.all(
          [
            query(
              transaction
                .select()
                .from(attributeValueRevisions)
                .where(
                  and(
                    eq(attributeValueRevisions.tenantId, tenantId),
                    eq(attributeValueRevisions.attributeValueSetId, set.attributeValueSetId),
                    eq(attributeValueRevisions.revision, set.currentRevision),
                  ),
                )
                .limit(2),
            ),
            query(
              transaction
                .select()
                .from(attributeValueItems)
                .where(
                  and(
                    eq(attributeValueItems.tenantId, tenantId),
                    eq(attributeValueItems.attributeValueSetId, set.attributeValueSetId),
                  ),
                )
                .orderBy(attributeValueItems.ordinal),
            ),
          ],
          { concurrency: 2 },
        );
        if (malformedSetSnapshot(set, records, items, tenantId, productId, definitionId, variantId)) {
          return { snapshot: null, valid: false };
        }
        const decoded = yield* Effect.forEach(
          items,
          (item) => decodeItem(transaction, tenantId, definitionId, definition.controlledValueKind, item),
          { concurrency: 1 },
        );
        if (decoded.some(Option.isNone)) {
          return { snapshot: null, valid: false };
        }
        const values = Option.all(decoded);
        if (Option.isNone(values)) {
          return { snapshot: null, valid: false };
        }
        if (set.currentState !== 'SET' && set.currentState !== 'REMOVED') {
          return { snapshot: null, valid: false };
        }
        const revisionSnapshot = Schema.decodeUnknownOption(ValueRevisionSnapshotSchema)(records[0]?.valueSnapshot);
        if (Option.isNone(revisionSnapshot) || !isDeepStrictEqual(revisionSnapshot.value.values, values.value)) {
          return { snapshot: null, valid: false };
        }
        const snapshot: AttributeValueSetSnapshot = {
          revision: set.currentRevision,
          state: set.currentState,
          values: values.value,
        };
        return { snapshot, valid: true };
      });
      if (!validRelevantSets(sets, tenantId, productId, definitionId, variantId, applicability.productLevel)) {
        return invalid('Current attribute value sets are ambiguous or malformed');
      }
      const [productSet, variantSet] = yield* Effect.all(
        [loadSet(sets.find((set) => set.variantId === null)), loadSet(sets.find((set) => set.variantId === variantId))],
        { concurrency: 2 },
      );
      if (!productSet.valid || !variantSet.valid) {
        return invalid('Current attribute value snapshot is malformed');
      }
      return resolveEffectiveAttributeValues({
        basis: basis.value,
        definition: decodedDefinition.value,
        productRef: input.productRef,
        productSet: productSet.snapshot,
        rulesRevision: rulesRevision.value,
        variantProductRef: input.productRef,
        variantRef: input.variantRef,
        variantSet: variantSet.snapshot,
      });
    }),
  });
