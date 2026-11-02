import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import type { SQL } from 'drizzle-orm';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  configurationUnitRevisions,
  configurationUnits,
  packageContentRevisions,
  packageDefinitions,
  packageOptionRoleRevisions,
  packageUnitDivisibility,
  productConfigurationChoiceOptions,
  productConfigurationChoices,
  productConfigurationCompatibilityRules,
  productConfigurationDefinitionRevisions,
  productConfigurationDefinitions,
  productConfigurationMeasuredRules,
  productConfigurationOptionAllowances,
  productConfigurationRevisionActivations,
  productUnitRuleRevisions,
  productUnits,
  productVariants,
  products,
  variantUnitDivisibility,
  setCompositions,
  setCompositionRevisions,
  setCompositionComponents,
} from '../../src/database/schema.ts';
import { catalogSelectionPackageUnitBasisForScope } from '../../src/persistence/catalog-selection-package-unit-basis.ts';
import { CatalogSelectionSchema } from '../../shared/domain/catalog-selection-evidence.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const productId = '22222222-2222-4222-8222-222222222222';
const variantId = '33333333-3333-4333-8333-333333333333';
const packageId = '44444444-4444-4444-8444-444444444444';
const lowerPackageId = '77777777-7777-4777-8777-777777777777';
const unitId = '55555555-5555-4555-8555-555555555555';
const now = new Date('2026-09-17T10:00:00.000Z');
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:catalog-selection-package-test:run:1',
    authMethod: 'system',
    principalId: '66666666-6666-4666-8666-666666666666',
    tenantId,
  }),
  correlationId: 'catalog-selection-package-test',
};
const ref = (resourceType: string, resourceId: string) => ({
  moduleId: 'commerce.catalog',
  resourceId,
  resourceType,
  tenantId,
});
const selection = Schema.decodeUnknownSync(CatalogSelectionSchema)({
  packageOption: {
    contentRevision: { resourceRef: ref('commerce.catalog.package-definition', packageId), revision: 4 },
    optionRef: ref('commerce.catalog.package-definition', packageId),
  },
  productRef: ref('commerce.catalog.product', productId),
  variantRef: ref('commerce.catalog.variant', variantId),
});
const content = {
  amount: '10',
  configurationKey: null,
  effectiveAt: new Date('2026-09-16T00:00:00.000Z'),
  lifecycleState: 'ACTIVE',
  lowerCount: null,
  lowerPackageDefinitionId: null,
  lowerRevision: null,
  packageDefinitionId: packageId,
  productId,
  revision: 4,
  setCompositionResourceId: null,
  setCompositionRevision: null,
  unitResourceId: unitId,
  unitResourceType: 'commerce.catalog.product-unit',
  variantId,
};
const role = {
  contentRevision: 4,
  effectiveAt: content.effectiveAt,
  independentlyRequested: true,
  looseUnitsSubstitutable: false,
  productId,
  revision: 2,
  state: 'ACTIVE',
  variantId,
};
const revisionsWith = <T extends object>(selected: T) => [
  { ...content, effectiveAt: new Date('2026-09-13T00:00:00.000Z'), revision: 1 },
  { ...content, effectiveAt: new Date('2026-09-14T00:00:00.000Z'), revision: 2 },
  { ...content, effectiveAt: new Date('2026-09-15T00:00:00.000Z'), revision: 3 },
  selected,
];
const definition = {
  currentOptionRevision: 2,
  currentRevision: 4,
  lifecycleState: 'ACTIVE',
  optionState: 'ACTIVE',
  productId,
  variantId,
};
const rows = new Map<unknown, unknown>([
  [products, { currentRevision: 2, lifecycleState: 'ACTIVE', productId }],
  [productVariants, { currentRevision: 3, lifecycleState: 'ACTIVE', productId, variantId }],
  [packageDefinitions, definition],
  [packageContentRevisions, revisionsWith(content)],
  [packageOptionRoleRevisions, role],
  [packageUnitDivisibility, { currentRevision: 5, divisible: false, unitId }],
  [productUnits, { currentRuleRevision: 6, lifecycleState: 'ACTIVE', unitId }],
  [productUnitRuleRevisions, { lifecycleState: 'ACTIVE', revision: 6, rounding: 'UP', step: '1' }],
]);
type ReadTable =
  | typeof setCompositions
  | typeof setCompositionRevisions
  | typeof setCompositionComponents
  | typeof configurationUnits
  | typeof configurationUnitRevisions
  | typeof products
  | typeof productVariants
  | typeof packageDefinitions
  | typeof packageContentRevisions
  | typeof packageOptionRoleRevisions
  | typeof packageUnitDivisibility
  | typeof productUnits
  | typeof productUnitRuleRevisions
  | typeof productConfigurationDefinitions
  | typeof productConfigurationDefinitionRevisions
  | typeof productConfigurationRevisionActivations
  | typeof productConfigurationChoices
  | typeof productConfigurationChoiceOptions
  | typeof productConfigurationOptionAllowances
  | typeof productConfigurationMeasuredRules
  | typeof productConfigurationCompatibilityRules
  | typeof variantUnitDivisibility;
