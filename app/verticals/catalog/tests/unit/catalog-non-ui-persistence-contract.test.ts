import { NodeCrypto } from '@effect/platform-node';
import { TrustedPrincipalContextSchema, defineDatabaseIdentityEnrollment } from '@app/core-runtime';
import type { ScopedTransactionExecutor } from '@app/core-runtime';
import {
  createActionCollector,
  getActionHandler,
  getActionServiceFactory,
  installOperationalScope,
} from '@app/core-runtime/testing/actions';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { scriptedPgClientLayer, testSqlConnection } from '@app/core-runtime/testing/scripted-pg-client';
import { getTableColumns } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { DateTime, Effect, Layer, Match, Predicate, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import type { SqlError } from 'effect/sql/SqlError';
import { expect, it } from 'effect-rstest';

import { CreateProductPayloadSchema } from '../../shared/actions/create-product.ts';
import { SetCompositionRevisionSchema } from '../../shared/domain/set-composition.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { createProductAction, handleCreateProduct } from '../../src/actions/create-product.action.ts';
import {
  products,
  productVariants,
  productTypeUntypedDecisions,
  productVariantAxisEvents,
  setCompositions,
  setCompositionRevisions,
} from '../../src/database/schema.ts';
import { productSelectionTypeValueAxisBasisForScope } from '../../src/persistence/product-type-readiness-source.ts';
import { setCompositionPersistenceForScope } from '../../src/persistence/set-composition-persistence.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const productId = '22222222-2222-4222-8222-222222222222';
const variantId = '33333333-3333-4333-8333-333333333333';
const principalId = '44444444-4444-4444-8444-444444444444';
const invocationId = '55555555-5555-4555-8555-555555555555';
const compositionId = '66666666-6666-4666-8666-666666666666';
const instant = '2026-11-07T10:00:00.000Z';
const at = DateTime.makeUnsafe(instant);
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authBindingId: '77777777-7777-4777-8777-777777777777',
    authContextRef: 'better-auth-session:catalog-persistence-unit',
    authMethod: 'session',
    principalId,
    tenantId,
  }),
  correlationId: 'catalog-persistence-unit',
};
const enrollment = defineDatabaseIdentityEnrollment([]);
const ref = (resourceType: string, resourceId: string) => ({
  moduleId: 'commerce.catalog' as const,
  resourceId,
  resourceType: `commerce.catalog.${resourceType}`,
  tenantId,
});
const selection = {
  productRef: { ...ref('product', productId), resourceType: 'commerce.catalog.product' as const },
  variantRef: { ...ref('variant', variantId), resourceType: 'commerce.catalog.variant' as const },
};

/** Full SELECT rows follow the real table's column order, as the native driver protocol does. */
type CatalogSqlRow =
  | typeof products.$inferSelect
  | typeof productVariants.$inferSelect
  | typeof productTypeUntypedDecisions.$inferSelect
  | typeof productVariantAxisEvents.$inferSelect
  | typeof setCompositions.$inferSelect
  | typeof setCompositionRevisions.$inferSelect;
type ColumnValue<Row> = Row extends object ? Row[keyof Row] : never;
const tableRow = (table: PgTable, row: Readonly<Record<string, ColumnValue<CatalogSqlRow>>>) =>
  Object.fromEntries(Object.keys(getTableColumns(table)).map((key) => [key, row[key]]));
const productRow = (id: string, currentRevision: number) =>
  tableRow(products, {
    createdAt: instant,
    createdByActionInvocationId: invocationId,
    createdByPrincipalId: principalId,
    currentRevision,
    description: null,
    lifecycleState: 'DRAFT',
    name: null,
    productId: id,
    retiredEffectiveAt: null,
    retiredReason: null,
    tenantId,
    updatedAt: instant,
  });
const variantRow = (id: string, ownerProductId: string, currentRevision: number) =>
  tableRow(productVariants, {
    combinationAxisRevision: null,
    combinationKey: null,
    createdAt: instant,
    createdByActionInvocationId: invocationId,
    createdByPrincipalId: principalId,
    currentRevision,
    lifecycleState: 'WORK_IN_PROGRESS',
    productId: ownerProductId,
    tenantId,
    updatedAt: instant,
    variantId: id,
  });

type Query = (statement: string, params: readonly unknown[]) => Effect.Effect<readonly object[], SqlError>;

