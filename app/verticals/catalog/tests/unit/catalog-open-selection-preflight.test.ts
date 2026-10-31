import {
  insideDatabaseTransaction,
  refuseInsideDatabaseTransaction,
} from '../../../../packages/core-runtime/src/db/transaction-io-guard.ts';
import type { ActionServicePreparationContext } from '@app/core-runtime';
import { DateTime, Effect, Exit } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, it } from 'effect-rstest';
import { getActionServicePreflight } from '../../../../packages/core-runtime/src/actions/definition.ts';
import {
  CartOpenSelectionPopulationService,
  CartOpenSelectionPopulationUnavailable,
} from '../../shared/domain/catalog-open-selection-population.ts';
import {
  prepareCatalogOpenSelectionPopulation,
  validatePreparedCatalogScope,
} from '../../src/services/catalog-open-selection-preflight.ts';
import { setProductTypeAction } from '../../src/actions/set-product-type.action.ts';
import { governVariantAxesAction } from '../../src/actions/govern-variant-axes.action.ts';
import { changeVariantAction } from '../../src/actions/change-variant.action.ts';
import { reactivateVariantAction } from '../../src/actions/reactivate-variant.action.ts';
import { reviseProductTypeAction } from '../../src/actions/revise-product-type.action.ts';
import { reviseAttributeDefinitionAction } from '../../src/actions/revise-attribute-definition.action.ts';
import { governProductAttributeApplicabilityAction } from '../../src/actions/govern-product-attribute-applicability.action.ts';
import { setProductAttributeValuesAction } from '../../src/actions/set-product-attribute-values.action.ts';
import { removeProductAttributeValuesAction } from '../../src/actions/remove-product-attribute-values.action.ts';
import { setVariantAttributeOverrideAction } from '../../src/actions/set-variant-attribute-override.action.ts';
import { removeVariantAttributeOverrideAction } from '../../src/actions/remove-variant-attribute-override.action.ts';
import { activatePackageDefinitionAction } from '../../src/actions/activate-package-definition.action.ts';
import { createSetCompositionAction } from '../../src/actions/create-set-composition.action.ts';
import { reviseSetCompositionAction } from '../../src/actions/revise-set-composition.action.ts';
import { publishProductConfigurationAction } from '../../src/actions/publish-product-configuration.action.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const context: ActionServicePreparationContext = {
  actionInvocationId: '22222222-2222-4222-8222-222222222222',
  compositionRevision: 'a'.repeat(64),
  scope: {
    authMethod: 'system',
    correlationId: 'population-preflight',
    principalId: '33333333-3333-4333-8333-333333333333',
    tenantId,
  },
  transaction: () => Effect.die('Tenant-derived population must not open a SQL transaction'),
};

