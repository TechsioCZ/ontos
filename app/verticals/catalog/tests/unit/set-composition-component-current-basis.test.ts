import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { NodeCrypto } from '@effect/platform-node';
import { Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { SetCompositionRevisionSchema } from '../../shared/domain/set-composition.ts';
import { CatalogSelectionSchema } from '../../shared/domain/catalog-selection-evidence.ts';
import { CatalogResourceRefSchema } from '../../shared/domain/catalog-revision-reference.ts';
import {
  attributeValueSets,
  productTypeAssignments,
  productTypeUntypedDecisions,
  productTypes,
  productTypeRevisions,
  productTypeRevisionAttributes,
  productVariantAxes,
  productVariantAxisEvents,
  packageContentRevisions,
  packageDefinitions,
  packageOptionRoleRevisions,
  productConfigurationDefinitions,
  productConfigurationRevisionActivations,
  productUnitRuleRevisions,
  productUnits,
  productVariants,
  products,
  setCompositions,
  variantUnitDivisibility,
} from '../../src/database/schema.ts';
import {
  setComponentConfigurationDependencies,
  setCompositionComponentCurrentBasisForScope,
} from '../../src/persistence/set-composition-component-current-basis.ts';
import { SetCompositionPersistenceUnavailable } from '../../src/persistence/set-composition-persistence.ts';
import { setCompositionBasisForScope } from '../../src/actions/set-composition-action-support.ts';
import { evaluateCurrentProductConfiguration } from '../../src/persistence/product-configuration-current-evaluator.ts';
import type {
  CurrentConfigurationAssessment,
  CurrentConfigurationValue,
} from '../../src/persistence/product-configuration-current-evaluator.ts';
import type {
  CurrentConfigurationRevision,
  ProductConfigurationPersistence,
} from '../../src/persistence/product-configuration-persistence.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const setProductId = '22222222-2222-4222-8222-222222222222';
const unitId = '33333333-3333-4333-8333-333333333333';
const ref = (type: string, resourceId: string) => ({
  moduleId: 'commerce.catalog',
  resourceId,
  resourceType: `commerce.catalog.${type}`,
  tenantId,
});
const revision = Schema.decodeUnknownSync(SetCompositionRevisionSchema)({
  components: [
    {
      componentId: '44444444-4444-4444-8444-444444444444',
      quantity: { amount: '1', unitRef: ref('product-unit', unitId) },
      selection: {
        productRef: ref('product', '55555555-5555-4555-8555-555555555555'),
        variantRef: ref('variant', '66666666-6666-4666-8666-666666666666'),
      },
    },
    {
      componentId: '77777777-7777-4777-8777-777777777777',
      quantity: { amount: '2', unitRef: ref('product-unit', unitId) },
      selection: {
        productRef: ref('product', '88888888-8888-4888-8888-888888888888'),
        variantRef: ref('variant', '99999999-9999-4999-8999-999999999999'),
      },
    },
  ],
  productRef: ref('product', setProductId),
  provenance: { changeKind: 'INITIAL', evidenceRefs: ['set-proof'], reason: 'Fixed contents' },
  reference: { resourceRef: ref('set-composition', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), revision: 1 },
  variantRef: ref('variant', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
});
const scope = { tenantId };
const at = new Date('2026-09-18T00:00:00.000Z');

interface BasisOptions {
  readonly absentProduct?: boolean;
  readonly absentVariant?: boolean;
  readonly configurationDefinitionIds?: readonly string[];
  readonly missingRequiredValue?: boolean;
  readonly missingUntypedDecision?: boolean;
  readonly nested?: boolean;
  readonly retired?: boolean;
  readonly typeRevision?: number;
  readonly unavailableProduct?: boolean;
  readonly unavailableType?: boolean;
  readonly unitId?: string;
  readonly untyped?: boolean;
}
type BasisTable =
  | typeof attributeValueSets
  | typeof productTypeUntypedDecisions
  | typeof productTypeAssignments
  | typeof productTypes
  | typeof productTypeRevisions
  | typeof productTypeRevisionAttributes
  | typeof productVariantAxes
  | typeof productVariantAxisEvents
  | typeof setCompositions
  | typeof products
  | typeof productVariants
  | typeof productConfigurationDefinitions
  | typeof productConfigurationRevisionActivations
  | typeof variantUnitDivisibility
  | typeof productUnits
  | typeof productUnitRuleRevisions
  | typeof packageDefinitions
  | typeof packageContentRevisions
  | typeof packageOptionRoleRevisions;
const typeId = '10101010-1010-4010-8010-101010101010';
const typeRevisionId = '12121212-1212-4212-8212-121212121212';
const typeRowsFor = (
  table: BasisTable,
  options: BasisOptions,
  selectedProductId: string,
  variantId: string | undefined,
): readonly object[] | undefined => {
  if (table === productTypeUntypedDecisions) {
    return options.missingUntypedDecision === true
      ? []
      : [
          {
            axisRevision: 1,
            decisionRevision: 7,
            decisionState: 'CONFIRMED',
            productId: selectedProductId,
            productRevision: 3,
            structuredAttributesRequired: false,
            tenantId,
            valueRevisionTokens: [],
            variantAxesRequired: false,
            variantRevisionTokens: [`${variantId}:4`],
          },
        ];
  }
  if (table === attributeValueSets || table === productVariantAxes) {
    return [];
  }
  if (table === productTypeAssignments) {
    return options.untyped === true
      ? []
      : [{ assignmentRevision: 1, productId: selectedProductId, productTypeId: typeId, tenantId }];
  }
  if (table === productTypes) {
    return [{ currentRevision: options.typeRevision ?? 1, productTypeId: typeId, tenantId }];
  }
  if (table === productTypeRevisions) {
    return [
      {
        effectiveAt: new Date('1960-01-01'),
        productTypeId: typeId,
        productTypeRevisionId: typeRevisionId,
        revision: options.typeRevision ?? 1,
        tenantId,
      },
    ];
  }
  if (table === productTypeRevisionAttributes) {
    return options.missingRequiredValue === true
      ? [
          {
            attributeDefinitionId: '13131313-1313-4313-8313-131313131313',
            level: 'PRODUCT',
            productTypeId: typeId,
            requirement: 'REQUIRED',
            revision: options.typeRevision ?? 1,
            tenantId,
          },
        ]
      : [];
  }
  if (table === productVariantAxisEvents) {
    return [
      {
        attributeDefinitionIds: [],
        attributeDefinitionRevisions: [],
        axisRevision: 1,
        productId: selectedProductId,
        tenantId,
      },
    ];
  }
  return undefined;
};
const packageRowsFor = (table: BasisTable): readonly object[] | undefined => {
  if (table === packageDefinitions) {
    return [
      {
        currentOptionRevision: 1,
        currentRevision: 2,
        lifecycleState: 'ACTIVE',
        optionState: 'ACTIVE',
        packageDefinitionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        productId: 'product',
        variantId: 'variant',
      },
    ];
  }
  if (table === packageContentRevisions) {
    const content = {
      amount: '1',
      configurationKey: null,
      lifecycleState: 'ACTIVE',
      lowerCount: null,
      lowerPackageDefinitionId: null,
      lowerRevision: null,
      packageDefinitionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      productId: 'product',
      setCompositionResourceId: null,
      setCompositionRevision: null,
      unitResourceId: unitId,
      unitResourceType: 'commerce.catalog.product-unit',
      variantId: 'variant',
    };
    return [
      { ...content, effectiveAt: new Date('2026-09-16T00:00:00.000Z'), revision: 1 },
      { ...content, effectiveAt: new Date('2026-09-17T00:00:00.000Z'), revision: 2 },
    ];
  }
  if (table === packageOptionRoleRevisions) {
    return [
      {
        contentRevision: 1,
        effectiveAt: new Date('2026-09-17T00:00:00.000Z'),
        independentlyRequested: true,
        looseUnitsSubstitutable: false,
        productId: 'product',
        revision: 1,
        state: 'ACTIVE',
        variantId: 'variant',
      },
    ];
  }
  return undefined;
};
const rowsFor = (table: BasisTable, options: BasisOptions, selectedProductId: string): readonly object[] => {
  const variantId = revision.components.find(
    (component) => component.selection.productRef.resourceId === selectedProductId,
  )?.selection.variantRef.resourceId;
  const typeRows = typeRowsFor(table, options, selectedProductId, variantId);
  if (typeRows !== undefined) {
    return typeRows;
  }
  if (table === setCompositions) {
    return options.nested === true ? [{ compositionId: 'nested' }] : [];
  }
  if (table === products) {
    if (options.absentProduct === true) {
      return [];
    }
    return [
      {
        currentRevision: 3,
        lifecycleState: options.retired === true ? 'RETIRED' : 'ACTIVE',
        productId: selectedProductId,
        tenantId,
      },
    ];
  }
  if (table === productVariants) {
    if (options.absentVariant === true) {
      return [];
    }
    return [{ currentRevision: 4, lifecycleState: 'ACTIVE', productId: selectedProductId, tenantId, variantId }];
  }
  if (table === productConfigurationDefinitions) {
    return (options.configurationDefinitionIds ?? []).map((definitionId) => ({ definitionId }));
  }
  if (table === productConfigurationRevisionActivations) {
    return [];
  }
  if (table === variantUnitDivisibility) {
    return [{ currentRevision: 5, divisible: false, unitId: options.unitId ?? unitId }];
  }
  if (table === productUnits) {
    return [{ currentRuleRevision: 6, lifecycleState: 'ACTIVE', unitId: options.unitId ?? unitId }];
  }
  if (table === productUnitRuleRevisions) {
    return [{ lifecycleState: 'ACTIVE', revision: 6, rounding: 'UP', step: '1' }];
  }
  const packageRows = packageRowsFor(table);
  if (packageRows !== undefined) {
    return packageRows;
  }
  throw new Error('Unexpected component basis table');
};
const dialect = new PgDialect();
const selectedProductFor = (params: readonly unknown[]) =>
  revision.components.find((component) => params.includes(component.selection.productRef.resourceId))?.selection
    .productRef.resourceId ?? '';
const queryResult = (rows: readonly object[], failed: boolean) => {
  const result = failed ? Effect.fail(new Error('Owner read unavailable')) : Effect.succeed(rows);
  return Object.assign(result, {
    for: () => Object.assign(result, { limit: () => result }),
    limit: () => result,
    orderBy: () => Object.assign(result, { limit: () => result }),
  });
};
const scopedRows = (table: BasisTable, options: BasisOptions) => (condition: SQL) => {
  const { params } = dialect.sqlToQuery(condition);
  const rows = rowsFor(table, options, selectedProductFor(params));
  return queryResult(
    rows,
    (table === products && options.unavailableProduct === true) ||
      (table === productTypeAssignments && options.unavailableType === true),
  );
};
const transactionFor = (options: BasisOptions = {}) => ({
  select: () => ({ from: (table: BasisTable) => ({ where: scopedRows(table, options) }) }),
});

const read = (options?: Parameters<typeof transactionFor>[0], candidate = revision) => {
  // @ts-expect-error Only the exercised owner-local Drizzle query chains are mocked.
  const service = setCompositionComponentCurrentBasisForScope(transactionFor(options), scope);
  return service.read(candidate, at);
};

const configurationDefinitionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const measurementUnitId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const selectedComponentId = '44444444-4444-4444-8444-444444444444';
const componentProductId = '55555555-5555-4555-8555-555555555555';
const componentVariantId = '66666666-6666-4666-8666-666666666666';
const configurationRevision: CurrentConfigurationRevision = {
  choices: [
    {
      choiceKey: 'mount',
      kind: 'SINGLE_CHOICE',
      label: 'Mount',
      meaning: 'Mount',
      options: [{ label: 'A', meaning: 'Fixed mount', optionKey: 'A' }],
      required: true,
    },
    {
      choiceKey: 'finish',
      kind: 'SINGLE_CHOICE',
      label: 'Finish',
      meaning: 'Finish',
      options: [{ label: 'None', meaning: 'Explicit no finish', optionKey: 'NONE' }],
      required: false,
    },
    {
      choiceKey: 'length',
      kind: 'MEASURED_VALUE',
      label: 'Length',
      meaning: 'Length',
      required: false,
      unitId: measurementUnitId,
      unitRevision: 3,
    },
  ],
  compatibilityRules: [],
  definitionEvidenceRefs: ['owner:configuration:2'],
  definitionId: configurationDefinitionId,
  effectiveFrom: new Date('2026-09-17T00:00:00.000Z'),
  measuredRules: [
    {
      choiceKey: 'length',
      evidenceRefs: ['owner:length:range'],
      maximum: '100',
      maximumInclusive: true,
      minimum: '1',
      minimumInclusive: true,
    },
  ],
  optionAllowances: [
    { allowed: true, choiceKey: 'mount', evidenceRefs: ['owner:mount:A'], optionKey: 'A' },
    { allowed: true, choiceKey: 'finish', evidenceRefs: ['owner:finish:NONE'], optionKey: 'NONE' },
  ],
  productId: componentProductId,
  revision: 2,
  ruleCombination: 'CONJUNCTION_ONLY',
  units: [
    {
      dimension: 'length',
      effectiveFrom: new Date('2026-09-17T00:00:00.000Z'),
      evidenceRefs: ['owner:unit:3'],
      lifecycleState: 'ACTIVE',
      meaning: 'centimetre',
      ref: Schema.decodeUnknownSync(CatalogResourceRefSchema)(ref('unit', measurementUnitId)),
      revision: 3,
    },
  ],
};
const mountValue: CurrentConfigurationValue = { choiceKey: 'mount', kind: 'SINGLE_CHOICE', optionKey: 'A' };
const finishValue: CurrentConfigurationValue = { choiceKey: 'finish', kind: 'SINGLE_CHOICE', optionKey: 'NONE' };
const lengthValue: CurrentConfigurationValue = {
  amount: '83',
  choiceKey: 'length',
  kind: 'MEASURED_VALUE',
  unitId: measurementUnitId,
};
const configurationTarget = {
  definitionId: configurationDefinitionId,
  productId: componentProductId,
  variantId: componentVariantId,
};
const assessConfiguration = (current: CurrentConfigurationRevision, values: readonly CurrentConfigurationValue[]) => {
  const source: Pick<ProductConfigurationPersistence, 'readCurrent'> = {
    readCurrent: () => Effect.succeed(Option.some(current)),
  };
  return evaluateCurrentProductConfiguration(source, { at, target: configurationTarget, values });
};
const configuredSelection = (values: readonly CurrentConfigurationValue[]) =>
  Schema.decodeUnknownEffect(CatalogSelectionSchema)({
    configuration: {
      choices: values.map((value) =>
        value.kind === 'SINGLE_CHOICE'
          ? { choiceKey: value.choiceKey, value: value.optionKey }
          : {
              choiceKey: value.choiceKey,
              unit: { resourceRef: ref('unit', value.unitId), revision: 3 },
              value: value.amount,
            },
      ),
      definition: { resourceRef: ref('configuration-definition', configurationDefinitionId), revision: 2 },
      productRef: ref('product', componentProductId),
      variantRef: ref('variant', componentVariantId),
    },
    productRef: ref('product', componentProductId),
    variantRef: ref('variant', componentVariantId),
  });

describe('Set composition component Current basis', () => {
  it.effect('preserves omitted optional choices from the genuine evaluator without trimming definition evidence', () =>
    Effect.gen(function* optionalComponentConfiguration() {
      const variants = [
        { current: configurationRevision, values: [mountValue] },
        { current: configurationRevision, values: [mountValue, finishValue, lengthValue] },
        { current: configurationRevision, values: [mountValue, finishValue] },
        {
          current: {
            ...configurationRevision,
            choices: configurationRevision.choices.map((choice) => ({ ...choice, required: false })),
          },
          values: [],
        },
      ];
      for (const { current, values } of variants) {
        const selection = yield* configuredSelection(values);
        const assessment = yield* assessConfiguration(current, values);
        expect(assessment.status).toBe('VALID');
        expect(assessment.choiceRevisions).toHaveLength(3);
        const before = JSON.stringify({ assessment, selection });
        const result = setComponentConfigurationDependencies(selectedComponentId, selection, assessment);
        expect(result).toMatchObject({ status: 'PROVEN' });
        if (result.status === 'PROVEN') {
          expect(result.dependencies).toHaveLength(values.some((value) => value.kind === 'MEASURED_VALUE') ? 2 : 1);
          expect(result.dependencies[0]?.fact).toEqual({
            role: 'CONFIGURATION_DEFINITION',
            source: { resourceRef: ref('configuration-definition', configurationDefinitionId), revision: 2 },
          });
          if (values.some((value) => value.kind === 'MEASURED_VALUE')) {
            expect(result.dependencies[1]?.fact).toEqual({
              role: 'UNIT',
              source: { resourceRef: ref('unit', measurementUnitId), revision: 3 },
            });
          }
        }
        expect(selection.configuration?.choices).toHaveLength(values.length);
        expect(JSON.stringify({ assessment, selection })).toBe(before);
      }
    }),
  );

  it.effect('accepts shared measured Unit evidence for omitted and selected optional choices', () =>
    Effect.gen(function* sharedMeasuredUnit() {
      const [unit] = configurationRevision.units;
      const measured = configurationRevision.choices.find((choice) => choice.choiceKey === 'length');
      const [rule] = configurationRevision.measuredRules;
      if (unit === undefined || measured === undefined || rule === undefined) {
        return yield* Effect.die('Expected the owner measurement fixtures');
      }
      const current: CurrentConfigurationRevision = {
        ...configurationRevision,
        choices: [...configurationRevision.choices, { ...measured, choiceKey: 'height' }],
        measuredRules: [...configurationRevision.measuredRules, { ...rule, choiceKey: 'height' }],
        // Native readPinnedUnits returns one independently decoded attestation per measured choice.
        units: [unit, { ...unit, effectiveFrom: new Date(unit.effectiveFrom), evidenceRefs: [...unit.evidenceRefs] }],
      };
      for (const values of [
        [mountValue],
        [mountValue, lengthValue],
        [mountValue, lengthValue, { ...lengthValue, choiceKey: 'height' }],
      ]) {
        const selection = yield* configuredSelection(values);
        const assessment = yield* assessConfiguration(current, values);
        expect(assessment.status).toBe('VALID');
        expect(assessment.choiceRevisions).toHaveLength(4);
        expect(assessment.unitRevisions).toHaveLength(2);
        const before = JSON.stringify({ assessment, selection });
        const result = setComponentConfigurationDependencies(selectedComponentId, selection, assessment);
        expect(result).toMatchObject({ status: 'PROVEN' });
        if (result.status === 'PROVEN') {
          expect(result.dependencies.filter(({ fact }) => fact.role === 'UNIT')).toEqual(
            values.length === 1
              ? []
              : [
                  {
                    componentId: selectedComponentId,
                    fact: { role: 'UNIT', source: { resourceRef: ref('unit', measurementUnitId), revision: 3 } },
                  },
                ],
          );
        }
        expect(JSON.stringify({ assessment, selection })).toBe(before);
      }
      return yield* Effect.void;
    }),
  );

  it.effect('keeps required unknown duplicate forbidden and wrong-kind values rejected by the actual evaluator', () =>
    Effect.gen(function* invalidComponentConfiguration() {
      const selection = yield* configuredSelection([mountValue]);
      const invalidValues: readonly (readonly CurrentConfigurationValue[])[] = [
        [],
        [mountValue, { choiceKey: 'unknown', kind: 'SINGLE_CHOICE', optionKey: 'A' }],
        [mountValue, mountValue],
        [{ choiceKey: 'mount', kind: 'SINGLE_CHOICE', optionKey: 'FORBIDDEN' }],
        [{ amount: '83', choiceKey: 'mount', kind: 'MEASURED_VALUE', unitId: measurementUnitId }],
      ];
      for (const values of invalidValues) {
        const assessment = yield* assessConfiguration(configurationRevision, values);
        expect(assessment.status).not.toBe('VALID');
        expect(setComponentConfigurationDependencies(selectedComponentId, selection, assessment)).toMatchObject({
          code: 'CONFIGURATION_PROOF_INCOMPLETE',
          status: 'INDETERMINATE',
        });
      }
    }),
  );

  it.effect('requires full Current measured Unit and definition proof even when the measured choice is omitted', () =>
    Effect.gen(function* omittedMeasuredAuthority() {
      const selection = yield* configuredSelection([mountValue]);
      const [unit] = configurationRevision.units;
      if (unit === undefined) {
        return yield* Effect.die('Expected the owner measurement Unit fixture');
      }
      const invalidCurrents: readonly CurrentConfigurationRevision[] = [
        { ...configurationRevision, units: [] },
        { ...configurationRevision, units: [{ ...unit, revision: 4 }] },
        { ...configurationRevision, units: [{ ...unit, lifecycleState: 'RETIRED' }] },
        { ...configurationRevision, units: [{ ...unit, effectiveTo: at }] },
        { ...configurationRevision, units: [{ ...unit, effectiveFrom: new Date('2026-09-19T00:00:00.000Z') }] },
        { ...configurationRevision, effectiveTo: at },
        { ...configurationRevision, effectiveFrom: new Date('2026-09-19T00:00:00.000Z') },
      ];
      for (const current of invalidCurrents) {
        const assessment = yield* assessConfiguration(current, [mountValue]);
        expect(assessment.status).not.toBe('VALID');
        expect(setComponentConfigurationDependencies(selectedComponentId, selection, assessment)).toMatchObject({
          status: 'INDETERMINATE',
        });
      }
      return yield* Effect.void;
    }),
  );

  it.effect('retains selected proof identity and duplicate proof controls after optional omission', () =>
    Effect.gen(function* exactOptionalProofs() {
      const selection = yield* configuredSelection([mountValue, lengthValue]);
      const assessment = yield* assessConfiguration(configurationRevision, [mountValue, lengthValue]);
      expect(assessment.status).toBe('VALID');
      expect(
        Schema.is(CatalogResourceRefSchema)({ ...ref('unit', measurementUnitId), moduleId: 'foreign.catalog' }),
      ).toBe(false);
      const wrongUnitRefs = yield* Effect.forEach(
        [
          { ...ref('unit', measurementUnitId), resourceId: 'abababab-abab-4bab-8bab-abababababab' },
          { ...ref('unit', measurementUnitId), resourceType: 'commerce.catalog.product-unit' },
          { ...ref('unit', measurementUnitId), tenantId: '00000000-0000-4000-8000-000000000000' },
        ],
        (rawRef) => Schema.decodeUnknownEffect(CatalogResourceRefSchema)(rawRef),
      );
      for (const corrupted of [
        { ...assessment, definitionId: 'wrong-definition' },
        { ...assessment, definitionRevision: 3 },
        { ...assessment, choiceRevisions: [...assessment.choiceRevisions, ...assessment.choiceRevisions] },
        ...[
          { revision: 4 },
          { meaning: 'metre' },
          { dimension: 'mass' },
          { lifecycleState: 'RETIRED' as const },
          { effectiveFrom: new Date('2026-09-16T00:00:00.000Z') },
          { effectiveTo: at },
          { evidenceRefs: ['conflicting-owner-evidence'] },
          ...wrongUnitRefs
            .filter((unitRef) => unitRef.resourceId === measurementUnitId)
            .map((unitRef) => ({ ref: unitRef })),
        ].map((change) => ({
          ...assessment,
          unitRevisions: [
            ...assessment.unitRevisions,
            ...assessment.unitRevisions.map((unit) => ({ ...unit, ...change })),
          ],
        })),
        { ...assessment, choiceRevisions: assessment.choiceRevisions.filter((choice) => choice.choiceKey !== 'mount') },
        { ...assessment, unitRevisions: [] },
        { ...assessment, unitRevisions: assessment.unitRevisions.map((unit) => ({ ...unit, revision: 4 })) },
        ...wrongUnitRefs.map((unitRef) => ({
          ...assessment,
          unitRevisions: assessment.unitRevisions.map((unit) => ({ ...unit, ref: unitRef })),
        })),
      ]) {
        expect(setComponentConfigurationDependencies(selectedComponentId, selection, corrupted)).toMatchObject({
          status: 'INDETERMINATE',
        });
      }
      const withRevisionId = yield* Schema.decodeUnknownEffect(CatalogSelectionSchema)({
        ...selection,
        configuration: {
          ...selection.configuration,
          definition: { ...selection.configuration?.definition, revisionId: 'abababab-abab-4bab-8bab-abababababab' },
        },
      });
      expect(setComponentConfigurationDependencies(selectedComponentId, withRevisionId, assessment)).toMatchObject({
        code: 'CONFIGURATION_PROOF_INCOMPLETE',
        status: 'INDETERMINATE',
      });
    }),
  );

  it.effect('connects the Action basis to every exact component and fails closed on invalid or unavailable reads', () =>
    Effect.gen(function* actionBasis() {
      // @ts-expect-error Only the exercised owner-local Drizzle query chains are mocked.
      const valid = setCompositionBasisForScope(transactionFor(), scope);
      expect(yield* valid.verify({ at, revision })).toBe(true);
      // @ts-expect-error Only the exercised owner-local Drizzle query chains are mocked.
      const invalid = setCompositionBasisForScope(transactionFor({ absentVariant: true }), scope);
      expect(yield* invalid.verify({ at, revision })).toBe(false);
      // @ts-expect-error Only the exercised owner-local Drizzle query chains are mocked.
      const unavailable = setCompositionBasisForScope(transactionFor({ unavailableProduct: true }), scope);
      const error = yield* unavailable.verify({ at, revision }).pipe(Effect.flip);
      expect(Schema.is(SetCompositionPersistenceUnavailable)(error)).toBe(true);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );
  it('preserves exact configured Definition and measurement Unit revisions', () => {
    const definitionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const configurationUnitId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const selection = Schema.decodeUnknownSync(CatalogSelectionSchema)({
      ...revision.components[0]?.selection,
      configuration: {
        choices: [
          {
            attributeDefinition: {
              resourceRef: ref('attribute-definition', 'abababab-abab-4bab-8bab-abababababab'),
              revision: 1,
            },
            choiceKey: 'length',
            unit: { resourceRef: ref('unit', configurationUnitId), revision: 3 },
            value: '83',
          },
        ],
        definition: { resourceRef: ref('configuration-definition', definitionId), revision: 2 },
        productRef: revision.components[0]?.selection.productRef,
        variantRef: revision.components[0]?.selection.variantRef,
      },
    });
    const chosenUnit = selection.configuration?.choices[0]?.unit;
    if (chosenUnit === undefined) {
      throw new Error('Configured test selection must contain a measured Unit');
    }
    const assessment: CurrentConfigurationAssessment = {
      assessedAt: at,
      choiceRevisions: [
        {
          choiceKey: 'length',
          evidenceRefs: ['configured-length'],
          kind: 'MEASURED_VALUE',
          meaning: 'Length',
          options: [],
          ownerModuleId: 'commerce.catalog',
          required: true,
          revision: 2,
          unitId: configurationUnitId,
          unitRevision: 3,
        },
      ],
      definitionId,
      definitionRevision: 2,
      rules: [],
      status: 'VALID',
      target: {
        definitionId,
        productId: selection.productRef.resourceId,
        variantId: selection.variantRef.resourceId,
      },
      unitRevisions: [
        {
          dimension: 'length',
          effectiveFrom: at,
          evidenceRefs: ['unit-current'],
          lifecycleState: 'ACTIVE',
          meaning: 'cm',
          ref: chosenUnit.resourceRef,
          revision: 3,
        },
      ],
    };
    expect(
      setComponentConfigurationDependencies('44444444-4444-4444-8444-444444444444', selection, assessment),
    ).toMatchObject({
      dependencies: [
        {
          fact: {
            role: 'CONFIGURATION_DEFINITION',
            source: { resourceRef: { resourceId: definitionId }, revision: 2 },
          },
        },
        { fact: { role: 'UNIT', source: { resourceRef: { resourceId: configurationUnitId }, revision: 3 } } },
      ],
      status: 'PROVEN',
    });
    expect(
      setComponentConfigurationDependencies('44444444-4444-4444-8444-444444444444', selection, undefined),
    ).toMatchObject({
      code: 'CONFIGURATION_PROOF_INCOMPLETE',
      status: 'INDETERMINATE',
    });
    expect(
      setComponentConfigurationDependencies('44444444-4444-4444-8444-444444444444', selection, {
        ...assessment,
        definitionRevision: 3,
      }),
    ).toMatchObject({
      code: 'CONFIGURATION_PROOF_INCOMPLETE',
      status: 'INDETERMINATE',
    });
    expect(
      setComponentConfigurationDependencies('44444444-4444-4444-8444-444444444444', selection, {
        ...assessment,
        unitRevisions: [],
      }),
    ).toMatchObject({
      code: 'CONFIGURATION_UNIT_UNPROVEN',
      status: 'INDETERMINATE',
    });
    expect(
      setComponentConfigurationDependencies('44444444-4444-4444-8444-444444444444', selection, {
        ...assessment,
        choiceRevisions: [],
      }),
    ).toMatchObject({
      code: 'CONFIGURATION_CHOICE_UNPROVEN',
      status: 'INDETERMINATE',
    });
    expect(
      setComponentConfigurationDependencies('44444444-4444-4444-8444-444444444444', selection, {
        ...assessment,
        unitRevisions: [{ ...assessment.unitRevisions[0], revision: 4 }],
      }),
    ).toMatchObject({ code: 'CONFIGURATION_UNIT_UNPROVEN', status: 'INDETERMINATE' });
  });
  it.effect('does not certify a component whose Product Type authority is unavailable', () =>
    Effect.gen(function* missingTypeAuthority() {
      // A failed Type owner read cannot be replaced by healthy lifecycle/Unit facts.
      const result = yield* read({ unavailableType: true });
      expect(result.status).toBe('INDETERMINATE');
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('issues exact component and dependency revisions without claiming selection Current', () =>
    Effect.gen(function* validComponents() {
      const result = yield* read();
      expect(result.status).toBe('VALID');
      if (result.status === 'VALID') {
        expect(result.proofs.map((proof) => proof.componentId)).toEqual(
          revision.components.map((item) => item.componentId),
        );
        expect(result.dependencies).toHaveLength(12);
        expect(result.dependencies.map((item) => item.fact.source.revision)).toEqual([
          3, 4, 6, 5, 1, 1, 3, 4, 6, 5, 1, 1,
        ]);
      }
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('carries actual component untyped decision provenance and refuses a missing decision', () =>
    Effect.gen(function* untypedComponents() {
      const result = yield* read({ untyped: true });
      expect(result.status).toBe('VALID');
      if (result.status === 'VALID') {
        expect(result.dependencies.filter(({ fact }) => fact.role === 'PRODUCT_TYPE_UNTYPED_DECISION')).toEqual(
          revision.components.map(({ componentId, selection }) => ({
            componentId,
            fact: {
              provenance: 'CATALOG_OWNER_CONFIRMED_UNTYPED_DECISION',
              role: 'PRODUCT_TYPE_UNTYPED_DECISION',
              source: { resourceRef: selection.productRef, revision: 7 },
            },
          })),
        );
      }
      expect(yield* read({ missingUntypedDecision: true, untyped: true })).toMatchObject({ status: 'INDETERMINATE' });
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('retains Type revision identity and rejects a confirmed missing required value', () =>
    Effect.gen(function* typeClosure() {
      const before = yield* read();
      expect(before.status).toBe('VALID');
      if (before.status === 'VALID') {
        expect(before.dependencies.filter(({ fact }) => fact.role === 'PRODUCT_TYPE')).toEqual(
          revision.components.map(({ componentId }) => ({
            componentId,
            fact: {
              role: 'PRODUCT_TYPE',
              source: { resourceRef: ref('product-type', typeId), revision: 1, revisionId: typeRevisionId },
            },
          })),
        );
      }
      expect(yield* read({ missingRequiredValue: true })).toMatchObject({
        code: 'COMPONENT_TYPE_VALUE_AXIS_UNVERIFIABLE',
        status: 'INVALID',
      });
      const changed = yield* read({ typeRevision: 2 });
      expect(changed.status).toBe('VALID');
      if (changed.status === 'VALID') {
        expect(
          changed.dependencies
            .filter(({ fact }) => fact.role === 'PRODUCT_TYPE')
            .every(({ fact }) => fact.source.revision === 2),
        ).toBe(true);
      }
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('rejects nested and retired components without dropping a need', () =>
    Effect.gen(function* invalidComponents() {
      expect(yield* read({ nested: true })).toMatchObject({ code: 'NESTED_SET', status: 'INVALID' });
      expect(yield* read({ retired: true })).toMatchObject({ status: 'INVALID' });
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('fails closed when an omitted component Configuration has an owner definition', () =>
    Effect.gen(function* omittedRequiredConfiguration() {
      expect(yield* read({ configurationDefinitionIds: ['eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'] })).toMatchObject({
        status: 'INDETERMINATE',
      });
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('rejects a Set Product even when the component selection hides it behind a Package Option', () =>
    Effect.gen(function* nestedPackage() {
      const candidate = Schema.decodeUnknownSync(SetCompositionRevisionSchema)({
        ...revision,
        components: [
          {
            ...revision.components[0],
            selection: {
              ...revision.components[0]?.selection,
              packageOption: {
                contentRevision: {
                  resourceRef: ref('package-definition', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'),
                  revision: 1,
                },
                optionRef: ref('package-definition', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'),
              },
            },
          },
          revision.components[1],
        ],
      });
      expect(yield* read({ nested: true }, candidate)).toMatchObject({ code: 'NESTED_SET', status: 'INVALID' });
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('distinguishes confirmed missing Product or Variant from an unavailable owner read', () =>
    Effect.gen(function* missingOrUnavailable() {
      expect(yield* read({ absentProduct: true })).toMatchObject({
        code: 'COMPONENT_PRODUCT_MISSING',
        status: 'INVALID',
      });
      expect(yield* read({ absentVariant: true })).toMatchObject({
        code: 'COMPONENT_VARIANT_MISSING',
        status: 'INVALID',
      });
      const error = yield* read({ unavailableProduct: true }).pipe(Effect.flip);
      expect(Schema.is(SetCompositionPersistenceUnavailable)(error)).toBe(true);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('rejects an exact Unit mismatch instead of treating a stale target basis as Current', () =>
    Effect.gen(function* staleUnit() {
      expect(yield* read({ unitId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' })).toMatchObject({
        code: 'COMPONENT_UNIT_MISMATCH',
        status: 'INVALID',
      });
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('rejects a stale selected Package Content revision', () =>
    Effect.gen(function* stalePackage() {
      const candidate = Schema.decodeUnknownSync(SetCompositionRevisionSchema)({
        ...revision,
        components: [
          {
            ...revision.components[0],
            selection: {
              ...revision.components[0]?.selection,
              packageOption: {
                contentRevision: {
                  resourceRef: ref('package-definition', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'),
                  revision: 1,
                },
                optionRef: ref('package-definition', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'),
              },
            },
          },
          revision.components[1],
        ],
      });
      expect(yield* read({}, candidate)).toMatchObject({ status: 'INVALID' });
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('issues fresh component-bound proofs when stable needs are re-keyed', () =>
    Effect.gen(function* rekeyedComponent() {
      const candidate = Schema.decodeUnknownSync(SetCompositionRevisionSchema)({
        ...revision,
        components: [
          { ...revision.components[0], componentId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' },
          revision.components[1],
        ],
      });
      const result = yield* read({}, candidate);
      expect(result.status).toBe('VALID');
      if (result.status === 'VALID') {
        expect(result.proofs[0]?.componentId).toBe('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
        expect(result.dependencies[0]?.componentId).toBe('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
      }
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );
});
