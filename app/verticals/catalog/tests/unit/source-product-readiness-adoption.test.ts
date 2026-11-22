import { NodeCrypto } from '@effect/platform-node';
import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { Effect, Match, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  ConfirmVariantCombinationPayloadSchema,
  ConfirmVariantCombinationResultSchema,
} from '../../shared/actions/confirm-variant-combination.ts';
import {
  DecideProductTypeUnnecessaryPayloadSchema,
  DecideProductTypeUnnecessaryResultSchema,
} from '../../shared/actions/decide-product-type-unnecessary.ts';
import { GovernVariantAxesResultSchema } from '../../shared/actions/govern-variant-axes.ts';
import { LocalizedFactsChangeResultSchema } from '../../shared/actions/localized-facts.ts';
import {
  SetProductUnitTargetDivisibilityPayloadSchema,
  SetProductUnitTargetDivisibilityResultSchema,
} from '../../shared/actions/set-product-unit-target-divisibility.ts';
import { UpdateProductPayloadSchema, UpdateProductResultSchema } from '../../shared/actions/update-product.ts';
import {
  catalogResultSnapshots,
  catalogSourceCorrelations,
  productLocalizedFacts,
  products,
  productTypeUntypedDecisions,
  productUnitRuleRevisions,
  productUnits,
  productVariantAxisEvents,
  productVariants,
  variantUnitDivisibility,
} from '../../src/database/schema.ts';
import type { productVariantRevisions, variantUnitDivisibilityRevisions } from '../../src/database/schema.ts';
import { catalogActionResultSnapshotForScope } from '../../src/persistence/catalog-action-result-snapshot.ts';
import { catalogPersistenceForScope } from '../../src/persistence/catalog-persistence.ts';
import { catalogSourceProductIntentMatches } from '../../src/persistence/catalog-source-product-intent.ts';
import { localizedProductFactsPersistenceForScope } from '../../src/persistence/localized-product-facts-persistence.ts';
import {
  ProductTypeUntypedDecisionRejected,
  productTypeUntypedDecisionPersistenceForScope,
} from '../../src/persistence/product-type-untyped-decision-persistence.ts';
import { productUnitPersistenceServiceFactory } from '../../src/actions/product-unit-action-support.ts';
import { axisFreeCombinationKey } from '../../src/persistence/variant-current-basis.ts';
import { variantAxisPersistenceForScope } from '../../src/persistence/variant-axis-persistence.ts';
import {
  ConfirmedVariantCombinationSchema,
  variantPersistenceForScope,
} from '../../src/persistence/variant-persistence.ts';
import { localizedOutcome } from '../../src/actions/localized-facts-action-support.ts';
import { sourceProductIntentFixture } from '../support/source-product-intent.fixture.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const principalId = '22222222-2222-4222-8222-222222222222';
const productId = '33333333-3333-4333-8333-333333333333';
const variantId = '44444444-4444-4444-8444-444444444444';
const unitId = '55555555-5555-4555-8555-555555555555';
const otherId = '66666666-6666-4666-8666-666666666666';
const actionInvocationId = '77777777-7777-4777-8777-777777777777';
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:source-readiness:run:2',
    authMethod: 'system',
    principalId,
    tenantId,
  }),
  correlationId: 'new-source-batch',
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
const unitRef = {
  moduleId: 'commerce.catalog',
  resourceId: unitId,
  resourceType: 'commerce.catalog.product-unit',
  tenantId,
} as const;
const reason = 'Symmy product import';
const evidenceRefs = ['symmy-product:ready'] as const;
const at = new Date('2026-11-22T00:00:00.000Z');
const product = {
  createdAt: at,
  currentRevision: 2,
  description: null,
  lifecycleState: 'ACTIVE',
  name: 'Ready product',
  productId,
  retiredEffectiveAt: null,
  retiredReason: null,
  tenantId,
  updatedAt: at,
};
const variant = {
  combinationAxisRevision: 1,
  combinationKey: axisFreeCombinationKey(),
  createdAt: at,
  currentRevision: 2,
  lifecycleState: 'ACTIVE',
  productId,
  tenantId,
  updatedAt: at,
  variantId,
};
const axes = {
  actingPrincipalId: principalId,
  attributeDefinitionIds: [],
  attributeDefinitionRevisions: [],
  axisRevision: 1,
  productId,
  tenantId,
};
const facts = {
  currentRevision: 1,
  description: null,
  locale: 'en',
  name: product.name,
  productId,
  state: 'SET',
  tenantId,
};
const divisibility = { currentRevision: 1, divisible: false, tenantId, unitId, variantId };
const decision = {
  actingPrincipalId: principalId,
  axisRevision: 1,
  decisionRevision: 1,
  decisionState: 'CONFIRMED',
  productId,
  productRevision: 2,
  structuredAttributesRequired: false,
  tenantId,
  valueRevisionTokens: [],
  variantAxesRequired: false,
  variantRevisionTokens: [`${variantId}:2`],
};
const dialect = new PgDialect();
type ReadQuery = Effect.Effect<readonly object[]> & {
  readonly for: () => ReadQuery;
  readonly limit: (count: number) => ReadQuery;
  readonly orderBy: () => ReadQuery;
};
const query = (selected: readonly object[]): ReadQuery =>
  Object.assign(Effect.succeed(selected), {
    for: () => query(selected),
    limit: (count: number) => query(selected.slice(0, count)),
    orderBy: () => query(selected),
  });
