import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { PgDialect } from 'drizzle-orm/pg-core';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import type { attributeValueSets } from '../../src/database/schema.ts';
import {
  attributeDefinitions,
  attributeDefinitionRevisions,
  attributeValueItems,
  attributeValueRevisions,
  productTypeAssignments,
  productTypeUntypedDecisions,
  productVariantAxes,
  productVariantAxisEvents,
  productVariants,
  products,
} from '../../src/database/schema.ts';
import { productTypeUntypedDecisionPersistenceForScope } from '../../src/persistence/product-type-untyped-decision-persistence.ts';
import { DecideProductTypeUnnecessaryPayloadSchema } from '../../shared/actions/decide-product-type-unnecessary.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const productId = '22222222-2222-4222-8222-222222222222';
const variantId = '55555555-5555-4555-8555-555555555555';
const definitionId = '66666666-6666-4666-8666-666666666666';
const setId = '77777777-7777-4777-8777-777777777777';
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:untyped-decision-test:run:1',
    authMethod: 'system',
    principalId: '33333333-3333-4333-8333-333333333333',
    tenantId,
  }),
  correlationId: 'untyped-decision-test',
};
const basePayload = {
  decisionState: 'CONFIRMED',
  evidenceRefs: ['catalog-review:123'],
  expectedAxisRevision: 0,
  expectedDecisionRevision: 0,
  expectedProductRevision: 1,
  expectedValueRevisionTokens: [],
  expectedVariantRevisionTokens: [],
  productRef: {
    moduleId: 'commerce.catalog',
    resourceId: productId,
    resourceType: 'commerce.catalog.product',
    tenantId,
  },
  reason: 'No structured facts or axes needed',
  structuredAttributesRequired: false,
  variantAxesRequired: false,
};
type Payload = typeof DecideProductTypeUnnecessaryPayloadSchema.Type;
const payload = (overrides: Partial<Payload> = {}): Payload =>
  Schema.decodeUnknownSync(DecideProductTypeUnnecessaryPayloadSchema)({ ...basePayload, ...overrides });

type Table =
  | typeof products
  | typeof productTypeAssignments
  | typeof productTypeUntypedDecisions
  | typeof productVariantAxes
  | typeof productVariantAxisEvents
  | typeof productVariants
  | typeof attributeValueSets
  | typeof attributeDefinitions
  | typeof attributeDefinitionRevisions
  | typeof attributeValueRevisions
  | typeof attributeValueItems;
interface Row {
  readonly attributeDefinitionId?: string;
  readonly attributeValueSetId?: string;
  readonly axisRevision?: number;
  readonly changeKind?: string;
  readonly currentRevision?: number;
  readonly currentState?: string;
  readonly decisionRevision?: number;
  readonly lifecycleState?: string;
  readonly ordinal?: number;
  readonly productId?: string;
  readonly revision?: number;
  readonly specialState?: string | null;
  readonly tenantId?: string;
  readonly textValue?: string | null;
  readonly valueKind?: string;
  readonly valueSnapshot?: object;
  readonly variantId?: string | null;
}
const KeySchema = Schema.Literals([
  'products',
  'assignments',
  'decisions',
  'axes',
  'axisEvents',
  'variants',
  'sets',
  'definitions',
  'definitionRevisions',
  'valueRevisions',
  'valueItems',
]);
type Key = typeof KeySchema.Type;
type Fixture = Partial<Record<Key, readonly Row[]>>;
const dialect = new PgDialect();
const filterRows = (rows: readonly Row[], field: 'tenantId' | 'productId', value: string): readonly Row[] =>
  rows.filter((row) => row[field] === value);
const tableKey = (table: Table): Key => {
  if (table === products) {
    return 'products';
  }
  if (table === productTypeAssignments) {
    return 'assignments';
  }
  if (table === productTypeUntypedDecisions) {
    return 'decisions';
  }
  if (table === productVariantAxes) {
    return 'axes';
  }
  if (table === productVariantAxisEvents) {
    return 'axisEvents';
  }
  if (table === productVariants) {
    return 'variants';
  }
  if (table === attributeDefinitions) {
    return 'definitions';
  }
  if (table === attributeDefinitionRevisions) {
    return 'definitionRevisions';
  }
  if (table === attributeValueRevisions) {
    return 'valueRevisions';
  }
  if (table === attributeValueItems) {
    return 'valueItems';
  }
  return 'sets';
};

/** In-memory Drizzle seam that applies tenant/product SQL predicates to fixture rows. */
const transaction = (fixture: Fixture = {}) => {
  const inserted: Row[] = [];
  const rows = {
    assignments: [],
    axes: [],
    axisEvents: [],
    decisions: [],
    definitionRevisions: [],
    definitions: [],
    products: [{ currentRevision: 1, productId, tenantId }],
    sets: [],
    valueItems: [],
    valueRevisions: [],
    variants: [],
    ...fixture,
  } satisfies Record<Key, readonly Row[]>;
  const select = () => ({
    from: (table: Table) => {
      let selected: readonly Row[] = rows[tableKey(table)];
      const query = {
        for: () => query,
        limit: (count: number) => Effect.succeed(selected.slice(0, count)),
        orderBy: () => query,
        pipe: (operation: (value: Effect.Effect<readonly Row[]>) => Effect.Effect<readonly Row[]>) =>
          operation(Effect.succeed(selected)),
        *[Symbol.iterator]() {
          return yield* Effect.succeed(selected);
        },
        where: (condition: Parameters<typeof dialect.sqlToQuery>[0]) => {
          const { params, sql } = dialect.sqlToQuery(condition);
          for (const [column, field, value] of [
            ['tenant_id', 'tenantId', tenantId],
            ['product_id', 'productId', productId],
          ] as const) {
            if (sql.includes(`"${column}"`) && params.includes(value)) {
              selected = filterRows(selected, field, value);
            }
          }
          return query;
        },
      };
      return query;
    },
  });
  return {
    insert: (table: Table) => {
      expect(table).toBe(productTypeUntypedDecisions);
      return {
        values: (value: Row) => {
          inserted.push(value);
          return Effect.void;
        },
      };
    },
    inserted,
    select,
  };
};

