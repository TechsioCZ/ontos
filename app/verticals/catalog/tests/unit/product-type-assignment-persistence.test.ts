import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { CatalogSelectionSchema } from '../../shared/domain/catalog-selection-evidence.ts';
import type { productTypeRevisions } from '../../src/database/schema.ts';
import {
  productTypeAssignmentEvents,
  productTypeAssignments,
  productTypes,
  products,
} from '../../src/database/schema.ts';
import {
  ProductTypeAssignmentRejected,
  productTypeAssignmentPersistenceForScope,
} from '../../src/persistence/product-type-assignment-persistence.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const productId = '22222222-2222-4222-8222-222222222222';
const productTypeId = '33333333-3333-4333-8333-333333333333';
const principalId = '44444444-4444-4444-8444-444444444444';
const actionInvocationId = '55555555-5555-4555-8555-555555555555';
const variantId = '66666666-6666-4666-8666-666666666666';
const impactBasis = 'cart-population-current-1';
const nextProductTypeRef = {
  moduleId: 'commerce.catalog',
  resourceId: productTypeId,
  resourceType: 'commerce.catalog.product-type',
  tenantId,
} as const;
const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: productId,
  resourceType: 'commerce.catalog.product',
  tenantId,
} as const;
const selection = Schema.decodeUnknownSync(CatalogSelectionSchema)({
  productRef,
  variantRef: {
    moduleId: 'commerce.catalog',
    resourceId: variantId,
    resourceType: 'commerce.catalog.variant',
    tenantId,
  },
});
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:product-type-assignment-test:run:1',
    authMethod: 'system',
    principalId,
    tenantId,
  }),
  correlationId: 'product-type-assignment-test',
};
const input = {
  actionInvocationId,
  expectedProductRevision: 1,
  impactBasis,
  nextProductTypeRef,
  principalId,
  productId,
  reason: 'Verified Product Type requirements',
};

interface Fixture {
  readonly assignment?: { readonly assignmentRevision: number; readonly productTypeId: string };
  readonly latestAssignmentRevision?: number;
  readonly productRevision?: number;
  readonly productTypeExists?: boolean;
  readonly productTypeRevisionEvidence?: boolean;
}

type Table =
  | typeof products
  | typeof productTypeAssignments
  | typeof productTypeAssignmentEvents
  | typeof productTypes
  | typeof productTypeRevisions;

interface Row {
  readonly assignmentRevision?: number;
  readonly currentRevision?: number;
  readonly productTypeId?: string;
  readonly productTypeRevisionId?: string;
}

type WriteValue =
  | Partial<typeof products.$inferInsert>
  | Partial<typeof productTypeAssignments.$inferInsert>
  | Partial<typeof productTypeAssignmentEvents.$inferInsert>;

const updateOperation = (table: Table, writes: [Table, WriteValue][]) => ({
  set: (value: WriteValue) => ({
    where: () => ({
      returning: () => {
        writes.push([table, value]);
        return Effect.succeed([{ currentRevision: 2 }]);
      },
    }),
  }),
});

const transaction = (fixture: Fixture = {}) => {
  const writes: [Table, WriteValue][] = [];
  const rows = (table: Table): readonly Row[] => {
    if (table === products) {
      return [{ currentRevision: fixture.productRevision ?? 1 }];
    }
    if (table === productTypeAssignments) {
      return fixture.assignment === undefined ? [] : [fixture.assignment];
    }
    if (table === productTypeAssignmentEvents) {
      return fixture.latestAssignmentRevision === undefined
        ? []
        : [{ assignmentRevision: fixture.latestAssignmentRevision }];
    }
    if (table === productTypes) {
      return fixture.productTypeExists === false ? [] : [{ currentRevision: 3 }];
    }
    return fixture.productTypeRevisionEvidence === false
      ? []
      : [{ productTypeRevisionId: '77777777-7777-4777-8777-777777777777' }];
  };
  const select = () => ({
    from: (table: Table) => {
      const selected = rows(table);
      const query = {
        for: () => query,
        limit: (count: number) => Effect.succeed(selected.slice(0, count)),
        orderBy: () => query,
        where: () => query,
      };
      return query;
    },
  });
  return {
    delete: (table: Table) => ({
      where: () => {
        writes.push([table, { productId }]);
        return Effect.void;
      },
    }),
    insert: (table: Table) => ({
      values: (value: WriteValue) => {
        if (table === productTypeAssignments) {
          return {
            onConflictDoUpdate: () => {
              writes.push([table, value]);
              return Effect.void;
            },
          };
        }
        writes.push([table, value]);
        return Effect.void;
      },
    }),
    select,
    update: (table: Table) => updateOperation(table, writes),
    writes,
  };
};

const population = (
  snapshots: readonly {
    readonly revisionToken: string;
    readonly selections?: readonly { readonly selection: typeof selection; readonly selectionId: string }[];
  }[],
) => {
  let reads = 0;
  return {
    port: {
      read: () => {
        const snapshot = snapshots[Math.min(reads, snapshots.length - 1)];
        reads += 1;
        return Effect.succeed({
          complete: true as const,
          observedAt: '2026-09-18T12:00:00.000Z',
          revisionToken: snapshot?.revisionToken ?? impactBasis,
          selections: snapshot?.selections ?? [],
          tenantId,
        });
      },
    },
    reads: () => reads,
  };
};