type Snapshot = typeof catalogResultSnapshots.$inferInsert;
const snapshotInsert = (table: PgTable, snapshots: Snapshot[]) => ({
  values: (value: Snapshot) => {
    expect(table).toBe(catalogResultSnapshots);
    snapshots.push(value);
    return { onConflictDoNothing: () => ({ returning: () => Effect.succeed([value]) }) };
  },
});
const selectedRows = (table: PgTable, rows: Map<PgTable, readonly object[]>, snapshots: readonly Snapshot[]) => ({
  where: (condition: SQL) =>
    query(
      table === catalogResultSnapshots
        ? snapshots.filter((row) => dialect.sqlToQuery(condition).params.includes(row.actionInvocationId))
        : (rows.get(table) ?? []),
    ),
});

type FixtureWrite =
  | typeof productVariantRevisions.$inferInsert
  | typeof productVariants.$inferInsert
  | typeof variantUnitDivisibility.$inferInsert
  | typeof variantUnitDivisibilityRevisions.$inferInsert;
const writeFixture = (allowWrites: boolean, writes: { readonly table: PgTable; readonly value: FixtureWrite }[]) => {
  const record = (table: PgTable, value: FixtureWrite) => {
    if (!allowWrites) {
      throw new Error('Unexpected business mutation');
    }
    writes.push({ table, value });
  };
  const insert = (table: PgTable) => ({
    values: (value: FixtureWrite) => {
      record(table, value);
      return Effect.succeed([]);
    },
  });
  const returning = (table: PgTable, value: FixtureWrite) => () => {
    record(table, value);
    return Effect.succeed([{ ...variant, ...value }]);
  };
  const update = (table: PgTable) => ({
    set: (value: FixtureWrite) => ({ where: () => ({ returning: returning(table, value) }) }),
  });
  return { insert, update };
};

