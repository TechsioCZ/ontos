import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { DateTime, Effect, Exit, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  attributeDefinitions,
  attributeDefinitionRevisions,
  attributeValueItems,
  attributeValueRevisions,
  attributeValueSets,
  productTypeAssignments,
  productTypeUntypedDecisions,
  productTypeRevisions,
  productTypes,
  productVariantAxes,
  productVariantAxisEvents,
  productVariants,
  products,
} from '../../src/database/schema.ts';
import type { productTypeRevisionAttributes } from '../../src/database/schema.ts';
import {
  ProductTypeCurrentBasisSchema,
  ProductTypeCurrentRulesRevisionSchema,
} from '../../shared/domain/product-type-rules.ts';
import { evaluateCurrentProductTypeReadiness } from '../../src/persistence/product-type-readiness-evaluator.ts';
import { productTypeReadinessSourceForScope } from '../../src/persistence/product-type-readiness-source.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const productId = '22222222-2222-4222-8222-222222222222';
const typeId = '33333333-3333-4333-8333-333333333333';
const definitionId = '44444444-4444-4444-8444-444444444444';
const revisionId = '55555555-5555-4555-8555-555555555555';
const at = DateTime.makeUnsafe('2026-09-17T12:00:00.000Z');
const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: productId,
  resourceType: 'commerce.catalog.product',
  tenantId,
} as const;
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:product-type-source-test:run:1',
    authMethod: 'system',
    principalId: '66666666-6666-4666-8666-666666666666',
    tenantId,
  }),
  correlationId: 'product-type-source-test',
};
type Table =
  | typeof attributeDefinitions
  | typeof attributeDefinitionRevisions
  | typeof attributeValueItems
  | typeof attributeValueRevisions
  | typeof products
  | typeof productTypeAssignments
  | typeof productTypeUntypedDecisions
  | typeof productTypes
  | typeof productTypeRevisions
  | typeof productTypeRevisionAttributes
  | typeof attributeValueSets
  | typeof productVariantAxes
  | typeof productVariantAxisEvents
  | typeof productVariants;
interface Rows {
  readonly assigned?: boolean;
  readonly decisionState?: 'CONFIRMED' | 'REVOKED';
  readonly foreignRule?: boolean;
  readonly malformedValueSet?: boolean;
  readonly optionalRule?: boolean;
  readonly revision?: number;
  readonly specialState?: 'UNKNOWN' | 'NONE' | 'NOT_APPLICABLE';
  readonly staleDecision?: boolean;
}
const decisionRows = (options: Rows) =>
  options.decisionState === undefined
    ? []
    : [
        {
          axisRevision: 0,
          decisionRevision: 2,
          decisionState: options.decisionState,
          productId,
          productRevision: options.staleDecision === true ? 2 : 1,
          structuredAttributesRequired: false,
          tenantId,
          valueRevisionTokens: [],
          variantAxesRequired: false,
          variantRevisionTokens: [],
        },
      ];
const assignmentRows = (options: Rows) =>
  options.assigned === false ? [] : [{ assignmentRevision: 3, productId, productTypeId: typeId, tenantId }];
const revisionRows = (options: Rows) =>
  options.revision === 3
    ? []
    : [
        {
          effectiveAt: new Date('2026-09-16T00:00:00.000Z'),
          productTypeId: typeId,
          productTypeRevisionId: revisionId,
          revision: 2,
          tenantId,
        },
      ];
const rowsFor = (table: Table, options: Rows) => {
  if (table === attributeDefinitions || table === attributeDefinitionRevisions) {
    return [
      {
        allowsNone: 1,
        allowsNotApplicable: 1,
        allowsUnknown: 1,
        applicableLevels: ['PRODUCT'],
        canonicalUnit: null,
        controlledValueKind: null,
        currentRevision: 2,
        decimalPlaces: null,
        maximumValue: null,
        meaning: 'Product material',
        measuredQuantity: null,
        minimumValue: null,
        multiplicity: 'SINGLE',
        name: 'Material',
        valueKind: 'TEXT',
      },
    ];
  }
  if (table === attributeValueRevisions) {
    return [
      {
        attributeValueSetId: '88888888-8888-4888-8888-888888888888',
        changeKind: 'SET',
        revision: 1,
        tenantId,
        valueSnapshot: {
          attributeDefinitionRevision: 2,
          productTypeId: typeId,
          productTypeRevision: 2,
          sourceProductValueRevision: null,
          values: [{ kind: 'SPECIAL', state: options.specialState }],
        },
      },
    ];
  }
  if (table === attributeValueItems) {
    return [
      {
        attributeDefinitionId: definitionId,
        attributeValueSetId: '88888888-8888-4888-8888-888888888888',
        ordinal: 0,
        specialState: options.specialState,
        tenantId,
        valueKind: 'SPECIAL',
      },
    ];
  }
  if (table === attributeValueSets) {
    return options.malformedValueSet === true || options.specialState !== undefined
      ? [
          {
            attributeDefinitionId: definitionId,
            attributeValueSetId: '88888888-8888-4888-8888-888888888888',
            currentRevision: 1,
            currentState: 'SET',
            productId,
            tenantId,
            variantId: null,
          },
        ]
      : [];
  }
  if (table === productVariantAxes || table === productVariants) {
    return [];
  }
  if (table === productVariantAxisEvents) {
    return [];
  }
  if (table === productTypeUntypedDecisions) {
    return decisionRows(options);
  }
  if (table === products) {
    return [{ currentRevision: 1, productId, tenantId }];
  }
  if (table === productTypeAssignments) {
    return assignmentRows(options);
  }
  if (table === productTypes) {
    return [{ currentRevision: options.revision ?? 2, productTypeId: typeId, tenantId }];
  }
  if (table === productTypeRevisions) {
    return revisionRows(options);
  }
  return [
    {
      attributeDefinitionId: definitionId,
      level: 'PRODUCT',
      productTypeId: typeId,
      requirement: options.optionalRule === true ? 'OPTIONAL' : 'REQUIRED',
      revision: 2,
      tenantId: options.foreignRule === true ? '77777777-7777-4777-8777-777777777777' : tenantId,
    },
  ];
};
const selected = (rows: readonly object[]) => ({
  where: () => {
    const result = Effect.succeed(rows);
    return Object.assign(result, { for: () => result, limit: () => result, orderBy: () => result });
  },
});
const transaction = (options: Rows = {}) => ({
  select: () => ({
    from: (table: Table) => selected(rowsFor(table, options)),
  }),
});

