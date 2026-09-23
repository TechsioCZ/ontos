import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import type { SQL } from 'drizzle-orm';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
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
const makeWhere = (table: ReadTable, overrides: Map<unknown, unknown>, projected: boolean) => (condition?: SQL) => {
  if (table === packageContentRevisions) {
    return contentRows(overrides);
  }
  if (
    table === productConfigurationDefinitions ||
    table === productConfigurationRevisionActivations ||
    table === productConfigurationDefinitionRevisions ||
    table === productConfigurationChoices ||
    table === productConfigurationChoiceOptions ||
    table === productConfigurationOptionAllowances ||
    table === productConfigurationMeasuredRules ||
    table === productConfigurationCompatibilityRules
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
const read = (overrides = new Map<unknown, unknown>()) =>
  // @ts-expect-error The mock supplies only the read chains exercised here.
  catalogSelectionPackageUnitBasisForScope(transactionFor(overrides), scope).read(selection, now);

describe('Catalog Selection package and Unit owner basis', () => {
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
