import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { and, eq, sql } from 'drizzle-orm';
import { Effect, Match, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { randomUUID } from 'node:crypto';

import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import {
  catalogRelations,
  catalogSourceCorrelations,
  commercialSkuAssignmentRevisions,
  commercialSkuReservations,
  packageContentRevisions,
  packageDefinitions,
  packageOptionRoleRevisions,
  productUnits,
  productVariantAxisEvents,
  products,
  productVariants,
} from '../../src/database/schema.ts';
import type { CatalogTransaction } from '../../src/database/types.ts';
import { SkuPersistenceUnavailable, skuPersistenceForScope } from '../../src/persistence/sku-persistence.ts';
import type { SkuChangeOutcome, SkuLookupOutcome } from '../../src/persistence/sku-persistence.ts';
import type { SkuTarget } from '../../shared/domain/commercial-code.ts';

// These rows are append-only evidence. Each run uses fresh tenant IDs in the disposable integration DB.
const tenantA = randomUUID();
const tenantB = randomUUID();
const principalId = randomUUID();
const productA = randomUUID();
const productB = randomUUID();
const variantA = randomUUID();
const variantB = randomUUID();
const variantC = randomUUID();
const variantD = randomUUID();
const variantE = randomUUID();
const optionId = randomUUID();
const unitId = randomUUID();
const observedAt = new Date('2020-01-01T00:00:00.000Z');

const scopeFor = (tenantId: string) => ({
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:sku-postgres-test:run:1',
    authMethod: 'system',
    principalId,
    tenantId,
  }),
  correlationId: 'sku-postgres-test',
});

const change = (
  code: string,
  target:
    | { kind: 'VARIANT'; tenantId: string; variantId: string }
    | { kind: 'PACKAGE_OPTION'; packageDefinitionId: string; tenantId: string },
) => ({
  actionInvocationId: randomUUID(),
  code,
  evidenceRefs: ['sku-postgres-test:source'],
  expectedRevision: 0,
  principalId,
  reason: 'Verified catalog code',
  target,
});

const expectTagged = (
  outcome: SkuChangeOutcome | SkuLookupOutcome,
  tag: SkuChangeOutcome['_tag'] | SkuLookupOutcome['_tag'],
  details: { displayCode?: string; revision?: number; state?: 'CURRENT' | 'HISTORICAL'; target?: SkuTarget } = {},
) => {
  expect(
    Match.value(outcome).pipe(
      Match.tag(tag, () => true),
      Match.orElse(() => false),
    ),
  ).toBe(true);
  expect(outcome).toMatchObject(details);
};

const sku = (transaction: CatalogTransaction, tenantId: string) =>
  skuPersistenceForScope(
    // @ts-expect-error The test transaction intentionally lacks only Core's private scope brand.
    transaction,
    scopeFor(tenantId),
  );

