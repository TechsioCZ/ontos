import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  attributeDefinitionRevisions,
  attributeDefinitions,
  attributeValueItems,
  attributeValueSets,
  controlledAttributeValues,
  productTypeAssignments,
  productTypeRevisionAttributes,
  productAttributeApplicability,
  productAttributeApplicabilityRevisions,
  productTypeRevisions,
  productTypes,
  productVariantAxes,
  productVariantAxisAllowanceEvents,
  productVariantAxisAllowedValues,
  productVariantAxisEvents,
  productVariants,
  products,
} from '../../src/database/schema.ts';
import {
  GovernVariantAllowedValuesAxisConflictSchema,
  GovernVariantAllowedValuesGovernedSchema,
  GovernVariantAllowedValuesInvalidInputSchema,
  GovernVariantAllowedValuesRevisionConflictSchema,
  VariantAxisBasisUnavailable,
  allowedValueKeyHash,
  effectiveValueItemKeyHash,
  recordedVariantCombinationKey,
  variantAxisPersistenceForScope,
} from '../../src/persistence/variant-axis-persistence.ts';
import { axisFreeCombinationKey } from '../../src/persistence/variant-current-basis.ts';
import {
  ConfirmedVariantCombinationSchema,
  DuplicateVariantCombinationSchema,
  ImpermissibleVariantCombinationSchema,
  MissingVariantCombinationAxisSchema,
  VariantCombinationRevisionConflictSchema,
  VariantCombinationStaleBasisSchema,
  VariantCurrentBasisUnavailable,
  variantPersistenceForScope,
} from '../../src/persistence/variant-persistence.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const productId = '22222222-2222-4222-8222-222222222222';
const definitionId = '33333333-3333-4333-8333-333333333333';
const typeId = '44444444-4444-4444-8444-444444444444';
const variantId = '66666666-6666-4666-8666-666666666666';
const valueSetId = '77777777-7777-4777-8777-777777777777';
const controlledValueId = '88888888-8888-4888-8888-888888888888';
const foreignVariantId = '99999999-9999-4999-8999-999999999999';

const definitionRules = {
  allowsNone: 0,
  allowsNotApplicable: 0,
  allowsUnknown: 0,
  applicableLevels: ['VARIANT'],
  canonicalUnit: null,
  controlledValueKind: 'COLOR',
  decimalPlaces: null,
  maximumValue: null,
  meaning: 'Actual color',
  measuredQuantity: null,
  minimumValue: null,
  multiplicity: 'SINGLE',
  name: 'Color',
  valueKind: 'CONTROLLED',
};
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:variant-combination-test:run:1',
    authMethod: 'system',
    principalId: '55555555-5555-4555-8555-555555555555',
    tenantId,
  }),
  correlationId: 'variant-combination-test',
};
const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: productId,
  resourceType: 'commerce.catalog.product',
  tenantId,
} as const;
const variantRef = {
  moduleId: 'commerce.catalog',
  resourceId: variantId,
  resourceType: 'commerce.catalog.variant',
  tenantId,
} as const;
const controlledValue = {
  kind: 'CONTROLLED',
  valueRef: {
    moduleId: 'commerce.catalog',
    resourceId: controlledValueId,
    resourceType: 'commerce.catalog.controlled-attribute-value',
    tenantId,
  },
} as const;
const controlledItem = {
  attributeDefinitionId: definitionId,
  attributeValueSetId: valueSetId,
  controlledAttributeValueId: controlledValueId,
  numericValue: null,
  ordinal: 0,
  specialState: null,
  tenantId,
  textValue: null,
  unit: null,
  valueKind: 'CONTROLLED',
};

type Table =
  | typeof products
  | typeof productVariantAxisEvents
  | typeof productVariants
  | typeof productVariantAxes
  | typeof productVariantAxisAllowanceEvents
  | typeof productVariantAxisAllowedValues
  | typeof productTypeAssignments
  | typeof productTypes
  | typeof productTypeRevisions
  | typeof attributeDefinitions
  | typeof attributeDefinitionRevisions
  | typeof productTypeRevisionAttributes
  | typeof productAttributeApplicability
  | typeof productAttributeApplicabilityRevisions
  | typeof attributeValueSets
  | typeof attributeValueItems
  | typeof controlledAttributeValues;

