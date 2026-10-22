import {
  insideDatabaseTransaction,
  refuseInsideDatabaseTransaction,
} from '../../../../packages/core-runtime/src/db/transaction-io-guard.ts';
import { prepareCatalogActionOpenSelections } from '../../src/actions/catalog-action-open-selections.ts';
import { SetProductAttributeValuesPayloadSchema } from '../../shared/actions/attribute-value-mutations.ts';
import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import {
  getActionServiceFactory,
  runActionOwnerSteps,
} from '../../../../packages/core-runtime/src/actions/definition.ts';

import {
  CartOpenSelectionPopulationEvidenceSchema,
  CartOpenSelectionPopulationService,
  CartOpenSelectionPopulationUnavailable,
  cartOpenSelectionPopulationFromEnvironment,
  readCartOpenSelectionPopulation,
} from '../../shared/domain/catalog-open-selection-population.ts';
import { CatalogSelectionSchema } from '../../shared/domain/catalog-selection-evidence.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { setProductAttributeValuesAction } from '../../src/actions/set-product-attribute-values.action.ts';
import { catalogOpenSelectionImpactForScope } from '../../src/persistence/catalog-open-selection-impact.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:open-selection-test:run:1',
    authMethod: 'system',
    principalId: '22222222-2222-4222-8222-222222222222',
    tenantId,
  }),
  correlationId: 'open-selection-test',
};
const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.catalog.product',
  tenantId,
} as const;
const variantRef = {
  moduleId: 'commerce.catalog',
  resourceId: '44444444-4444-4444-8444-444444444444',
  resourceType: 'commerce.catalog.variant',
  tenantId,
} as const;
const selection = Schema.decodeUnknownSync(CatalogSelectionSchema)({ productRef, variantRef });
const foreignTenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const foreignSelection = Schema.decodeUnknownSync(CatalogSelectionSchema)({
  productRef: { ...productRef, tenantId: foreignTenantId },
  variantRef: { ...variantRef, tenantId: foreignTenantId },
});
const decodePopulation = Schema.decodeUnknownSync(CartOpenSelectionPopulationEvidenceSchema);
const population = (selections: readonly { readonly selection: typeof selection; readonly selectionId: string }[]) => ({
  read: () =>
    Effect.succeed(
      decodePopulation({
        complete: true,
        observedAt: '2026-09-18T12:00:00.000Z',
        revisionToken: 'cart-population-1',
        selections,
        tenantId,
      }),
    ),
});
const untouchedTransaction = {
  select: () => {
    throw new Error('must not infer population from private rows');
  },
};