it.live('enforces tenant-wide normalized Current and historical SKU reservations in PostgreSQL', () =>
  Effect.scoped(
    Effect.gen(function* skuNamespacePostgresTest() {
      const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
      const admin = yield* makeTestDatabaseFromClient(adminClient, catalogRelations);
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, catalogRelations);
      const withTenant = <Value, Failure>(
        tenantId: string,
        operation: (transaction: CatalogTransaction) => Effect.Effect<Value, Failure>,
      ) =>
        runtime.transaction((transaction) =>
          Effect.gen(function* scopedSkuTransaction() {
            yield* transaction.execute(sql`select set_config('ontos.tenant_id', ${tenantId}, true)`, 'objects');
            return yield* operation(transaction);
          }),
        );
      const assign = (tenantId: string, input: ReturnType<typeof change>) =>
        withTenant(tenantId, (transaction) => sku(transaction, tenantId).assign(input));
      const lookup = (tenantId: string, code: string) =>
        withTenant(tenantId, (transaction) => sku(transaction, tenantId).lookup(code));
      const targetA = { kind: 'VARIANT' as const, tenantId: tenantA, variantId: variantA };
      const targetB = { kind: 'VARIANT' as const, tenantId: tenantA, variantId: variantB };
      const targetC = { kind: 'VARIANT' as const, tenantId: tenantB, variantId: variantC };
      const targetD = { kind: 'VARIANT' as const, tenantId: tenantA, variantId: variantD };
      const targetE = { kind: 'VARIANT' as const, tenantId: tenantA, variantId: variantE };
      const optionTarget = { kind: 'PACKAGE_OPTION' as const, packageDefinitionId: optionId, tenantId: tenantA };

      yield* admin.insert(products).values([
        {
          createdByActionInvocationId: randomUUID(),
          createdByPrincipalId: principalId,
          lifecycleState: 'ACTIVE',
          productId: productA,
          tenantId: tenantA,
        },
        {
          createdByActionInvocationId: randomUUID(),
          createdByPrincipalId: principalId,
          lifecycleState: 'ACTIVE',
          productId: productB,
          tenantId: tenantB,
        },
      ]);
      yield* admin.insert(productVariantAxisEvents).values([
        {
          actingPrincipalId: principalId,
          actionInvocationId: randomUUID(),
          attributeDefinitionIds: [],
          axisRevision: 1,
          evidenceRefs: ['sku-postgres-test:source'],
          productId: productA,
          reason: 'Test fixture',
          tenantId: tenantA,
        },
        {
          actingPrincipalId: principalId,
          actionInvocationId: randomUUID(),
          attributeDefinitionIds: [],
          axisRevision: 1,
          evidenceRefs: ['sku-postgres-test:source'],
          productId: productB,
          reason: 'Test fixture',
          tenantId: tenantB,
        },
      ]);
      yield* admin.insert(productVariants).values([
        {
          combinationAxisRevision: 1,
          combinationKey: 'a'.repeat(64),
          createdByActionInvocationId: randomUUID(),
          createdByPrincipalId: principalId,
          lifecycleState: 'ACTIVE',
          productId: productA,
          tenantId: tenantA,
          variantId: variantA,
        },
        {
          combinationAxisRevision: 1,
          combinationKey: 'b'.repeat(64),
          createdByActionInvocationId: randomUUID(),
          createdByPrincipalId: principalId,
          lifecycleState: 'ACTIVE',
          productId: productA,
          tenantId: tenantA,
          variantId: variantB,
        },
        {
          combinationAxisRevision: 1,
          combinationKey: 'c'.repeat(64),
          createdByActionInvocationId: randomUUID(),
          createdByPrincipalId: principalId,
          lifecycleState: 'ACTIVE',
          productId: productB,
          tenantId: tenantB,
          variantId: variantC,
        },
        {
          combinationAxisRevision: 1,
          combinationKey: 'd'.repeat(64),
          createdByActionInvocationId: randomUUID(),
          createdByPrincipalId: principalId,
          lifecycleState: 'ACTIVE',
          productId: productA,
          tenantId: tenantA,
          variantId: variantD,
        },
        {
          combinationAxisRevision: 1,
          combinationKey: 'e'.repeat(64),
          createdByActionInvocationId: randomUUID(),
          createdByPrincipalId: principalId,
          lifecycleState: 'ACTIVE',
          productId: productA,
          tenantId: tenantA,
          variantId: variantE,
        },
      ]);
      yield* admin.insert(productUnits).values({
        code: 'EA',
        currentRuleRevision: 1,
        label: 'Each',
        lifecycleState: 'ACTIVE',
        tenantId: tenantA,
        unitId,
      });
      yield* admin.insert(packageDefinitions).values({
        createdByActionInvocationId: randomUUID(),
        createdByPrincipalId: principalId,
        currentOptionRevision: 1,
        currentRevision: 1,
        lifecycleState: 'ACTIVE',
        optionState: 'ACTIVE',
        packageDefinitionId: optionId,
        productId: productA,
        tenantId: tenantA,
        variantId: variantA,
      });
      yield* admin.insert(packageContentRevisions).values({
        actingPrincipalId: principalId,
        actionInvocationId: randomUUID(),
        amount: '1',
        effectiveAt: observedAt,
        evidenceRefs: ['sku-postgres-test:source'],
        lifecycleState: 'ACTIVE',
        packageDefinitionId: optionId,
        productId: productA,
        reason: 'Test fixture',
        revision: 1,
        tenantId: tenantA,
        unitResourceId: unitId,
        unitResourceType: 'commerce.catalog.product-unit',
        variantId: variantA,
      });
      yield* admin.insert(packageOptionRoleRevisions).values({
        actingPrincipalId: principalId,
        actionInvocationId: randomUUID(),
        contentRevision: 1,
        effectiveAt: observedAt,
        evidenceRefs: ['sku-postgres-test:source'],
        independentlyRequested: true,
        looseUnitsSubstitutable: false,
        packageDefinitionId: optionId,
        productId: productA,
        revision: 1,
        state: 'ACTIVE',
        tenantId: tenantA,
        validationReason: 'Independent package option',
        variantId: variantA,
      });

      const missingTarget = { kind: 'VARIANT' as const, tenantId: tenantA, variantId: randomUUID() };
      expectTagged(yield* assign(tenantA, change('MISSING-00', missingTarget)), 'not_found');
      expectTagged(
        yield* assign(
          tenantA,
          change('MISSING-PACKAGE-00', {
            kind: 'PACKAGE_OPTION',
            packageDefinitionId: randomUUID(),
            tenantId: tenantA,
          }),
        ),
        'not_found',
      );

      yield* admin
        .update(products)
        .set({
          lifecycleState: 'RETIRED',
          retiredEffectiveAt: observedAt,
          retiredReason: 'SKU eligibility test',
        })
        .where(and(eq(products.tenantId, tenantA), eq(products.productId, productA)));
      expectTagged(yield* assign(tenantA, change('RETIRED-PRODUCT-00', targetA)), 'invalid');
      yield* admin
        .update(products)
        .set({ lifecycleState: 'ACTIVE', retiredEffectiveAt: null, retiredReason: null })
        .where(and(eq(products.tenantId, tenantA), eq(products.productId, productA)));

      yield* admin
        .update(productVariants)
        .set({ combinationAxisRevision: null, combinationKey: null, lifecycleState: 'RETIRED' })
        .where(and(eq(productVariants.tenantId, tenantA), eq(productVariants.variantId, variantA)));
      expectTagged(yield* assign(tenantA, change('RETIRED-VARIANT-00', targetA)), 'invalid');
      yield* admin
        .update(productVariants)
        .set({ combinationAxisRevision: 1, combinationKey: 'a'.repeat(64), lifecycleState: 'ACTIVE' })
        .where(and(eq(productVariants.tenantId, tenantA), eq(productVariants.variantId, variantA)));

      yield* admin
        .update(packageDefinitions)
        .set({ lifecycleState: 'RETIRED' })
        .where(and(eq(packageDefinitions.tenantId, tenantA), eq(packageDefinitions.packageDefinitionId, optionId)));
      expectTagged(yield* assign(tenantA, change('RETIRED-PACKAGE-00', optionTarget)), 'invalid');
      yield* admin
        .update(packageDefinitions)
        .set({ lifecycleState: 'ACTIVE' })
        .where(and(eq(packageDefinitions.tenantId, tenantA), eq(packageDefinitions.packageDefinitionId, optionId)));

      yield* admin
        .update(packageDefinitions)
        .set({ optionState: 'RETIRED' })
        .where(and(eq(packageDefinitions.tenantId, tenantA), eq(packageDefinitions.packageDefinitionId, optionId)));
      expectTagged(yield* assign(tenantA, change('RETIRED-OPTION-00', optionTarget)), 'invalid');
      yield* admin
        .update(packageDefinitions)
        .set({ optionState: 'ACTIVE' })
        .where(and(eq(packageDefinitions.tenantId, tenantA), eq(packageDefinitions.packageDefinitionId, optionId)));

      yield* admin.insert(packageContentRevisions).values({
        actingPrincipalId: principalId,
        actionInvocationId: randomUUID(),
        amount: '1',
        effectiveAt: new Date('2020-01-02T00:00:00.000Z'),
        evidenceRefs: ['sku-postgres-test:retired-content'],
        lifecycleState: 'RETIRED',
        packageDefinitionId: optionId,
        productId: productA,
        reason: 'Retired content fixture',
        revision: 2,
        tenantId: tenantA,
        unitResourceId: unitId,
        unitResourceType: 'commerce.catalog.product-unit',
        variantId: variantA,
      });
      yield* admin
        .update(packageDefinitions)
        .set({ currentRevision: 2 })
        .where(and(eq(packageDefinitions.tenantId, tenantA), eq(packageDefinitions.packageDefinitionId, optionId)));
      expectTagged(yield* assign(tenantA, change('RETIRED-CONTENT-00', optionTarget)), 'invalid');
      yield* admin.insert(packageContentRevisions).values({
        actingPrincipalId: principalId,
        actionInvocationId: randomUUID(),
        amount: '1',
        effectiveAt: new Date('2020-01-03T00:00:00.000Z'),
        evidenceRefs: ['sku-postgres-test:restored-content'],
        lifecycleState: 'ACTIVE',
        packageDefinitionId: optionId,
        productId: productA,
        reason: 'Restored content fixture',
        revision: 3,
        tenantId: tenantA,
        unitResourceId: unitId,
        unitResourceType: 'commerce.catalog.product-unit',
        variantId: variantA,
      });
      yield* admin
        .update(packageDefinitions)
        .set({ currentRevision: 3 })
        .where(and(eq(packageDefinitions.tenantId, tenantA), eq(packageDefinitions.packageDefinitionId, optionId)));

      yield* admin.insert(packageOptionRoleRevisions).values({
        actingPrincipalId: principalId,
        actionInvocationId: randomUUID(),
        contentRevision: 3,
        effectiveAt: new Date('2020-01-04T00:00:00.000Z'),
        evidenceRefs: ['sku-postgres-test:retired-role'],
        independentlyRequested: true,
        looseUnitsSubstitutable: false,
        packageDefinitionId: optionId,
        productId: productA,
        revision: 2,
        state: 'RETIRED',
        tenantId: tenantA,
        validationReason: 'Retired package option role fixture',
        variantId: variantA,
      });
      yield* admin
        .update(packageDefinitions)
        .set({ currentOptionRevision: 2 })
        .where(and(eq(packageDefinitions.tenantId, tenantA), eq(packageDefinitions.packageDefinitionId, optionId)));
      expectTagged(yield* assign(tenantA, change('RETIRED-ROLE-00', optionTarget)), 'invalid');
      yield* admin.insert(packageOptionRoleRevisions).values({
        actingPrincipalId: principalId,
        actionInvocationId: randomUUID(),
        contentRevision: 3,
        effectiveAt: new Date('2020-01-05T00:00:00.000Z'),
        evidenceRefs: ['sku-postgres-test:restored-role'],
        independentlyRequested: true,
        looseUnitsSubstitutable: false,
        packageDefinitionId: optionId,
        productId: productA,
        revision: 3,
        state: 'ACTIVE',
        tenantId: tenantA,
        validationReason: 'Restored package option role fixture',
        variantId: variantA,
      });
      yield* admin
        .update(packageDefinitions)
        .set({ currentOptionRevision: 3 })
        .where(and(eq(packageDefinitions.tenantId, tenantA), eq(packageDefinitions.packageDefinitionId, optionId)));

      yield* admin
        .update(productUnits)
        .set({ lifecycleState: 'RETIRED' })
        .where(and(eq(productUnits.tenantId, tenantA), eq(productUnits.unitId, unitId)));
      expectTagged(yield* assign(tenantA, change('RETIRED-UNIT-00', optionTarget)), 'invalid');
      yield* admin
        .update(productUnits)
        .set({ lifecycleState: 'ACTIVE' })
        .where(and(eq(productUnits.tenantId, tenantA), eq(productUnits.unitId, unitId)));

      yield* admin
        .update(packageDefinitions)
        .set({ currentOptionRevision: 4 })
        .where(and(eq(packageDefinitions.tenantId, tenantA), eq(packageDefinitions.packageDefinitionId, optionId)));
      const inconsistentCurrent = yield* Effect.flip(assign(tenantA, change('INDETERMINATE-00', optionTarget)));
      expect(Schema.is(SkuPersistenceUnavailable)(inconsistentCurrent)).toBe(true);
      yield* admin
        .update(packageDefinitions)
        .set({ currentOptionRevision: 3 })
        .where(and(eq(packageDefinitions.tenantId, tenantA), eq(packageDefinitions.packageDefinitionId, optionId)));

      const displayCode = '  MiXeD-01  ';
      expectTagged(yield* assign(tenantA, change(displayCode, targetA)), 'applied', { revision: 1 });
      expectTagged(
        yield* withTenant(tenantA, (transaction) =>
          sku(transaction, tenantA).rename({
            ...change('STALE-01', targetA),
            expectedRevision: 2,
            oldCode: displayCode,
          }),
        ),
        'stale',
      );
      expectTagged(yield* lookup(tenantA, 'mixed-01'), 'found', { displayCode, state: 'CURRENT', target: targetA });
      expectTagged(yield* assign(tenantA, change('MIXED-01', targetB)), 'conflict');
      expectTagged(yield* assign(tenantA, change(' mixed-01 ', optionTarget)), 'conflict');
      expectTagged(yield* assign(tenantB, change('mixed-01', targetC)), 'applied');
      expectTagged(yield* lookup(tenantB, ' MiXeD-01 '), 'found', { target: targetC });

      const rename = change('New-01', targetA);
      expectTagged(
        yield* withTenant(tenantA, (transaction) =>
          sku(transaction, tenantA).rename({ ...rename, expectedRevision: 1, oldCode: displayCode }),
        ),
        'applied',
      );
      expectTagged(yield* lookup(tenantA, ' mixed-01 '), 'found', { displayCode, state: 'HISTORICAL' });
      expectTagged(yield* assign(tenantA, change('MIXED-01', targetB)), 'conflict');
      expectTagged(yield* assign(tenantA, change(' mixed-01 ', optionTarget)), 'conflict');

      const optionCode = '  Pack-02 ';
      expectTagged(yield* assign(tenantA, change(optionCode, optionTarget)), 'applied');
      expectTagged(yield* lookup(tenantA, 'PACK-02'), 'found', { displayCode: optionCode, target: optionTarget });
      expectTagged(yield* assign(tenantA, change('pack-02', targetB)), 'conflict');

      const racing = yield* Effect.all(
        [assign(tenantA, change(' Race-03 ', targetB)), assign(tenantA, change('race-03', targetD))],
        { concurrency: 2 },
      );
      expect(
        racing.filter((outcome) =>
          Match.value(outcome).pipe(
            Match.tag('applied', () => true),
            Match.orElse(() => false),
          ),
        ),
      ).toHaveLength(1);
      expect(
        racing.filter((outcome) =>
          Match.value(outcome).pipe(
            Match.tag('conflict', () => true),
            Match.orElse(() => false),
          ),
        ),
      ).toHaveLength(1);
      expect(
        yield* admin
          .select()
          .from(commercialSkuReservations)
          .where(
            and(
              eq(commercialSkuReservations.tenantId, tenantA),
              eq(commercialSkuReservations.normalizedCode, 'RACE-03'),
            ),
          ),
      ).toHaveLength(1);
      expect(
        yield* admin
          .select()
          .from(commercialSkuAssignmentRevisions)
          .where(
            and(
              eq(commercialSkuAssignmentRevisions.tenantId, tenantA),
              eq(commercialSkuAssignmentRevisions.normalizedCode, 'RACE-03'),
            ),
          ),
      ).toHaveLength(1);

      expectTagged(yield* lookup(tenantA, '   '), 'invalid');
      expectTagged(yield* assign(tenantA, change('   ', targetB)), 'invalid');
      expectTagged(yield* assign(tenantA, change('A'.repeat(241), targetB)), 'invalid');
      expectTagged(yield* lookup(tenantA, 'unassigned'), 'not_found');

      const corrected = change('New-01', targetE);
      expectTagged(
        yield* withTenant(tenantA, (transaction) =>
          sku(transaction, tenantA).correct({ ...corrected, expectedRevision: 1, previousTarget: targetA }),
        ),
        'applied',
      );
      expectTagged(yield* lookup(tenantA, 'new-01'), 'ambiguous');
    }),
  ),
);