describe('Product Type Current readiness source', () => {
  for (const specialState of ['UNKNOWN', 'NONE', 'NOT_APPLICABLE'] as const) {
    it.effect(`does not satisfy a required Product fact with allowed ${specialState}`, () =>
      Effect.gen(function* requiredSpecial() {
        // @ts-expect-error Mock supplies only the selected Drizzle query chain.
        const source = productTypeReadinessSourceForScope(transaction({ specialState }), scope);
        const result = yield* source.evaluate(productRef, at);
        expect(result).toMatchObject({
          rules: { minimumSatisfied: false, violations: [{ kind: 'INVALID' }, { kind: 'MISSING_REQUIRED' }] },
          status: 'INVALID',
        });
      }),
    );
    it.effect(`keeps allowed ${specialState} valid when Product fact is optional`, () =>
      Effect.gen(function* optionalSpecial() {
        // @ts-expect-error Mock supplies only the selected Drizzle query chain.
        const source = productTypeReadinessSourceForScope(transaction({ optionalRule: true, specialState }), scope);
        const result = yield* source.evaluate(productRef, at);
        expect(result).toMatchObject({
          rules: { minimumSatisfied: true, violations: [] },
          status: 'VERIFIED_TYPE_MINIMUM',
        });
      }),
    );
  }
  it('keeps an allowed special Variant value without treating it as a confirmed required fact', () => {
    const variantRef = {
      moduleId: 'commerce.catalog',
      resourceId: '99999999-9999-4999-8999-999999999999',
      resourceType: 'commerce.catalog.variant',
      tenantId,
    } as const;
    const productTypeRef = {
      moduleId: 'commerce.catalog',
      resourceId: typeId,
      resourceType: 'commerce.catalog.product-type',
      tenantId,
    } as const;
    const attributeDefinitionRef = {
      moduleId: 'commerce.catalog',
      resourceId: definitionId,
      resourceType: 'commerce.catalog.attribute-definition',
      tenantId,
    } as const;
    const rulesRevision = Schema.decodeUnknownSync(ProductTypeCurrentRulesRevisionSchema)({
      effectiveFrom: '2026-09-16T00:00:00.000Z',
      productTypeRef,
      revision: 2,
      revisionId,
      rules: [{ attributeDefinitionRef, level: 'VARIANT', required: true }],
    });
    const basis = Schema.decodeUnknownSync(ProductTypeCurrentBasisSchema)({
      currentRevision: 2,
      effectiveFrom: rulesRevision.effectiveFrom,
      evaluatedAt: '2026-09-17T00:00:00.000Z',
      productTypeRef,
      revision: 2,
      revisionId,
    });
    const snapshot = {
      productValues: [],
      productValueSource: { complete: true, revisionTokens: [] },
      source: { assignmentRevision: 3, basis, productRef, rulesRevision, status: 'VERIFIED' },
      variantRefs: [variantRef],
      variants: [
        {
          currentAttributeDefinitionIds: [definitionId],
          currentValueSource: { complete: true, revisionTokens: ['value:1'] },
          effectiveValues: [
            {
              attributeDefinitionId: definitionId,
              result: { status: 'CURRENT', values: [{ kind: 'SPECIAL', state: 'UNKNOWN' }], variantRevision: 1 },
            },
          ],
          variantRef,
        },
      ],
    } as const;
    expect(evaluateCurrentProductTypeReadiness(snapshot)).toMatchObject({
      rules: { minimumSatisfied: false, violations: [{ kind: 'MISSING_REQUIRED', variantId: variantRef.resourceId }] },
      status: 'INVALID',
    });
    expect(
      evaluateCurrentProductTypeReadiness({
        ...snapshot,
        source: {
          ...snapshot.source,
          rulesRevision: { ...rulesRevision, rules: [{ attributeDefinitionRef, level: 'VARIANT', required: false }] },
        },
      }),
    ).toMatchObject({ rules: { minimumSatisfied: true, violations: [] }, status: 'VERIFIED_TYPE_MINIMUM' });
  });
  it.effect('fails closed when a recorded Current value set has no owner-verifiable revision', () =>
    Effect.gen(function* malformedValueSet() {
      // @ts-expect-error Mock supplies only the selected Drizzle query chain.
      const source = productTypeReadinessSourceForScope(transaction({ malformedValueSet: true }), scope);
      const result = yield* source.evaluate(productRef, at);
      expect(result).toMatchObject({ status: 'INDETERMINATE' });
    }),
  );
  it.effect('reads owner-held empty value and Variant inventories before evaluating a typed minimum', () =>
    Effect.gen(function* evaluate() {
      // @ts-expect-error Mock supplies only the selected Drizzle query chain.
      const source = productTypeReadinessSourceForScope(transaction(), scope);
      const result = yield* source.evaluate(productRef, at);
      expect(result).toMatchObject({ rules: { minimumSatisfied: false }, status: 'INVALID' });
    }),
  );

  it.effect('keeps an untyped empty inventory partial, not a Catalog-ready claim', () =>
    Effect.gen(function* evaluateUntyped() {
      // @ts-expect-error Mock supplies only the selected Drizzle query chain.
      const source = productTypeReadinessSourceForScope(transaction({ assigned: false }), scope);
      const result = yield* source.evaluate(productRef, at);
      expect(result).toMatchObject({ status: 'UNTYPED_PARTIAL' });
    }),
  );
  it.effect('attests only a matching latest confirmed unnecessary decision', () =>
    Effect.gen(function* confirmedUntyped() {
      const source = productTypeReadinessSourceForScope(
        // @ts-expect-error Mock supplies only the selected Drizzle query chain.
        transaction({ assigned: false, decisionState: 'CONFIRMED' }),
        scope,
      );
      expect(yield* source.evaluate(productRef, at)).toMatchObject({
        decisionRevision: 2,
        status: 'CONFIRMED_UNTYPED_MINIMUM',
      });
    }),
  );
  it.effect('fails closed on decision revocation or Product revision drift', () =>
    Effect.gen(function* staleUntyped() {
      const revoked = productTypeReadinessSourceForScope(
        // @ts-expect-error Mock supplies only the selected Drizzle query chain.
        transaction({ assigned: false, decisionState: 'REVOKED' }),
        scope,
      );
      expect(yield* revoked.evaluate(productRef, at)).toMatchObject({ status: 'UNTYPED_PARTIAL' });
      const stale = productTypeReadinessSourceForScope(
        // @ts-expect-error Mock supplies only the selected Drizzle query chain.
        transaction({ assigned: false, decisionState: 'CONFIRMED', staleDecision: true }),
        scope,
      );
      expect(yield* stale.evaluate(productRef, at)).toMatchObject({ status: 'INDETERMINATE' });
    }),
  );
  it.effect('returns UNTYPED without fabricating rules', () =>
    Effect.gen(function* untyped() {
      // @ts-expect-error Mock supplies only the selected Drizzle query chain.
      const source = productTypeReadinessSourceForScope(transaction({ assigned: false }), scope);
      expect(yield* source.load(productRef, at)).toEqual({ productRef, status: 'UNTYPED' });
    }),
  );

  it.effect('returns the exact Current revision, required rule, and assignment revision', () =>
    Effect.gen(function* verified() {
      // @ts-expect-error Mock supplies only the selected Drizzle query chain.
      const source = productTypeReadinessSourceForScope(transaction(), scope);
      const result = yield* source.load(productRef, at);
      expect(result.status).toBe('VERIFIED');
      if (result.status === 'VERIFIED') {
        expect(result.assignmentRevision).toBe(3);
        expect(result.basis.revisionId).toBe(revisionId);
        expect(result.rulesRevision.rules).toMatchObject([
          { attributeDefinitionRef: { resourceId: definitionId }, level: 'PRODUCT', required: true },
        ]);
      }
    }),
  );

  it.effect('fails closed when the Current revision pointer has no matching revision', () =>
    Effect.gen(function* stale() {
      // @ts-expect-error Mock supplies only the selected Drizzle query chain.
      const source = productTypeReadinessSourceForScope(transaction({ revision: 3 }), scope);
      const result = yield* Effect.exit(source.load(productRef, at));
      expect(Exit.isFailure(result)).toBe(true);
    }),
  );

  it.effect('rejects a rule row outside the exact Tenant revision', () =>
    Effect.gen(function* foreignRule() {
      // @ts-expect-error Mock supplies only the selected Drizzle query chain.
      const source = productTypeReadinessSourceForScope(transaction({ foreignRule: true }), scope);
      const result = yield* Effect.exit(source.load(productRef, at));
      expect(Exit.isFailure(result)).toBe(true);
    }),
  );
});