const queryResult = (table: ReadTable, overrides: Map<unknown, unknown>) => {
  const candidate = overrides.has(table) ? overrides.get(table) : rows.get(table);
  const row = Array.isArray(candidate) ? candidate.shift() : candidate;
  return Effect.succeed(row === null || row === undefined ? [] : [row]);
};
const contentRows = (overrides: Map<unknown, unknown>) => {
  const candidate = overrides.has(packageContentRevisions)
    ? overrides.get(packageContentRevisions)
    : rows.get(packageContentRevisions);
  const result = Array.isArray(candidate) && Array.isArray(candidate[0]) ? candidate.shift() : candidate;
  if (result === null || result === undefined) {
    return Effect.succeed([]);
  }
  return Effect.succeed(Array.isArray(result) ? result : [result]);
};
const makeLimit = (table: ReadTable, overrides: Map<unknown, unknown>) => () => queryResult(table, overrides);
const setFixtureWhere = (table: ReadTable, overrides: Map<unknown, unknown>, condition?: SQL) => {
  const scripted = overrides.get(table);
  const candidate = Array.isArray(scripted) && Array.isArray(scripted[0]) ? scripted.shift() : scripted;
  let entries: readonly object[] = [];
  if (Array.isArray(candidate)) {
    entries = candidate;
  } else if (candidate !== undefined && candidate !== null) {
    entries = [candidate];
  }
  const bound =
    condition?.toQuery({
      escapeName: (name) => name,
      escapeParam: () => '?',
      escapeString: (text) => text,
    }).params ?? [];
  const matched = entries.filter(
    (entry) =>
      (!('tenantId' in entry) || bound.includes(entry.tenantId)) &&
      (!('compositionId' in entry) || bound.includes(entry.compositionId)) &&
      (!('revision' in entry) ||
        !bound.some((value) => Schema.is(Schema.Number)(value)) ||
        bound.includes(entry.revision)),
  );
  return Object.assign(Effect.succeed(matched), { limit: () => Effect.succeed(matched.slice(0, 1)) });
};
const makeWhere = (table: ReadTable, overrides: Map<unknown, unknown>, projected: boolean) => (condition?: SQL) => {
  if ([setCompositions, setCompositionRevisions, setCompositionComponents].some((candidate) => candidate === table)) {
    return setFixtureWhere(table, overrides, condition);
  }
  if (table === configurationUnitRevisions) {
    return { orderBy: () => Effect.succeed(overrides.get(table) ?? []) };
  }
  if (table === packageContentRevisions) {
    return contentRows(overrides);
  }
  if (
    [
      productConfigurationDefinitions,
      productConfigurationRevisionActivations,
      productConfigurationDefinitionRevisions,
      productConfigurationChoices,
      productConfigurationChoiceOptions,
      productConfigurationOptionAllowances,
      productConfigurationMeasuredRules,
      productConfigurationCompatibilityRules,
    ].some((candidate) => candidate === table)
  ) {
    const value = overrides.get(table);
    let entries: readonly object[] = [];
    if (Array.isArray(value)) {
      entries = value;
    } else if (value !== undefined && value !== null) {
      entries = [value];
    }
    const bound =
      condition?.toQuery({
        escapeName: (name) => name,
        escapeParam: () => '?',
        escapeString: (text) => text,
      }).params ?? [];
    const matched = entries.filter((entry) => !('definitionId' in entry) || bound.includes(entry.definitionId));
    if (table === productConfigurationDefinitions && !projected) {
      return { limit: () => Effect.succeed(matched.slice(0, 1)) };
    }
    if (table === productConfigurationDefinitionRevisions) {
      return Object.assign(Effect.succeed(matched), { limit: () => Effect.succeed(matched.slice(0, 1)) });
    }
    return Effect.succeed(table === productConfigurationDefinitions ? entries : matched);
  }
  return { limit: makeLimit(table, overrides) };
};
const makeFrom = (overrides: Map<unknown, unknown>, projected: boolean) => (table: ReadTable) => ({
  where: makeWhere(table, overrides, projected),
});
const transactionFor = (overrides = new Map<unknown, unknown>()) => ({
  select: (projection?: { readonly definitionId: typeof productConfigurationDefinitions.definitionId }) => ({
    from: makeFrom(overrides, projection !== undefined),
  }),
});
const read = (overrides = new Map<unknown, unknown>(), requested = selection, at = now) =>
  // @ts-expect-error The mock supplies only the read chains exercised here.
  catalogSelectionPackageUnitBasisForScope(transactionFor(overrides), scope).read(requested, at);

const optionalConfigurationRows = (optionalKeys: readonly string[] = ['finish'], requiredMount = true) => {
  const evidenceRefs = ['owner:optional-configuration'];
  const choiceKeys = ['mount', ...optionalKeys];
  const publication = {
    actingPrincipalId: scope.principalId,
    actionInvocationId: '88888888-8888-4888-8888-888888888888',
    definitionId: packageId,
    evidenceRefs,
    productId,
    reason: 'Required mount and optional finish',
    revision: 1,
  };
  return new Map<unknown, unknown>([
    [productConfigurationDefinitions, [{ currentRevision: 1, definitionId: packageId, productId }]],
    [
      productConfigurationRevisionActivations,
      [{ ...publication, effectiveAt: content.effectiveAt, supersededRevision: null }],
    ],
    [
      productConfigurationDefinitionRevisions,
      [{ ...publication, effectiveFrom: content.effectiveAt, state: 'ACTIVE' }],
    ],
    [
      productConfigurationChoices,
      choiceKeys.map((choiceKey) => ({
        choiceKey,
        definitionId: packageId,
        label: choiceKey,
        meaning: choiceKey,
        required: choiceKey === 'mount' && requiredMount,
        unitId: null,
        valueKind: 'SINGLE_CHOICE',
      })),
    ],
    [
      productConfigurationChoiceOptions,
      choiceKeys.flatMap((choiceKey) =>
        ['A', 'NONE'].map((optionKey) => ({
          choiceKey,
          definitionId: packageId,
          label: optionKey,
          meaning: `Explicit ${optionKey}`,
          optionKey,
        })),
      ),
    ],
    [
      productConfigurationOptionAllowances,
      choiceKeys.flatMap((choiceKey) =>
        ['A', 'NONE'].map((optionKey) => ({
          allowed: true,
          choiceKey,
          definitionId: packageId,
          evidenceRefs,
          optionKey,
          packageDefinitionId: null,
          variantId: null,
        })),
      ),
    ],
    [variantUnitDivisibility, { currentRevision: 5, divisible: false, unitId }],
  ]);
};