const readyFixture = Effect.fn('sourceReadiness.readyFixture')(function* readyFixture(
  overrides = new Map<PgTable, readonly object[]>(),
  allowWrites = false,
) {
  const source = yield* sourceProductIntentFixture({ principalId, productId, tenantId, variantId });
  const rows = new Map<PgTable, readonly object[]>([
    [products, [product]],
    [productVariants, [variant]],
    [catalogSourceCorrelations, [source.correlation]],
    [productVariantAxisEvents, [axes]],
    [productLocalizedFacts, [facts]],
    [variantUnitDivisibility, [divisibility]],
    [productTypeUntypedDecisions, [decision]],
    [productUnits, [{ currentRuleRevision: 1, lifecycleState: 'ACTIVE', tenantId, unitId }]],
    [productUnitRuleRevisions, [{ revision: 1, rounding: 'UP', step: '1', tenantId, unitId }]],
    ...overrides,
  ]);
  const snapshots: Snapshot[] = [];
  const writes: { readonly table: PgTable; readonly value: FixtureWrite }[] = [];
  const business = writeFixture(allowWrites, writes);
  const transaction = {
    insert: (table: PgTable) =>
      table === catalogResultSnapshots ? snapshotInsert(table, snapshots) : business.insert(table),
    select: () => ({ from: (table: PgTable) => selectedRows(table, rows, snapshots) }),
    update: business.update,
  };
  // @ts-expect-error The seam implements only exercised, read-only Drizzle chains and result snapshot inserts.
  const axisService = variantAxisPersistenceForScope(transaction, scope);
  // @ts-expect-error Focused Drizzle seam; a business mutation has no implementation and fails the test.
  const variantService = variantPersistenceForScope(transaction, scope);
  // @ts-expect-error Focused Drizzle seam.
  const textService = localizedProductFactsPersistenceForScope(transaction, scope);
  // @ts-expect-error Focused Drizzle seam.
  const productService = yield* catalogPersistenceForScope(transaction, scope);
  // @ts-expect-error Uses the real owner target-basis verifier over the focused Drizzle seam.
  const unitService = yield* productUnitPersistenceServiceFactory(transaction, scope);
  // @ts-expect-error Uses the real Current attribute inventory over the focused Drizzle seam.
  const typeService = yield* productTypeUntypedDecisionPersistenceForScope(transaction, scope);
  const commands = (includeSource = true) => {
    const sourceProduct = includeSource ? source.sourceProduct : undefined;
    const witness = sourceProduct === undefined ? {} : { sourceProduct };
    const activation = Schema.decodeUnknownSync(UpdateProductPayloadSchema)({
      expectedRevision: 1,
      productRef,
      reason,
      ...witness,
      targetLifecycle: 'ACTIVE',
    });
    return {
      activate: productService.update({
        actionInvocationId,
        activateVariantId: activation.activateVariantRef?.resourceId,
        expectedRevision: activation.expectedRevision,
        principalId,
        productId,
        reason: activation.reason,
        sourceProduct: activation.sourceProduct,
        targetLifecycle: activation.targetLifecycle,
        tenantId,
      }),
      axes: axisService.govern({
        actionInvocationId,
        axes: [],
        change: { evidenceRefs, kind: 'AXIS_INITIALIZATION', reason },
        expectedAxisRevision: 0,
        principalId,
        productRef,
        reason,
        sourceProduct,
      }),
      confirm: variantService.confirm({
        ...Schema.decodeUnknownSync(ConfirmVariantCombinationPayloadSchema)({
          evidenceRefs,
          expectedAxisRevision: 1,
          expectedVariantRevision: 1,
          productRef,
          reason,
          ...witness,
          variantRef,
        }),
        actionInvocationId,
        principalId,
      }),
      name: textService.changeProduct({
        actionInvocationId,
        evidenceRefs,
        expectedRevision: 0,
        locale: 'en',
        principalId,
        productRef,
        reason,
        sourceProduct,
        value: { facts: { name: product.name }, kind: 'SET' },
      }),
      unit: unitService.setTargetDivisibility({
        actionInvocationId,
        payload: Schema.decodeUnknownSync(SetProductUnitTargetDivisibilityPayloadSchema)({
          divisible: false,
          evidenceRefs,
          expectedSources: {
            product: { resourceRef: productRef, revision: 2 },
            variant: { resourceRef: variantRef, revision: 2 },
          },
          reason,
          ...witness,
          target: { targetId: variantId, targetType: 'commerce.catalog.variant', tenantId, unit: unitRef },
        }),
        principalId,
      }),
      untyped: typeService.decide({
        actionInvocationId,
        payload: Schema.decodeUnknownSync(DecideProductTypeUnnecessaryPayloadSchema)({
          decisionState: 'CONFIRMED',
          evidenceRefs,
          expectedAxisRevision: 1,
          expectedDecisionRevision: 0,
          expectedProductRevision: 2,
          expectedValueRevisionTokens: [],
          expectedVariantRevisionTokens: [`${variantId}:2`],
          productRef,
          reason,
          ...witness,
          structuredAttributesRequired: false,
          variantAxesRequired: false,
        }),
        principalId,
      }),
    };
  };
  const receipt = <Result, Encoded extends object>(
    schema: Schema.Codec<Result, Encoded>,
    result: Encoded,
    slug: string,
    position: number,
  ) =>
    Effect.gen(function* retainReceipt() {
      // @ts-expect-error Focused Drizzle result snapshot seam.
      const store = catalogActionResultSnapshotForScope(transaction, scope, {
        decode: Schema.decodeUnknownEffect(schema),
        encode: Schema.encodeEffect(schema),
      });
      const identity = {
        actionInvocationId: `88888888-8888-4888-8888-88888888888${position}`,
        actionKey: `commerce.catalog.${slug}`,
        schemaVersion: 1,
      };
      const decoded = yield* Schema.decodeUnknownEffect(schema)(result);
      yield* store.insert(identity, decoded);
      expect(yield* store.read(identity)).toEqual(decoded);
    });
  const matches = (sourceProduct = source.sourceProduct) =>
    // @ts-expect-error Focused Drizzle source-intent read seam.
    catalogSourceProductIntentMatches(transaction, scope, { productRef, sourceProduct, variantRef });
  return { commands, matches, receipt, rows, snapshots, source, writes };
});

