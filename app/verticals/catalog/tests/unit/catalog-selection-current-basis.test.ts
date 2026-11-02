import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { NodeCrypto } from '@effect/platform-node';
import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Option, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import type { CatalogSelection } from '../../shared/domain/catalog-selection-evidence.ts';
import { describe, expect, it } from 'effect-rstest';

import { CatalogSelectionBasisSchema, CatalogSelectionSchema } from '../../shared/domain/catalog-selection-evidence.ts';
import { assessCatalogSelection } from '../../shared/domain/catalog-selection-assessment.ts';
import {
  attributeDefinitionRevisions,
  attributeDefinitions,
  attributeValueItems,
  attributeValueRevisions,
  attributeValueSets,
  productConfigurationDefinitions,
  productConfigurationDefinitionRevisions,
  productConfigurationRevisionActivations,
  productConfigurationChoices,
  productConfigurationChoiceOptions,
  productConfigurationOptionAllowances,
  productCategories,
  productCategoryAssignments,
  productCategoryHierarchyRevisions,
  packageContentRevisions,
  packageDefinitions,
  packageOptionRoleRevisions,
  packageUnitDivisibility,
  productVariants,
  productUnitRuleRevisions,
  productUnits,
  products,
  productTypeAssignments,
  productTypeRevisionAttributes,
  productTypeRevisions,
  productTypes,
  productTypeUntypedDecisions,
  productAttributeApplicability,
  productAttributeApplicabilityRevisions,
  productVariantAxisAllowanceEvents,
  productVariantAxisAllowedValues,
  productVariantAxes,
  productVariantAxisEvents,
  setCompositionComponents,
  setCompositionRevisions,
  setCompositions,
  variantUnitDivisibility,
} from '../../src/database/schema.ts';
import { allowedValueKeyHash } from '../../src/persistence/variant-axis-persistence.ts';
import {
  hasClosedScheduledConfigurationBasis,
  catalogSelectionCurrentBasisForScope,
} from '../../src/persistence/catalog-selection-current-basis.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const productId = '22222222-2222-4222-8222-222222222222';
const variantId = '33333333-3333-4333-8333-333333333333';
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:selection-current-test:run:1',
    authMethod: 'system',
    principalId: '44444444-4444-4444-8444-444444444444',
    tenantId,
  }),
  correlationId: 'selection-current-test',
};
const selection = {
  productRef: {
    moduleId: 'commerce.catalog',
    resourceId: productId,
    resourceType: 'commerce.catalog.product',
    tenantId,
  },
  variantRef: {
    moduleId: 'commerce.catalog',
    resourceId: variantId,
    resourceType: 'commerce.catalog.variant',
    tenantId,
  },
} as const;
const selected = (rows: readonly object[]) => ({
  where: () =>
    Object.assign(Effect.succeed(rows), {
      for: () => Object.assign(Effect.succeed(rows), { limit: () => Effect.succeed(rows) }),
      limit: () => Effect.succeed(rows),
      orderBy: () => Object.assign(Effect.succeed(rows), { limit: () => Effect.succeed(rows) }),
    }),
});
type BareSetTable =
  | typeof products
  | typeof productVariants
  | typeof setCompositions
  | typeof productConfigurationDefinitionRevisions;
const unavailableAllowanceRows = {
  where: () => ({ orderBy: () => ({ limit: () => Effect.fail(new Error('allowance owner unavailable')) }) }),
};
const unavailableSetRows = { where: () => ({ limit: () => Effect.fail(new Error('Set owner unavailable')) }) };
const selectedConfigurationRevisions = (rows: readonly object[]) => ({
  where: (where: SQL) => {
    const { params } = new PgDialect().sqlToQuery(where);
    const revision = params.find(Schema.is(Schema.Int));
    return Object.assign(Effect.succeed(rows), {
      limit: () => Effect.succeed(rows.filter((row) => !('revision' in row) || row.revision === revision)),
    });
  },
});
const readBareSet = (
  setRows: readonly object[] | null,
  exactSelection: CatalogSelection = selection,
  ownerRows: ReadonlyMap<unknown, readonly object[]> = new Map(),
  purpose = 'PURCHASE_ACCEPTANCE',
) => {
  const transaction = {
    select: () => ({
      from: (table: BareSetTable) => {
        const override = ownerRows.get(table);
        if (override !== undefined) {
          if (table === productConfigurationDefinitionRevisions) {
            return selectedConfigurationRevisions(override);
          }
          return selected(override);
        }
        if (table === products) {
          return selected([{ lifecycleState: 'ACTIVE', revision: 4 }]);
        }
        if (table === productVariants) {
          return selected([{ lifecycleState: 'ACTIVE', productId, revision: 7 }]);
        }
        return setRows === null ? unavailableSetRows : selected(setRows);
      },
    }),
  };
  // @ts-expect-error The mock implements only the exercised owner read chains.
  return catalogSelectionCurrentBasisForScope(transaction, scope).read({ purpose, selection: exactSelection });
};
const packageEffectiveDate = (index: number, selectedAt: Date): Date => {
  if (index < 3) {
    return new Date(`195${index}-01-01T00:00:00.000Z`);
  }
  return index === 3 ? selectedAt : new Date('1961-01-01T00:00:00.000Z');
};