it.effect('preserves complete definition evidence when an optional choice is omitted (#1263)', () =>
  Effect.gen(function* omittedOptionalConfiguration() {
    const requested = yield* Schema.decodeUnknownEffect(CatalogSelectionSchema)({
      configuration: {
        choices: [{ choiceKey: 'mount', value: 'A' }],
        definition: { resourceRef: ref('commerce.catalog.configuration-definition', packageId), revision: 1 },
        productRef: selection.productRef,
        variantRef: selection.variantRef,
      },
      productRef: selection.productRef,
      variantRef: selection.variantRef,
    });
    const result = yield* read(optionalConfigurationRows(), requested);
    expect(result).not.toHaveProperty('reason');
    expect(result).toMatchObject({
      configuration: {
        choiceRevisions: [
          { choiceKey: 'mount', required: true },
          { choiceKey: 'finish', required: false },
        ],
        status: 'VALID',
      },
      status: 'CURRENT',
    });
    expect(requested.configuration?.choices).toEqual([{ choiceKey: 'mount', value: 'A' }]);
  }),
);

it.effect('accepts complete selections, multiple optional omissions and an all-optional empty subset (#1263)', () =>
  Effect.gen(function* optionalSubsets() {
    for (const scenario of [
      {
        choices: [
          { choiceKey: 'mount', value: 'A' },
          { choiceKey: 'finish', value: 'A' },
        ],
        optional: ['finish'],
        required: true,
      },
      { choices: [{ choiceKey: 'mount', value: 'A' }], optional: ['finish', 'paint', 'trim'], required: true },
      { choices: [], optional: ['finish'], required: false },
    ]) {
      const requested = yield* Schema.decodeUnknownEffect(CatalogSelectionSchema)({
        configuration: {
          choices: scenario.choices,
          definition: { resourceRef: ref('commerce.catalog.configuration-definition', packageId), revision: 1 },
          productRef: selection.productRef,
          variantRef: selection.variantRef,
        },
        productRef: selection.productRef,
        variantRef: selection.variantRef,
      });
      const result = yield* read(optionalConfigurationRows(scenario.optional, scenario.required), requested);
      expect(result.status).toBe('CURRENT');
      if (result.status === 'CURRENT') {
        expect(result.configuration?.choiceRevisions).toHaveLength(1 + scenario.optional.length);
      }
      expect(requested.configuration?.choices).toEqual(scenario.choices);
    }
  }),
);

it.effect('keeps required, unknown value, unknown choice and stale definition failures (#1263)', () =>
  Effect.gen(function* invalidOptionalSelections() {
    for (const scenario of [
      { choices: [], reason: 'Configuration Current proof: REQUIRED_CHOICE_MISSING', revision: 1, status: 'INVALID' },
      {
        choices: [{ choiceKey: 'mount', value: 'X' }],
        reason: 'Configuration Current proof: UNKNOWN_OPTION',
        revision: 1,
        status: 'INVALID',
      },
      {
        choices: [
          { choiceKey: 'mount', value: 'A' },
          { choiceKey: 'foreign', value: 'A' },
        ],
        reason: 'Configuration Current proof: UNKNOWN_CHOICE',
        revision: 1,
        status: 'INVALID',
      },
      {
        choices: [{ choiceKey: 'mount', value: 'A' }],
        reason: 'Configuration proof does not match exact target, choices, or Unit revisions',
        revision: 2,
        status: 'INDETERMINATE',
      },
    ]) {
      const requested = yield* Schema.decodeUnknownEffect(CatalogSelectionSchema)({
        configuration: {
          choices: scenario.choices,
          definition: {
            resourceRef: ref('commerce.catalog.configuration-definition', packageId),
            revision: scenario.revision,
          },
          productRef: selection.productRef,
          variantRef: selection.variantRef,
        },
        productRef: selection.productRef,
        variantRef: selection.variantRef,
      });
      expect(yield* read(optionalConfigurationRows(), requested)).toMatchObject({
        reason: scenario.reason,
        status: scenario.status,
      });
    }
  }),
);

it.effect('requires complete measured Unit evidence even when its optional value is omitted (#1263)', () =>
  Effect.gen(function* optionalMeasuredUnit() {
    for (const scenario of [
      { expected: 'CURRENT', selected: false, selectedRevision: 1, unitPresent: true },
      { expected: 'CURRENT', selected: true, selectedRevision: 1, unitPresent: true },
      { expected: 'INDETERMINATE', selected: true, selectedRevision: 2, unitPresent: true },
      { expected: 'INDETERMINATE', selected: false, selectedRevision: 1, unitPresent: false },
    ]) {
      const ownerRows = optionalConfigurationRows([]);
      ownerRows.set(productConfigurationChoices, [
        {
          choiceKey: 'mount',
          definitionId: packageId,
          label: 'Mount',
          meaning: 'Mount',
          required: true,
          unitId: null,
          valueKind: 'SINGLE_CHOICE',
        },
        {
          choiceKey: 'length',
          definitionId: packageId,
          label: 'Length',
          meaning: 'Length',
          required: false,
          unitId,
          unitRevision: 1,
          valueKind: 'MEASURED_VALUE',
        },
      ]);
      ownerRows.set(productConfigurationMeasuredRules, [
        {
          choiceKey: 'length',
          definitionId: packageId,
          evidenceRefs: ['owner:optional-length'],
          maximum: null,
          maximumInclusive: null,
          minimum: null,
          minimumInclusive: null,
          packageDefinitionId: null,
          step: null,
          stepBase: null,
          variantId: null,
        },
      ]);
      ownerRows.set(configurationUnits, scenario.unitPresent ? { unitId } : null);
      ownerRows.set(configurationUnitRevisions, [
        {
          dimension: 'length',
          effectiveFrom: content.effectiveAt,
          effectiveTo: null,
          evidenceRefs: ['owner:length-unit'],
          lifecycleState: 'ACTIVE',
          meaning: 'Centimetre',
          revision: 1,
        },
      ]);
      const requested = yield* Schema.decodeUnknownEffect(CatalogSelectionSchema)({
        configuration: {
          choices: [
            { choiceKey: 'mount', value: 'A' },
            ...(scenario.selected
              ? [
                  {
                    choiceKey: 'length',
                    unit: { resourceRef: ref('commerce.catalog.unit', unitId), revision: scenario.selectedRevision },
                    value: '10',
                  },
                ]
              : []),
          ],
          definition: { resourceRef: ref('commerce.catalog.configuration-definition', packageId), revision: 1 },
          productRef: selection.productRef,
          variantRef: selection.variantRef,
        },
        productRef: selection.productRef,
        variantRef: selection.variantRef,
      });
      const result = yield* read(ownerRows, requested);
      expect(result.status).toBe(scenario.expected);
      if (result.status === 'CURRENT') {
        expect(result.configuration?.unitRevisions).toMatchObject([
          { ref: ref('commerce.catalog.unit', unitId), revision: 1 },
        ]);
      }
    }
  }),
);