interface VariantUpdateValues {
  readonly combinationAxisRevision?: number | null;
  readonly combinationKey?: string | null;
  readonly currentRevision?: number;
  readonly lifecycleState?: string;
  readonly updatedAt?: Date;
}

const candidateVariant = {
  combinationAxisRevision: null,
  combinationKey: null,
  currentRevision: 1,
  lifecycleState: 'WORK_IN_PROGRESS',
  productId,
  tenantId,
  variantId,
};

const baseRows = (): Map<Table, readonly object[]> =>
  new Map<Table, readonly object[]>([
    [products, [{ lifecycleState: 'ACTIVE', productId }]],
    [
      productVariantAxisEvents,
      [
        {
          attributeDefinitionIds: [definitionId],
          attributeDefinitionRevisions: [3],
          axisRevision: 1,
          productId,
          tenantId,
        },
      ],
    ],
    [
      productVariantAxes,
      [
        {
          attributeDefinitionId: definitionId,
          axisRevision: 1,
          definitionRevision: 3,
          ordinal: 0,
          productId,
          tenantId,
        },
      ],
    ],
    [productTypeAssignments, [{ productTypeId: typeId }]],
    [productTypes, [{ currentRevision: 2 }]],
    [productTypeRevisions, [{ revision: 2 }]],
    [attributeDefinitions, [{ ...definitionRules, attributeDefinitionId: definitionId, currentRevision: 3, tenantId }]],
    [
      attributeDefinitionRevisions,
      [{ ...definitionRules, attributeDefinitionId: definitionId, revision: 3, tenantId }],
    ],
    [productTypeRevisionAttributes, [{ attributeDefinitionId: definitionId }]],
    [
      productAttributeApplicability,
      [
        {
          attributeDefinitionId: definitionId,
          currentRevision: 1,
          productId,
          productLevel: false,
          tenantId,
          variantLevel: true,
        },
      ],
    ],
    [
      productAttributeApplicabilityRevisions,
      [
        {
          attributeDefinitionId: definitionId,
          productId,
          productLevel: false,
          revision: 1,
          tenantId,
          variantLevel: true,
        },
      ],
    ],
    [
      controlledAttributeValues,
      [{ controlledAttributeValueId: controlledValueId, lifecycleState: 'ACTIVE', tenantId }],
    ],
  ]);

const updateWhere = (values: VariantUpdateValues) => ({
  returning: () => Effect.succeed([{ ...candidateVariant, ...values }]),
});

const transactionWith = (overrides = new Map<Table, readonly object[]>(), writes: object[] = []) => {
  const rows = baseRows();
  for (const [table, value] of overrides) {
    rows.set(table, value);
  }
  const rowsFor = (table: Table) => rows.get(table) ?? [];
  const selected = (table: Table) => {
    const result = Object.assign(Effect.succeed(rowsFor(table)), { limit: () => Effect.succeed(rowsFor(table)) });
    return { where: () => ({ for: () => result, limit: () => result, orderBy: () => result, pipe: () => result }) };
  };
  return {
    insert: (table: Table) => ({
      values: (values: VariantUpdateValues | readonly VariantUpdateValues[]) =>
        Effect.sync(() => {
          writes.push({ insert: table, values });
        }),
    }),
    select: () => ({ from: selected }),
    update: (_table: Table) => ({
      set: (values: VariantUpdateValues) => ({ where: () => updateWhere(values) }),
    }),
  };
};

interface AllowanceRowOverrides {
  readonly axisRevision?: number;
}

const allowanceRow = (overrides: AllowanceRowOverrides = {}) => ({
  actionInvocationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  allowanceRevision: 1,
  attributeDefinitionId: definitionId,
  axisRevision: 1,
  definitionRevision: 3,
  productId,
  tenantId,
  valueCount: 1,
  ...overrides,
});

const allowedValueRow = (valueKey: string) => ({
  allowanceRevision: 1,
  attributeDefinitionId: definitionId,
  axisRevision: 1,
  productId,
  tenantId,
  valueKey,
  valueSnapshot: controlledValue,
});