describe('exact source Product readiness adoption', () => {
  it.effect('matches the same source Product and Variant UUIDs independently of letter case', () =>
    Effect.gen(function* canonicalSourceUuids() {
      const originalProductId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const originalVariantId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      const source = yield* sourceProductIntentFixture({
        principalId,
        productId: originalProductId,
        tenantId,
        variantId: originalVariantId,
      });
      const transaction = {
        select: () => ({ from: () => ({ where: () => query([source.correlation]) }) }),
      };
      const matches = (productUuid: string, variantUuid: string) =>
        // @ts-expect-error Focused read-only Drizzle source-intent seam.
        catalogSourceProductIntentMatches(transaction, scope, {
          productRef: { ...productRef, resourceId: productUuid },
          sourceProduct: source.sourceProduct,
          variantRef: { ...variantRef, resourceId: variantUuid },
        });
      for (const productUuid of [originalProductId, originalProductId.toUpperCase()]) {
        for (const variantUuid of [originalVariantId, originalVariantId.toUpperCase()]) {
          expect(yield* matches(productUuid, variantUuid)).toBe(true);
        }
      }
      expect(yield* matches(otherId, originalVariantId)).toBe(false);
      expect(yield* matches(originalProductId, otherId)).toBe(false);
      expect(source.correlation.productId).toBe(originalProductId);
      expect(source.correlation.variantId).toBe(originalVariantId);
    }),
  );

  it.effect('reports fresh ordinary Variant confirmation and divisibility writes as changes', () =>
    Effect.gen(function* freshDecisions() {
      const draft = {
        ...variant,
        combinationAxisRevision: null,
        combinationKey: null,
        currentRevision: 1,
        lifecycleState: 'WORK_IN_PROGRESS',
      };
      const variantFixture = yield* readyFixture(new Map([[productVariants, [draft]]]), true);
      expect(
        Match.value(yield* variantFixture.commands(false).confirm).pipe(
          Match.tag('confirmed', ({ changed }) => changed),
          Match.orElse(() => false),
        ),
      ).toBe(true);
      expect(variantFixture.writes.length).toBeGreaterThan(0);

      const unitFixture = yield* readyFixture(new Map([[variantUnitDivisibility, []]]), true);
      expect(
        Match.value(yield* unitFixture.commands(false).unit).pipe(
          Match.tag('divisibility_set', ({ changed }) => changed),
          Match.orElse(() => false),
        ),
      ).toBe(true);
      expect(unitFixture.writes.length).toBeGreaterThan(0);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('adopts all six identical owner decisions and retains six independent recoverable Action receipts', () =>
    Effect.gen(function* adoptsReadyProduct() {
      const fixture = yield* readyFixture();
      const commands = fixture.commands();
      const governed = yield* commands.axes;
      const confirmed = yield* commands.confirm.pipe(
        Effect.flatMap((outcome) =>
          Match.value(outcome).pipe(
            Match.tag('confirmed', (value) => Effect.succeed(value)),
            Match.orElse(() => Effect.die('Expected adopted Variant')),
          ),
        ),
      );
      const localized = yield* commands.name.pipe(Effect.flatMap(localizedOutcome));
      const activated = yield* commands.activate.pipe(
        Effect.flatMap((outcome) =>
          Match.value(outcome).pipe(
            Match.tag('updated', (value) => Effect.succeed(value)),
            Match.orElse(() => Effect.die('Expected adopted Product')),
          ),
        ),
      );
      const unit = yield* commands.unit.pipe(
        Effect.flatMap((outcome) =>
          Match.value(outcome).pipe(
            Match.tag('divisibility_set', (value) => Effect.succeed(value)),
            Match.orElse(() => Effect.die('Expected adopted Unit decision')),
          ),
        ),
      );
      const untyped = yield* commands.untyped;
      expect(governed).toEqual({ axisRevision: 1, changed: false });
      expect(confirmed.revision).toBe(2);
      expect(confirmed).toMatchObject({ changed: false });
      expect(localized).toEqual({ changed: false, revision: 1 });
      expect(activated).toMatchObject({
        changed: false,
        product: { lifecycle: 'ACTIVE', revision: 2 },
      });
      expect(unit.targetDivisibility).toMatchObject({ divisible: false, revision: 1 });
      expect(unit).toMatchObject({ changed: false });
      expect(untyped).toEqual({ changed: false, decisionRevision: 1, decisionState: 'CONFIRMED', productRef });
      yield* fixture.receipt(GovernVariantAxesResultSchema, { ...governed, productRef }, 'govern-variant-axes', 1);
      yield* fixture.receipt(
        ConfirmVariantCombinationResultSchema,
        {
          changed: confirmed.changed,
          combinationAxisRevision: confirmed.combinationAxisRevision,
          combinationKey: confirmed.combinationKey,
          variant: confirmed.variant,
          variantRevision: confirmed.revision,
        },
        'confirm-variant-combination',
        2,
      );
      yield* fixture.receipt(
        LocalizedFactsChangeResultSchema,
        { changed: false, revision: localized.revision },
        'set-product-localized-facts',
        3,
      );
      yield* fixture.receipt(
        UpdateProductResultSchema,
        { changed: false, product: activated.product },
        'update-product',
        4,
      );
      yield* fixture.receipt(
        SetProductUnitTargetDivisibilityResultSchema,
        {
          changed: unit.changed,
          ruleRevision: unit.ruleRevision,
          targetDivisibility: unit.targetDivisibility,
          unit: unit.unit,
        },
        'set-product-unit-target-divisibility',
        5,
      );
      yield* fixture.receipt(DecideProductTypeUnnecessaryResultSchema, untyped, 'decide-product-type-unnecessary', 6);
      expect(fixture.snapshots).toHaveLength(6);
      expect(new Set(fixture.snapshots.map((snapshot) => snapshot.actionInvocationId)).size).toBe(6);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('rejects every readiness adoption when the source intent belongs to another Product', () =>
    Effect.gen(function* rejectsForeignSourceProduct() {
      const fixture = yield* readyFixture();
      fixture.rows.set(catalogSourceCorrelations, [{ ...fixture.source.correlation, productId: otherId }]);
      const commands = fixture.commands();
      expect(yield* Effect.flip(commands.axes)).toMatchObject({ conflict: 'INVALID_INPUT' });
      expect(
        Match.value(yield* commands.confirm).pipe(
          Match.tag('invalid_change', () => true),
          Match.orElse(() => false),
        ),
      ).toBe(true);
      expect(yield* commands.name).toEqual({ kind: 'INVALID' });
      expect(
        Match.value(yield* commands.activate).pipe(
          Match.tag('revision_conflict', () => true),
          Match.orElse(() => false),
        ),
      ).toBe(true);
      expect(
        Match.value(yield* commands.unit).pipe(
          Match.tag('invalid', () => true),
          Match.orElse(() => false),
        ),
      ).toBe(true);
      expect(Schema.is(ProductTypeUntypedDecisionRejected)(yield* Effect.flip(commands.untyped))).toBe(true);
      expect(fixture.snapshots).toEqual([]);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('keeps ordinary stale writes rejected without an exact source creation witness', () =>
    Effect.gen(function* rejectsUnwitnessedAdoption() {
      const fixture = yield* readyFixture();
      const commands = fixture.commands(false);
      expect(yield* Effect.flip(commands.axes)).toMatchObject({ conflict: 'REVISION' });
      expect(
        Match.value(yield* commands.confirm).pipe(
          Match.tag('revision_conflict', () => true),
          Match.orElse(() => false),
        ),
      ).toBe(true);
      expect(yield* commands.name).toMatchObject({ kind: 'STALE' });
      expect(
        Match.value(yield* commands.activate).pipe(
          Match.tag('revision_conflict', () => true),
          Match.orElse(() => false),
        ),
      ).toBe(true);
      expect(
        Match.value(yield* commands.unit).pipe(
          Match.tag('stale', () => true),
          Match.orElse(() => false),
        ),
      ).toBe(true);
      expect(Schema.is(ProductTypeUntypedDecisionRejected)(yield* Effect.flip(commands.untyped))).toBe(true);
      expect(fixture.snapshots).toEqual([]);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('requires the exact source, principal, Product, Variant, mapping and creation fields', () =>
    Effect.gen(function* rejectsDifferentWitness() {
      const fixture = yield* readyFixture();
      for (const change of [
        { actingPrincipalId: otherId },
        { tenantId: otherId },
        { productId: otherId },
        { variantId: otherId },
        { entityKind: 'VARIANT' },
        { issuerId: 'other' },
        { routeScope: 'other' },
        { recordNamespace: 'other' },
        { recordId: 'other' },
        { mappingRevision: 'other' },
        { intentFingerprint: '0'.repeat(64) },
      ]) {
        fixture.rows.set(catalogSourceCorrelations, [{ ...fixture.source.correlation, ...change }]);
        expect(yield* fixture.matches()).toBe(false);
      }
      for (const rows of [[], [fixture.source.correlation, fixture.source.correlation]]) {
        fixture.rows.set(catalogSourceCorrelations, rows);
        expect(yield* fixture.matches()).toBe(false);
      }
      fixture.rows.set(catalogSourceCorrelations, [fixture.source.correlation]);
      expect(yield* fixture.matches()).toBe(true);
      for (const change of [{ name: 'Changed' }, { description: 'Added' }, { variantId: otherId }]) {
        expect(yield* fixture.matches({ ...fixture.source.sourceProduct, ...change })).toBe(false);
      }
    }),
  );

  it.effect('keeps a changed axis snapshot stale even when the source intent is exact', () =>
    Effect.gen(function* rejectsChangedAxes() {
      const fixture = yield* readyFixture(new Map([[productVariantAxisEvents, [{ ...axes, axisRevision: 2 }]]]));
      expect(yield* Effect.flip(fixture.commands().axes)).toMatchObject({ conflict: 'REVISION' });
    }),
  );

  it.effect('never uses source adoption to repair a changed, retired or stale Variant', () =>
    Effect.gen(function* rejectsChangedVariant() {
      for (const change of [
        { combinationKey: '0'.repeat(64) },
        { combinationAxisRevision: 2 },
        { currentRevision: 3 },
        { lifecycleState: 'WORK_IN_PROGRESS' },
        { lifecycleState: 'RETIRED' },
      ]) {
        const fixture = yield* readyFixture(new Map([[productVariants, [{ ...variant, ...change }]]]));
        expect(Schema.is(ConfirmedVariantCombinationSchema)(yield* fixture.commands().confirm)).toBe(false);
      }
    }),
  );

  it.effect('does not overwrite different localized fields or a later localized revision', () =>
    Effect.gen(function* rejectsDifferentFacts() {
      for (const change of [
        { name: 'Changed' },
        { description: 'Added' },
        { currentRevision: 2 },
        { state: 'REMOVED' },
      ]) {
        const fixture = yield* readyFixture(new Map([[productLocalizedFacts, [{ ...facts, ...change }]]]));
        expect(yield* fixture.commands().name).toMatchObject({ kind: 'STALE' });
      }
    }),
  );

  it.effect('does not turn a changed or DRAFT Product into ACTIVE through a stale source revision', () =>
    Effect.gen(function* rejectsChangedProduct() {
      for (const change of [
        { name: 'Changed' },
        { description: 'Added' },
        { currentRevision: 3 },
        { lifecycleState: 'DRAFT' },
        { lifecycleState: 'RETIRED' },
      ]) {
        const fixture = yield* readyFixture(new Map([[products, [{ ...product, ...change }]]]));
        expect(
          Match.value(yield* fixture.commands().activate).pipe(
            Match.tag('revision_conflict', () => true),
            Match.orElse(() => false),
          ),
        ).toBe(true);
      }
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('keeps the exact Unit, divisibility and Current Product/Variant basis fences', () =>
    Effect.gen(function* rejectsDifferentUnit() {
      for (const change of [{ unitId: otherId }, { divisible: true }, { currentRevision: 2 }]) {
        const fixture = yield* readyFixture(new Map([[variantUnitDivisibility, [{ ...divisibility, ...change }]]]));
        expect(
          Match.value(yield* fixture.commands().unit).pipe(
            Match.tag('divisibility_set', () => true),
            Match.orElse(() => false),
          ),
        ).toBe(false);
      }
      for (const table of [products, productVariants]) {
        const current = table === products ? product : variant;
        const fixture = yield* readyFixture(new Map([[table, [{ ...current, currentRevision: 3 }]]]));
        expect(
          Match.value(yield* fixture.commands().unit).pipe(
            Match.tag('stale', () => true),
            Match.orElse(() => false),
          ),
        ).toBe(true);
      }
    }),
  );

  it.effect('refuses changed untyped decisions rather than appending or silently reconfirming them', () =>
    Effect.gen(function* rejectsDifferentUntypedDecision() {
      for (const change of [
        { actingPrincipalId: otherId },
        { decisionState: 'REVOKED' },
        { decisionRevision: 2 },
        { productRevision: 1 },
        { axisRevision: 0 },
        { valueRevisionTokens: ['changed'] },
        { variantRevisionTokens: [`${variantId}:1`] },
      ]) {
        const fixture = yield* readyFixture(new Map([[productTypeUntypedDecisions, [{ ...decision, ...change }]]]));
        expect(Schema.is(ProductTypeUntypedDecisionRejected)(yield* Effect.flip(fixture.commands().untyped))).toBe(
          true,
        );
      }
    }),
  );
});
