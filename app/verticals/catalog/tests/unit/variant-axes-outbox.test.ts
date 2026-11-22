import { NodeCrypto } from '@effect/platform-node';
import type { ActionHandlerContext } from '@app/core-runtime';
import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import type { PgTable } from 'drizzle-orm/pg-core';
import { Array as EffectArray, Effect, Schema } from 'effect';
import { assert, describe, expect, it } from 'effect-rstest';

import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';

import { GovernVariantAxesPayloadSchema } from '../../shared/actions/govern-variant-axes.ts';
import { OutboxPayloadSchema } from '../../shared/outbox/commerce-catalog-variant-axes-changed-v1.ts';
import { handleGovernVariantAxes } from '../../src/actions/govern-variant-axes.action.ts';
import type { governVariantAxesAction } from '../../src/actions/govern-variant-axes.action.ts';
import {
  VariantAxisWriteConflict,
  variantAxisPersistenceForScope,
} from '../../src/persistence/variant-axis-persistence.ts';
import type { VariantAxisPersistence } from '../../src/persistence/variant-axis-persistence.ts';
import { catalogPersistenceForScope } from '../../src/persistence/catalog-persistence.ts';
import { catalogSourceCorrelationForScope } from '../../src/persistence/catalog-source-correlation.ts';
import { catalogOpenSelectionImpactForScope } from '../../src/persistence/catalog-open-selection-impact.ts';
import type { CatalogOpenSelectionImpactUnavailable } from '../../src/persistence/catalog-open-selection-impact.ts';
import { CreateProductPayloadSchema } from '../../shared/actions/create-product.ts';
import type {
  catalogSourceCorrelations,
  productRevisions,
  productVariantRevisions,
} from '../../src/database/schema.ts';
import { products, productVariants, productVariantAxisEvents } from '../../src/database/schema.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'commerce.catalog.product',
  tenantId,
} as const;
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:variant-axes-outbox:run:1',
    authMethod: 'system',
    principalId: '33333333-3333-4333-8333-333333333333',
    tenantId,
  }),
  correlationId: 'variant-axes-outbox-test',
};
const payload = {
  axes: [],
  classification: {
    evidenceRefs: ['catalog-axis-review-1'],
    kind: 'AXIS_REMOVAL',
    reason: 'Update distinguishing axes',
  },
  expectedAxisRevision: 1,
  productRef,
  reason: 'Update distinguishing axes',
} as const;
const unexpected = () => Effect.die('Unexpected persistence call');

type FreshProductWrite =
  | typeof products.$inferInsert
  | typeof productRevisions.$inferInsert
  | typeof productVariants.$inferInsert
  | typeof productVariantRevisions.$inferInsert
  | typeof catalogSourceCorrelations.$inferInsert
  | typeof productVariantAxisEvents.$inferInsert;
const insertFreshRows = (
  rows: Map<PgTable, readonly object[]>,
  table: PgTable,
  value: FreshProductWrite | FreshProductWrite[],
) =>
  Effect.sync(() => {
    const values = Array.isArray(value) ? value : [value];
    const inserted = values.map((row) => ({
      createdAt: new Date('2026-11-22T00:00:00.000Z'),
      currentRevision: 1,
      updatedAt: new Date('2026-11-22T00:00:00.000Z'),
      ...row,
    }));
    rows.set(table, [...(rows.get(table) ?? []), ...inserted]);
    return inserted;
  });
const conflictFreeInsert = <A>(write: Effect.Effect<A>) => ({
  onConflictDoNothing: () => ({ returning: () => write }),
});
const freshProductTransaction = () => {
  const rows = new Map<PgTable, readonly object[]>();
  const read = (table: PgTable, latest = false) => {
    const result = Effect.sync(() => (latest ? EffectArray.reverse(rows.get(table) ?? []) : (rows.get(table) ?? [])));
    return Object.assign(result, {
      for: () => read(table, latest),
      limit: () => read(table, latest),
      orderBy: () => read(table, true),
    });
  };
  const transaction = {
    delete: (table: PgTable) => ({ where: () => Effect.sync(() => rows.set(table, [])) }),
    insert: (table: PgTable) => ({
      values: (value: FreshProductWrite | FreshProductWrite[]) => {
        const write = insertFreshRows(rows, table, value);
        return Object.assign(write, conflictFreeInsert(write));
      },
    }),
    select: () => ({ from: (table: PgTable) => ({ where: () => read(table) }) }),
  };
  return { rows, transaction };
};