/** One scripted native connection and a genuine installed owner transaction; no admission is claimed. */
const withOwnerSql = <Value, Failure, Requirements>(
  query: Query,
  use: (transaction: ScopedTransactionExecutor) => Effect.Effect<Value, Failure, Requirements>,
  statements: string[],
) =>
  Effect.scoped(
    Effect.gen(function* scopedOwnerSql() {
      const connection = testSqlConnection((statement, params) => {
        statements.push(statement);
        if (/^(?:BEGIN|COMMIT|ROLLBACK)$/u.test(statement)) {
          return Effect.succeed([]);
        }
        if (statement.includes("set_config('ontos.tenant_id'")) {
          expect(params).toEqual([tenantId, '']);
          return Effect.succeed([]);
        }
        if (statement.includes('current_user::text as role')) {
          return Effect.succeed([{ legal_entity_id: '', role: 'ontos_runtime', tenant_id: tenantId }]);
        }
        return query(statement, params);
      });
      const database = yield* testCoreDatabase.pipe(
        Effect.provide(scriptedPgClientLayer(Effect.succeed(connection)).pipe(Layer.provide(Reactivity.layer))),
      );
      return yield* database.transaction((transaction) =>
        installOperationalScope(transaction, scope, enrollment).pipe(Effect.flatMap(use)),
      );
    }),
  );