const withRecordedSelection = (overrides = new Map<Table, readonly object[]>()) => {
  const selection = {
    attributeDefinitionId: definitionId,
    definitionRevision: 3,
    items: [controlledItem],
    source: 'VARIANT' as const,
    sourceRevision: 5,
    sourceValueSetRef: { attributeValueSetId: valueSetId, tenantId },
  };
  const key = effectiveValueItemKeyHash(controlledItem);
  const rows = new Map<Table, readonly object[]>([
    [productVariantAxisAllowanceEvents, [allowanceRow()]],
    [productVariantAxisAllowedValues, [allowedValueRow(key)]],
    [
      attributeValueSets,
      [
        {
          attributeDefinitionId: definitionId,
          attributeValueSetId: valueSetId,
          currentRevision: 5,
          currentState: 'SET',
          productId,
          tenantId,
          variantId,
        },
      ],
    ],
    [attributeValueItems, [controlledItem]],
    [productVariants, [candidateVariant]],
  ]);
  for (const [table, value] of overrides) {
    rows.set(table, value);
  }
  return { key, rows, selection };
};

const confirmInput = (
  overrides: Partial<Parameters<ReturnType<typeof variantPersistenceForScope>['confirm']>[0]> = {},
) => ({
  actionInvocationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  evidenceRefs: ['evidence'],
  expectedAxisRevision: 1,
  expectedVariantRevision: 1,
  principalId: scope.principalId,
  productRef,
  reason: 'Explicit recorded realization',
  variantRef,
  ...overrides,
});

