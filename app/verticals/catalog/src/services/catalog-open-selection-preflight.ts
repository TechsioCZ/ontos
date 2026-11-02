import type { ActionServicePreparationContext, OperationalScope } from '@app/core-runtime';
import { OperationContextUnavailable, TrustedPrincipalContextSchema } from '@app/core-runtime';
import { DateTime, Effect, Result, Schema } from 'effect';
import {
  CartOpenSelectionPopulationUnavailable,
  cartOpenSelectionPopulationFromEnvironment,
  readCartOpenSelectionPopulation,
} from '../../shared/domain/catalog-open-selection-population.ts';
import type { CartOpenSelectionPopulationPort } from '../../shared/domain/catalog-open-selection-population.ts';

/** Tenant is the entire remote selector. Owner-local candidate/revision checks still run at commit. */
export const prepareCatalogOpenSelectionPopulation = Effect.fn('CatalogOpenSelections.prepare')(
  function* preparePopulation(context: ActionServicePreparationContext) {
    const source = yield* cartOpenSelectionPopulationFromEnvironment;
    if (source === undefined) {
      return {
        read: () =>
          Effect.fail(
            new CartOpenSelectionPopulationUnavailable({
              code: 'cart_open_selection_population_unavailable',
              reason: 'A complete Current Cart selection basis is required',
            }),
          ),
      };
    }
    const preparedAt = yield* DateTime.now;
    // Preserve unavailable evidence for the existing domain-specific error mapping at the use site.
    const result = yield* readCartOpenSelectionPopulation(source, context.scope.tenantId).pipe(Effect.result);
    const population: CartOpenSelectionPopulationPort = {
      read: Effect.fn('CatalogOpenSelections.readPrepared')(function* readPrepared(input) {
        const now = yield* DateTime.now;
        const age = DateTime.toEpochMillis(now) - DateTime.toEpochMillis(preparedAt);
        if (input.tenantId !== context.scope.tenantId || age < 0 || age >= 30_000) {
          return yield* new CartOpenSelectionPopulationUnavailable({
            code: 'cart_open_selection_population_unavailable',
            reason: 'Prepared Cart population is expired or belongs to another Tenant',
          });
        }
        return yield* Result.isFailure(result) ? Effect.fail(result.failure) : Effect.succeed(result.success);
      }),
    };
    return population;
  },
);

const samePrincipal = Schema.toEquivalence(TrustedPrincipalContextSchema);

export const validatePreparedCatalogScope = (
  context: ActionServicePreparationContext,
  scope: OperationalScope,
  revision: string,
): Effect.Effect<void, OperationContextUnavailable> =>
  scope.tenantId === context.scope.tenantId &&
  scope.legalEntityId === context.scope.legalEntityId &&
  samePrincipal(scope, context.scope) &&
  scope.correlationId === context.scope.correlationId &&
  revision === context.compositionRevision
    ? Effect.void
    : Effect.fail(
        new OperationContextUnavailable({
          code: 'operation_context_unavailable',
          reason: 'Prepared Cart population belongs to another operation context',
        }),
      );
