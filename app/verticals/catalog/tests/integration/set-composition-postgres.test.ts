import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { eq, sql } from 'drizzle-orm';
import { Effect, Match, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { randomUUID } from 'node:crypto';

import {
  makeTestDatabaseFromPool,
  testDatabasePools,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { SetCompositionRevisionSchema } from '../../shared/domain/set-composition.ts';
import { ProductConfigurationSelectionSchema } from '../../shared/domain/catalog-selection-evidence.ts';
import type { CatalogSelection } from '../../shared/domain/catalog-selection-evidence.ts';
import {
  catalogRelations,
  configurationUnitRevisions,
  configurationUnits,
  productConfigurationChoiceOptions,
  productConfigurationChoices,
  productConfigurationDefinitionRevisions,
  productConfigurationDefinitions,
  productConfigurationMeasuredRules,
  productConfigurationOptionAllowances,
  productConfigurationRevisionActivations,
  productUnitRuleRevisions,
  productUnits,
  productVariantAxisEvents,
  productVariants,
  products,
  setCompositionComponents,
  setCompositionRevisions,
  setCompositions,
  variantUnitDivisibility,
} from '../../src/database/schema.ts';
import type { CatalogTransaction } from '../../src/database/types.ts';
import { setCompositionBasisForScope } from '../../src/actions/set-composition-action-support.ts';
import { setCompositionPersistenceForScope } from '../../src/persistence/set-composition-persistence.ts';

// Immutable rows remain in the disposable database; every execution uses new Tenant identities.
const tenantId = randomUUID();
const foreignTenantId = randomUUID();
const principalId = randomUUID();
const setProductId = randomUUID();
const setVariantId = randomUUID();
const configuredSetVariantId = randomUUID();
const shelfId = randomUUID();
const shelfVariantId = randomUUID();
const bracketId = randomUUID();
const bracketVariantId = randomUUID();
const cleanerId = randomUUID();
const cleanerVariantId = randomUUID();
const lightId = randomUUID();
const unitId = randomUUID();
const lengthUnitId = randomUUID();
const configurationDefinitionId = randomUUID();
const at = new Date('2026-09-18T00:00:00.000Z');

const ref = (scopedTenantId: string, type: string, resourceId: string) => ({
  moduleId: 'commerce.catalog',
  resourceId,
  resourceType: `commerce.catalog.${type}`,
  tenantId: scopedTenantId,
});
const scopeFor = (scopedTenantId: string) => ({
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:set-composition-postgres:run:1',
    authMethod: 'system',
    principalId,
    tenantId: scopedTenantId,
  }),
  correlationId: 'set-composition-postgres',
});
const revisionFor = (
  compositionId: string,
  components: readonly {
    amount: string;
    configuration?: CatalogSelection['configuration'];
    productId: string;
    variantId: string;
  }[],
  scopedTenantId: string = tenantId,
  selectedSetVariantId: string = setVariantId,
) =>
  Schema.decodeUnknownSync(SetCompositionRevisionSchema)({
    components: components.map(({ amount, configuration, productId, variantId }) => {
      const selection =
        configuration === undefined
          ? {
              productRef: ref(scopedTenantId, 'product', productId),
              variantRef: ref(scopedTenantId, 'variant', variantId),
            }
          : {
              configuration,
              productRef: ref(scopedTenantId, 'product', productId),
              variantRef: ref(scopedTenantId, 'variant', variantId),
            };
      return {
        componentId: randomUUID(),
        quantity: { amount, unitRef: ref(scopedTenantId, 'product-unit', unitId) },
        selection,
      };
    }),
    productRef: ref(scopedTenantId, 'product', setProductId),
    provenance: { changeKind: 'INITIAL', evidenceRefs: ['catalog:set-postgres-proof'], reason: 'Fixed Set contents' },
    reference: { resourceRef: ref(scopedTenantId, 'set-composition', compositionId), revision: 1 },
    variantRef: ref(scopedTenantId, 'variant', selectedSetVariantId),
  });