describe('Catalog open-selection impact', () => {
  it.effect('resolves the exact deployment-provided Cart port and preserves an absent binding', () =>
    Effect.gen(function* deploymentBinding() {
      const port = population([]);
      expect(yield* cartOpenSelectionPopulationFromEnvironment).toBeUndefined();
      expect(
        yield* cartOpenSelectionPopulationFromEnvironment.pipe(
          Effect.provideService(CartOpenSelectionPopulationService, port),
        ),
      ).toBe(port);
    }),
  );

  it.effect('fails closed without a durable complete population source', () =>
    Effect.gen(function* rejectUnprovenPopulation() {
      // @ts-expect-error The deliberately unused transaction has no full Drizzle methods.
      const service = catalogOpenSelectionImpactForScope(untouchedTransaction, scope);
      const result = yield* Effect.flip(service.assess(productRef));
      expect(result.code).toBe('catalog_open_selection_impact_unavailable');
    }),
  );

  it.effect('proceeds when the injected Cart owner population is complete and references no open selection', () =>
    Effect.gen(function* provenClear() {
      // @ts-expect-error The deliberately unused transaction is never read for a clear population.
      const service = catalogOpenSelectionImpactForScope(untouchedTransaction, scope, population([]));
      const result = yield* service.assess(productRef);
      expect(result).toBeUndefined();
    }),
  );

  it.effect('reads Cart before BEGIN and binds only its prepared snapshot to the Attribute Action services', () =>
    Effect.gen(function* actionFactoryBinding() {
      let reads = 0;
      const port = {
        read: () =>
          refuseInsideDatabaseTransaction('module-transport', 'cart-open-selection-population').pipe(
            Effect.andThen(
              Effect.sync(() => {
                reads += 1;
              }),
            ),
            Effect.andThen(population([]).read()),
          ),
      };
      const snapshot = yield* makeApplicationCompositionSnapshotFixture(['catalog'], ultramodernApiMarker.buildMarker);
      const prepared = yield* prepareCatalogActionOpenSelections(
        {},
        {
          actionInvocationId: '66666666-6666-4666-8666-666666666666',
          compositionRevision: snapshot.composition.revision,
          scope,
          transaction: () => Effect.die('Cart preparation must not open an owner transaction'),
        },
      ).pipe(Effect.provideService(CartOpenSelectionPopulationService, port));
      const bindServices = yield* getActionServiceFactory(setProductAttributeValuesAction)(
        // @ts-expect-error The impact check over an empty population never reads Catalog persistence.
        untouchedTransaction,
        scope,
        snapshot.composition.revision,
      ).pipe(insideDatabaseTransaction('catalog-factory'));
      const services = yield* bindServices(prepared).pipe(insideDatabaseTransaction('catalog-bind'));
      expect(
        yield* services.assessOpenSelectionImpact(productRef).pipe(insideDatabaseTransaction('catalog-write')),
      ).toBeUndefined();
      expect(
        yield* services.assessOpenSelectionImpact(productRef).pipe(insideDatabaseTransaction('catalog-write-again')),
      ).toBeUndefined();
      expect(reads).toBe(1);
      expect(prepared).toBeDefined();
      if (prepared !== undefined) {
        const failure = yield* prepared.read({ tenantId: foreignTenantId }).pipe(Effect.flip);
        expect(failure.reason).toContain('different Tenant');
      }
    }),
  );

  it.effect('preserves an absent Cart binding without reading owner persistence', () =>
    Effect.gen(function* absentPreparedPopulation() {
      const prepared = yield* prepareCatalogActionOpenSelections(
        {},
        {
          actionInvocationId: '66666666-6666-4666-8666-666666666666',
          compositionRevision: 'catalog-test',
          scope,
          transaction: () => Effect.die('Absent Cart binding must not read owner persistence'),
        },
      );
      expect(prepared).toBeUndefined();
    }),
  );

  it.effect('replays a prepared Cart failure as the existing Action domain error under the transaction mark', () =>
    Effect.gen(function* actionPipelineOwnerUnavailable() {
      let reads = 0;
      const port = {
        read: () =>
          refuseInsideDatabaseTransaction('module-transport', 'cart-open-selection-population').pipe(
            Effect.andThen(
              Effect.sync(() => {
                reads += 1;
              }),
            ),
            Effect.andThen(
              Effect.fail(
                new CartOpenSelectionPopulationUnavailable({
                  code: 'cart_open_selection_population_unavailable',
                  reason: 'Cart is unavailable',
                }),
              ),
            ),
          ),
      };
      const bindServices = yield* getActionServiceFactory(setProductAttributeValuesAction)(
        // @ts-expect-error Cart failure must prevent any use of owner persistence.
        untouchedTransaction,
        scope,
        'catalog-test',
      );
      const payload = Schema.decodeUnknownSync(SetProductAttributeValuesPayloadSchema)({
        attributeDefinitionRef: {
          moduleId: 'commerce.catalog',
          resourceId: '77777777-7777-4777-8777-777777777777',
          resourceType: 'commerce.catalog.attribute-definition',
          tenantId,
        },
        classification: {
          evidenceRefs: ['catalog-review-1'],
          kind: 'EVIDENCED_CORRECTION',
          reason: 'Correct the documented fact',
        },
        expectedRevision: null,
        productRef,
        reason: 'Correct the documented fact',
        values: [{ kind: 'SPECIAL', state: 'UNKNOWN' }],
      });
      const context = {
        actionInvocationId: '66666666-6666-4666-8666-666666666666',
        addDomainEvent: () => Effect.die('Unavailable population must prevent domain events'),
        addOutboxMessage: () => Effect.die('Unavailable population must prevent outbox writes'),
        compositionRevision: 'catalog-test',
        recordAuditEvidence: () => Effect.die('Unavailable population must prevent audit writes'),
        recordDataAccess: () => Effect.die('Unavailable population must prevent data access writes'),
        scope,
        services: bindServices,
      };
      const failure = yield* runActionOwnerSteps(setProductAttributeValuesAction, payload, context).pipe(
        Effect.provideService(CartOpenSelectionPopulationService, port),
        Effect.flip,
      );
      expect(failure).toMatchObject({
        code: 'catalog_open_selection_impact_unavailable',
        reason: 'Cart is unavailable',
      });
      expect(reads).toBe(1);
      const invalidPayload = Schema.decodeUnknownSync(SetProductAttributeValuesPayloadSchema)({
        ...payload,
        classification: {
          evidenceRefs: ['catalog-review-1'],
          kind: 'NEW_REALIZATION' as const,
          newVariantRef: selection.variantRef,
          previousVariantRef: selection.variantRef,
          reason: 'New realization',
        },
      });
      const invalid = yield* runActionOwnerSteps(setProductAttributeValuesAction, invalidPayload, context).pipe(
        Effect.provideService(CartOpenSelectionPopulationService, port),
        Effect.flip,
      );
      expect(invalid).toMatchObject({ code: 'product_attribute_change_conflict' });
      expect(reads).toBe(2);
    }),
  );

  it.effect('rejects a Cart population attested for another Tenant', () =>
    Effect.gen(function* wrongTenantPopulation() {
      const service = catalogOpenSelectionImpactForScope(
        // @ts-expect-error The transaction is never reached when the owner attestation is foreign.
        untouchedTransaction,
        scope,
        {
          read: ({ tenantId: requestedTenantId }) =>
            Effect.succeed({
              complete: true,
              observedAt: '2026-09-18T12:00:00.000Z',
              revisionToken: `cart-population-for-${requestedTenantId}`,
              selections: [],
              tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            }),
        },
      );
      const failure = yield* service.assess(productRef).pipe(Effect.flip);
      expect(failure.reason).toContain('different Tenant');
    }),
  );

  it.effect('rejects a complete population containing a Selection from another Tenant', () =>
    Effect.gen(function* foreignInnerSelection() {
      const failure = yield* readCartOpenSelectionPopulation(
        {
          read: () =>
            Effect.succeed({
              complete: true,
              observedAt: '2026-09-18T12:00:00.000Z',
              revisionToken: 'cart-population-with-foreign-selection',
              selections: [{ selection: foreignSelection, selectionId: 'foreign-selection' }],
              tenantId,
            }),
        },
        tenantId,
      ).pipe(Effect.flip);
      expect(failure.reason).toContain('invalid open-selection population attestation');
    }),
  );

  it.effect('rejects a complete population containing duplicate Selection identities', () =>
    Effect.gen(function* duplicateSelectionIds() {
      const failure = yield* readCartOpenSelectionPopulation(
        {
          read: () =>
            Effect.succeed({
              complete: true,
              observedAt: '2026-09-18T12:00:00.000Z',
              revisionToken: 'cart-population-with-duplicates',
              selections: [
                { selection, selectionId: 'duplicate-selection' },
                { selection, selectionId: 'duplicate-selection' },
              ],
              tenantId,
            }),
        },
        tenantId,
      ).pipe(Effect.flip);
      expect(failure.reason).toContain('invalid open-selection population attestation');
    }),
  );

  it.effect('blocks an impact write when an open selection references the Product', () =>
    Effect.gen(function* referencedProduct() {
      const service = catalogOpenSelectionImpactForScope(
        // @ts-expect-error The transaction is reached only through the injected Catalog evidence reader.
        untouchedTransaction,
        scope,
        population([{ selection, selectionId: 'cart-selection-1' }]),
        () => Effect.succeed({ evidence: { kind: 'NOT_FOUND', requested: selection } }),
      );
      const result = yield* Effect.flip(service.assess(productRef));
      expect(result.code).toBe('catalog_open_selection_impact_unavailable');
      expect(result.reason).toContain('open Catalog selection');
    }),
  );

  it.effect('fails closed when the injected Cart owner read is unavailable', () =>
    Effect.gen(function* ownerUnavailable() {
      const service = catalogOpenSelectionImpactForScope(
        // @ts-expect-error The transaction is never reached when the owner read fails.
        untouchedTransaction,
        scope,
        {
          read: () =>
            Effect.fail(
              new CartOpenSelectionPopulationUnavailable({
                code: 'cart_open_selection_population_unavailable',
                reason: 'Cart is unavailable',
              }),
            ),
        },
      );
      const result = yield* Effect.flip(service.assess(productRef));
      expect(result.code).toBe('catalog_open_selection_impact_unavailable');
    }),
  );
});