describe('Variant allowed-value governance', () => {
  const input = {
    actionInvocationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    attributeDefinitionId: definitionId,
    definitionRevision: 3,
    evidenceRefs: ['evidence'],
    expectedAllowanceRevision: 0,
    expectedAxisRevision: 1,
    principalId: scope.principalId,
    productRef,
    reason: 'Product-specific allowed colors',
    values: [controlledValue],
  };

  it.effect('appends an explicit replacement snapshot pinned to the Current axis and definition', () =>
    Effect.gen(function* appendsSnapshot() {
      const writes: object[] = [];
      // @ts-expect-error Focused Drizzle transaction mock.
      const persistence = variantAxisPersistenceForScope(transactionWith(new Map(), writes), scope);
      const outcome = yield* persistence.governAllowedValues(input);
      expect(Schema.is(GovernVariantAllowedValuesGovernedSchema)(outcome)).toBe(true);
      if (Schema.is(GovernVariantAllowedValuesGovernedSchema)(outcome)) {
        expect(outcome.allowanceRevision).toBe(1);
        expect(outcome.changed).toBe(true);
      }
      expect(writes).toEqual([
        {
          insert: productVariantAxisAllowanceEvents,
          values: expect.objectContaining({
            allowanceRevision: 1,
            axisRevision: 1,
            definitionRevision: 3,
            valueCount: 1,
          }),
        },
        {
          insert: productVariantAxisAllowedValues,
          values: [
            expect.objectContaining({
              allowanceRevision: 1,
              axisRevision: 1,
              valueKey: allowedValueKeyHash(controlledValue),
            }),
          ],
        },
      ]);
    }),
  );

  it.effect('stages an allowed-value snapshot for a permitted proposed axis', () =>
    Effect.gen(function* stagesProposedAxis() {
      const writes: object[] = [];
      const persistence = variantAxisPersistenceForScope(
        // @ts-expect-error Focused Drizzle transaction mock.
        transactionWith(
          new Map<Table, readonly object[]>([
            [
              productVariantAxisEvents,
              [{ attributeDefinitionIds: [], attributeDefinitionRevisions: [], axisRevision: 1, productId, tenantId }],
            ],
            [productVariantAxes, []],
          ]),
          writes,
        ),
        scope,
      );
      const outcome = yield* persistence.governAllowedValues(input);
      expect(Schema.is(GovernVariantAllowedValuesGovernedSchema)(outcome)).toBe(true);
      expect(writes).toContainEqual({
        insert: productVariantAxisAllowanceEvents,
        values: expect.objectContaining({ attributeDefinitionId: definitionId, axisRevision: 1 }),
      });
    }),
  );

  it.effect('records an intentionally empty allowed set without inventing a Variant', () =>
    Effect.gen(function* recordsEmpty() {
      const writes: object[] = [];
      // @ts-expect-error Focused Drizzle transaction mock.
      const persistence = variantAxisPersistenceForScope(transactionWith(new Map(), writes), scope);
      const outcome = yield* persistence.governAllowedValues({ ...input, values: [] });
      expect(Schema.is(GovernVariantAllowedValuesGovernedSchema)(outcome)).toBe(true);
      if (Schema.is(GovernVariantAllowedValuesGovernedSchema)(outcome)) {
        expect(outcome.changed).toBe(true);
      }
      expect(writes).toEqual([
        {
          insert: productVariantAxisAllowanceEvents,
          values: expect.objectContaining({ valueCount: 0 }),
        },
      ]);
    }),
  );

  it.effect('rejects a stale axis revision before appending evidence', () =>
    Effect.gen(function* staleAxis() {
      const writes: object[] = [];
      // @ts-expect-error Focused Drizzle transaction mock.
      const persistence = variantAxisPersistenceForScope(transactionWith(new Map(), writes), scope);
      const outcome = yield* persistence.governAllowedValues({ ...input, expectedAxisRevision: 0 });
      expect(Schema.is(GovernVariantAllowedValuesAxisConflictSchema)(outcome)).toBe(true);
      if (Schema.is(GovernVariantAllowedValuesAxisConflictSchema)(outcome)) {
        expect(outcome.actualAxisRevision).toBe(1);
      }
      expect(writes).toEqual([]);
    }),
  );

  it.effect('rejects a stale allowance revision before appending evidence', () =>
    Effect.gen(function* staleAllowance() {
      const writes: object[] = [];
      const persistence = variantAxisPersistenceForScope(
        // @ts-expect-error Focused Drizzle transaction mock.
        transactionWith(
          new Map<Table, readonly object[]>([[productVariantAxisAllowanceEvents, [allowanceRow()]]]),
          writes,
        ),
        scope,
      );
      const outcome = yield* persistence.governAllowedValues({ ...input, expectedAllowanceRevision: 2 });
      expect(Schema.is(GovernVariantAllowedValuesRevisionConflictSchema)(outcome)).toBe(true);
      if (Schema.is(GovernVariantAllowedValuesRevisionConflictSchema)(outcome)) {
        expect(outcome.actualAllowanceRevision).toBe(1);
      }
      expect(writes).toEqual([]);
    }),
  );

  it.effect('rejects a definition pin that is not the declared Current axis revision', () =>
    Effect.gen(function* staleDefinition() {
      const writes: object[] = [];
      // @ts-expect-error Focused Drizzle transaction mock.
      const persistence = variantAxisPersistenceForScope(transactionWith(new Map(), writes), scope);
      const outcome = yield* persistence.governAllowedValues({ ...input, definitionRevision: 2 });
      expect(Schema.is(GovernVariantAllowedValuesInvalidInputSchema)(outcome)).toBe(true);
      if (Schema.is(GovernVariantAllowedValuesInvalidInputSchema)(outcome)) {
        expect(outcome.reason).toBe('Allowed values must pin the Current declared axis definition revision');
      }
      expect(writes).toEqual([]);
    }),
  );

  it.effect('rejects a value that is not permissible for the definition', () =>
    Effect.gen(function* impermissible() {
      const writes: object[] = [];
      // @ts-expect-error Focused Drizzle transaction mock.
      const persistence = variantAxisPersistenceForScope(transactionWith(new Map(), writes), scope);
      const outcome = yield* persistence.governAllowedValues({
        ...input,
        values: [{ amount: 10, kind: 'MEASUREMENT', unit: 'cm' }],
      });
      expect(Schema.is(GovernVariantAllowedValuesInvalidInputSchema)(outcome)).toBe(true);
      expect(writes).toEqual([]);
    }),
  );

  it.effect('rejects a controlled value that is no longer Active (#431, #438 R5)', () =>
    Effect.gen(function* retiredControlled() {
      const writes: object[] = [];
      const persistence = variantAxisPersistenceForScope(
        // @ts-expect-error Focused Drizzle transaction mock.
        transactionWith(
          new Map<Table, readonly object[]>([
            [
              controlledAttributeValues,
              [{ controlledAttributeValueId: controlledValueId, lifecycleState: 'RETIRED', tenantId }],
            ],
          ]),
          writes,
        ),
        scope,
      );
      const outcome = yield* persistence.governAllowedValues(input);
      expect(Schema.is(GovernVariantAllowedValuesInvalidInputSchema)(outcome)).toBe(true);
      if (Schema.is(GovernVariantAllowedValuesInvalidInputSchema)(outcome)) {
        expect(outcome.reason).toBe('Allowed controlled value is not Active in this Tenant');
      }
      expect(writes).toEqual([]);
    }),
  );

  it.effect('is idempotent for the same Action invocation', () =>
    Effect.gen(function* idempotentInvocation() {
      const writes: object[] = [];
      const persistence = variantAxisPersistenceForScope(
        // @ts-expect-error Focused Drizzle transaction mock.
        transactionWith(
          new Map<Table, readonly object[]>([
            [productVariantAxisAllowanceEvents, [allowanceRow()]],
            [productVariantAxisAllowedValues, [allowedValueRow(allowedValueKeyHash(controlledValue))]],
          ]),
          writes,
        ),
        scope,
      );
      const outcome = yield* persistence.governAllowedValues({
        ...input,
        actionInvocationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        expectedAllowanceRevision: 1,
      });
      expect(Schema.is(GovernVariantAllowedValuesGovernedSchema)(outcome)).toBe(true);
      if (Schema.is(GovernVariantAllowedValuesGovernedSchema)(outcome)) {
        expect(outcome.allowanceRevision).toBe(1);
        expect(outcome.changed).toBe(false);
      }
      expect(writes).toEqual([]);
    }),
  );

  it.effect('reads the Current Product-specific allowed set and fails closed when it is stale', () =>
    Effect.gen(function* readsAllowed() {
      const key = allowedValueKeyHash(controlledValue);
      const persistence = variantAxisPersistenceForScope(
        // @ts-expect-error Focused Drizzle transaction mock.
        transactionWith(
          new Map<Table, readonly object[]>([
            [productVariantAxisAllowanceEvents, [allowanceRow()]],
            [productVariantAxisAllowedValues, [allowedValueRow(key)]],
          ]),
        ),
        scope,
      );
      const axes = yield* persistence.readCurrent(productRef);
      expect(yield* persistence.readCurrentAllowedValues(productRef, axes)).toEqual([
        { allowanceRevision: 1, attributeDefinitionId: definitionId, definitionRevision: 3, valueKeys: [key] },
      ]);

      const stale = variantAxisPersistenceForScope(
        // @ts-expect-error Focused Drizzle transaction mock.
        transactionWith(
          new Map<Table, readonly object[]>([
            [productVariantAxisAllowanceEvents, [allowanceRow({ axisRevision: 2 })]],
            [productVariantAxisAllowedValues, [allowedValueRow(key)]],
          ]),
        ),
        scope,
      );
      const staleAxes = yield* stale.readCurrent(productRef);
      const failure = yield* Effect.flip(stale.readCurrentAllowedValues(productRef, staleAxes));
      expect(Schema.is(VariantAxisBasisUnavailable)(failure)).toBe(true);
    }),
  );

  it.effect('carries an explicitly governed allowance across a revalidated axis revision', () =>
    Effect.gen(function* carriesAllowance() {
      const key = allowedValueKeyHash(controlledValue);
      const persistence = variantAxisPersistenceForScope(
        // @ts-expect-error Focused Drizzle transaction mock.
        transactionWith(
          new Map<Table, readonly object[]>([
            [
              productVariantAxisEvents,
              [
                {
                  attributeDefinitionIds: [definitionId],
                  attributeDefinitionRevisions: [3],
                  axisRevision: 2,
                  productId,
                  tenantId,
                },
              ],
            ],
            [
              productVariantAxes,
              [
                {
                  attributeDefinitionId: definitionId,
                  axisRevision: 2,
                  definitionRevision: 3,
                  ordinal: 0,
                  productId,
                  tenantId,
                },
              ],
            ],
            [productVariantAxisAllowanceEvents, [allowanceRow()]],
            [productVariantAxisAllowedValues, [allowedValueRow(key)]],
          ]),
        ),
        scope,
      );
      const axes = yield* persistence.readCurrent(productRef);
      expect(yield* persistence.readCurrentAllowedValues(productRef, axes)).toEqual([
        { allowanceRevision: 1, attributeDefinitionId: definitionId, definitionRevision: 3, valueKeys: [key] },
      ]);
    }),
  );
});

