import { OperationContextUnavailable, TrustedPrincipalContextSchema } from '@app/core-runtime';
import type {
  ActionHandlerContext,
  ActionServiceFactory,
  ActionServicePreflight,
  ActionServicePreparationContext,
} from '@app/core-runtime';
import { DateTime, Effect, Schema } from 'effect';
import type { SalesInsightsCommandPayload } from '../../shared/actions/apply-command.ts';
import { persistenceService, prepareSalesInsightsCommand } from '../services/persistence.service.ts';

type Services = Effect.Success<ReturnType<typeof persistenceService>>;
export const handleApplyCommand = (
  payload: SalesInsightsCommandPayload,
  context: ActionHandlerContext<Readonly<Record<string, never>>, Services>,
) => context.services.apply(payload.command, payload.expectedRevision, context.actionInvocationId);

const samePrincipal = Schema.toEquivalence(TrustedPrincipalContextSchema);
export const prepareApplyCommandServices = Effect.fn('SalesInsights.prepareApplyCommandServices')(
  function* prepareServices(payload: SalesInsightsCommandPayload, context: ActionServicePreparationContext) {
    const preparedAt = yield* DateTime.now;
    yield* prepareSalesInsightsCommand(payload.command, context.scope);
    const factory: ActionServiceFactory<Services> = Effect.fn('SalesInsights.revalidatePreparedCommand')(
      function* revalidate(transaction, scope, compositionRevision) {
        const age = DateTime.toEpochMillis(yield* DateTime.now) - DateTime.toEpochMillis(preparedAt);
        if (
          age < 0 ||
          age >= 30_000 ||
          !samePrincipal(scope, context.scope) ||
          scope.tenantId !== context.scope.tenantId ||
          scope.legalEntityId !== context.scope.legalEntityId ||
          scope.correlationId !== context.scope.correlationId ||
          compositionRevision !== context.compositionRevision
        ) {
          return yield* new OperationContextUnavailable({
            code: 'operation_context_unavailable',
            reason: 'Prepared SalesInsights permissions expired or belong to another operation',
          });
        }
        return yield* persistenceService(transaction, {
          prepared: { actionInvocationId: context.actionInvocationId, payload },
          scope,
        });
      },
    );
    return factory;
  },
) satisfies ActionServicePreflight<
  SalesInsightsCommandPayload,
  Services,
  Effect.Error<ReturnType<typeof prepareSalesInsightsCommand>>
>;