/**
 * Every context here reads only the content-digest revision of one identical Application Composition
 * bundle, so the full decode/encode/digest/validate pass runs once for the whole file.
 */
let cachedCatalogCompositionRevision: string | undefined;
const catalogCompositionRevision = Effect.gen(function* catalogCompositionRevision() {
  if (cachedCatalogCompositionRevision !== undefined) {
    return cachedCatalogCompositionRevision;
  }
  const snapshot = yield* makeApplicationCompositionSnapshotFixture(['catalog'], ultramodernApiMarker.buildMarker);
  cachedCatalogCompositionRevision = snapshot.composition.revision;
  return snapshot.composition.revision;
});

const context = (govern: VariantAxisPersistence['govern']) =>
  Effect.gen(function* makeContext() {
    const compositionRevision = yield* catalogCompositionRevision;
    const events: { eventType: string; payloadJson: unknown; reference: object; subjectResourceId: string }[] = [];
    const outbox: { event: object; message: { payloadJson: unknown; producerModuleKey: string; topic: string } }[] = [];
    const services: VariantAxisPersistence = {
      govern,
      governAllowedValues: unexpected,
      readCurrent: unexpected,
      readCurrentAllowedValues: unexpected,
      readEffectiveValues: unexpected,
      readRecordedCombinations: unexpected,
      readRecordedVariants: unexpected,
    };
    const value: ActionHandlerContext<
      typeof governVariantAxesAction.descriptor.domainEvents,
      VariantAxisPersistence & {
        readonly assessOpenSelectionImpact: () => Effect.Effect<void, CatalogOpenSelectionImpactUnavailable>;
      }
    > = {
      actionInvocationId: '44444444-4444-4444-8444-444444444444',
      addDomainEvent: (event) =>
        Effect.sync(() => {
          const reference = Object.create(null);
          events.push({
            eventType: event.eventType,
            payloadJson: event.payloadJson,
            reference,
            subjectResourceId: event.subjectResourceId,
          });
          return reference;
        }),
      addOutboxMessage: (event, message) =>
        Effect.sync(() => {
          outbox.push({ event, message });
        }),
      compositionRevision,
      recordAuditEvidence: () => Effect.void,
      recordDataAccess: () => Effect.void,
      scope,
      services: { ...services, assessOpenSelectionImpact: () => Effect.void },
    };
    return { events, outbox, value };
  });