it.effect('keeps optional Configuration target, time and value-kind guards (#1263)', () =>
  Effect.gen(function* optionalProofBoundaries() {
    const requested = yield* Schema.decodeUnknownEffect(CatalogSelectionSchema)({
      configuration: {
        choices: [{ choiceKey: 'mount', value: 'A' }],
        definition: { resourceRef: ref('commerce.catalog.configuration-definition', packageId), revision: 1 },
        productRef: selection.productRef,
        variantRef: selection.variantRef,
      },
      productRef: selection.productRef,
      variantRef: selection.variantRef,
    });
    const beforePublication = new Date(content.effectiveAt.getTime() - 1);
    expect((yield* read(optionalConfigurationRows(), requested, beforePublication)).status).not.toBe('CURRENT');
    expect((yield* read(optionalConfigurationRows(), requested, new Date(Number.NaN))).status).not.toBe('CURRENT');
    const wrongTarget = yield* Schema.decodeUnknownEffect(CatalogSelectionSchema)({
      ...requested,
      configuration: { ...requested.configuration, variantRef: { ...selection.variantRef, resourceId: unitId } },
    }).pipe(Effect.flip);
    expect(wrongTarget).toBeDefined();
    const foreignValue = yield* Schema.decodeUnknownEffect(CatalogSelectionSchema)({
      ...requested,
      configuration: {
        ...requested.configuration,
        choices: [
          {
            choiceKey: 'mount',
            unit: { resourceRef: { ...ref('commerce.catalog.unit', unitId), tenantId: unitId }, revision: 1 },
            value: 'A',
          },
        ],
      },
    }).pipe(Effect.flip);
    expect(foreignValue).toBeDefined();
    const wrongKind = yield* Schema.decodeUnknownEffect(CatalogSelectionSchema)({
      ...requested,
      configuration: {
        ...requested.configuration,
        choices: [
          { choiceKey: 'mount', unit: { resourceRef: ref('commerce.catalog.unit', unitId), revision: 1 }, value: 'A' },
        ],
      },
    });
    expect((yield* read(optionalConfigurationRows(), wrongKind)).status).not.toBe('CURRENT');
  }),
);

it.effect('does not treat a supplied optional value as unrestricted (#1263)', () =>
  Effect.gen(function* forbiddenOptionalValue() {
    const ownerRows = optionalConfigurationRows();
    ownerRows.set(
      productConfigurationOptionAllowances,
      ['mount', 'finish'].flatMap((choiceKey) =>
        ['A', 'NONE'].map((optionKey) => ({
          allowed: choiceKey !== 'finish' || optionKey !== 'A',
          choiceKey,
          definitionId: packageId,
          evidenceRefs: ['owner:optional-configuration'],
          optionKey,
          packageDefinitionId: null,
          variantId: null,
        })),
      ),
    );
    const requested = yield* Schema.decodeUnknownEffect(CatalogSelectionSchema)({
      configuration: {
        choices: [
          { choiceKey: 'mount', value: 'A' },
          { choiceKey: 'finish', value: 'A' },
        ],
        definition: { resourceRef: ref('commerce.catalog.configuration-definition', packageId), revision: 1 },
        productRef: selection.productRef,
        variantRef: selection.variantRef,
      },
      productRef: selection.productRef,
      variantRef: selection.variantRef,
    });
    expect(yield* read(ownerRows, requested)).toMatchObject({
      reason: 'Configuration Current proof: OPTION_NOT_ALLOWED',
      status: 'INVALID',
    });
  }),
);

it.effect('retains explicit none as a different Selection from optional omission and rejects duplicates (#1263)', () =>
  Effect.gen(function* distinctOptionalMeaning() {
    const base = {
      configuration: {
        choices: [{ choiceKey: 'mount', value: 'A' }],
        definition: { resourceRef: ref('commerce.catalog.configuration-definition', packageId), revision: 1 },
        productRef: selection.productRef,
        variantRef: selection.variantRef,
      },
      productRef: selection.productRef,
      variantRef: selection.variantRef,
    };
    const omitted = yield* Schema.decodeUnknownEffect(CatalogSelectionSchema)(base);
    const explicit = yield* Schema.decodeUnknownEffect(CatalogSelectionSchema)({
      ...base,
      configuration: {
        ...base.configuration,
        choices: [...base.configuration.choices, { choiceKey: 'finish', value: 'NONE' }],
      },
    });
    expect((yield* read(optionalConfigurationRows(), omitted)).status).toBe('CURRENT');
    expect((yield* read(optionalConfigurationRows(), explicit)).status).toBe('CURRENT');
    expect(Schema.toEquivalence(CatalogSelectionSchema)(omitted, explicit)).toBe(false);
    expect(
      Schema.is(CatalogSelectionSchema)({
        ...base,
        configuration: {
          ...base.configuration,
          choices: [...base.configuration.choices, ...base.configuration.choices],
        },
      }),
    ).toBe(false);
  }),
);

const compositionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const successorAt = new Date('2026-09-18T00:00:00.000Z');
const setSelection = (revision: number) =>
  Schema.decodeUnknownSync(CatalogSelectionSchema)({
    productRef: selection.productRef,
    setComposition: { resourceRef: ref('commerce.catalog.set-composition', compositionId), revision },
    variantRef: selection.variantRef,
  });
const setRevisionRows = () =>
  [1, 2].map((revision) => ({
    actingPrincipalId: scope.principalId,
    actionInvocationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    changeKind: revision === 1 ? 'INITIAL' : 'MATERIAL_CHANGE',
    compositionId,
    effectiveFrom: revision === 1 ? content.effectiveAt : successorAt,
    effectiveTo: null,
    evidenceRefs: ['catalog:verified-set'],
    lifecycleState: 'ACTIVE',
    predecessorRevision: revision === 1 ? null : 1,
    productId,
    reason: 'Publish exact fixed components',
    revision,
    tenantId,
    variantId,
  }));
const setComponents = () =>
  [1, 2].flatMap((revision) =>
    ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'].map((componentId) => ({
      componentId,
      componentProductId: componentId,
      componentVariantId: componentId,
      compositionId,
      configuration: null,
      packageContentRevision: null,
      packageDefinitionId: null,
      quantityAmount: '1',
      quantityUnitId: unitId,
      revision,
      tenantId,
    })),
  );
const setRows = () =>
  new Map<unknown, unknown>([
    [setCompositions, { compositionId, currentRevision: 2, productId, tenantId, variantId }],
    [setCompositionRevisions, setRevisionRows()],
    [setCompositionComponents, setComponents()],
    [variantUnitDivisibility, { currentRevision: 5, divisible: false, unitId }],
  ]);