const decide = (tx: ReturnType<typeof transaction>, input: Payload = payload()) =>
  Effect.gen(function* executeDecision() {
    // @ts-expect-error The in-memory seam implements only the exercised Drizzle chain.
    const service = yield* productTypeUntypedDecisionPersistenceForScope(tx, scope);
    return yield* service
      .decide({
        actionInvocationId: '44444444-4444-4444-8444-444444444444',
        payload: input,
        principalId: scope.principalId,
      })
      .pipe(
        Effect.match({
          onFailure: (error) => ({ reason: error.reason, result: null }),
          onSuccess: (value) => ({ reason: null, result: value }),
        }),
      );
  });

describe('Product Type untyped decision persistence', () => {
  it.effect('appends CONFIRMED against an empty Current inventory', () =>
    Effect.gen(function* confirms() {
      const tx = transaction();
      const result = yield* decide(tx);
      expect(result.reason).toBeNull();
      expect(tx.inserted).toMatchObject([
        {
          axisRevision: 0,
          decisionRevision: 1,
          decisionState: 'CONFIRMED',
          productId,
          productRevision: 1,
          tenantId,
          valueRevisionTokens: [],
          variantRevisionTokens: [],
        },
      ]);
    }),
  );

  it.effect('appends REVOKED after the latest decision even with axes', () =>
    Effect.gen(function* revokes() {
      const tx = transaction({
        axes: [{ productId, tenantId }],
        axisEvents: [{ axisRevision: 2, productId, tenantId }],
        decisions: [{ decisionRevision: 1, productId, tenantId }],
      });
      const result = yield* decide(
        tx,
        payload({ decisionState: 'REVOKED', expectedAxisRevision: 2, expectedDecisionRevision: 1 }),
      );
      expect(result.reason).toBeNull();
      expect(tx.inserted).toMatchObject([{ axisRevision: 2, decisionRevision: 2, decisionState: 'REVOKED' }]);
    }),
  );

  it.effect('rejects CONFIRMED with a valid Current SET, even when its revision token matches', () =>
    Effect.gen(function* currentSet() {
      const definition = {
        allowsNone: 0,
        allowsNotApplicable: 0,
        allowsUnknown: 0,
        applicableLevels: ['PRODUCT'],
        canonicalUnit: null,
        controlledValueKind: null,
        currentRevision: 2,
        decimalPlaces: null,
        maximumValue: null,
        meaning: 'Material',
        measuredQuantity: null,
        minimumValue: null,
        multiplicity: 'SINGLE',
        name: 'Material',
        valueKind: 'TEXT',
      };
      const tx = transaction({
        definitionRevisions: [{ ...definition, attributeDefinitionId: definitionId, revision: 2, tenantId }],
        definitions: [{ ...definition, attributeDefinitionId: definitionId, tenantId }],
        sets: [
          {
            attributeDefinitionId: definitionId,
            attributeValueSetId: setId,
            currentRevision: 1,
            currentState: 'SET',
            productId,
            tenantId,
            variantId: null,
          },
        ],
        valueItems: [
          {
            attributeDefinitionId: definitionId,
            attributeValueSetId: setId,
            ordinal: 0,
            specialState: null,
            tenantId,
            textValue: 'Steel',
            valueKind: 'TEXT',
          },
        ],
        valueRevisions: [
          {
            attributeValueSetId: setId,
            changeKind: 'SET',
            revision: 1,
            tenantId,
            valueSnapshot: {
              attributeDefinitionRevision: 2,
              productTypeId: variantId,
              productTypeRevision: 1,
              sourceProductValueRevision: null,
              values: [{ kind: 'TEXT', text: 'Steel' }],
            },
          },
        ],
      });
      const token = `${setId}:1:${definitionId}:2:2`;
      const result = yield* decide(tx, payload({ expectedValueRevisionTokens: [token] }));
      expect(result.reason).toContain('Structured attributes or Variant Axes still exist');
      expect(tx.inserted).toHaveLength(0);
    }),
  );

  for (const [name, fixture, reason] of [
    ['missing Product', { products: [] }, 'Product is not Current'],
    ['stale Product', { products: [{ currentRevision: 2, productId, tenantId }] }, 'Product revision is stale'],
    ['stale decision', { decisions: [{ decisionRevision: 1, productId, tenantId }] }, 'basis is stale'],
    ['stale axis', { axisEvents: [{ axisRevision: 1, productId, tenantId }] }, 'basis is stale'],
    [
      'stale Variant',
      { variants: [{ currentRevision: 2, lifecycleState: 'ACTIVE', productId, tenantId, variantId }] },
      'inventory revisions are stale',
    ],
    ['Current axis', { axes: [{ productId, tenantId }] }, 'Variant Axes still exist'],
    [
      'foreign Tenant Product',
      { products: [{ currentRevision: 1, productId, tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }] },
      'Product is not Current',
    ],
  ] as const) {
    it.effect(`rejects ${name} without append`, () =>
      Effect.gen(function* rejects() {
        const tx = transaction(fixture);
        const result = yield* decide(tx);
        expect(result.reason).toContain(reason);
        expect(tx.inserted).toHaveLength(0);
      }),
    );
  }
});