it.layer(NodeCrypto.layer)('Catalog non-UI scripted SQL contracts', (suite) => {
  for (const kind of ['independent', 'independent-with-reason', 'successor'] as const) {
    suite.effect(`retains exact JSON audit keys for ${kind} through the original create factory`, () =>
      Effect.gen(function* originalCreateEvidence() {
        const snapshot = yield* makeApplicationCompositionSnapshotFixture(
          ['catalog'],
          ultramodernApiMarker.buildMarker,
        );
        const reason = 'Reviewed Product creation';
        const scenario = Match.value(kind).pipe(
          Match.when('successor', () => ({
            evidence: { evidenceRefs: ['catalog:predecessor-review'], reason },
            payload: {
              classification: {
                affectsOpenSelection: true,
                evidenceRefs: ['catalog:predecessor-review'],
                kind: 'NEW_PRODUCT',
                previousProductRef: selection.productRef,
                reason,
              },
              reason,
            },
          })),
          Match.when('independent-with-reason', () => ({ evidence: { reason }, payload: { reason } })),
          Match.when('independent', () => ({ evidence: {}, payload: {} })),
          Match.exhaustive,
        );
        const payload = yield* Schema.decodeUnknownEffect(CreateProductPayloadSchema)(scenario.payload);
        const state = { productId, variantId };
        const statements: string[] = [];
        const query: Query = (statement, params) => {
          if (statement.startsWith('insert into "catalog".')) {
            expect(params).toContain(tenantId);
            expect(params).toContain(principalId);
            expect(params).toContain(invocationId);
          }
          if (statement.startsWith('insert into "catalog"."products"')) {
            const [id] = params;
            if (!Predicate.isString(id)) {
              return Effect.die('Product insert must carry its genuine generated identity');
            }
            state.productId = id;
            return Effect.succeed([]);
          }
          if (statement.startsWith('insert into "catalog"."product_variants"')) {
            const [id] = params;
            if (!Predicate.isString(id)) {
              return Effect.die('Variant insert must carry its genuine generated identity');
            }
            state.variantId = id;
            return Effect.succeed([]);
          }
          if (
            statement.startsWith('insert into "catalog"."product_revisions"') ||
            statement.startsWith('insert into "catalog"."product_variant_revisions"')
          ) {
            return Effect.succeed([]);
          }
          expect(params).toContain(tenantId);
          if (statement.includes('from "catalog"."products"')) {
            const [, id] = params;
            return Predicate.isString(id)
              ? Effect.succeed([productRow(id, 1)])
              : Effect.die('Product lookup must retain its exact owner identity');
          }
          if (statement.includes('from "catalog"."product_variants"')) {
            const [, id] = params;
            return Predicate.isString(id)
              ? Effect.succeed([variantRow(state.variantId, id, 1)])
              : Effect.die('Variant lookup must retain its exact Product');
          }
          if (statement.includes('from "catalog"."product_localized_facts"')) {
            return Effect.succeed([]);
          }
          return Effect.die(`Unexpected create Product SQL: ${statement}`);
        };
        const { descriptor } = createProductAction;
        const collector = createActionCollector(
          descriptor.domainEvents,
          descriptor.owningModuleKey,
          descriptor.accessEvidencePolicy,
          descriptor.auditEvidenceSchema,
          snapshot.composition.revision,
        );
        const result = yield* withOwnerSql(
          query,
          Effect.fn(function* createWithOriginalServices(transaction) {
            const services = yield* getActionServiceFactory(createProductAction)(
              transaction,
              scope,
              snapshot.composition.revision,
            );
            expect(getActionHandler(createProductAction)).toBe(handleCreateProduct);
            return yield* handleCreateProduct(payload, {
              ...collector,
              actionInvocationId: invocationId,
              compositionRevision: snapshot.composition.revision,
              scope,
              services,
            });
          }),
          statements,
        );
        const evidence = collector.snapshot().auditEvidence;
        expect(evidence).toEqual(scenario.evidence);
        expect(Object.values(evidence).every((value) => value !== undefined)).toBe(true);
        expect(collector.snapshot().domainEvents).toHaveLength(1);
        expect(collector.snapshot().dataAccessEvents).toHaveLength(kind === 'successor' ? 2 : 1);
        expect(result.product.productRef.resourceId).toBe(state.productId);
        expect(result.product.revision).toBe(1);
        expect(statements.filter((statement) => statement.startsWith('insert into "catalog".'))).toHaveLength(4);
        expect(statements.at(-1)).toBe('COMMIT');
      }),
    );
  }

  for (const decisionRevision of [9, undefined, null, 0] as const) {
    suite.effect(`never invents an untyped decision revision from ${String(decisionRevision)}`, () =>
      Effect.gen(function* exactUntypedDecisionRevision() {
        const statements: string[] = [];
        const query: Query = (statement, params) => {
          expect(params).toContain(tenantId);
          if (statement.includes('from "catalog"."products"')) {
            return Effect.succeed(
              statement.startsWith('select "current_revision",')
                ? [{ currentRevision: 4, productId, tenantId }]
                : [{ productId }],
            );
          }
          if (statement.includes('from "catalog"."product_variants"')) {
            return Effect.succeed([{ currentRevision: 7, lifecycleState: 'ACTIVE', productId, tenantId, variantId }]);
          }
          if (statement.includes('from "catalog"."product_type_untyped_decisions"')) {
            return Effect.succeed(
              decisionRevision === undefined
                ? []
                : [
                    tableRow(productTypeUntypedDecisions, {
                      actingPrincipalId: principalId,
                      actionInvocationId: invocationId,
                      axisRevision: 3,
                      decisionRevision,
                      decisionState: 'CONFIRMED',
                      evidenceRefs: ['catalog:confirmed-untyped'],
                      productId,
                      productRevision: 4,
                      reason: 'No structured Product Type is required',
                      recordedAt: instant,
                      structuredAttributesRequired: false,
                      tenantId,
                      valueRevisionTokens: [],
                      variantAxesRequired: false,
                      variantRevisionTokens: [`${variantId}:7`],
                    }),
                  ],
            );
          }
          if (statement.includes('from "catalog"."product_variant_axis_events"')) {
            return Effect.succeed([
              tableRow(productVariantAxisEvents, {
                actingPrincipalId: principalId,
                actionInvocationId: invocationId,
                attributeDefinitionIds: [],
                attributeDefinitionRevisions: [],
                axisRevision: 3,
                evidenceRefs: ['catalog:axes-cleared'],
                productId,
                reason: 'Axes cleared',
                recordedAt: instant,
                tenantId,
              }),
            ]);
          }
          if (
            statement.includes('from "catalog"."product_type_assignments"') ||
            statement.includes('from "catalog"."product_variant_axes"') ||
            statement.includes('from "catalog"."attribute_value_sets"')
          ) {
            return Effect.succeed([]);
          }
          return Effect.die(`Unexpected Product Type readiness SQL: ${statement}`);
        };
        const result = yield* withOwnerSql(
          query,
          (transaction) => productSelectionTypeValueAxisBasisForScope(transaction, scope).read(selection, at),
          statements,
        );
        if (decisionRevision === 9) {
          expect(result.reason).toBeNull();
          expect(result.basis).toEqual([
            {
              provenance: 'CATALOG_OWNER_CONFIRMED_UNTYPED_DECISION',
              role: 'PRODUCT_TYPE_UNTYPED_DECISION',
              source: { resourceRef: selection.productRef, revision: 9 },
            },
          ]);
        } else {
          expect(result).toMatchObject({ status: 'INDETERMINATE' });
          expect(result.basis.some(({ role }) => role === 'PRODUCT_TYPE_UNTYPED_DECISION')).toBe(false);
        }
        expect(statements.some((statement) => /^(?:insert|update|delete)\b/iu.test(statement))).toBe(false);
        expect(statements.at(-1)).toBe('COMMIT');
      }),
    );
  }

  const revision = Schema.decodeUnknownSync(SetCompositionRevisionSchema)({
    components: ['88888888-8888-4888-8888-888888888888', '99999999-9999-4999-8999-999999999999'].map(
      (componentId, index) => ({
        componentId,
        quantity: { amount: String(index + 1), unitRef: ref('product-unit', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') },
        selection: {
          productRef: ref('product', componentId),
          variantRef: ref('variant', componentId),
        },
      }),
    ),
    productRef: selection.productRef,
    provenance: { changeKind: 'INITIAL', evidenceRefs: ['catalog:set-review'], reason: 'Reviewed fixed contents' },
    reference: { resourceRef: ref('set-composition', compositionId), revision: 1 },
    variantRef: selection.variantRef,
  });

  for (const missing of ['product', 'variant', 'composition', 'stale', 'retained-owner'] as const) {
    suite.effect(`returns an honest Set publication outcome for ${missing}`, () =>
      Effect.gen(function* honestPublicationOutcome() {
        const statements: string[] = [];
        const query: Query = (statement, params) => {
          expect(params).toContain(tenantId);
          if (statement.includes('from "catalog"."set_composition_revisions"')) {
            return Effect.succeed(
              missing === 'retained-owner'
                ? [
                    tableRow(setCompositionRevisions, {
                      actingPrincipalId: principalId,
                      actionInvocationId: invocationId,
                      changeKind: revision.provenance.changeKind,
                      compositionId,
                      effectiveFrom: instant,
                      effectiveTo: null,
                      evidenceRefs: [...revision.provenance.evidenceRefs],
                      lifecycleState: 'ACTIVE',
                      predecessorRevision: null,
                      productId,
                      reason: revision.provenance.reason,
                      recordedAt: instant,
                      revision: 1,
                      tenantId,
                      variantId,
                    }),
                  ]
                : [],
            );
          }
          if (statement.includes('from "catalog"."products"')) {
            return Effect.succeed(missing === 'product' ? [] : [productRow(productId, 4)]);
          }
          if (statement.includes('from "catalog"."product_variants"')) {
            return Effect.succeed(missing === 'variant' ? [] : [variantRow(variantId, productId, 7)]);
          }
          if (statement.includes('from "catalog"."set_compositions"')) {
            return Effect.succeed(
              missing === 'stale'
                ? [
                    tableRow(setCompositions, {
                      compositionId,
                      createdAt: instant,
                      currentRevision: 2,
                      productId,
                      tenantId,
                      updatedAt: instant,
                      variantId,
                    }),
                  ]
                : [],
            );
          }
          return Effect.die(`Refused publication must not write or read unrelated owner data: ${statement}`);
        };
        const next = yield* Schema.decodeUnknownEffect(SetCompositionRevisionSchema)(
          missing === 'composition'
            ? {
                ...revision,
                predecessor: revision.reference,
                provenance: { ...revision.provenance, changeKind: 'MATERIAL_CHANGE' as const },
                reference: { ...revision.reference, revision: 2 },
              }
            : revision,
        );
        const result = yield* withOwnerSql(
          query,
          (transaction) =>
            setCompositionPersistenceForScope(transaction, scope, {
              verify: () => Effect.die('A refused target must not reach the component authority'),
            }).publish({
              actingPrincipalId: principalId,
              actionInvocationId: invocationId,
              effectiveFrom: DateTime.toDateUtc(at),
              expectedRevision: missing === 'composition' ? 1 : 0,
              lifecycleState: 'ACTIVE',
              revision: next,
            }),
          statements,
        ).pipe(Effect.result);
        if (missing === 'retained-owner') {
          expect(result).toMatchObject({ failure: { _tag: 'SetCompositionPersistenceUnavailable' } });
          expect(statements.at(-1)).toBe('ROLLBACK');
        } else {
          expect(result).toMatchObject({
            success: missing === 'stale' ? { _tag: 'stale', actualRevision: 2 } : { _tag: 'not_found' },
          });
          expect(statements.at(-1)).toBe('COMMIT');
          expect(statements.filter((statement) => statement.includes('for update')).length).toBeGreaterThan(0);
        }
        expect(statements.some((statement) => /^(?:insert|update|delete)\b/iu.test(statement))).toBe(false);
      }),
    );
  }
});