describe('Catalog Selection package and Unit owner basis', () => {
  it.effect('keeps the selected effective Set revision Current while its published successor is future', () =>
    Effect.gen(function* effectiveSetRevision() {
      const before = yield* read(setRows(), setSelection(1));
      expect(before.status).toBe('CURRENT');
      if (before.status === 'CURRENT') {
        expect(before.setCompositionRevision).toBe(1);
      }
      expect((yield* read(setRows(), setSelection(2))).status).toBe('INVALID');
      for (const at of [successorAt, new Date(successorAt.getTime() + 1)]) {
        expect((yield* read(setRows(), setSelection(1), at)).status).toBe('INVALID');
        const successor = yield* read(setRows(), setSelection(2), at);
        expect(successor.status).toBe('CURRENT');
        if (successor.status === 'CURRENT') {
          expect(successor.setCompositionRevision).toBe(2);
        }
      }
    }),
  );

  it.effect('rejects an old Set when effective authority advances between the actual selected and Current reads', () =>
    Effect.gen(function* setChangesDuringRead() {
      const initial = setRevisionRows();
      const successor = initial.map((row) => (row.revision === 2 ? { ...row, effectiveFrom: now } : row));
      const scriptedRevisions = [initial, successor, successor];
      const overrides = setRows();
      overrides.set(setCompositionRevisions, scriptedRevisions);
      expect((yield* read(overrides, setSelection(1))).status).toBe('INVALID');
      expect(scriptedRevisions).toHaveLength(0);
    }),
  );

  it.effect('never resurrects a superseded Active Set behind a Draft or ended successor', () =>
    Effect.gen(function* successorState() {
      for (const state of ['DRAFT', 'RETIRED', 'ENDED']) {
        const overrides = setRows();
        overrides.set(
          setCompositionRevisions,
          setRevisionRows().map((row) =>
            row.revision === 2
              ? {
                  ...row,
                  effectiveTo: state === 'ENDED' ? successorAt : null,
                  lifecycleState: state === 'ENDED' ? 'ACTIVE' : state,
                }
              : row,
          ),
        );
        for (const revision of [1, 2]) {
          expect((yield* read(overrides, setSelection(revision), successorAt)).status).toBe('INVALID');
        }
      }
    }),
  );
  it.effect('retains missing Set owner, selected row, identity, interval and Unit failures', () =>
    Effect.gen(function* setGuards() {
      for (const table of [setCompositions, setCompositionRevisions]) {
        const overrides = setRows();
        overrides.set(table, []);
        expect((yield* read(overrides, setSelection(1))).status).toBe('INDETERMINATE');
      }
      for (const [field, wrong] of [
        ['productId', unitId],
        ['variantId', unitId],
        ['lifecycleState', 'DRAFT'],
        ['effectiveFrom', successorAt],
        ['effectiveTo', now],
      ] as const) {
        const overrides = setRows();
        overrides.set(
          setCompositionRevisions,
          setRevisionRows().map((row) => (row.revision === 1 ? { ...row, [field]: wrong } : row)),
        );
        expect((yield* read(overrides, setSelection(1))).status).toBe('INVALID');
      }
      for (const [field, value] of [
        ['tenantId', unitId],
        ['resourceType', 'commerce.catalog.product'],
      ]) {
        const requested = setSelection(1);
        Object.defineProperty(requested.setComposition?.resourceRef, field, { value });
        expect((yield* read(setRows(), requested)).status).toBe('INVALID');
      }
      const noUnit = setRows();
      noUnit.set(variantUnitDivisibility, null);
      expect((yield* read(noUnit, setSelection(1))).status).toBe('INDETERMINATE');
    }),
  );
  it.effect('does not fabricate Current when reconstructed Set components or head consistency are unavailable', () =>
    Effect.gen(function* invalidOwnerProof() {
      const noComponents = setRows();
      noComponents.set(setCompositionComponents, []);
      expect((yield* read(noComponents, setSelection(1)).pipe(Effect.flip)).code).toBe(
        'catalog_persistence_unavailable',
      );
      const behindHead = setRows();
      behindHead.set(setCompositions, { compositionId, currentRevision: 1, productId, tenantId, variantId });
      expect((yield* read(behindHead, setSelection(2), successorAt).pipe(Effect.flip)).code).toBe(
        'catalog_persistence_unavailable',
      );
    }),
  );
  it.effect('rejects a non-Unit Configuration reference even when its Unit ID and revision match', () =>
    Effect.gen(function* wrongUnitRef() {
      for (const [field, value] of [
        ['resourceType', 'commerce.catalog.product'],
        ['tenantId', '99999999-9999-4999-8999-999999999999'],
      ]) {
        const configured = Schema.decodeUnknownSync(CatalogSelectionSchema)({
          ...selection,
          configuration: {
            choices: [
              {
                choiceKey: 'length',
                unit: { resourceRef: ref('commerce.catalog.unit', unitId), revision: 3 },
                value: '83',
              },
            ],
            definition: { resourceRef: ref('commerce.catalog.configuration-definition', packageId), revision: 2 },
            productRef: selection.productRef,
            variantRef: selection.variantRef,
          },
        });
        const unitRef = configured.configuration?.choices[0]?.unit?.resourceRef;
        if (unitRef === undefined) {
          throw new Error('Fixture must contain a Unit reference');
        }
        Object.defineProperty(unitRef, field, { configurable: true, value });
        const result = yield* catalogSelectionPackageUnitBasisForScope(
          // @ts-expect-error The mock supplies only the exercised read chains.
          transactionFor(),
          scope,
        ).read(configured, now);
        expect(result.status).toBe('INVALID');
      }
    }),
  );

  it.effect('attests exact Current Option content and target Unit without a purchase quantity', () =>
    Effect.gen(function* current() {
      const result = yield* read();
      expect(result).toMatchObject({
        contentPath: [{ amount: '10', packageDefinitionId: packageId, revision: 4 }],
        optionRevision: 2,
        status: 'CURRENT',
        unit: { divisible: false, id: unitId, ruleRevision: 6, targetDivisibilityRevision: 5 },
      });
      expect('quantity' in result).toBe(false);
    }),
  );

  it.effect('fails closed when an omitted Configuration has an owner definition but no Current proof', () =>
    Effect.gen(function* omittedConfiguration() {
      const result = yield* read(new Map([[productConfigurationDefinitions, [{ definitionId: packageId }]]]));
      expect(result).toMatchObject({
        reason: 'Configuration applicability proof is unavailable',
        status: 'INDETERMINATE',
      });
    }),
  );

  it.effect('rejects required length/type both when omitted and when another Configuration A is complete', () =>
    Effect.gen(function* requiredConfiguration() {
      const effectiveAt = new Date('2026-09-16T00:00:00.000Z');
      const actionInvocationId = '88888888-8888-4888-8888-888888888888';
      const actingPrincipalId = '99999999-9999-4999-8999-999999999999';
      const reason = 'Required component configuration';
      const evidenceRefs = ['owner:required-configuration'];
      const ownerRows = new Map<unknown, unknown>([
        [productConfigurationDefinitions, [{ currentRevision: 1, definitionId: packageId, productId }]],
        [
          productConfigurationRevisionActivations,
          [
            {
              actingPrincipalId,
              actionInvocationId,
              definitionId: packageId,
              effectiveAt,
              evidenceRefs,
              reason,
              revision: 1,
              supersededRevision: null,
            },
          ],
        ],
        [
          productConfigurationDefinitionRevisions,
          [
            {
              actingPrincipalId,
              actionInvocationId,
              definitionId: packageId,
              effectiveFrom: effectiveAt,
              evidenceRefs,
              productId,
              reason,
              revision: 1,
              state: 'ACTIVE',
            },
          ],
        ],
        [
          productConfigurationChoices,
          ['length', 'type'].map((choiceKey) => ({
            choiceKey,
            definitionId: packageId,
            kind: 'SINGLE_CHOICE',
            label: choiceKey,
            meaning: choiceKey,
            required: true,
            unitId: null,
            valueKind: 'SINGLE_CHOICE',
          })),
        ],
        [
          productConfigurationChoiceOptions,
          ['length', 'type'].map((choiceKey) => ({
            choiceKey,
            definitionId: packageId,
            label: 'A',
            meaning: 'A',
            optionKey: 'A',
          })),
        ],
        [
          productConfigurationOptionAllowances,
          ['length', 'type'].map((choiceKey) => ({
            allowed: true,
            choiceKey,
            definitionId: packageId,
            evidenceRefs,
            optionKey: 'A',
            packageDefinitionId: null,
            variantId: null,
          })),
        ],
      ]);
      const result = yield* read(ownerRows);
      expect(result).toMatchObject({
        reason: 'Configuration Current proof: REQUIRED_CHOICE_MISSING',
        status: 'INVALID',
      });
      const complete = Schema.decodeUnknownSync(CatalogSelectionSchema)({
        ...selection,
        configuration: {
          choices: ['length', 'type'].map((choiceKey) => ({ choiceKey, value: 'A' })),
          definition: { resourceRef: ref('commerce.catalog.configuration-definition', packageId), revision: 1 },
          productRef: selection.productRef,
          variantRef: selection.variantRef,
        },
      });
      ownerRows.set(productConfigurationDefinitions, [{ currentRevision: 1, definitionId: packageId, productId }]);
      const completeResult = yield* catalogSelectionPackageUnitBasisForScope(
        // @ts-expect-error The mock supplies only the read chains exercised here.
        transactionFor(ownerRows),
        scope,
      ).read(complete, now);
      expect(completeResult).toMatchObject({ status: 'CURRENT' });

      const otherDefinitionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const otherActionInvocationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      ownerRows.set(productConfigurationDefinitions, [
        { currentRevision: 1, definitionId: packageId, productId },
        { currentRevision: 1, definitionId: otherDefinitionId, productId },
      ]);
      ownerRows.set(productConfigurationRevisionActivations, [
        {
          actingPrincipalId,
          actionInvocationId,
          definitionId: packageId,
          effectiveAt,
          evidenceRefs,
          reason,
          revision: 1,
          supersededRevision: null,
        },
        {
          actingPrincipalId,
          actionInvocationId: otherActionInvocationId,
          definitionId: otherDefinitionId,
          effectiveAt,
          evidenceRefs,
          reason,
          revision: 1,
          supersededRevision: null,
        },
      ]);
      ownerRows.set(productConfigurationDefinitionRevisions, [
        {
          actingPrincipalId,
          actionInvocationId,
          definitionId: packageId,
          effectiveFrom: effectiveAt,
          evidenceRefs,
          productId,
          reason,
          revision: 1,
          state: 'ACTIVE',
        },
        {
          actingPrincipalId,
          actionInvocationId: otherActionInvocationId,
          definitionId: otherDefinitionId,
          effectiveFrom: effectiveAt,
          evidenceRefs,
          productId,
          reason,
          revision: 1,
          state: 'ACTIVE',
        },
      ]);
      ownerRows.set(productConfigurationChoices, [
        ...['length', 'type'].map((choiceKey) => ({
          choiceKey,
          definitionId: packageId,
          label: choiceKey,
          meaning: choiceKey,
          required: true,
          unitId: null,
          valueKind: 'SINGLE_CHOICE',
        })),
        ...['length', 'type'].map((choiceKey) => ({
          choiceKey,
          definitionId: otherDefinitionId,
          label: choiceKey,
          meaning: choiceKey,
          required: true,
          unitId: null,
          valueKind: 'SINGLE_CHOICE',
        })),
      ]);
      ownerRows.set(productConfigurationChoiceOptions, [
        ...['length', 'type'].map((choiceKey) => ({
          choiceKey,
          definitionId: packageId,
          label: 'A',
          meaning: 'A',
          optionKey: 'A',
        })),
        ...['length', 'type'].map((choiceKey) => ({
          choiceKey,
          definitionId: otherDefinitionId,
          label: 'A',
          meaning: 'A',
          optionKey: 'A',
        })),
      ]);
      ownerRows.set(productConfigurationOptionAllowances, [
        ...['length', 'type'].map((choiceKey) => ({
          allowed: true,
          choiceKey,
          definitionId: packageId,
          evidenceRefs,
          optionKey: 'A',
          packageDefinitionId: null,
          variantId: null,
        })),
        ...['length', 'type'].map((choiceKey) => ({
          allowed: true,
          choiceKey,
          definitionId: otherDefinitionId,
          evidenceRefs,
          optionKey: 'A',
          packageDefinitionId: null,
          variantId: null,
        })),
      ]);
      const otherRequired = yield* catalogSelectionPackageUnitBasisForScope(
        // @ts-expect-error The mock supplies only the read chains exercised here.
        transactionFor(ownerRows),
        scope,
      ).read(complete, now);
      expect(otherRequired).toMatchObject({
        reason: 'Configuration Current proof: REQUIRED_CHOICE_MISSING',
        status: 'INVALID',
      });
      ownerRows.set(productConfigurationRevisionActivations, [
        {
          actingPrincipalId,
          actionInvocationId,
          definitionId: packageId,
          effectiveAt,
          evidenceRefs,
          reason,
          revision: 1,
          supersededRevision: null,
        },
      ]);
      const unknownOther = yield* catalogSelectionPackageUnitBasisForScope(
        // @ts-expect-error The mock supplies only the read chains exercised here.
        transactionFor(ownerRows),
        scope,
      ).read(complete, now);
      expect(unknownOther).toMatchObject({
        reason: 'Configuration applicability proof is unavailable',
        status: 'INDETERMINATE',
      });
    }),
  );

  it.effect('does not promote a substituteable role or a future content revision', () =>
    Effect.gen(function* stale() {
      const substitute = yield* read(
        new Map([[packageOptionRoleRevisions, { ...role, looseUnitsSubstitutable: true }]]),
      );
      expect(substitute.status).toBe('INVALID');
      const future = yield* read(
        new Map<unknown, unknown>([
          [packageContentRevisions, revisionsWith({ ...content, effectiveAt: new Date('2026-09-18T00:00:00.000Z') })],
        ]),
      );
      expect(future.status).toBe('INVALID');
    }),
  );

  it.effect('uses the effective content at assessment time, not the latest scheduled revision', () =>
    Effect.gen(function* scheduled() {
      const future = {
        ...content,
        amount: '8',
        effectiveAt: new Date('2026-09-18T00:00:00.000Z'),
        revision: 5,
      };
      const prior = yield* read(
        new Map<unknown, unknown>([[packageContentRevisions, [...revisionsWith(content), future]]]),
      );
      expect(prior).toMatchObject({
        contentPath: [{ amount: '10', revision: 4 }],
        status: 'CURRENT',
      });
      const after = yield* catalogSelectionPackageUnitBasisForScope(
        // @ts-expect-error The mock supplies only the read chains exercised here.
        transactionFor(new Map<unknown, unknown>([[packageContentRevisions, [...revisionsWith(content), future]]])),
        scope,
      ).read(selection, new Date('2026-09-18T10:00:00.000Z'));
      expect(after.status).toBe('INVALID');
      const successorSelection = Schema.decodeUnknownSync(CatalogSelectionSchema)({
        ...selection,
        packageOption: {
          ...selection.packageOption,
          contentRevision: { resourceRef: ref('commerce.catalog.package-definition', packageId), revision: 5 },
        },
      });
      const successor = yield* catalogSelectionPackageUnitBasisForScope(
        // @ts-expect-error The mock supplies only the read chains exercised here.
        transactionFor(
          new Map<unknown, unknown>([
            [packageContentRevisions, [...revisionsWith(content), future]],
            [packageOptionRoleRevisions, { ...role, contentRevision: 5, effectiveAt: future.effectiveAt }],
          ]),
        ),
        scope,
      ).read(successorSelection, new Date('2026-09-18T10:00:00.000Z'));
      expect(successor).toMatchObject({ contentPath: [{ amount: '8', revision: 5 }], status: 'CURRENT' });
    }),
  );

  it.effect('keeps an incomplete owner history indeterminate and rejects conflicting effectivity', () =>
    Effect.gen(function* history() {
      const missing = yield* read(new Map([[packageContentRevisions, revisionsWith(content).slice(1)]]));
      expect(missing.status).toBe('INDETERMINATE');
      const conflict = yield* read(
        new Map([
          [
            packageContentRevisions,
            revisionsWith({
              ...content,
              effectiveAt: new Date('2026-09-15T00:00:00.000Z'),
            }),
          ],
        ]),
      );
      expect(conflict.status).toBe('INVALID');
    }),
  );

  it.effect('keeps missing owner facts and unverified configuration indeterminate', () =>
    Effect.gen(function* incomplete() {
      expect((yield* read(new Map([[packageOptionRoleRevisions, null]]))).status).toBe('INDETERMINATE');
      expect(
        (yield* read(new Map([[packageContentRevisions, revisionsWith({ ...content, configurationKey: 'red' })]])))
          .status,
      ).toBe('INDETERMINATE');
    }),
  );

  it.effect('does not treat a predefined component configuration as open, but requires its exact Current proof', () =>
    Effect.gen(function* configuredComponent() {
      const configured = Schema.decodeUnknownSync(CatalogSelectionSchema)({
        configuration: {
          choices: [
            {
              choiceKey: 'length',
              unit: { resourceRef: ref('commerce.catalog.unit', unitId), revision: 3 },
              value: '83',
            },
          ],
          definition: { resourceRef: ref('commerce.catalog.configuration-definition', packageId), revision: 2 },
          productRef: ref('commerce.catalog.product', productId),
          variantRef: ref('commerce.catalog.variant', variantId),
        },
        productRef: ref('commerce.catalog.product', productId),
        variantRef: ref('commerce.catalog.variant', variantId),
      });
      // The fixed value is represented in the composition selection. A missing
      // owner Configuration revision still cannot become a Current component.
      const result = yield* catalogSelectionPackageUnitBasisForScope(
        // @ts-expect-error The mock supplies only the read chains exercised here.
        transactionFor(new Map([[variantUnitDivisibility, { currentRevision: 5, divisible: false, unitId }]])),
        scope,
      ).read(configured, now);
      expect(result).toMatchObject({
        reason: 'Configuration Current proof: CURRENT_DEFINITION_UNAVAILABLE',
        status: 'INDETERMINATE',
      });
    }),
  );

  it.effect('retains a pinned lower Package Content revision and refuses a cycle', () =>
    Effect.gen(function* nested() {
      const top = { ...content, lowerCount: '2', lowerPackageDefinitionId: lowerPackageId, lowerRevision: 2 };
      const lower = { ...content, amount: '5', packageDefinitionId: lowerPackageId, revision: 2 };
      const overrides = new Map<unknown, unknown>([
        [packageDefinitions, [definition, { ...definition, currentRevision: 2 }]],
        [
          packageContentRevisions,
          [revisionsWith(top), [{ ...lower, effectiveAt: new Date('2026-09-14T00:00:00.000Z'), revision: 1 }, lower]],
        ],
      ]);
      const current = yield* read(overrides);
      expect(current).toMatchObject({
        contentPath: [
          { lowerCount: '2', packageDefinitionId: packageId, revision: 4 },
          { amount: '5', packageDefinitionId: lowerPackageId, revision: 2 },
        ],
        status: 'CURRENT',
      });
      const cycle = yield* read(
        new Map([[packageContentRevisions, revisionsWith({ ...top, lowerPackageDefinitionId: packageId })]]),
      );
      expect(cycle.status).toBe('INDETERMINATE');
    }),
  );

  it.effect('rejects missing or contradictory exact content without turning it into purchase quantity', () =>
    Effect.gen(function* checksContent() {
      expect(
        (yield* read(new Map([[packageContentRevisions, revisionsWith({ ...content, amount: '0' })]]))).status,
      ).toBe('INVALID');
      const top = { ...content, lowerCount: '2', lowerPackageDefinitionId: lowerPackageId, lowerRevision: 2 };
      const mismatched = yield* read(
        new Map<unknown, unknown>([
          [packageDefinitions, [definition, { ...definition, currentRevision: 2 }]],
          [
            packageContentRevisions,
            [
              revisionsWith(top),
              [
                {
                  ...content,
                  effectiveAt: new Date('2026-09-14T00:00:00.000Z'),
                  packageDefinitionId: lowerPackageId,
                  revision: 1,
                },
                { ...content, amount: '8', packageDefinitionId: lowerPackageId, revision: 2 },
              ],
            ],
          ],
        ]),
      );
      expect(mismatched.status).toBe('INVALID');
      const unknown = yield* read(
        new Map<unknown, unknown>([
          [packageDefinitions, [definition, { ...definition, currentRevision: 2 }]],
          [packageContentRevisions, [revisionsWith(top), []]],
        ]),
      );
      expect(unknown.status).toBe('INDETERMINATE');
    }),
  );
});