const execute = (tx: ReturnType<typeof transaction>, owner: ReturnType<typeof population>) =>
  Effect.gen(function* runAssignment() {
    // @ts-expect-error The in-memory transaction implements only the exercised Drizzle chains.
    const persistence = yield* productTypeAssignmentPersistenceForScope(tx, scope, {
      openSelections: owner.port,
    });
    return yield* persistence.set(input);
  });

describe('Product Type assignment persistence', () => {
  it.effect('assigns a valid Current Product Type after a stable complete empty Cart basis', () =>
    Effect.gen(function* assignsProductType() {
      const tx = transaction();
      const owner = population([{ revisionToken: impactBasis }, { revisionToken: impactBasis }]);
      const result = yield* execute(tx, owner);

      expect(result).toEqual({
        currentProductTypeRef: nextProductTypeRef,
        productRef,
        revision: 2,
        unresolvedProductRefs: [],
      });
      expect(owner.reads()).toBe(2);
      expect(tx.writes).toEqual([
        [products, expect.objectContaining({ currentRevision: 2 })],
        [productTypeAssignments, expect.objectContaining({ assignmentRevision: 1, productTypeId })],
        [
          productTypeAssignmentEvents,
          expect.objectContaining({
            assignmentRevision: 1,
            nextProductTypeId: productTypeId,
            previousProductTypeId: null,
          }),
        ],
      ]);
    }),
  );

  it.effect('rejects a stale caller basis without database reads or writes', () =>
    Effect.gen(function* rejectsStaleBasis() {
      const tx = transaction();
      const owner = population([{ revisionToken: 'cart-population-newer' }]);
      const failure = yield* execute(tx, owner).pipe(Effect.flip);

      expect(failure).toBeInstanceOf(ProductTypeAssignmentRejected);
      expect(failure.reason).toContain('stale');
      expect(tx.writes).toEqual([]);
    }),
  );

  it.effect('fails closed when the complete Cart owner population is unavailable', () =>
    Effect.gen(function* rejectsUnavailablePopulation() {
      const tx = transaction();
      // @ts-expect-error The in-memory transaction implements only the exercised Drizzle chains.
      const persistence = yield* productTypeAssignmentPersistenceForScope(tx, scope);
      const failure = yield* persistence.set(input).pipe(Effect.flip);

      expect(failure.reason).toContain('complete Current Cart selection basis');
      expect(tx.writes).toEqual([]);
    }),
  );

  it.effect('requires the exact Product revision before any write', () =>
    Effect.gen(function* rejectsStaleProduct() {
      const tx = transaction({ productRevision: 2 });
      const owner = population([{ revisionToken: impactBasis }]);
      const failure = yield* execute(tx, owner).pipe(Effect.flip);

      expect(failure.reason).toContain('changed since impact review');
      expect(tx.writes).toEqual([]);
    }),
  );

  it.effect('rejects an absent Product Type without writes', () =>
    Effect.gen(function* rejectsAbsentType() {
      const tx = transaction({ productTypeExists: false });
      const owner = population([{ revisionToken: impactBasis }]);
      const failure = yield* execute(tx, owner).pipe(Effect.flip);

      expect(failure.reason).toContain('absent from the trusted Tenant');
      expect(tx.writes).toEqual([]);
      expect(owner.reads()).toBe(1);
    }),
  );

  it.effect('rejects an absent Current Product Type revision without writes', () =>
    Effect.gen(function* rejectsInvalidType() {
      const tx = transaction({ productTypeRevisionEvidence: false });
      const owner = population([{ revisionToken: impactBasis }]);
      const failure = yield* execute(tx, owner).pipe(Effect.flip);

      expect(failure.reason).toContain('revision evidence is absent');
      expect(tx.writes).toEqual([]);
      expect(owner.reads()).toBe(1);
    }),
  );

  it.effect('blocks an open selection because Current evidence cannot prove the candidate assignment', () =>
    Effect.gen(function* rejectsOpenSelection() {
      const tx = transaction();
      const owner = population([
        { revisionToken: impactBasis, selections: [{ selection, selectionId: 'cart-open-selection-1' }] },
      ]);
      const failure = yield* execute(tx, owner).pipe(Effect.flip);

      expect(failure.reason).toContain('candidate Product Type reassessment');
      expect(tx.writes).toEqual([]);
      expect(owner.reads()).toBe(1);
    }),
  );

  it.effect('re-reads the complete Cart population and rejects a changed token without writes', () =>
    Effect.gen(function* rejectsChangedPopulation() {
      const tx = transaction();
      const owner = population([{ revisionToken: impactBasis }, { revisionToken: 'cart-population-after-review' }]);
      const failure = yield* execute(tx, owner).pipe(Effect.flip);

      expect(failure.reason).toContain('changed during assignment review');
      expect(owner.reads()).toBe(2);
      expect(tx.writes).toEqual([]);
    }),
  );

  it('keeps stale-basis rejection typed', () => {
    const failure = new ProductTypeAssignmentRejected({
      code: 'product_type_stale_impact_basis',
      reason: 'No authoritative impact basis',
    });
    expect(Schema.is(ProductTypeAssignmentRejected)(failure)).toBe(true);
  });
});