it.live('assigns, keeps and replaces the SKU a source route sends for a draft Variant it created', () =>
  Effect.scoped(
    Effect.gen(function* sourceSkuPostgresTest() {
      const tenantId = randomUUID();
      const draftProduct = randomUUID();
      const draftVariant = randomUUID();
      const otherVariant = randomUUID();
      const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
      const admin = yield* makeTestDatabaseFromClient(adminClient, catalogRelations);
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, catalogRelations);
      const withTenant = <Value, Failure>(
        operation: (transaction: CatalogTransaction) => Effect.Effect<Value, Failure>,
      ) =>
        runtime.transaction((transaction) =>
          Effect.gen(function* scopedSourceSkuTransaction() {
            yield* transaction.execute(sql`select set_config('ontos.tenant_id', ${tenantId}, true)`, 'objects');
            return yield* operation(transaction);
          }),
        );
      const source = {
        issuerId: 'akros-erp',
        mappingRevision: 'akros-symmy-products-v1',
        recordId: 'variant:variantId:AKROS-10001-V1',
        recordNamespace: 'akros',
        routeScope: randomUUID(),
      };
      const target = { kind: 'VARIANT' as const, tenantId, variantId: draftVariant };
      const fromSource = (code: string) =>
        withTenant((transaction) => sku(transaction, tenantId).assignFromSource(change(code, target), source));
      yield* admin.insert(products).values({
        createdByActionInvocationId: randomUUID(),
        createdByPrincipalId: principalId,
        lifecycleState: 'DRAFT',
        productId: draftProduct,
        tenantId,
      });
      // A draft Variant is created the way Catalog's create writes it: WORK_IN_PROGRESS carries no combination yet.
      yield* admin.insert(productVariants).values([
        {
          createdByActionInvocationId: randomUUID(),
          createdByPrincipalId: principalId,
          lifecycleState: 'WORK_IN_PROGRESS',
          productId: draftProduct,
          tenantId,
          variantId: draftVariant,
        },
        {
          createdByActionInvocationId: randomUUID(),
          createdByPrincipalId: principalId,
          lifecycleState: 'WORK_IN_PROGRESS',
          productId: draftProduct,
          tenantId,
          variantId: otherVariant,
        },
      ]);
      const otherSource = { ...source, recordId: 'variant:variantId:AKROS-10001-V2' };
      const correlation = (record: typeof source, variantId: string) => ({
        ...record,
        actingPrincipalId: principalId,
        actionInvocationId: randomUUID(),
        entityKind: 'VARIANT',
        intentFingerprint: 'a'.repeat(64),
        productId: draftProduct,
        tenantId,
        variantId,
      });
      yield* admin
        .insert(catalogSourceCorrelations)
        .values([correlation(source, draftVariant), correlation(otherSource, otherVariant)]);

      // A staff assignment still needs an Active Product and Variant.
      expectTagged(
        yield* withTenant((transaction) => sku(transaction, tenantId).assign(change('DIN933-M8', target))),
        'invalid',
      );
      // The source route assigns the first code to its draft Variant, keeps it when it is sent again and replaces it
      // with another one, which leaves the old code reserved as Historical.
      expectTagged(yield* fromSource('DIN933-M8'), 'applied', { revision: 1 });
      expectTagged(yield* fromSource('DIN933-M8'), 'unchanged', { revision: 1 });
      expectTagged(yield* fromSource('DIN933-M8-ZN'), 'applied', { revision: 1 });
      const lookupIn = (code: string) => withTenant((transaction) => sku(transaction, tenantId).lookup(code));
      expectTagged(yield* lookupIn('din933-m8-zn'), 'found', { state: 'CURRENT', target });
      expectTagged(yield* lookupIn('DIN933-M8'), 'found', { state: 'HISTORICAL', target });
      // A source record Catalog does not bind to the Variant is refused.
      expectTagged(
        yield* withTenant((transaction) =>
          sku(transaction, tenantId).assignFromSource(
            change('OTHER-01', { ...target, variantId: otherVariant }),
            source,
          ),
        ),
        'invalid',
      );
      // A code the Tenant already holds, Current for another Variant or Historical for this one, is a conflict.
      expectTagged(
        yield* withTenant((transaction) =>
          sku(transaction, tenantId).assignFromSource(
            change('TAKEN-01', { ...target, variantId: otherVariant }),
            otherSource,
          ),
        ),
        'applied',
        { revision: 1 },
      );
      expectTagged(yield* fromSource('TAKEN-01'), 'conflict');
      expectTagged(yield* fromSource('DIN933-M8'), 'conflict');
      // A Retired Variant never takes a code, from any caller.
      yield* admin
        .update(productVariants)
        .set({ combinationAxisRevision: null, combinationKey: null, lifecycleState: 'RETIRED' })
        .where(and(eq(productVariants.tenantId, tenantId), eq(productVariants.variantId, draftVariant)));
      expectTagged(yield* fromSource('DIN933-M8-A2'), 'invalid');
      expect(
        yield* admin
          .select()
          .from(commercialSkuReservations)
          .where(
            and(
              eq(commercialSkuReservations.tenantId, tenantId),
              eq(commercialSkuReservations.variantId, draftVariant),
            ),
          ),
      ).toHaveLength(2);
    }),
  ),
);
