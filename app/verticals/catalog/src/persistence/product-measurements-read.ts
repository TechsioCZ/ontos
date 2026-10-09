import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { and, eq } from 'drizzle-orm';
import { Effect, Option, Schema } from 'effect';
import { isDeepStrictEqual } from 'node:util';

import { AttributeDefinitionSchema, validateAttributeValues } from '../../shared/domain/attribute-values.ts';
import type { ProductRef } from '../../shared/resources/product.ts';
import { ProductRefSchema } from '../../shared/resources/product.ts';
import {
  attributeDefinitionRevisions,
  attributeDefinitions,
  attributeValueItems,
  attributeValueRevisions,
  attributeValueSets,
  products,
} from '../database/schema.ts';
import { CatalogPersistenceUnavailable } from './errors.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];
type DefinitionRow = typeof attributeDefinitions.$inferSelect;
type DefinitionRevisionRow = typeof attributeDefinitionRevisions.$inferSelect;
type SetRow = typeof attributeValueSets.$inferSelect;
type ValueRevisionRow = typeof attributeValueRevisions.$inferSelect;
type ItemRow = typeof attributeValueItems.$inferSelect;

export interface ProductMeasurement {
  readonly amount: number;
  readonly attributeDefinitionId: string;
  readonly attributeDefinitionRevision: number;
  readonly attributeValueSetId: string;
  readonly attributeValueSetRevision: number;
  readonly canonicalUnit: string;
  readonly meaning: string;
  readonly quantity: string;
  readonly unit: string;
}

type ProductMeasurementsResult =
  | { readonly measurements: readonly ProductMeasurement[]; readonly status: 'KNOWN' }
  | { readonly status: 'ABSENT' }
  | { readonly status: 'UNAVAILABLE' };

export interface ProductMeasurementsRead {
  readonly read: (productRef: ProductRef) => Effect.Effect<ProductMeasurementsResult, CatalogPersistenceUnavailable>;
}

const snapshotSchema = Schema.Struct({
  attributeDefinitionRevision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  productTypeId: Schema.String.pipe(Schema.brand('ProductTypeId')),
  productTypeRevision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  sourceProductValueRevision: Schema.Null,
  values: Schema.Array(
    Schema.Struct({
      amount: Schema.Number.check(Schema.isFinite()),
      kind: Schema.Literal('MEASUREMENT'),
      unit: Schema.String.check(Schema.isNonEmpty(), Schema.isTrimmed()),
    }),
  ),
});