describe('Catalog Selection Current basis', () => {
  it.effect('does not launder caller revision IDs into Current Attribute or Package evidence', () =>
    Effect.gen(function* forgedDependentIds() {
      const revisionId = '99999999-9999-4999-8999-999999999999';
      const packageId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      const definitionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
      const transaction = {
        select: () => {
          throw new Error('unverified revision ID must be rejected before owner reads');
        },
      };
      // @ts-expect-error The forbidden read path needs no Drizzle implementation.
      const reader = catalogSelectionCurrentBasisForScope(transaction, scope);
      const candidates = [
        {
          ...selection,
          packageOption: {
            contentRevision: {
              resourceRef: {
                moduleId: 'commerce.catalog',
                resourceId: packageId,
                resourceType: 'commerce.catalog.package-definition',
                tenantId,
              },
              revision: 4,
              revisionId,
            },
            optionRef: {
              moduleId: 'commerce.catalog',
              resourceId: packageId,
              resourceType: 'commerce.catalog.package-definition',
              tenantId,
            },
          },
        },
        {
          ...selection,
          configuration: {
            choices: [
              {
                attributeDefinition: {
                  resourceRef: {
                    moduleId: 'commerce.catalog',
                    resourceId: definitionId,
                    resourceType: 'commerce.catalog.attribute-definition',
                    tenantId,
                  },
                  revision: 2,
                  revisionId,
                },
                choiceKey: 'material',
                value: 'cotton',
              },
            ],
            definition: {
              resourceRef: {
                moduleId: 'commerce.catalog',
                resourceId: definitionId,
                resourceType: 'commerce.catalog.configuration-definition',
                tenantId,
              },
              revision: 1,
            },
            productRef: selection.productRef,
            variantRef: selection.variantRef,
          },
        },
      ];
      for (const candidate of candidates) {
        const result = yield* reader.read({
          purpose: 'PURCHASE_ACCEPTANCE',
          selection: Schema.decodeUnknownSync(CatalogSelectionSchema)(candidate),
        });
        expect(result.status).toBe('INDETERMINATE');
        expect(result.basis).toEqual([]);
        expect(result.basis.some(({ source }) => source.revisionId === revisionId)).toBe(false);
      }
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('rejects a selected non-Unit reference before projecting its matching ID', () =>
    Effect.gen(function* wrongUnitRef() {
      const unitId = '55555555-5555-4555-8555-555555555555';
      const configured = Schema.decodeUnknownSync(CatalogSelectionSchema)({
        ...selection,
        configuration: {
          choices: [
            {
              choiceKey: 'length',
              unit: {
                resourceRef: {
                  moduleId: 'commerce.catalog',
                  resourceId: unitId,
                  resourceType: 'commerce.catalog.unit',
                  tenantId,
                },
                revision: 3,
              },
              value: '83',
            },
          ],
          definition: {
            resourceRef: {
              moduleId: 'commerce.catalog',
              resourceId: '77777777-7777-4777-8777-777777777777',
              resourceType: 'commerce.catalog.configuration-definition',
              tenantId,
            },
            revision: 2,
          },
          productRef: selection.productRef,
          variantRef: selection.variantRef,
        },
      });
      const transaction = {
        select: () => {
          throw new Error('invalid Unit must not reach owner reads');
        },
      };
      // @ts-expect-error Invalid input must be rejected before any Drizzle read.
      const reader = catalogSelectionCurrentBasisForScope(transaction, scope);
      for (const [field, value] of [
        ['resourceType', 'commerce.catalog.product'],
        ['tenantId', '99999999-9999-4999-8999-999999999999'],
      ]) {
        const bad = structuredClone(configured);
        const unitRef = bad.configuration?.choices[0]?.unit?.resourceRef;
        if (unitRef === undefined) {
          throw new Error('Fixture must contain a Unit reference');
        }
        Object.defineProperty(unitRef, field, { configurable: true, value });
        const result = yield* reader.read({ purpose: 'PURCHASE_ACCEPTANCE', selection: bad });
        expect(result).toMatchObject({ basis: [], status: 'INVALID' });
      }
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('never queries a foreign tenant selection', () =>
    Effect.gen(function* foreignTenant() {
      const transaction = {
        select: () => {
          throw new Error('foreign query');
        },
      };
      // @ts-expect-error The deliberately forbidden query path needs no Drizzle methods.
      const reader = catalogSelectionCurrentBasisForScope(transaction, scope);
      const result = yield* reader.read({
        purpose: 'PURCHASE_ACCEPTANCE',
        selection: {
          ...selection,
          productRef: { ...selection.productRef, tenantId: '55555555-5555-4555-8555-555555555555' },
        },
      });
      expect(result.status).toBe('INDETERMINATE');
      expect(result.basis).toEqual([]);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('retains exact owner revisions but does not invent indirect proof', () =>
    Effect.gen(function* partialBasis() {
      const transaction = {
        select: () => ({
          from: (table: BareSetTable) => {
            if (table === products) {
              return selected([{ lifecycleState: 'ACTIVE', revision: 4 }]);
            }
            return table === productVariants
              ? selected([{ lifecycleState: 'ACTIVE', productId, revision: 7 }])
              : selected([]);
          },
        }),
      };
      // @ts-expect-error Only the two exercised Drizzle read chains are mocked.
      const reader = catalogSelectionCurrentBasisForScope(transaction, scope);
      const result = yield* reader.read({ purpose: 'PURCHASE_ACCEPTANCE', selection });
      expect(result.status).toBe('INDETERMINATE');
      expect(result.basis.map(({ role, source }) => [role, source.revision])).toEqual([
        ['PRODUCT', 4],
        ['VARIANT', 7],
      ]);
      expect(result.source).toBe('CATALOG_OWNER_CURRENT_READ');
      expect(result.purpose).toBe('PURCHASE_ACCEPTANCE');
      expect(Number.isNaN(Date.parse(result.assessedAt))).toBe(false);
      if (result.status !== 'OBSERVED') {
        expect(result.reason).toBe('Current Product Type readiness cannot be proved');
      }
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('rejects a bare Set selection and fails closed when Set ownership cannot be read', () =>
    Effect.gen(function* bareSet() {
      const knownSet = yield* readBareSet([{ compositionId: '88888888-8888-4888-8888-888888888888' }]);
      expect(knownSet.status).toBe('INVALID');
      if (knownSet.status !== 'OBSERVED') {
        expect(knownSet.reason).toBe('Set Product requires an exact selected Composition revision');
      }
      expect(knownSet.basis.map(({ role }) => role)).toEqual(['PRODUCT', 'VARIANT']);
      const unavailable = yield* readBareSet(null);
      expect(unavailable.status).toBe('INDETERMINATE');
      if (unavailable.status !== 'OBSERVED') {
        expect(unavailable.reason).toBe('Set ownership source is unavailable');
      }
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('observes an indirect Product Type revision change without a Variant edit', () =>
    Effect.gen(function* indirectTypeChange() {
      const typeId = '77777777-7777-4777-8777-777777777777';
      const revisionId = '88888888-8888-4888-8888-888888888888';
      const packageId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      const unitId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const definitionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
      const valueSetId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
      const packageSelection = Schema.decodeUnknownSync(CatalogSelectionSchema)({
        ...selection,
        packageOption: {
          contentRevision: {
            resourceRef: {
              moduleId: 'commerce.catalog',
              resourceId: packageId,
              resourceType: 'commerce.catalog.package-definition',
              tenantId,
            },
            revision: 4,
          },
          optionRef: {
            moduleId: 'commerce.catalog',
            resourceId: packageId,
            resourceType: 'commerce.catalog.package-definition',
            tenantId,
          },
        },
      });
      const readAt = (
        currentRevision: number,
        packageCurrentRevision?: number,
        packageEffectiveAt = new Date('1960-01-01T00:00:00.000Z'),
        inheritedRevision?: number,
        allowance?: {
          readonly foreignProduct?: boolean;
          readonly incomplete?: boolean;
          readonly missing?: boolean;
          readonly revision: number;
          readonly staleDefinition?: boolean;
          readonly unavailable?: boolean;
          readonly values: readonly string[];
        },
      ) => {
        const rows = new Map<unknown, readonly object[]>([
          [products, [{ currentRevision: 4, lifecycleState: 'ACTIVE', productId, revision: 4, tenantId }]],
          [
            productVariants,
            [{ currentRevision: 7, lifecycleState: 'ACTIVE', productId, revision: 7, tenantId, variantId }],
          ],
          [productTypeAssignments, [{ assignmentRevision: 1, productId, productTypeId: typeId, tenantId }]],
          [productTypes, [{ currentRevision, productTypeId: typeId, tenantId }]],
          [
            productTypeRevisions,
            [
              {
                effectiveAt: new Date('1960-01-01T00:00:00.000Z'),
                productTypeId: typeId,
                productTypeRevisionId: revisionId,
                revision: currentRevision,
                tenantId,
              },
            ],
          ],
          [productTypeRevisionAttributes, []],
          [productVariantAxes, []],
          [
            productVariantAxisEvents,
            [{ attributeDefinitionIds: [], attributeDefinitionRevisions: [], axisRevision: 3, productId, tenantId }],
          ],
          [variantUnitDivisibility, [{ currentRevision: 1, divisible: false, unitId }]],
          [packageUnitDivisibility, [{ currentRevision: 1, divisible: false, unitId }]],
          [productUnits, [{ currentRuleRevision: 2, lifecycleState: 'ACTIVE', unitId }]],
          [productUnitRuleRevisions, [{ lifecycleState: 'ACTIVE', revision: 2, rounding: 'UP', step: '1' }]],
          [
            packageDefinitions,
            [
              {
                currentOptionRevision: 2,
                currentRevision: packageCurrentRevision,
                lifecycleState: 'ACTIVE',
                optionState: 'ACTIVE',
                packageDefinitionId: packageId,
                productId,
                variantId,
              },
            ],
          ],
          [
            packageContentRevisions,
            Array.from({ length: packageCurrentRevision ?? 4 }, (_, index) => ({
              amount: index === 4 ? '8' : '10',
              configurationKey: null,
              effectiveAt: packageEffectiveDate(index, packageEffectiveAt),
              lifecycleState: 'ACTIVE',
              lowerCount: null,
              lowerPackageDefinitionId: null,
              lowerRevision: null,
              packageDefinitionId: packageId,
              productId,
              revision: index + 1,
              setCompositionResourceId: null,
              setCompositionRevision: null,
              unitResourceId: unitId,
              unitResourceType: 'commerce.catalog.product-unit',
              variantId,
            })),
          ],
          [
            packageOptionRoleRevisions,
            [
              {
                contentRevision: 4,
                effectiveAt: new Date('1960-01-01T00:00:00.000Z'),
                independentlyRequested: true,
                looseUnitsSubstitutable: false,
                productId,
                revision: 2,
                state: 'ACTIVE',
                variantId,
              },
            ],
          ],
        ]);
        if (inheritedRevision !== undefined) {
          const definitionRules = {
            allowsNone: 0,
            allowsNotApplicable: 0,
            allowsUnknown: 0,
            applicableLevels: ['PRODUCT', 'VARIANT'],
            canonicalUnit: null,
            controlledValueKind: null,
            decimalPlaces: null,
            maximumValue: null,
            meaning: 'Material',
            measuredQuantity: null,
            minimumValue: null,
            multiplicity: 'SINGLE',
            name: 'Material',
            valueKind: 'TEXT',
          };
          rows.set(productTypeRevisionAttributes, [
            {
              attributeDefinitionId: definitionId,
              level: 'PRODUCT',
              productTypeId: typeId,
              requirement: 'OPTIONAL',
              revision: currentRevision,
              tenantId,
            },
            {
              attributeDefinitionId: definitionId,
              level: 'VARIANT',
              productTypeId: typeId,
              requirement: 'OPTIONAL',
              revision: currentRevision,
              tenantId,
            },
          ]);
          rows.set(productVariantAxes, [
            { attributeDefinitionId: definitionId, axisRevision: 3, ordinal: 0, productId, tenantId },
          ]);
          rows.set(productVariantAxisEvents, [
            {
              attributeDefinitionIds: [definitionId],
              attributeDefinitionRevisions: [3],
              axisRevision: 3,
              productId,
              tenantId,
            },
          ]);
          rows.set(attributeDefinitions, [
            { ...definitionRules, attributeDefinitionId: definitionId, currentRevision: 3, tenantId },
          ]);
          rows.set(attributeDefinitionRevisions, [
            { ...definitionRules, attributeDefinitionId: definitionId, revision: 3, tenantId },
          ]);
          rows.set(attributeValueSets, [
            {
              attributeDefinitionId: definitionId,
              attributeValueSetId: valueSetId,
              currentRevision: inheritedRevision,
              currentState: 'SET',
              productId,
              tenantId,
              variantId: null,
            },
          ]);
          rows.set(attributeValueRevisions, [
            {
              attributeValueSetId: valueSetId,
              changeKind: 'SET',
              revision: inheritedRevision,
              tenantId,
              valueSnapshot: {
                attributeDefinitionRevision: 3,
                productTypeId: typeId,
                productTypeRevision: currentRevision,
                sourceProductValueRevision: null,
                values: [{ kind: 'TEXT', text: 'cotton' }],
              },
            },
          ]);
          rows.set(attributeValueItems, [
            {
              attributeDefinitionId: definitionId,
              attributeValueSetId: valueSetId,
              ordinal: 0,
              tenantId,
              textValue: 'cotton',
              valueKind: 'TEXT',
            },
          ]);
        }
        if (allowance !== undefined) {
          rows.set(productVariantAxes, [
            {
              attributeDefinitionId: definitionId,
              axisRevision: 3,
              definitionRevision: 3,
              ordinal: 0,
              productId,
              tenantId,
            },
          ]);
          rows.set(productAttributeApplicability, [
            {
              attributeDefinitionId: definitionId,
              currentRevision: 1,
              productId,
              productLevel: true,
              tenantId,
              variantLevel: true,
            },
          ]);
          rows.set(productAttributeApplicabilityRevisions, [
            {
              attributeDefinitionId: definitionId,
              productId,
              productLevel: true,
              revision: 1,
              tenantId,
              variantLevel: true,
            },
          ]);
          rows.set(
            productVariantAxisAllowanceEvents,
            allowance.missing === true
              ? []
              : [
                  {
                    allowanceRevision: allowance.revision,
                    attributeDefinitionId: definitionId,
                    axisRevision: 3,
                    definitionRevision: allowance.staleDefinition === true ? 2 : 3,
                    productId: allowance.foreignProduct === true ? typeId : productId,
                    tenantId,
                    valueCount: allowance.values.length + (allowance.incomplete === true ? 1 : 0),
                  },
                ],
          );
          rows.set(
            productVariantAxisAllowedValues,
            allowance.values.map((text) => ({ valueKey: allowedValueKeyHash({ kind: 'TEXT', text }) })),
          );
        }
        const transaction = {
          select: () => ({
            from: (table: typeof products | typeof productVariantAxisAllowanceEvents) =>
              table === productVariantAxisAllowanceEvents && allowance?.unavailable === true
                ? unavailableAllowanceRows
                : selected(rows.get(table) ?? []),
          }),
        };
        // @ts-expect-error The mock provides the exercised owner read chains only.
        return catalogSelectionCurrentBasisForScope(transaction, scope).read({
          purpose: 'PURCHASE_ACCEPTANCE',
          selection: packageCurrentRevision === undefined ? selection : packageSelection,
        });
      };
      const before = yield* readAt(2);
      const after = yield* readAt(3);
      expect(before.status).toBe('OBSERVED');
      expect(after.status).toBe('OBSERVED');
      expect(before.basis.map(({ role, source }) => [role, source.revision])).toContainEqual(['PRODUCT_TYPE', 2]);
      expect(after.basis.map(({ role, source }) => [role, source.revision])).toContainEqual(['PRODUCT_TYPE', 3]);
      expect(after.basis.map(({ role, source }) => [role, source.revision])).toContainEqual(['UNIT_RULE', 2]);
      expect(
        assessCatalogSelection({
          assessedAt: after.assessedAt,
          current: after,
          purpose: 'PURCHASE_ACCEPTANCE',
          selection,
        }).status,
      ).toBe('VALID');
      const pinnedTen = yield* readAt(3, 4);
      expect(pinnedTen.status).toBe('OBSERVED');
      expect(pinnedTen.basis.map(({ role, source }) => [role, source.revision])).toContainEqual(['PACKAGE_CONTENT', 4]);
      expect(
        assessCatalogSelection({
          assessedAt: pinnedTen.assessedAt,
          current: pinnedTen,
          purpose: 'PURCHASE_ACCEPTANCE',
          selection: packageSelection,
        }).status,
      ).toBe('VALID');
      const nowEight = yield* readAt(3, 5);
      expect(nowEight.status).toBe('INVALID');
      expect(nowEight.selection.packageOption?.contentRevision.revision).toBe(4);
      expect(nowEight.basis.some(({ role }) => role === 'PACKAGE_CONTENT')).toBe(false);
      const futureContent = yield* readAt(3, 4, new Date('2999-01-01T00:00:00.000Z'));
      expect(futureContent.status).toBe('INVALID');
      expect(futureContent.basis.some(({ role }) => role === 'PACKAGE_CONTENT')).toBe(false);
      const inheritedBefore = yield* readAt(3, undefined, undefined, 1);
      const inheritedAfter = yield* readAt(3, undefined, undefined, 2);
      expect(inheritedBefore.status).toBe('INDETERMINATE');
      expect(inheritedAfter.status).toBe('INDETERMINATE');
      expect(inheritedBefore.basis.map(({ role, source }) => [role, source.revision])).toContainEqual([
        'INHERITED_VALUE',
        1,
      ]);
      expect(inheritedAfter.basis.map(({ role, source }) => [role, source.revision])).toContainEqual([
        'INHERITED_VALUE',
        2,
      ]);
      expect(inheritedAfter.basis.find(({ role }) => role === 'INHERITED_VALUE')?.source.resourceRef.resourceId).toBe(
        valueSetId,
      );
      const allowed = yield* readAt(3, undefined, undefined, 1, { revision: 1, values: ['cotton', 'wool'] });
      expect(allowed.status).toBe('OBSERVED');
      const revoked = yield* readAt(3, undefined, undefined, 1, { revision: 2, values: ['wool'] });
      expect(revoked).toMatchObject({
        reason: 'Current Variant axis value is not permitted for this Product',
        status: 'INVALID',
      });
      const empty = yield* readAt(3, undefined, undefined, 1, { revision: 3, values: [] });
      expect(empty.status).toBe('INVALID');
      const changed = yield* readAt(3, undefined, undefined, 1, { revision: 4, values: ['cotton'] });
      expect(changed.status).toBe('OBSERVED');
      expect(changed.basis.find(({ role }) => role === 'VARIANT_AXIS')).toMatchObject({
        axisAllowances: [
          { allowanceRevision: 4, attributeDefinition: { resourceRef: { resourceId: definitionId }, revision: 3 } },
        ],
        source: { resourceRef: selection.productRef, revision: 3 },
      });
      expect(allowed.basis.find(({ role }) => role === 'VARIANT')?.source).toEqual(
        revoked.basis.find(({ role }) => role === 'VARIANT')?.source,
      );
      for (const control of [
        { missing: true },
        { unavailable: true },
        { foreignProduct: true },
        { staleDefinition: true },
        { incomplete: true },
      ]) {
        const unknown = yield* readAt(3, undefined, undefined, 1, { revision: 2, values: ['wool'], ...control });
        expect(unknown).toMatchObject({
          reason: 'Current Product-specific axis allowances are unavailable or incomplete',
          status: 'INDETERMINATE',
        });
      }
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('accepts confirmed-untyped Current proof after axes were cleared at a later revision', () =>
    Effect.gen(function* confirmedUntypedAfterAxisClear() {
      const unitId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const rows = new Map<unknown, readonly object[]>([
        [products, [{ currentRevision: 4, lifecycleState: 'ACTIVE', productId, revision: 4, tenantId }]],
        [
          productVariants,
          [{ currentRevision: 7, lifecycleState: 'ACTIVE', productId, revision: 7, tenantId, variantId }],
        ],
        [productTypeAssignments, []],
        [productTypes, []],
        [productTypeRevisions, []],
        [productTypeRevisionAttributes, []],
        [productVariantAxes, []],
        [
          productVariantAxisEvents,
          [{ attributeDefinitionIds: [], attributeDefinitionRevisions: [], axisRevision: 3, productId, tenantId }],
        ],
        [
          productTypeUntypedDecisions,
          [
            {
              axisRevision: 3,
              decisionRevision: 2,
              decisionState: 'CONFIRMED',
              productId,
              productRevision: 4,
              structuredAttributesRequired: false,
              tenantId,
              valueRevisionTokens: [],
              variantAxesRequired: false,
              variantRevisionTokens: [`${variantId}:7`],
            },
          ],
        ],
        [variantUnitDivisibility, [{ currentRevision: 1, divisible: false, unitId }]],
        [packageUnitDivisibility, [{ currentRevision: 1, divisible: false, unitId }]],
        [productUnits, [{ currentRuleRevision: 2, lifecycleState: 'ACTIVE', unitId }]],
        [productUnitRuleRevisions, [{ lifecycleState: 'ACTIVE', revision: 2, rounding: 'UP', step: '1' }]],
      ]);
      const transaction = {
        select: () => ({
          from: (table: typeof products) => selected(rows.get(table) ?? []),
        }),
      };
      // @ts-expect-error The mock provides only the Current owner read chains exercised by this scenario.
      const current = yield* catalogSelectionCurrentBasisForScope(transaction, scope).read({
        purpose: 'PURCHASE_ACCEPTANCE',
        selection,
      });
      expect(current.status).toBe('OBSERVED');
      expect(current.basis).toContainEqual({
        provenance: 'CATALOG_OWNER_CONFIRMED_UNTYPED_DECISION',
        role: 'PRODUCT_TYPE_UNTYPED_DECISION',
        source: { resourceRef: selection.productRef, revision: 2 },
      });
      expect(
        assessCatalogSelection({ assessedAt: current.assessedAt, current, purpose: 'PURCHASE_ACCEPTANCE', selection })
          .status,
      ).toBe('VALID');
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('rejects a Variant owned by a different Product without membership proof', () =>
    Effect.gen(function* wrongProduct() {
      const transaction = {
        select: () => ({
          from: (table: typeof products | typeof productVariants) =>
            selected(
              table === products
                ? [{ lifecycleState: 'ACTIVE', revision: 4 }]
                : [{ lifecycleState: 'ACTIVE', productId: '66666666-6666-4666-8666-666666666666', revision: 7 }],
            ),
        }),
      };
      // @ts-expect-error Only the two exercised Drizzle read chains are mocked.
      const reader = catalogSelectionCurrentBasisForScope(transaction, scope);
      const result = yield* reader.read({ purpose: 'PURCHASE_ACCEPTANCE', selection });
      expect(result.status).toBe('INVALID');
      expect(result.basis.map(({ role }) => role)).toEqual(['PRODUCT']);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('does not promote a missing Configuration or Set revision to Current', () =>
    Effect.gen(function* missingSelectedRevision() {
      const transaction = {
        select: () => ({
          from: (table: typeof products | typeof productVariants | typeof setCompositions) => {
            if (table === products) {
              return selected([{ lifecycleState: 'ACTIVE', revision: 4 }]);
            }
            if (table === productVariants) {
              return selected([{ lifecycleState: 'ACTIVE', productId, revision: 7 }]);
            }
            return selected([]);
          },
        }),
      };
      // @ts-expect-error Only the exercised Drizzle read chains are mocked.
      const reader = catalogSelectionCurrentBasisForScope(transaction, scope);
      const definitionRef = {
        moduleId: 'commerce.catalog',
        resourceId: '77777777-7777-4777-8777-777777777777',
        resourceType: 'commerce.catalog.configuration-definition',
        tenantId,
      };
      const configuration = Schema.decodeUnknownSync(CatalogSelectionSchema)({
        ...selection,
        configuration: {
          choices: [],
          definition: { resourceRef: definitionRef, revision: 1 },
          productRef: selection.productRef,
          variantRef: selection.variantRef,
        },
      });
      const configResult = yield* reader.read({ purpose: 'PURCHASE_ACCEPTANCE', selection: configuration });
      expect(configResult.status).toBe('INDETERMINATE');
      expect(configResult.basis.map(({ role }) => role)).toEqual(['PRODUCT', 'VARIANT']);
      const setSelection = Schema.decodeUnknownSync(CatalogSelectionSchema)({
        ...selection,
        setComposition: {
          resourceRef: {
            moduleId: 'commerce.catalog',
            resourceId: '88888888-8888-4888-8888-888888888888',
            resourceType: 'commerce.catalog.set-composition',
            tenantId,
          },
          revision: 1,
        },
      });
      const setResult = yield* reader.read({ purpose: 'PURCHASE_ACCEPTANCE', selection: setSelection });
      expect(setResult.status).toBe('INDETERMINATE');
      expect(setResult.basis.map(({ role }) => role)).toEqual(['PRODUCT', 'VARIANT']);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('rejects a caller-invented Configuration or Set revision ID before emitting owner basis', () =>
    Effect.gen(function* forgedRevisionId() {
      const transaction = {
        select: () => ({
          from: (table: typeof products | typeof productVariants | typeof setCompositions) => {
            if (table === products) {
              return selected([{ lifecycleState: 'ACTIVE', revision: 4 }]);
            }
            if (table === productVariants) {
              return selected([{ lifecycleState: 'ACTIVE', productId, revision: 7 }]);
            }
            if (table === setCompositions) {
              return selected([]);
            }
            throw new Error('forged revision ID must not reach dependent read');
          },
        }),
      };
      // @ts-expect-error Only the exercised Drizzle read chains are mocked.
      const reader = catalogSelectionCurrentBasisForScope(transaction, scope);
      const forgedId = '99999999-9999-4999-8999-999999999999';
      const refs = [
        {
          configuration: {
            choices: [],
            definition: {
              resourceRef: {
                moduleId: 'commerce.catalog',
                resourceId: '77777777-7777-4777-8777-777777777777',
                resourceType: 'commerce.catalog.configuration-definition',
                tenantId,
              },
              revision: 1,
              revisionId: forgedId,
            },
            productRef: selection.productRef,
            variantRef: selection.variantRef,
          },
        },
        {
          setComposition: {
            resourceRef: {
              moduleId: 'commerce.catalog',
              resourceId: '88888888-8888-4888-8888-888888888888',
              resourceType: 'commerce.catalog.set-composition',
              tenantId,
            },
            revision: 1,
            revisionId: forgedId,
          },
        },
      ];
      for (const extra of refs) {
        const forged = Schema.decodeUnknownSync(CatalogSelectionSchema)({ ...selection, ...extra });
        const result = yield* reader.read({ purpose: 'PURCHASE_ACCEPTANCE', selection: forged });
        expect(result.status).toBe('INDETERMINATE');
        expect(result.basis.map(({ role }) => role)).toEqual(['PRODUCT', 'VARIANT']);
        expect(result.basis.some(({ source }) => source.revisionId === forgedId)).toBe(false);
      }
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('rejects a stale Set revision only after the owner resolves its Current revision', () =>
    Effect.gen(function* staleSet() {
      const compositionId = '88888888-8888-4888-8888-888888888888';
      // A Set cannot contain its own Product; otherwise owner decoding fails before the Current comparison.
      const componentProductId = '99999999-9999-4999-8999-999999999999';
      const componentVariantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab';
      const component = (componentId: string) => ({
        componentId,
        componentProductId,
        componentVariantId,
        configuration: null,
        packageContentRevision: null,
        packageDefinitionId: null,
        quantityAmount: '1',
        quantityUnitId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      });
      const transaction = {
        select: () => ({
          from: (
            table:
              | typeof products
              | typeof productVariants
              | typeof setCompositionComponents
              | typeof setCompositionRevisions
              | typeof setCompositions,
          ) => {
            if (table === products) {
              return selected([{ lifecycleState: 'ACTIVE', revision: 4 }]);
            }
            if (table === productVariants) {
              return selected([{ lifecycleState: 'ACTIVE', productId, revision: 7 }]);
            }
            if (table === setCompositionComponents) {
              return selected([
                component('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
                component('cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
              ]);
            }
            if (table === setCompositionRevisions) {
              return selected([
                {
                  changeKind: 'INITIAL',
                  effectiveFrom: new Date('1960-01-01'),
                  effectiveTo: null,
                  evidenceRefs: ['owner'],
                  lifecycleState: 'ACTIVE',
                  predecessorRevision: null,
                  productId,
                  reason: 'initial',
                  revision: 1,
                  variantId,
                },
              ]);
            }
            if (table === setCompositions) {
              return selected([{ currentRevision: 1, productId, variantId }]);
            }
            return selected([{ currentRevision: 1, productId, variantId }]);
          },
        }),
      };
      // @ts-expect-error The mock implements only the exercised owner read chains.
      const reader = catalogSelectionCurrentBasisForScope(transaction, scope);
      const result = yield* reader.read({
        purpose: 'PURCHASE_ACCEPTANCE',
        selection: Schema.decodeUnknownSync(CatalogSelectionSchema)({
          ...selection,
          setComposition: {
            resourceRef: {
              moduleId: 'commerce.catalog',
              resourceId: compositionId,
              resourceType: 'commerce.catalog.set-composition',
              tenantId,
            },
            revision: 2,
          },
        }),
      });
      expect(result).toMatchObject({
        reason: 'Selected Set Composition is not Current for this exact target',
        status: 'INVALID',
      });
      expect(result.basis.map(({ role }) => role)).toEqual(['PRODUCT', 'VARIANT']);
      const currentButNested = yield* reader.read({
        purpose: 'PURCHASE_ACCEPTANCE',
        selection: Schema.decodeUnknownSync(CatalogSelectionSchema)({
          ...selection,
          setComposition: {
            resourceRef: {
              moduleId: 'commerce.catalog',
              resourceId: compositionId,
              resourceType: 'commerce.catalog.set-composition',
              tenantId,
            },
            revision: 1,
          },
        }),
      });
      expect(currentButNested).toMatchObject({ reason: 'Set component Current proof: NESTED_SET', status: 'INVALID' });
      expect(currentButNested.basis.some(({ role }) => role === 'SET_COMPOSITION')).toBe(false);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );
});

it.effect('reassesses an unchanged Set selection against component Current facts', () =>
  Effect.gen(function* componentChanges() {
    const compositionId = '88888888-8888-4888-8888-888888888888';
    const componentProductId = '99999999-9999-4999-8999-999999999999';
    const componentVariantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab';
    const unitId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const typeId = '77777777-7777-4777-8777-777777777777';
    const typeRevisionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const packageId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const state = {
      componentLifecycle: 'ACTIVE',
      componentMissingRequired: false,
      componentTypeRevision: 2,
      componentUntyped: false,
      componentVariantLifecycle: 'ACTIVE',
      nested: false,
      ownerUnavailable: false,
      packageLifecycle: 'ACTIVE',
      quantityStep: '1',
      unitLifecycle: 'ACTIVE',
    };
    const setSelection = Schema.decodeUnknownSync(CatalogSelectionSchema)({
      ...selection,
      setComposition: {
        resourceRef: {
          moduleId: 'commerce.catalog',
          resourceId: compositionId,
          resourceType: 'commerce.catalog.set-composition',
          tenantId,
        },
        revision: 1,
      },
    });
    const component = (componentId: string, packaged: boolean) => ({
      componentId,
      componentProductId,
      componentVariantId,
      configuration: null,
      packageContentRevision: packaged ? 1 : null,
      packageDefinitionId: packaged ? packageId : null,
      quantityAmount: '2',
      quantityUnitId: unitId,
    });
    const dialect = new PgDialect();
    const componentScope = (params: readonly unknown[], previous: boolean): boolean => {
      if ([componentProductId, componentVariantId].some((id) => params.includes(id))) {
        return true;
      }
      return [productId, variantId].some((id) => params.includes(id)) ? false : previous;
    };
    let readingComponent = false;
    const transaction = {
      select: () => ({
        from: (table: BareSetTable) => ({
          where: (condition: SQL) => {
            const { params } = dialect.sqlToQuery(condition);
            readingComponent = componentScope(params, readingComponent);
            const currentProductId = readingComponent ? componentProductId : productId;
            const currentTypeRevision = readingComponent ? state.componentTypeRevision : 2;
            const typeAssignments =
              readingComponent && state.componentUntyped
                ? []
                : [{ assignmentRevision: 1, productId: currentProductId, productTypeId: typeId, tenantId }];
            if (state.ownerUnavailable && table === productVariants && readingComponent) {
              return unavailableSetRows.where();
            }
            const rows = new Map<unknown, readonly object[]>([
              [
                products,
                [
                  {
                    currentRevision: 1,
                    lifecycleState: state.componentLifecycle,
                    productId: componentProductId,
                    revision: 1,
                    tenantId,
                  },
                ],
              ],
              [
                productVariants,
                [
                  {
                    currentRevision: 1,
                    lifecycleState: state.componentVariantLifecycle,
                    productId: componentProductId,
                    revision: 1,
                    tenantId,
                    variantId: componentVariantId,
                  },
                ],
              ],
              [setCompositions, [{ compositionId, currentRevision: 1, productId, variantId }]],
              [
                setCompositionRevisions,
                [
                  {
                    changeKind: 'INITIAL',
                    effectiveFrom: new Date('1960-01-01'),
                    effectiveTo: null,
                    evidenceRefs: ['owner'],
                    lifecycleState: 'ACTIVE',
                    predecessorRevision: null,
                    productId,
                    reason: 'initial',
                    revision: 1,
                    variantId,
                  },
                ],
              ],
              [
                setCompositionComponents,
                [
                  component('cccccccc-cccc-4ccc-8ccc-cccccccccccc', false),
                  component('dddddddd-dddd-4ddd-8ddd-dddddddddddd', true),
                ],
              ],
              [productTypeAssignments, typeAssignments],
              [
                productTypes,
                [
                  {
                    currentRevision: currentTypeRevision,
                    productTypeId: typeId,
                    tenantId,
                  },
                ],
              ],
              [
                productTypeRevisions,
                [
                  {
                    effectiveAt: new Date('1960-01-01'),
                    productTypeId: typeId,
                    productTypeRevisionId: typeRevisionId,
                    revision: currentTypeRevision,
                    tenantId,
                  },
                ],
              ],
              [
                productTypeRevisionAttributes,
                readingComponent && state.componentMissingRequired
                  ? [
                      {
                        attributeDefinitionId: 'abababab-abab-4bab-8bab-abababababab',
                        level: 'PRODUCT',
                        productTypeId: typeId,
                        requirement: 'REQUIRED',
                        revision: state.componentTypeRevision,
                        tenantId,
                      },
                    ]
                  : [],
              ],
              [
                productTypeUntypedDecisions,
                [
                  {
                    axisRevision: 3,
                    decisionRevision: 9,
                    decisionState: 'CONFIRMED',
                    productId: currentProductId,
                    productRevision: 1,
                    structuredAttributesRequired: false,
                    tenantId,
                    valueRevisionTokens: [],
                    variantAxesRequired: false,
                    variantRevisionTokens: [`${componentVariantId}:1`],
                  },
                ],
              ],
              [productVariantAxes, []],
              [
                productVariantAxisEvents,
                [
                  {
                    attributeDefinitionIds: [],
                    attributeDefinitionRevisions: [],
                    axisRevision: 3,
                    productId: currentProductId,
                    tenantId,
                  },
                ],
              ],
              [variantUnitDivisibility, [{ currentRevision: 1, divisible: false, unitId }]],
              [packageUnitDivisibility, [{ currentRevision: 1, divisible: false, unitId }]],
              [productUnits, [{ currentRuleRevision: 2, lifecycleState: state.unitLifecycle, unitId }]],
              [
                productUnitRuleRevisions,
                [{ lifecycleState: 'ACTIVE', revision: 2, rounding: 'UP', step: state.quantityStep }],
              ],
              [
                packageDefinitions,
                [
                  {
                    currentOptionRevision: 1,
                    currentRevision: 1,
                    lifecycleState: state.packageLifecycle,
                    optionState: 'ACTIVE',
                    packageDefinitionId: packageId,
                    productId: componentProductId,
                    variantId: componentVariantId,
                  },
                ],
              ],
              [
                packageContentRevisions,
                [
                  {
                    amount: '1',
                    configurationKey: null,
                    effectiveAt: new Date('1960-01-01'),
                    lifecycleState: 'ACTIVE',
                    lowerCount: null,
                    lowerPackageDefinitionId: null,
                    lowerRevision: null,
                    packageDefinitionId: packageId,
                    productId: componentProductId,
                    revision: 1,
                    setCompositionResourceId: null,
                    setCompositionRevision: null,
                    unitResourceId: unitId,
                    unitResourceType: 'commerce.catalog.product-unit',
                    variantId: componentVariantId,
                  },
                ],
              ],
              [
                packageOptionRoleRevisions,
                [
                  {
                    contentRevision: 1,
                    effectiveAt: new Date('1960-01-01'),
                    independentlyRequested: true,
                    looseUnitsSubstitutable: false,
                    productId: componentProductId,
                    revision: 1,
                    state: 'ACTIVE',
                    variantId: componentVariantId,
                  },
                ],
              ],
            ]);
            if (table === products && !readingComponent) {
              rows.set(products, [{ currentRevision: 4, lifecycleState: 'ACTIVE', productId, revision: 4, tenantId }]);
            }
            if (table === productVariants && !readingComponent) {
              rows.set(productVariants, [
                { currentRevision: 7, lifecycleState: 'ACTIVE', productId, revision: 7, tenantId, variantId },
              ]);
            }
            if (table === setCompositions && readingComponent) {
              rows.set(
                setCompositions,
                state.nested
                  ? [
                      {
                        compositionId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
                        currentRevision: 1,
                        productId: componentProductId,
                        variantId: componentVariantId,
                      },
                    ]
                  : [],
              );
            }
            return selected(rows.get(table) ?? []).where();
          },
        }),
      }),
    };
    // @ts-expect-error The stateful fixture implements the exercised owner read chains only.
    const reader = catalogSelectionCurrentBasisForScope(transaction, scope);
    const assess = () => {
      readingComponent = false;
      return reader.read({ purpose: 'PURCHASE_ACCEPTANCE', selection: setSelection });
    };
    const before = yield* assess();
    expect(before.status).toBe('OBSERVED');
    expect(
      assessCatalogSelection({
        assessedAt: before.assessedAt,
        current: before,
        purpose: 'PURCHASE_ACCEPTANCE',
        selection: setSelection,
      }).status,
    ).toBe('VALID');
    const beforeComponentTypes = before.basis.filter(
      (fact) => fact.role === 'PRODUCT_TYPE' && fact.subject !== undefined,
    );
    expect(beforeComponentTypes).toHaveLength(2);
    expect(
      beforeComponentTypes.every((fact) => fact.source.revisionId === typeRevisionId && fact.source.revision === 2),
    ).toBe(true);
    state.componentTypeRevision = 3;
    const changedType = yield* assess();
    expect(changedType.status).toBe('OBSERVED');
    expect(
      changedType.basis
        .filter((fact) => fact.role === 'PRODUCT_TYPE' && fact.subject !== undefined)
        .every((fact) => fact.source.revision === 3),
    ).toBe(true);
    expect(
      changedType.basis.find((fact) => fact.role === 'PRODUCT_TYPE' && fact.subject === undefined)?.source.revision,
    ).toBe(2);
    state.componentUntyped = true;
    const untypedComponents = yield* assess();
    expect(untypedComponents.status).toBe('OBSERVED');
    expect(untypedComponents.basis.filter((fact) => fact.role === 'PRODUCT_TYPE_UNTYPED_DECISION')).toHaveLength(2);
    expect(
      untypedComponents.basis
        .filter((fact) => fact.role === 'PRODUCT_TYPE_UNTYPED_DECISION')
        .every(
          (fact) =>
            fact.provenance === 'CATALOG_OWNER_CONFIRMED_UNTYPED_DECISION' &&
            fact.source.resourceRef.resourceId === componentProductId &&
            fact.source.revision === 9 &&
            fact.subject?.composition.resourceRef.resourceId === compositionId,
        ),
    ).toBe(true);
    state.componentUntyped = false;
    state.componentMissingRequired = true;
    expect(yield* assess()).toMatchObject({
      reason: 'Set component Current proof: COMPONENT_TYPE_VALUE_AXIS_UNVERIFIABLE',
      status: 'INVALID',
    });
    state.componentMissingRequired = false;
    state.componentTypeRevision = 2;
    for (const [change, expected] of [
      ['componentLifecycle', 'Set component Current proof: CURRENT_COMPONENT_UNVERIFIABLE'],
      ['componentVariantLifecycle', 'Set component Current proof: CURRENT_COMPONENT_UNVERIFIABLE'],
      ['packageLifecycle', 'Set component Current proof: CURRENT_COMPONENT_UNVERIFIABLE'],
      ['nested', 'Set component Current proof: NESTED_SET'],
      ['quantityStep', 'Set component Current proof: COMPONENT_QUANTITY_RULE_VIOLATION'],
      ['unitLifecycle', 'Set component Current proof: CURRENT_COMPONENT_UNVERIFIABLE'],
    ] as const) {
      const previous = state[change];
      let changedValue: boolean | string = 'RETIRED';
      if (change === 'nested') {
        changedValue = true;
      } else if (change === 'quantityStep') {
        changedValue = '3';
      }
      Object.assign(state, { [change]: changedValue });
      const after = yield* assess();
      expect(after.status).toBe('INVALID');
      expect(after.basis.some(({ role }) => role === 'SET_COMPOSITION')).toBe(false);
      expect(after.status === 'OBSERVED' ? '' : after.reason).toContain(expected);
      Object.assign(state, { [change]: previous });
    }
    state.ownerUnavailable = true;
    const unavailable = yield* assess();
    expect(unavailable.status).toBe('INDETERMINATE');
    expect(unavailable.basis.some(({ role }) => role === 'SET_COMPOSITION')).toBe(false);
  }).pipe(Effect.provide(NodeCrypto.layer)),
);

it.effect('preserves real scheduled Configuration boundaries for complete untyped and typed axis-only bases', () =>
  Effect.gen(function* scheduledConfigurationBoundary() {
    const definitionId = '77777777-7777-4777-8777-777777777777';
    const unitId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const categoryId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const at = '2026-10-01T12:00:00.000Z';
    const boundary = '2026-10-02T00:00:00.000Z';
    const configured = Schema.decodeUnknownSync(CatalogSelectionSchema)({
      ...selection,
      configuration: {
        choices: [{ choiceKey: 'mount', value: 'A' }],
        definition: {
          resourceRef: {
            moduleId: 'commerce.catalog',
            resourceId: definitionId,
            resourceType: 'commerce.catalog.configuration-definition',
            tenantId,
          },
          revision: 1,
        },
        productRef: selection.productRef,
        variantRef: selection.variantRef,
      },
    });
    const activation = (revision: number, effectiveAt: string) => ({
      actingPrincipalId: scope.principalId,
      actionInvocationId: `activation-${revision}`,
      definitionId,
      effectiveAt: new Date(effectiveAt),
      evidenceRefs: ['owner:recorded-mount'],
      reason: 'Record mounting choice meaning',
      revision,
      supersededRevision: revision === 1 ? null : revision - 1,
      tenantId,
    });
    const activations = [activation(1, '2026-10-01T00:00:00.000Z'), activation(2, boundary)];
    const rows = new Map<unknown, readonly object[]>([
      [products, [{ currentRevision: 4, lifecycleState: 'ACTIVE', productId, revision: 4, tenantId }]],
      [
        productVariants,
        [{ currentRevision: 7, lifecycleState: 'ACTIVE', productId, revision: 7, tenantId, variantId }],
      ],
      [
        productVariantAxisEvents,
        [{ attributeDefinitionIds: [], attributeDefinitionRevisions: [], axisRevision: 3, productId, tenantId }],
      ],
      [
        productTypeUntypedDecisions,
        [
          {
            axisRevision: 3,
            decisionRevision: 2,
            decisionState: 'CONFIRMED',
            productId,
            productRevision: 4,
            structuredAttributesRequired: false,
            tenantId,
            valueRevisionTokens: [],
            variantAxesRequired: false,
            variantRevisionTokens: [`${variantId}:7`],
          },
        ],
      ],
      [variantUnitDivisibility, [{ currentRevision: 1, divisible: false, unitId }]],
      [productUnits, [{ currentRuleRevision: 2, lifecycleState: 'ACTIVE', unitId }]],
      [productUnitRuleRevisions, [{ lifecycleState: 'ACTIVE', revision: 2, rounding: 'UP', step: '1' }]],
      [productConfigurationDefinitions, [{ currentRevision: 2, definitionId, productId, tenantId }]],
      [productConfigurationRevisionActivations, activations],
      [
        productConfigurationDefinitionRevisions,
        activations.map(({ effectiveAt, ...item }) => ({
          ...item,
          effectiveFrom: effectiveAt,
          effectiveTo: null,
          productId,
          state: 'ACTIVE',
        })),
      ],
      [
        productConfigurationChoices,
        [
          {
            choiceKey: 'mount',
            label: 'Mount',
            meaning: 'Mounting part',
            required: true,
            unitId: null,
            unitRevision: null,
            valueKind: 'SINGLE_CHOICE',
          },
        ],
      ],
      [productConfigurationChoiceOptions, [{ choiceKey: 'mount', label: 'A', meaning: 'Mount A', optionKey: 'A' }]],
      [
        productConfigurationOptionAllowances,
        [
          {
            allowed: true,
            choiceKey: 'mount',
            evidenceRefs: ['owner:recorded-mount'],
            optionKey: 'A',
            packageDefinitionId: null,
            variantId: null,
          },
        ],
      ],
      [productCategoryHierarchyRevisions, [{ assignmentRevision: 1, hierarchyRevision: 1 }]],
      [productCategoryAssignments, [{ categoryId, productId, tenantId }]],
      [productCategories, [{ categoryId, currentRevision: 1, lifecycleState: 'ACTIVE', parentCategoryId: null }]],
    ]);
    yield* TestClock.setTime(new Date(at).getTime());
    const current = yield* readBareSet([], configured, rows, 'PRICING');
    expect(current.status).toBe('OBSERVED');
    expect(current).toMatchObject({ dependentFactsComplete: true, validUntil: boundary });
    expect(
      assessCatalogSelection({ assessedAt: current.assessedAt, current, purpose: 'PRICING', selection: configured }),
    ).toMatchObject({ status: 'VALID', validUntil: boundary });
    // Inspect the whole real returned basis, including roles the untyped branch could retain.
    expect(hasClosedScheduledConfigurationBasis(configured, current.basis)).toBe(true);
    const unsupported = [
      ['PRODUCT_TYPE', 'commerce.catalog.product-type'],
      ['ATTRIBUTE_DEFINITION', 'commerce.catalog.attribute-definition'],
      ['INHERITED_VALUE', 'commerce.catalog.attribute-value-set'],
      ['OTHER_CATALOG_FACT', 'commerce.catalog.attribute-value-set'],
      ['VARIANT_AXIS', 'commerce.catalog.product'],
      ['UNIT', 'commerce.catalog.unit'],
      ['UNIT_CONVERSION', 'commerce.catalog.unit'],
      ['PACKAGE_CONTENT', 'commerce.catalog.package-definition'],
      ['PACKAGE_OPTION_ROLE', 'commerce.catalog.package-definition'],
      ['SET_COMPOSITION', 'commerce.catalog.set-composition'],
    ];
    for (const [role, resourceType] of unsupported) {
      const extra = Schema.decodeUnknownSync(CatalogSelectionBasisSchema)({
        role,
        source: {
          resourceRef: { moduleId: 'commerce.catalog', resourceId: unitId, resourceType, tenantId },
          revision: 1,
        },
      });
      expect(hasClosedScheduledConfigurationBasis(configured, [...current.basis, extra])).toBe(false);
    }
    for (const fact of current.basis) {
      // Every admitted role still checks its foreign owner and tenant, not just its name.
      for (const resourceRef of [
        { ...fact.source.resourceRef, moduleId: 'foreign.owner' },
        { ...fact.source.resourceRef, tenantId: '99999999-9999-4999-8999-999999999999' },
      ]) {
        const foreign = Schema.decodeUnknownOption(CatalogSelectionBasisSchema)({
          ...fact,
          source: { ...fact.source, resourceRef },
        });
        if (Option.isSome(foreign)) {
          expect(
            hasClosedScheduledConfigurationBasis(
              configured,
              current.basis.map((entry) => (entry === fact ? foreign.value : entry)),
            ),
          ).toBe(false);
        } else {
          expect(resourceRef.moduleId).toBe('foreign.owner');
        }
      }
      expect(
        hasClosedScheduledConfigurationBasis(
          configured,
          current.basis.filter((entry) => entry !== fact),
        ),
      ).toBe(fact.role === 'CATEGORY');
      if (fact.role !== 'CATEGORY') {
        expect(hasClosedScheduledConfigurationBasis(configured, [...current.basis, fact])).toBe(false);
      }
    }
    const component = Schema.decodeUnknownSync(CatalogSelectionBasisSchema)({
      ...current.basis[0],
      subject: {
        componentId: unitId,
        composition: {
          resourceRef: {
            moduleId: 'commerce.catalog',
            resourceId: unitId,
            resourceType: 'commerce.catalog.set-composition',
            tenantId,
          },
          revision: 1,
        },
        kind: 'SET_COMPONENT',
      },
    });
    expect(hasClosedScheduledConfigurationBasis(configured, [...current.basis, component])).toBe(false);
    expect(
      Option.isNone(
        Schema.decodeUnknownOption(CatalogSelectionBasisSchema)({
          role: 'FUTURE_UNSUPPORTED_ROLE',
          source: { resourceRef: selection.productRef, revision: 1 },
        }),
      ),
    ).toBe(true);
    const omittedRequired = yield* readBareSet([], selection, rows, 'PRICING');
    expect(omittedRequired.status).toBe('INVALID');
    expect('validUntil' in omittedRequired).toBe(false);
    rows.set(productConfigurationDefinitions, []);
    const direct = yield* readBareSet([], selection, rows, 'PRICING');
    expect(direct.status).toBe('OBSERVED');
    expect('validUntil' in direct).toBe(false);
    // A later append cannot shorten R1's already recorded R2 end.
    const third = activation(3, '2026-10-03T00:00:00.000Z');
    rows.set(productConfigurationDefinitions, [{ currentRevision: 3, definitionId, productId, tenantId }]);
    rows.set(productConfigurationRevisionActivations, [...activations, third]);
    rows.set(
      productConfigurationDefinitionRevisions,
      [...activations, third].map(({ effectiveAt, ...item }) => ({
        ...item,
        effectiveFrom: effectiveAt,
        effectiveTo: null,
        productId,
        state: 'ACTIVE',
      })),
    );
    expect(yield* readBareSet([], configured, rows, 'PRICING')).toMatchObject({
      status: 'OBSERVED',
      validUntil: boundary,
    });
    // Incomplete deciding Category remains an observation, without a finite claim.
    rows.set(productCategoryAssignments, []);
    const incomplete = yield* readBareSet([], configured, rows, 'PRICING');
    expect(incomplete).toMatchObject({ dependentFactsComplete: false, status: 'OBSERVED' });
    expect('validUntil' in incomplete).toBe(false);
    rows.set(productCategoryAssignments, [{ categoryId, productId, tenantId }]);
    yield* TestClock.setTime(new Date(boundary).getTime());
    expect(yield* readBareSet([], configured, rows, 'PRICING')).toMatchObject({ status: 'INVALID' });
    const r2 = Schema.decodeUnknownSync(CatalogSelectionSchema)({
      ...configured,
      configuration: {
        ...configured.configuration,
        definition: { ...configured.configuration?.definition, revision: 2 },
      },
    });
    expect(yield* readBareSet([], r2, rows, 'PRICING')).toMatchObject({
      status: 'OBSERVED',
      validUntil: '2026-10-03T00:00:00.000Z',
    });
    yield* TestClock.setTime(new Date(at).getTime());
    rows.set(productConfigurationDefinitions, [{ currentRevision: 1, definitionId, productId, tenantId }]);
    rows.set(productConfigurationRevisionActivations, activations.slice(0, 1));
    rows.set(
      productConfigurationDefinitionRevisions,
      activations.slice(0, 1).map(({ effectiveAt, ...item }) => ({
        ...item,
        effectiveFrom: effectiveAt,
        effectiveTo: null,
        productId,
        state: 'ACTIVE',
      })),
    );
    const unbounded = yield* readBareSet([], configured, rows, 'PRICING');
    expect(unbounded.status).toBe('OBSERVED');
    expect('validUntil' in unbounded).toBe(false);

    // The native owner closure proves this selected Variant's one local value and complete axis allowance.
    const typeId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const typeRevisionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const attributeId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const valueSetId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const definitionRules = {
      allowsNone: 0,
      allowsNotApplicable: 0,
      allowsUnknown: 0,
      applicableLevels: ['PRODUCT', 'VARIANT'],
      canonicalUnit: null,
      controlledValueKind: null,
      decimalPlaces: null,
      maximumValue: null,
      meaning: 'Finish',
      measuredQuantity: null,
      minimumValue: null,
      multiplicity: 'SINGLE',
      name: 'Finish',
      valueKind: 'TEXT',
    };
    rows.set(productTypeUntypedDecisions, []);
    rows.set(productTypeAssignments, [{ assignmentRevision: 1, productId, productTypeId: typeId, tenantId }]);
    rows.set(productTypes, [{ currentRevision: 2, productTypeId: typeId, tenantId }]);
    rows.set(productTypeRevisions, [
      {
        effectiveAt: new Date('2026-09-01T00:00:00.000Z'),
        productTypeId: typeId,
        productTypeRevisionId: typeRevisionId,
        revision: 2,
        tenantId,
      },
    ]);
    rows.set(productTypeRevisionAttributes, [
      {
        attributeDefinitionId: attributeId,
        level: 'VARIANT',
        productTypeId: typeId,
        requirement: 'OPTIONAL',
        revision: 2,
        tenantId,
      },
    ]);
    rows.set(productVariantAxes, [
      { attributeDefinitionId: attributeId, axisRevision: 3, definitionRevision: 3, ordinal: 0, productId, tenantId },
    ]);
    rows.set(productVariantAxisEvents, [
      {
        attributeDefinitionIds: [attributeId],
        attributeDefinitionRevisions: [3],
        axisRevision: 3,
        productId,
        tenantId,
      },
    ]);
    rows.set(attributeDefinitions, [
      { ...definitionRules, attributeDefinitionId: attributeId, currentRevision: 3, tenantId },
    ]);
    rows.set(attributeDefinitionRevisions, [
      { ...definitionRules, attributeDefinitionId: attributeId, revision: 3, tenantId },
    ]);
    rows.set(attributeValueSets, [
      {
        attributeDefinitionId: attributeId,
        attributeValueSetId: valueSetId,
        currentRevision: 1,
        currentState: 'SET',
        productId,
        tenantId,
        variantId,
      },
    ]);
    rows.set(attributeValueRevisions, [
      {
        attributeValueSetId: valueSetId,
        changeKind: 'SET',
        revision: 1,
        tenantId,
        valueSnapshot: {
          attributeDefinitionRevision: 3,
          productTypeId: typeId,
          productTypeRevision: 2,
          sourceProductValueRevision: null,
          values: [{ kind: 'TEXT', text: 'matte' }],
        },
      },
    ]);
    rows.set(attributeValueItems, [
      {
        attributeDefinitionId: attributeId,
        attributeValueSetId: valueSetId,
        ordinal: 0,
        tenantId,
        textValue: 'matte',
        valueKind: 'TEXT',
      },
    ]);
    rows.set(productAttributeApplicability, [
      {
        attributeDefinitionId: attributeId,
        currentRevision: 1,
        productId,
        productLevel: false,
        tenantId,
        variantLevel: true,
      },
    ]);
    rows.set(productAttributeApplicabilityRevisions, [
      { attributeDefinitionId: attributeId, productId, productLevel: false, revision: 1, tenantId, variantLevel: true },
    ]);
    const allowance = {
      allowanceRevision: 4,
      attributeDefinitionId: attributeId,
      axisRevision: 3,
      definitionRevision: 3,
      productId,
      tenantId,
      valueCount: 1,
    };
    rows.set(productVariantAxisAllowanceEvents, [allowance]);
    rows.set(productVariantAxisAllowedValues, [{ valueKey: allowedValueKeyHash({ kind: 'TEXT', text: 'matte' }) }]);
    rows.set(productConfigurationDefinitions, [{ currentRevision: 2, definitionId, productId, tenantId }]);
    rows.set(productConfigurationRevisionActivations, activations);
    rows.set(
      productConfigurationDefinitionRevisions,
      activations.map(({ effectiveAt, ...item }) => ({
        ...item,
        effectiveFrom: effectiveAt,
        effectiveTo: null,
        productId,
        state: 'ACTIVE',
      })),
    );
    const typed = yield* readBareSet([], configured, rows, 'PRICING');
    expect(typed).toMatchObject({ dependentFactsComplete: true, status: 'OBSERVED', validUntil: boundary });
    expect(hasClosedScheduledConfigurationBasis(configured, typed.basis)).toBe(true);
    expect(typed.basis.filter(({ role }) => role === 'OTHER_CATALOG_FACT')).toHaveLength(1);
    expect(
      assessCatalogSelection({
        assessedAt: typed.assessedAt,
        current: typed,
        purpose: 'PRICING',
        selection: configured,
      }),
    ).toMatchObject({ status: 'VALID', validUntil: boundary });

    for (const fact of typed.basis) {
      expect(
        hasClosedScheduledConfigurationBasis(
          configured,
          typed.basis.filter((item) => item !== fact),
        ),
      ).toBe(fact.role === 'CATEGORY');
      expect(hasClosedScheduledConfigurationBasis(configured, [...typed.basis, fact])).toBe(false);
      for (const resourceRef of [
        { ...fact.source.resourceRef, tenantId: '99999999-9999-4999-8999-999999999999' },
        { ...fact.source.resourceRef, moduleId: 'foreign.owner' },
      ]) {
        const changed = Schema.decodeUnknownOption(CatalogSelectionBasisSchema)({
          ...fact,
          source: { ...fact.source, resourceRef },
        });
        if (Option.isSome(changed)) {
          expect(
            hasClosedScheduledConfigurationBasis(
              configured,
              typed.basis.map((item) => (item === fact ? changed.value : item)),
            ),
          ).toBe(false);
        }
      }
    }
    const untypedDecision = current.basis.find(({ role }) => role === 'PRODUCT_TYPE_UNTYPED_DECISION');
    expect(
      hasClosedScheduledConfigurationBasis(configured, [
        ...typed.basis,
        ...(untypedDecision === undefined ? [] : [untypedDecision]),
      ]),
    ).toBe(false);
    for (const [role, resourceType] of [
      ['UNIT', 'commerce.catalog.unit'],
      ['PACKAGE_CONTENT', 'commerce.catalog.package-definition'],
      ['SET_COMPOSITION', 'commerce.catalog.set-composition'],
    ]) {
      const extra = Schema.decodeUnknownSync(CatalogSelectionBasisSchema)({
        role,
        source: {
          resourceRef: {
            moduleId: 'commerce.catalog',
            resourceId: unitId,
            resourceType,
            tenantId,
          },
          revision: 1,
        },
      });
      expect(hasClosedScheduledConfigurationBasis(configured, [...typed.basis, extra])).toBe(false);
    }
    const axis = typed.basis.find(({ role }) => role === 'VARIANT_AXIS');
    for (const axisAllowances of [
      undefined,
      [],
      [
        {
          allowanceRevision: 4,
          attributeDefinition: {
            resourceRef: {
              moduleId: 'commerce.catalog',
              resourceId: attributeId,
              resourceType: 'commerce.catalog.attribute-definition',
              tenantId,
            },
            revision: 2,
          },
        },
      ],
    ]) {
      const changed = Schema.decodeUnknownSync(CatalogSelectionBasisSchema)(
        axisAllowances === undefined ? { role: axis?.role, source: axis?.source } : { ...axis, axisAllowances },
      );
      expect(
        hasClosedScheduledConfigurationBasis(
          configured,
          typed.basis.map((fact) => (fact === axis ? changed : fact)),
        ),
      ).toBe(false);
    }
    const withoutTypeRevisionId = typed.basis.map((fact) =>
      fact.role === 'PRODUCT_TYPE'
        ? Schema.decodeUnknownSync(CatalogSelectionBasisSchema)({
            ...fact,
            source: { resourceRef: fact.source.resourceRef, revision: fact.source.revision },
          })
        : fact,
    );
    expect(hasClosedScheduledConfigurationBasis(configured, withoutTypeRevisionId)).toBe(false);
    expect(hasClosedScheduledConfigurationBasis(configured, [...typed.basis, component])).toBe(false);

    for (const invalidAllowance of [
      [],
      [{ ...allowance, productId: typeId }],
      [{ ...allowance, valueCount: 2 }],
      [{ ...allowance, definitionRevision: 2 }],
    ]) {
      rows.set(productVariantAxisAllowanceEvents, invalidAllowance);
      const invalid = yield* readBareSet([], configured, rows, 'PRICING');
      expect(invalid.status).toBe('INDETERMINATE');
      expect('validUntil' in invalid).toBe(false);
    }
    rows.set(productVariantAxisAllowanceEvents, [allowance]);
    rows.set(productVariantAxisAllowedValues, [{ valueKey: allowedValueKeyHash({ kind: 'TEXT', text: 'gloss' }) }]);
    const restricted = yield* readBareSet([], configured, rows, 'PRICING');
    expect(restricted.status).toBe('INVALID');
    expect('validUntil' in restricted).toBe(false);
    rows.set(productVariantAxisAllowedValues, [{ valueKey: allowedValueKeyHash({ kind: 'TEXT', text: 'matte' }) }]);
    rows.set(productVariantAxisAllowanceEvents, [{ ...allowance, allowanceRevision: 5 }]);
    const sourceChanged = yield* readBareSet([], configured, rows, 'PRICING');
    expect(sourceChanged).toMatchObject({ status: 'OBSERVED', validUntil: boundary });
    expect(sourceChanged.basis).not.toEqual(typed.basis);
    expect(
      sourceChanged.basis.find(({ role }) => role === 'VARIANT_AXIS')?.axisAllowances?.[0]?.allowanceRevision,
    ).toBe(5);
  }).pipe(Effect.provide(NodeCrypto.layer)),
);