describe('committed Variant-axis change event', () => {
  it.effect('creates a real fresh Product then initializes its empty axis basis without a Cart population', () =>
    Effect.gen(function* freshProductAxes() {
      const { rows, transaction } = freshProductTransaction();
      // @ts-expect-error This in-memory seam implements only the exercised Drizzle chains.
      const catalog = yield* catalogPersistenceForScope(transaction, scope);
      const sourceProduct = Schema.decodeUnknownSync(CreateProductPayloadSchema)({
        classification: { kind: 'INDEPENDENT_PRODUCT' },
        name: 'Fresh source Product',
        reason: 'Symmy product import',
        sourceCorrelation: {
          issuerId: 'source-fixture',
          mappingRevision: 'mapping-1',
          recordId: 'fresh-product',
          recordNamespace: 'products',
          routeScope: 'source-route',
          sourceOccurrenceId: 'source-occurrence',
        },
        variantId: '55555555-5555-4555-8555-555555555555',
      });
      const created = yield* catalog.create({
        actionInvocationId: '66666666-6666-4666-8666-666666666666',
        description: sourceProduct.description,
        name: sourceProduct.name,
        principalId: scope.principalId,
        reason: sourceProduct.reason,
        tenantId,
        variantId: sourceProduct.variantId,
      });
      if (!('product' in created)) {
        return yield* Effect.die('The fresh Product creation must succeed');
      }
      // @ts-expect-error Uses the real source-capture owner logic over the same focused Drizzle seam.
      const source = catalogSourceCorrelationForScope(transaction, scope);
      yield* source.captureProduct(
        sourceProduct,
        { product: created.product, variantId: created.variantId },
        '66666666-6666-4666-8666-666666666666',
      );
      expect(created.product.lifecycle).toBe('DRAFT');
      expect(created.product.variants[0]?.lifecycle).toBe('WORK_IN_PROGRESS');
      expect(rows.get(productVariantAxisEvents)).toBeUndefined();
      // @ts-expect-error Uses the real axis persistence over the same focused Drizzle seam.
      const axes = variantAxisPersistenceForScope(transaction, scope);
      // @ts-expect-error No Cart population is installed; this is the real owner impact adapter.
      const impact = catalogOpenSelectionImpactForScope(transaction, scope);
      const state = yield* context(axes.govern);
      const actionContext = {
        ...state.value,
        services: {
          ...state.value.services,
          assessOpenSelectionImpact: () => impact.assess(created.product.productRef),
        },
      };
      const input = Schema.decodeUnknownSync(GovernVariantAxesPayloadSchema)({
        axes: [],
        classification: {
          evidenceRefs: ['source-axis-initialization'],
          kind: 'AXIS_INITIALIZATION',
          reason: sourceProduct.reason,
        },
        expectedAxisRevision: 0,
        productRef: created.product.productRef,
        reason: sourceProduct.reason,
        sourceProduct,
      });
      const result = yield* handleGovernVariantAxes(input, actionContext);
      expect(result).toMatchObject({ axisRevision: 1, changed: true, productRef: created.product.productRef });
      expect(rows.get(productVariantAxisEvents)).toHaveLength(1);
      expect(state.events).toHaveLength(1);
      expect(state.outbox).toHaveLength(1);
      expect(yield* handleGovernVariantAxes(input, actionContext)).toMatchObject({
        axisRevision: 1,
        changed: false,
      });
      const stale = yield* handleGovernVariantAxes({ ...input, expectedAxisRevision: 2 }, actionContext).pipe(
        Effect.flip,
      );
      expect(stale).toMatchObject({ conflict: 'REVISION' });
      expect(rows.get(productVariantAxisEvents)).toHaveLength(1);
      expect(state.events).toHaveLength(1);
      expect(state.outbox).toHaveLength(1);
      const product = rows.get(products)?.[0];
      assert.isDefined(product);
      expect(product).toMatchObject({ currentRevision: 1, lifecycleState: 'DRAFT' });
      expect(rows.get(productVariants)?.[0]).toMatchObject({ currentRevision: 1, lifecycleState: 'WORK_IN_PROGRESS' });
      return yield* Effect.void;
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('keeps additions and removals fail-closed when the Cart population is unavailable', () =>
    Effect.gen(function* existingBasisNeedsCart() {
      const { transaction } = freshProductTransaction();
      // @ts-expect-error The absent owner port fails before this focused transaction seam is queried.
      const impact = catalogOpenSelectionImpactForScope(transaction, scope);
      for (const kind of ['AXIS_ADDITION', 'AXIS_REMOVAL'] as const) {
        const state = yield* context(unexpected);
        const failure = yield* handleGovernVariantAxes(
          { ...payload, classification: { ...payload.classification, kind } },
          {
            ...state.value,
            services: { ...state.value.services, assessOpenSelectionImpact: () => impact.assess(productRef) },
          },
        ).pipe(Effect.flip);
        expect(failure).toMatchObject({ conflict: 'ACTIVE_SELECTION' });
        expect(state.events).toEqual([]);
        expect(state.outbox).toEqual([]);
      }
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('links one Product-source event and outbox message to a changed axis revision', () =>
    Effect.gen(function* changed() {
      const state = yield* context(() => Effect.succeed({ axisRevision: 2, changed: true }));
      yield* handleGovernVariantAxes(payload, state.value);
      expect(state.events).toHaveLength(1);
      expect(state.events[0]).toMatchObject({
        eventType: 'commerce.catalog.variant-axes-changed.v1',
        payloadJson: { axisRevision: 2, productRef, tenantId },
        subjectResourceId: productRef.resourceId,
      });
      expect(state.outbox).toHaveLength(1);
      expect(state.outbox[0]?.event).toBe(state.events[0]?.reference);
      expect(state.outbox[0]?.message).toMatchObject({
        payloadJson: { axisRevision: 2, productRef, tenantId },
        producerModuleKey: 'commerce.catalog',
        topic: 'commerce.catalog.variant-axes-changed.v1',
      });
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('publishes nothing when the governance call is unchanged or rejected', () =>
    Effect.gen(function* unchanged() {
      const noOp = yield* context(() => Effect.succeed({ axisRevision: 1, changed: false }));
      yield* handleGovernVariantAxes(payload, noOp.value);
      expect(noOp.events).toHaveLength(0);
      expect(noOp.outbox).toHaveLength(0);

      const rejected = yield* context(() =>
        Effect.fail(
          new VariantAxisWriteConflict({
            code: 'variant_axis_write_conflict',
            conflict: 'REVISION',
            reason: 'Stale axis revision',
          }),
        ),
      );
      yield* handleGovernVariantAxes(payload, rejected.value).pipe(Effect.flip);
      expect(rejected.events).toHaveLength(0);
      expect(rejected.outbox).toHaveLength(0);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('decodes legacy axes input but fails closed before persistence without change evidence', () =>
    Effect.gen(function* legacyAxesInput() {
      const state = yield* context(unexpected);
      const failure = yield* handleGovernVariantAxes(
        Schema.decodeUnknownSync(GovernVariantAxesPayloadSchema)({
          axes: [],
          expectedAxisRevision: 1,
          productRef,
          reason: 'Legacy axis request',
        }),
        state.value,
      ).pipe(Effect.flip);
      expect(Schema.is(VariantAxisWriteConflict)(failure)).toBe(true);
      expect(failure).toMatchObject({ conflict: 'INVALID_INPUT' });
      expect(state.events).toHaveLength(0);
      expect(state.outbox).toHaveLength(0);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('fails closed before persistence when an axis allowance revision is absent', () =>
    Effect.gen(function* missingAllowanceRevision() {
      const state = yield* context(unexpected);
      const failure = yield* handleGovernVariantAxes(
        Schema.decodeUnknownSync(GovernVariantAxesPayloadSchema)({
          axes: [
            {
              attributeDefinitionRef: {
                moduleId: 'commerce.catalog',
                resourceId: '55555555-5555-4555-8555-555555555555',
                resourceType: 'commerce.catalog.attribute-definition',
                tenantId,
              },
              definitionRevision: 1,
            },
          ],
          classification: {
            evidenceRefs: ['axis-review'],
            kind: 'AXIS_ADDITION',
            reason: 'Add evidenced axis',
          },
          expectedAxisRevision: 1,
          productRef,
          reason: 'Add evidenced axis',
        }),
        state.value,
      ).pipe(Effect.flip);
      expect(failure).toMatchObject({ conflict: 'INVALID_INPUT' });
      expect(state.events).toHaveLength(0);
      expect(state.outbox).toHaveLength(0);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it('rejects an event whose Product subject does not belong to its Tenant', () => {
    const valid = { axisRevision: 2, productRef, tenantId };
    expect(Schema.is(OutboxPayloadSchema)(valid)).toBe(true);
    expect(Schema.is(OutboxPayloadSchema)({ ...valid, tenantId: '55555555-5555-4555-8555-555555555555' })).toBe(false);
  });
});