it.live('publishes only a proven flat fixed Set with one shelf and two brackets', () =>
  Effect.scoped(
    Effect.gen(function* setCompositionPostgres() {
      const { admin: adminPool, runtimePool } = yield* testDatabasePools;
      const admin = yield* makeTestDatabaseFromPool(adminPool, catalogRelations);
      const runtime = yield* makeTestDatabaseFromPool(runtimePool, catalogRelations);
      const withTenant = <Value, Failure>(
        scopedTenantId: string,
        operation: (transaction: CatalogTransaction) => Effect.Effect<Value, Failure>,
      ) =>
        runtime.transaction((transaction) =>
          Effect.gen(function* scopedSetTransaction() {
            yield* transaction.execute(sql`select set_config('ontos.tenant_id', ${scopedTenantId}, true)`, 'objects');
            return yield* operation(transaction);
          }),
        );
      const publish = (
        scopedTenantId: string,
        compositionId: string,
        components: Parameters<typeof revisionFor>[1],
        selectedSetVariantId: string = setVariantId,
      ) =>
        withTenant(scopedTenantId, (transaction) => {
          const scope = scopeFor(scopedTenantId);
          // Real owner queries run on this transaction; Core's private scope brand is unavailable to this fixture.
          const service = setCompositionPersistenceForScope(
            // @ts-expect-error The integration transaction lacks only Core's private scope brand.
            transaction,
            scope,
            setCompositionBasisForScope(
              // @ts-expect-error The integration transaction lacks only Core's private scope brand.
              transaction,
              scope,
            ),
          );
          return service.publish({
            actingPrincipalId: principalId,
            actionInvocationId: randomUUID(),
            effectiveFrom: at,
            expectedRevision: 0,
            lifecycleState: 'ACTIVE',
            revision: revisionFor(compositionId, components, scopedTenantId, selectedSetVariantId),
          });
        });

      const productIds = [setProductId, shelfId, bracketId, cleanerId, lightId];
      yield* admin.insert(products).values(
        productIds.map((productId) => ({
          createdByActionInvocationId: randomUUID(),
          createdByPrincipalId: principalId,
          lifecycleState: 'ACTIVE',
          name: productId === setProductId ? 'Shelf Set' : 'Independent Product',
          productId,
          tenantId,
        })),
      );
      const variants = [
        { productId: setProductId, variantId: setVariantId },
        { productId: shelfId, variantId: shelfVariantId },
        { productId: bracketId, variantId: bracketVariantId },
        { productId: cleanerId, variantId: cleanerVariantId },
      ];
      yield* admin.insert(productVariantAxisEvents).values(
        variants.map(({ productId }) => ({
          actingPrincipalId: principalId,
          actionInvocationId: randomUUID(),
          attributeDefinitionIds: [],
          axisRevision: 1,
          evidenceRefs: ['catalog:set-postgres-proof'],
          productId,
          reason: 'Single exact Variant',
          tenantId,
        })),
      );
      yield* admin.insert(productVariants).values(
        variants.map(({ productId, variantId }) => ({
          combinationAxisRevision: 1,
          combinationKey: '0'.repeat(64),
          createdByActionInvocationId: randomUUID(),
          createdByPrincipalId: principalId,
          lifecycleState: 'ACTIVE',
          productId,
          tenantId,
          variantId,
        })),
      );
      yield* admin.insert(productUnits).values({
        code: `piece-${unitId}`,
        currentRuleRevision: 1,
        label: 'piece',
        lifecycleState: 'ACTIVE',
        tenantId,
        unitId,
      });
      yield* admin.insert(productUnitRuleRevisions).values({
        actingPrincipalId: principalId,
        actionInvocationId: randomUUID(),
        changeKind: 'CREATED',
        evidenceRefs: ['catalog:set-postgres-proof'],
        lifecycleState: 'ACTIVE',
        reason: 'Whole pieces',
        revision: 1,
        rounding: 'UP',
        step: '1',
        tenantId,
        unitId,
      });
      yield* admin.insert(variantUnitDivisibility).values(
        variants.slice(1, 3).map(({ variantId }) => ({
          currentRevision: 1,
          divisible: false,
          tenantId,
          unitId,
          variantId,
        })),
      );

      const exact = [
        { amount: '1', productId: shelfId, variantId: shelfVariantId },
        { amount: '2', productId: bracketId, variantId: bracketVariantId },
      ];
      const compositionId = randomUUID();
      expect(
        Match.value(yield* publish(tenantId, compositionId, exact)).pipe(
          Match.tag('published', ({ revision }) => revision),
          Match.orElse(() => 0),
        ),
      ).toBe(1);
      const rows = yield* admin
        .select()
        .from(setCompositionComponents)
        .where(eq(setCompositionComponents.compositionId, compositionId));
      expect(rows.map(({ componentProductId, quantityAmount }) => [componentProductId, quantityAmount])).toEqual([
        [shelfId, '1'],
        [bracketId, '2'],
      ]);
      expect(
        rows.some(({ componentProductId }) => componentProductId === cleanerId || componentProductId === lightId),
      ).toBe(false);

      const rejected = [
        [{ amount: '1', productId: randomUUID(), variantId: randomUUID() }, exact[1]],
        [{ amount: '1', productId: shelfId, variantId: randomUUID() }, exact[1]],
      ];
      for (const components of rejected) {
        const rejectedId = randomUUID();
        expect(
          Match.value(yield* publish(tenantId, rejectedId, components)).pipe(
            Match.tag('published', () => true),
            Match.orElse(() => false),
          ),
        ).toBe(false);
        expect(
          yield* admin.select().from(setCompositions).where(eq(setCompositions.compositionId, rejectedId)),
        ).toEqual([]);
        expect(
          yield* admin
            .select()
            .from(setCompositionRevisions)
            .where(eq(setCompositionRevisions.compositionId, rejectedId)),
        ).toEqual([]);
      }
      yield* admin
        .update(products)
        .set({ lifecycleState: 'RETIRED', retiredEffectiveAt: at, retiredReason: 'Postgres rejection proof' })
        .where(eq(products.productId, shelfId));
      const retiredId = randomUUID();
      expect(
        Match.value(yield* publish(tenantId, retiredId, exact)).pipe(
          Match.tag('published', () => true),
          Match.orElse(() => false),
        ),
      ).toBe(false);
      expect(yield* admin.select().from(setCompositions).where(eq(setCompositions.compositionId, retiredId))).toEqual(
        [],
      );
      yield* admin
        .update(products)
        .set({ lifecycleState: 'ACTIVE', retiredEffectiveAt: null, retiredReason: null })
        .where(eq(products.productId, shelfId));
      const indeterminateId = randomUUID();
      expect(
        Match.value(
          yield* publish(tenantId, indeterminateId, [
            { amount: '1', productId: cleanerId, variantId: cleanerVariantId },
            exact[1],
          ]),
        ).pipe(
          Match.tag('published', () => true),
          Match.orElse(() => false),
        ),
      ).toBe(false);
      expect(
        yield* admin.select().from(setCompositions).where(eq(setCompositions.compositionId, indeterminateId)),
      ).toEqual([]);
      expect(() =>
        revisionFor(randomUUID(), [{ amount: '1', productId: setProductId, variantId: setVariantId }, exact[1]]),
      ).toThrow();
      expect(
        Match.value(yield* publish(foreignTenantId, randomUUID(), exact)).pipe(
          Match.tag('published', () => true),
          Match.orElse(() => false),
        ),
      ).toBe(false);
      expect(yield* withTenant(foreignTenantId, (transaction) => transaction.select().from(setCompositions))).toEqual(
        [],
      );
      const role = yield* runtime.execute<{ rolbypassrls: boolean; rolsuper: boolean }>(
        sql`select rolbypassrls, rolsuper from pg_roles where rolname = current_user`,
        'objects',
      );
      expect(role).toEqual([{ rolbypassrls: false, rolsuper: false }]);

      // The shelf now has two owner-issued required choices. The Set basis must
      // read this authority in the same runtime transaction as publication.
      const effectiveFrom = new Date('2026-09-17T00:00:00.000Z');
      const configurationActionId = randomUUID();
      yield* admin.insert(configurationUnits).values({ code: `cm-${lengthUnitId}`, tenantId, unitId: lengthUnitId });
      yield* admin.insert(configurationUnitRevisions).values({
        actingPrincipalId: principalId,
        actionInvocationId: randomUUID(),
        dimension: 'length',
        effectiveFrom,
        evidenceRefs: ['catalog:fixed-set-length'],
        lifecycleState: 'ACTIVE',
        meaning: 'Centimetre',
        reason: 'Fixed shelf length',
        revision: 1,
        tenantId,
        unitId: lengthUnitId,
      });
      yield* admin.insert(productConfigurationDefinitions).values({
        currentRevision: 1,
        definitionId: configurationDefinitionId,
        productId: shelfId,
        tenantId,
      });
      yield* admin.insert(productConfigurationDefinitionRevisions).values({
        actingPrincipalId: principalId,
        actionInvocationId: configurationActionId,
        definitionId: configurationDefinitionId,
        effectiveFrom,
        evidenceRefs: ['catalog:fixed-set-configuration'],
        productId: shelfId,
        reason: 'Required length and type',
        revision: 1,
        state: 'ACTIVE',
        tenantId,
      });
      yield* admin.insert(productConfigurationRevisionActivations).values({
        actingPrincipalId: principalId,
        actionInvocationId: configurationActionId,
        definitionId: configurationDefinitionId,
        effectiveAt: effectiveFrom,
        evidenceRefs: ['catalog:fixed-set-configuration'],
        reason: 'Required length and type',
        revision: 1,
        tenantId,
      });
      yield* admin.insert(productConfigurationChoices).values([
        {
          choiceKey: 'length',
          definitionId: configurationDefinitionId,
          label: 'Length',
          meaning: 'Shelf length in centimetres',
          required: true,
          revision: 1,
          tenantId,
          unitId: lengthUnitId,
          unitRevision: 1,
          valueKind: 'MEASURED_VALUE',
        },
        {
          choiceKey: 'type',
          definitionId: configurationDefinitionId,
          label: 'Type',
          meaning: 'Shelf construction type',
          required: true,
          revision: 1,
          tenantId,
          valueKind: 'SINGLE_CHOICE',
        },
      ]);
      yield* admin.insert(productConfigurationChoiceOptions).values({
        choiceKey: 'type',
        definitionId: configurationDefinitionId,
        label: 'Solid',
        meaning: 'Solid shelf',
        optionKey: 'solid',
        revision: 1,
        tenantId,
      });
      yield* admin.insert(productConfigurationOptionAllowances).values({
        allowed: true,
        choiceKey: 'type',
        definitionId: configurationDefinitionId,
        evidenceRefs: ['catalog:fixed-set-type'],
        optionKey: 'solid',
        productId: shelfId,
        revision: 1,
        tenantId,
      });
      yield* admin.insert(productConfigurationMeasuredRules).values({
        choiceKey: 'length',
        definitionId: configurationDefinitionId,
        evidenceRefs: ['catalog:fixed-set-length'],
        maximum: '83',
        maximumInclusive: true,
        minimum: '83',
        minimumInclusive: true,
        productId: shelfId,
        revision: 1,
        tenantId,
      });
      yield* admin.insert(productVariants).values({
        combinationAxisRevision: 1,
        combinationKey: '1'.repeat(64),
        createdByActionInvocationId: randomUUID(),
        createdByPrincipalId: principalId,
        lifecycleState: 'ACTIVE',
        productId: setProductId,
        tenantId,
        variantId: configuredSetVariantId,
      });
      const configuredShelf = (
        choices: readonly {
          choiceKey: string;
          unit?: { resourceRef: ReturnType<typeof ref>; revision: number };
          value: string;
        }[],
      ) => ({
        ...exact[0],
        configuration: Schema.decodeUnknownSync(ProductConfigurationSelectionSchema)({
          choices,
          definition: {
            resourceRef: ref(tenantId, 'configuration-definition', configurationDefinitionId),
            revision: 1,
          },
          productRef: ref(tenantId, 'product', shelfId),
          variantRef: ref(tenantId, 'variant', shelfVariantId),
        }),
      });
      const lengthChoice = {
        choiceKey: 'length',
        unit: { resourceRef: ref(tenantId, 'unit', lengthUnitId), revision: 1 },
        value: '83',
      };
      const typeChoice = { choiceKey: 'type', value: 'solid' };
      const configurationCases = [
        { label: 'omitted configuration', shelf: exact[0] },
        { label: 'required type missing', shelf: configuredShelf([lengthChoice]) },
      ];
      for (const { label, shelf } of configurationCases) {
        const rejectedId = randomUUID();
        const outcome = yield* publish(tenantId, rejectedId, [shelf, exact[1]], configuredSetVariantId);
        expect(
          Match.value(outcome).pipe(
            Match.tag('invalid', () => true),
            Match.orElse(() => false),
          ),
          label,
        ).toBe(true);
        expect(
          yield* admin.select().from(setCompositions).where(eq(setCompositions.compositionId, rejectedId)),
        ).toEqual([]);
        expect(
          yield* admin
            .select()
            .from(setCompositionRevisions)
            .where(eq(setCompositionRevisions.compositionId, rejectedId)),
        ).toEqual([]);
        expect(
          yield* admin
            .select()
            .from(setCompositionComponents)
            .where(eq(setCompositionComponents.compositionId, rejectedId)),
        ).toEqual([]);
      }
      const configuredId = randomUUID();
      const configured = configuredShelf([lengthChoice, typeChoice]);
      expect(
        Match.value(yield* publish(tenantId, configuredId, [configured, exact[1]], configuredSetVariantId)).pipe(
          Match.tag('published', () => true),
          Match.orElse(() => false),
        ),
      ).toBe(true);
      const configuredRows = yield* admin
        .select()
        .from(setCompositionComponents)
        .where(eq(setCompositionComponents.compositionId, configuredId));
      expect(configuredRows).toHaveLength(2);
      expect(configuredRows[0]?.configuration).toEqual(configured.configuration);
      expect(configuredRows[1]?.configuration).toBeNull();
    }),
  ),
);