describe('Variant combination confirmation (#440)', () => {
  it.effect('confirms the explicit Variant using the canonical recorded combination identity', () =>
    Effect.gen(function* confirms() {
      const { rows, selection } = withRecordedSelection();
      const writes: object[] = [];
      const persistence = variantPersistenceForScope(
        // @ts-expect-error Focused Drizzle transaction mock.
        transactionWith(rows, writes),
        scope,
      );
      const outcome = yield* persistence.confirm(confirmInput());
      expect(Schema.is(ConfirmedVariantCombinationSchema)(outcome)).toBe(true);
      if (Schema.is(ConfirmedVariantCombinationSchema)(outcome)) {
        // The read path and the write path agree on one canonical combination encoding.
        expect(outcome.combinationKey).toBe(recordedVariantCombinationKey([selection], tenantId));
        expect(outcome.combinationAxisRevision).toBe(1);
        expect(outcome.revision).toBe(2);
        expect(outcome.variant.lifecycle).toBe('ACTIVE');
      }
      expect(writes).toContainEqual({ insert: expect.anything(), values: expect.anything() });
    }),
  );

  it.effect('reports a duplicate without writing when another Current Variant holds the combination', () =>
    Effect.gen(function* duplicate() {
      const { rows, selection } = withRecordedSelection();
      rows.set(productVariants, [
        candidateVariant,
        {
          combinationAxisRevision: 1,
          combinationKey: recordedVariantCombinationKey([selection], tenantId),
          currentRevision: 3,
          lifecycleState: 'ACTIVE',
          productId,
          tenantId,
          variantId: foreignVariantId,
        },
      ]);
      const writes: object[] = [];
      const persistence = variantPersistenceForScope(
        // @ts-expect-error Focused Drizzle transaction mock.
        transactionWith(rows, writes),
        scope,
      );
      const outcome = yield* persistence.confirm(confirmInput());
      expect(Schema.is(DuplicateVariantCombinationSchema)(outcome)).toBe(true);
      expect(writes).toEqual([]);
    }),
  );

  it.effect('distinguishes a missing axis from an impermissible value', () =>
    Effect.gen(function* missingAndImpermissible() {
      const missing = withRecordedSelection(new Map<Table, readonly object[]>([[attributeValueSets, []]]));
      // @ts-expect-error Focused Drizzle transaction mock.
      const missingPersistence = variantPersistenceForScope(transactionWith(missing.rows), scope);
      const missingOutcome = yield* missingPersistence.confirm(confirmInput());
      expect(Schema.is(MissingVariantCombinationAxisSchema)(missingOutcome)).toBe(true);
      if (Schema.is(MissingVariantCombinationAxisSchema)(missingOutcome)) {
        expect(missingOutcome.attributeDefinitionId).toBe(definitionId);
      }

      const impermissible = withRecordedSelection(
        new Map<Table, readonly object[]>([[productVariantAxisAllowedValues, [allowedValueRow('f'.repeat(64))]]]),
      );
      // @ts-expect-error Focused Drizzle transaction mock.
      const impermissiblePersistence = variantPersistenceForScope(transactionWith(impermissible.rows), scope);
      const impermissibleOutcome = yield* impermissiblePersistence.confirm(confirmInput());
      expect(Schema.is(ImpermissibleVariantCombinationSchema)(impermissibleOutcome)).toBe(true);
      if (Schema.is(ImpermissibleVariantCombinationSchema)(impermissibleOutcome)) {
        expect(impermissibleOutcome.attributeDefinitionId).toBe(definitionId);
      }
    }),
  );

  it.effect('rejects a stale axis basis so a concurrent change cannot be bypassed', () =>
    Effect.gen(function* staleBasis() {
      const { rows } = withRecordedSelection();
      // @ts-expect-error Focused Drizzle transaction mock.
      const persistence = variantPersistenceForScope(transactionWith(rows), scope);
      const outcome = yield* persistence.confirm(confirmInput({ expectedAxisRevision: 2 }));
      expect(Schema.is(VariantCombinationStaleBasisSchema)(outcome)).toBe(true);
      if (Schema.is(VariantCombinationStaleBasisSchema)(outcome)) {
        expect(outcome.actualAxisRevision).toBe(1);
        expect(outcome.expectedAxisRevision).toBe(2);
      }
    }),
  );

  it.effect('rejects a stale Variant revision before evaluating the basis', () =>
    Effect.gen(function* staleVariantRevision() {
      const { rows } = withRecordedSelection();
      // @ts-expect-error Focused Drizzle transaction mock.
      const persistence = variantPersistenceForScope(transactionWith(rows), scope);
      const outcome = yield* persistence.confirm(confirmInput({ expectedVariantRevision: 2 }));
      expect(Schema.is(VariantCombinationRevisionConflictSchema)(outcome)).toBe(true);
      if (Schema.is(VariantCombinationRevisionConflictSchema)(outcome)) {
        expect(outcome.actualRevision).toBe(1);
      }
    }),
  );

  it.effect('allows one axis-free Current Variant and rejects a second', () =>
    Effect.gen(function* axisFree() {
      const axisFreeRows = new Map<Table, readonly object[]>([
        [
          productVariantAxisEvents,
          [{ attributeDefinitionIds: [], attributeDefinitionRevisions: [], axisRevision: 1, productId, tenantId }],
        ],
        [productVariantAxes, []],
      ]);
      const single = withRecordedSelection(axisFreeRows);
      // @ts-expect-error Focused Drizzle transaction mock.
      const singlePersistence = variantPersistenceForScope(transactionWith(single.rows), scope);
      const outcome = yield* singlePersistence.confirm(confirmInput());
      expect(Schema.is(ConfirmedVariantCombinationSchema)(outcome)).toBe(true);
      if (Schema.is(ConfirmedVariantCombinationSchema)(outcome)) {
        expect(outcome.combinationKey).toBe(axisFreeCombinationKey());
        expect(outcome.combinationAxisRevision).toBe(1);
      }

      const second = withRecordedSelection(
        new Map<Table, readonly object[]>([
          [
            productVariantAxisEvents,
            [{ attributeDefinitionIds: [], attributeDefinitionRevisions: [], axisRevision: 1, productId, tenantId }],
          ],
          [productVariantAxes, []],
          [
            productVariants,
            [
              candidateVariant,
              {
                combinationAxisRevision: 1,
                combinationKey: axisFreeCombinationKey(),
                currentRevision: 1,
                lifecycleState: 'ACTIVE',
                productId,
                tenantId,
                variantId: foreignVariantId,
              },
            ],
          ],
        ]),
      );
      // @ts-expect-error Focused Drizzle transaction mock.
      const secondPersistence = variantPersistenceForScope(transactionWith(second.rows), scope);
      const secondOutcome = yield* secondPersistence.confirm(confirmInput());
      expect(Schema.is(DuplicateVariantCombinationSchema)(secondOutcome)).toBe(true);
    }),
  );

  it.effect('treats an already-Current identical combination as an idempotent confirmation', () =>
    Effect.gen(function* idempotent() {
      const { rows, selection } = withRecordedSelection();
      const active = {
        combinationAxisRevision: 1,
        combinationKey: recordedVariantCombinationKey([selection], tenantId),
        currentRevision: 4,
        lifecycleState: 'ACTIVE',
        productId,
        tenantId,
        variantId,
      };
      rows.set(productVariants, [active]);
      const writes: object[] = [];
      const persistence = variantPersistenceForScope(
        // @ts-expect-error Focused Drizzle transaction mock.
        transactionWith(rows, writes),
        scope,
      );
      const outcome = yield* persistence.confirm(confirmInput({ expectedVariantRevision: 4 }));
      expect(Schema.is(ConfirmedVariantCombinationSchema)(outcome)).toBe(true);
      if (Schema.is(ConfirmedVariantCombinationSchema)(outcome)) {
        expect(outcome.combinationKey).toBe(recordedVariantCombinationKey([selection], tenantId));
        expect(outcome.revision).toBe(4);
        expect(outcome.variant.lifecycle).toBe('ACTIVE');
      }
      expect(writes).toEqual([]);
    }),
  );

  it.effect('fails closed as unverifiable when the basis cannot be read', () =>
    Effect.gen(function* unverifiable() {
      const { rows } = withRecordedSelection(new Map<Table, readonly object[]>([[productAttributeApplicability, []]]));
      // @ts-expect-error Focused Drizzle transaction mock.
      const persistence = variantPersistenceForScope(transactionWith(rows), scope);
      const failure = yield* Effect.flip(persistence.confirm(confirmInput()));
      expect(Schema.is(VariantAxisBasisUnavailable)(failure)).toBe(false);
      expect(Schema.is(VariantCurrentBasisUnavailable)(failure)).toBe(true);
    }),
  );
});