describe('Catalog Cart population Action preflight', () => {
  it.effect('reads once before commit, retains exact evidence, and never performs HTTP on repeated commit reads', () =>
    Effect.gen(function* preparedPopulation() {
      let remoteReads = 0;
      const observedAt = DateTime.formatIso(yield* DateTime.now);
      const evidence = { complete: true, observedAt, revisionToken: 'cart:population:1', selections: [], tenantId };
      const source = {
        read: () =>
          refuseInsideDatabaseTransaction('outbound-fetch', 'https://cart.example.test/population').pipe(
            Effect.andThen(
              Effect.sync(() => {
                remoteReads += 1;
                return evidence;
              }),
            ),
          ),
      };
      const prepared = yield* prepareCatalogOpenSelectionPopulation(context).pipe(
        Effect.provideService(CartOpenSelectionPopulationService, source),
      );
      expect(remoteReads).toBe(1);
      const port = yield* Effect.fromNullishOr(prepared);
      expect(
        yield* port.read({ tenantId }).pipe(insideDatabaseTransaction('commerce.catalog.govern-variant-axes')),
      ).toEqual(evidence);
      expect(
        yield* port.read({ tenantId }).pipe(insideDatabaseTransaction('commerce.catalog.govern-variant-axes')),
      ).toEqual(evidence);
      const mismatch = yield* port.read({ tenantId: '44444444-4444-4444-8444-444444444444' }).pipe(Effect.flip);
      expect(mismatch.code).toBe('cart_open_selection_population_unavailable');
      yield* TestClock.adjust('30 seconds');
      const expired = yield* port.read({ tenantId }).pipe(Effect.flip);
      expect(expired.reason).toContain('expired');
      expect(remoteReads).toBe(1);
      const rejectedLiveRead = yield* source
        .read()
        .pipe(insideDatabaseTransaction('commerce.catalog.govern-variant-axes'), Effect.exit);
      expect(Exit.isFailure(rejectedLiveRead)).toBe(true);
    }),
  );

  it.effect('preserves remote failure and isolates successive invocations', () =>
    Effect.gen(function* failedAndFreshInvocations() {
      const unavailable = new CartOpenSelectionPopulationUnavailable({
        code: 'cart_open_selection_population_unavailable',
        reason: 'Cart owner unavailable',
      });
      const failed = yield* prepareCatalogOpenSelectionPopulation(context).pipe(
        Effect.provideService(CartOpenSelectionPopulationService, { read: () => Effect.fail(unavailable) }),
      );
      const failedPort = yield* Effect.fromNullishOr(failed);
      expect(yield* failedPort.read({ tenantId }).pipe(Effect.flip)).toBe(unavailable);
      const prepared = yield* prepareCatalogOpenSelectionPopulation({
        ...context,
        actionInvocationId: '55555555-5555-4555-8555-555555555555',
      }).pipe(
        Effect.provideService(CartOpenSelectionPopulationService, {
          read: () =>
            Effect.succeed({
              complete: true,
              observedAt: '2026-10-31T00:00:00.000Z',
              revisionToken: 'new-invocation',
              selections: [],
              tenantId,
            }),
        }),
      );
      const freshPort = yield* Effect.fromNullishOr(prepared);
      expect(yield* freshPort.read({ tenantId })).toMatchObject({ revisionToken: 'new-invocation' });
      expect(yield* failedPort.read({ tenantId }).pipe(Effect.flip)).toBe(unavailable);
    }),
  );

  it.effect(
    'rejects a changed principal, tenant, legal entity, correlation or composition before constructing commit services',
    () =>
      Effect.gen(function* rejectsContextChanges() {
        yield* validatePreparedCatalogScope(context, context.scope, context.compositionRevision);
        for (const scope of [
          { ...context.scope, tenantId: '44444444-4444-4444-8444-444444444444' },
          { ...context.scope, principalId: '55555555-5555-4555-8555-555555555555' },
          { ...context.scope, legalEntityId: '66666666-6666-4666-8666-666666666666' },
          { ...context.scope, correlationId: 'other-request' },
        ]) {
          expect(
            yield* validatePreparedCatalogScope(context, scope, context.compositionRevision).pipe(Effect.flip),
          ).toMatchObject({ code: 'operation_context_unavailable' });
        }
        expect(
          yield* validatePreparedCatalogScope(context, context.scope, 'b'.repeat(64)).pipe(Effect.flip),
        ).toMatchObject({ code: 'operation_context_unavailable' });
      }),
  );

  it('registers preflight for every Cart-dependent Action', () => {
    expect(getActionServicePreflight(setProductTypeAction)).toBeDefined();
    expect(getActionServicePreflight(governVariantAxesAction)).toBeDefined();
    expect(getActionServicePreflight(changeVariantAction)).toBeDefined();
    expect(getActionServicePreflight(reactivateVariantAction)).toBeDefined();
    expect(getActionServicePreflight(reviseProductTypeAction)).toBeDefined();
    expect(getActionServicePreflight(reviseAttributeDefinitionAction)).toBeDefined();
    expect(getActionServicePreflight(governProductAttributeApplicabilityAction)).toBeDefined();
    expect(getActionServicePreflight(setProductAttributeValuesAction)).toBeDefined();
    expect(getActionServicePreflight(removeProductAttributeValuesAction)).toBeDefined();
    expect(getActionServicePreflight(setVariantAttributeOverrideAction)).toBeDefined();
    expect(getActionServicePreflight(removeVariantAttributeOverrideAction)).toBeDefined();
    expect(getActionServicePreflight(activatePackageDefinitionAction)).toBeDefined();
    expect(getActionServicePreflight(createSetCompositionAction)).toBeDefined();
    expect(getActionServicePreflight(reviseSetCompositionAction)).toBeDefined();
    expect(getActionServicePreflight(publishProductConfigurationAction)).toBeDefined();
  });
});