const ruleFields = (row: DefinitionRow | DefinitionRevisionRow) => ({
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

const unavailable = (cause: unknown) => {
  const failure = new CatalogPersistenceUnavailable({
    code: 'catalog_persistence_unavailable',
    reason: 'Product measurements are temporarily unavailable',
  });
  Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  return failure;
};

const definitionValid = (row: DefinitionRow, revision: DefinitionRevisionRow | undefined, tenantId: string) =>
  revision !== undefined &&
  row.tenantId === tenantId &&
  revision.tenantId === tenantId &&
  revision.attributeDefinitionId === row.attributeDefinitionId &&
  revision.revision === row.currentRevision &&
  Number.isInteger(row.currentRevision) &&
  row.currentRevision > 0 &&
  isDeepStrictEqual(ruleFields(row), ruleFields(revision));

const decodeDefinition = (row: DefinitionRow, tenantId: string) => {
  const measurement = {
    canonicalUnit: row.canonicalUnit,
    decimalPlaces: row.decimalPlaces,
    quantity: row.measuredQuantity,
  };
  if (row.maximumValue !== null) {
    Object.assign(measurement, { maximum: Number(row.maximumValue) });
  }
  if (row.minimumValue !== null) {
    Object.assign(measurement, { minimum: Number(row.minimumValue) });
  }
  const proposed = {
    label: row.name,
    levels: row.applicableLevels,
    meaning: row.meaning,
    measurement,
    multiplicity: row.multiplicity,
    ref: {
      moduleId: 'commerce.catalog',
      resourceId: row.attributeDefinitionId,
      resourceType: 'commerce.catalog.attribute-definition',
      tenantId,
    },
    specialStates: [
      ...(row.allowsUnknown === 1 ? ['UNKNOWN'] : []),
      ...(row.allowsNone === 1 ? ['NONE'] : []),
      ...(row.allowsNotApplicable === 1 ? ['NOT_APPLICABLE'] : []),
    ],
    valueKind: row.valueKind,
  };
  return Schema.decodeUnknownOption(AttributeDefinitionSchema)(proposed);
};

const setValid = (
  set: SetRow,
  records: readonly ValueRevisionRow[],
  items: readonly ItemRow[],
  tenantId: string,
  productId: string,
) =>
  set.tenantId === tenantId &&
  set.productId === productId &&
  set.variantId === null &&
  (set.currentState === 'SET' || set.currentState === 'REMOVED') &&
  Number.isInteger(set.currentRevision) &&
  set.currentRevision > 0 &&
  records.length === 1 &&
  records[0]?.tenantId === tenantId &&
  records[0].attributeValueSetId === set.attributeValueSetId &&
  records[0].revision === set.currentRevision &&
  records[0].changeKind === set.currentState &&
  (set.currentState === 'SET' ? items.length > 0 : items.length === 0) &&
  items.every(
    (item, index) =>
      item.tenantId === tenantId &&
      item.attributeValueSetId === set.attributeValueSetId &&
      item.attributeDefinitionId === set.attributeDefinitionId &&
      item.ordinal === index,
  );

const evaluate = (
  set: SetRow,
  definition: DefinitionRow,
  definitionRevision: DefinitionRevisionRow | undefined,
  records: readonly ValueRevisionRow[],
  items: readonly ItemRow[],
  tenantId: string,
  productId: string,
): ProductMeasurementsResult => {
  const snapshot = Schema.decodeUnknownOption(snapshotSchema)(records[0]?.valueSnapshot);
  if (
    !definitionValid(definition, definitionRevision, tenantId) ||
    !setValid(set, records, items, tenantId, productId) ||
    Option.isNone(snapshot)
  ) {
    return { status: 'UNAVAILABLE' };
  }
  if (set.currentState === 'REMOVED') {
    return snapshot.value.values.length === 0 ? { status: 'ABSENT' } : { status: 'UNAVAILABLE' };
  }
  if (snapshot.value.attributeDefinitionRevision !== definition.currentRevision) {
    return { status: 'UNAVAILABLE' };
  }
  const decoded = decodeDefinition(definition, tenantId);
  if (
    Option.isNone(decoded) ||
    !new Set(decoded.value.levels).has('PRODUCT') ||
    decoded.value.measurement === undefined
  ) {
    return { status: 'UNAVAILABLE' };
  }
  const values = items.map((item) => ({
    amount: Number(item.numericValue),
    kind: 'MEASUREMENT' as const,
    unit: item.unit ?? '',
  }));
  if (
    items.some((item) => item.valueKind !== 'MEASUREMENT' || item.numericValue === null || item.unit === null) ||
    !isDeepStrictEqual(snapshot.value.values, values) ||
    !validateAttributeValues(decoded.value, values).valid
  ) {
    return { status: 'UNAVAILABLE' };
  }
  return {
    measurements: values.map((value) => ({
      amount: value.amount,
      attributeDefinitionId: set.attributeDefinitionId,
      attributeDefinitionRevision: definition.currentRevision,
      attributeValueSetId: set.attributeValueSetId,
      attributeValueSetRevision: set.currentRevision,
      canonicalUnit: decoded.value.measurement?.canonicalUnit ?? '',
      meaning: definition.meaning,
      quantity: decoded.value.measurement?.quantity ?? '',
      unit: value.unit,
    })),
    status: 'KNOWN',
  };
};

/** Owner-local read over scoped Product facts; Size identity never implies a dimension. */
export const productMeasurementsReadForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
): ProductMeasurementsRead => {
  const { tenantId } = scope;
  const readSet = Effect.fn('ProductMeasurementsRead.readSet')(function* readSet(set: SetRow, productId: string) {
    if (set.variantId !== null) {
      return { status: 'ABSENT' } as const;
    }
    const [definition] = yield* transaction
      .select()
      .from(attributeDefinitions)
      .where(
        and(
          eq(attributeDefinitions.tenantId, tenantId),
          eq(attributeDefinitions.attributeDefinitionId, set.attributeDefinitionId),
        ),
      )
      .limit(2)
      .pipe(Effect.mapError(unavailable));
    if (definition === undefined) {
      return { status: 'UNAVAILABLE' } as const;
    }
    if (definition.valueKind !== 'MEASUREMENT') {
      return { status: 'ABSENT' } as const;
    }
    const [definitionRevision] = yield* transaction
      .select()
      .from(attributeDefinitionRevisions)
      .where(
        and(
          eq(attributeDefinitionRevisions.tenantId, tenantId),
          eq(attributeDefinitionRevisions.attributeDefinitionId, set.attributeDefinitionId),
          eq(attributeDefinitionRevisions.revision, definition.currentRevision),
        ),
      )
      .limit(2)
      .pipe(Effect.mapError(unavailable));
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
    return evaluate(set, definition, definitionRevision, records, items, tenantId, productId);
  });
  return {
    read: Effect.fn('ProductMeasurementsRead.read')(function* read(productRef) {
      if (!Schema.is(ProductRefSchema)(productRef) || productRef.tenantId !== tenantId) {
        return { status: 'UNAVAILABLE' } as const;
      }
      const productId = productRef.resourceId;
      const [subject] = yield* transaction
        .select({ productId: products.productId })
        .from(products)
        .where(and(eq(products.tenantId, tenantId), eq(products.productId, productId)))
        .limit(1)
        .pipe(Effect.mapError(unavailable));
      if (subject === undefined) {
        return { status: 'UNAVAILABLE' } as const;
      }
      const sets = yield* transaction
        .select()
        .from(attributeValueSets)
        .where(and(eq(attributeValueSets.tenantId, tenantId), eq(attributeValueSets.productId, productId)))
        .pipe(Effect.mapError(unavailable));
      const results = yield* Effect.forEach(sets, (set) => readSet(set, productId), { concurrency: 1 });
      if (results.some((result) => result.status === 'UNAVAILABLE')) {
        return { status: 'UNAVAILABLE' } as const;
      }
      const measurements = results.flatMap((result) => (result.status === 'KNOWN' ? result.measurements : []));
      return measurements.length === 0 ? ({ status: 'ABSENT' } as const) : ({ measurements, status: 'KNOWN' } as const);
    }),
  };
};
