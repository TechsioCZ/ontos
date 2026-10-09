import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { CatalogSelectionSchema } from '../../shared/domain/catalog-selection-evidence.ts';
import { assessCatalogSelection } from '../../shared/domain/catalog-selection-assessment.ts';
import {
  attributeDefinitionRevisions,
  attributeDefinitions,
  attributeValueItems,
  attributeValueRevisions,
  attributeValueSets,
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
  productVariantAxes,
  productVariantAxisEvents,
  setCompositionComponents,
  setCompositionRevisions,
  setCompositions,
  variantUnitDivisibility,
} from '../../src/database/schema.ts';
import { catalogSelectionCurrentBasisForScope } from '../../src/persistence/catalog-selection-current-basis.ts';

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
type BareSetTable = typeof products | typeof productVariants | typeof setCompositions;
const unavailableSetRows = { where: () => ({ limit: () => Effect.fail(new Error('Set owner unavailable')) }) };
const readBareSet = (setRows: readonly object[] | null) => {
  const transaction = {
    select: () => ({
      from: (table: BareSetTable) => {
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
  return catalogSelectionCurrentBasisForScope(transaction, scope).read({ purpose: 'PURCHASE_ACCEPTANCE', selection });
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
    }),
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
    }),
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
    }),
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
    }),
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
    }),
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
        const transaction = {
          select: () => ({
            from: (table: typeof products) => selected(rows.get(table) ?? []),
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
    }),
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
    }),
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
    }),
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
    }),
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
    }),
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
    }),
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
    const readCounts = new Map<unknown, number>();
    const transaction = {
      select: () => ({
        from: (table: BareSetTable) => {
          const count = readCounts.get(table) ?? 0;
          readCounts.set(table, count + 1);
          if (state.ownerUnavailable && table === productVariants && count > 0) {
            return unavailableSetRows;
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
            [productTypeAssignments, [{ assignmentRevision: 1, productId, productTypeId: typeId, tenantId }]],
            [productTypes, [{ currentRevision: 2, productTypeId: typeId, tenantId }]],
            [
              productTypeRevisions,
              [
                {
                  effectiveAt: new Date('1960-01-01'),
                  productTypeId: typeId,
                  productTypeRevisionId: typeRevisionId,
                  revision: 2,
                  tenantId,
                },
              ],
            ],
            [productTypeRevisionAttributes, []],
            [productVariantAxes, []],
            [
              productVariantAxisEvents,
              [
                {
                  attributeDefinitionIds: [],
                  attributeDefinitionRevisions: [],
                  axisRevision: 3,
                  productId,
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
          if (table === products && (count === 0 || count >= 5)) {
            rows.set(products, [{ currentRevision: 4, lifecycleState: 'ACTIVE', productId, revision: 4, tenantId }]);
          }
          if (table === productVariants && (count === 0 || count >= 5)) {
            rows.set(productVariants, [
              { currentRevision: 7, lifecycleState: 'ACTIVE', productId, revision: 7, tenantId, variantId },
            ]);
          }
          if (table === setCompositions && count > 1 && count < 4) {
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
          return selected(rows.get(table) ?? []);
        },
      }),
    };
    // @ts-expect-error The stateful fixture implements the exercised owner read chains only.
    const reader = catalogSelectionCurrentBasisForScope(transaction, scope);
    const assess = () => {
      readCounts.clear();
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
  }),
);
