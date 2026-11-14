import type { TaggingPermissionDenied, TaggingCommandPayload } from '../../shared/actions/apply-command.ts';
import { OperationContextUnavailable, TrustedPrincipalContextSchema } from '@app/core-runtime';
import type {
  ActionHandlerContext,
  ActionServiceFactory,
  ActionServicePreflight,
  ActionServicePreparationContext,
} from '@app/core-runtime';
import { DateTime, Effect, Schema } from 'effect';
import { withCommandGuard } from '../../shared/actions/command-guard.ts';
import { persistenceService, prepareTaggingCommand } from '../services/persistence.service.ts';

type Services = Effect.Success<ReturnType<typeof persistenceService>>;
export const handleApplyCommand = (
  payload: TaggingCommandPayload,
  context: ActionHandlerContext<Readonly<Record<string, never>>, Services>,
): Effect.Effect<Effect.Success<ReturnType<Services['apply']>>, Effect.Error<ReturnType<Services['apply']>>> =>
  context.services.apply(payload.command, payload.expectedRevision, context.actionInvocationId);

const samePrincipal = Schema.toEquivalence(TrustedPrincipalContextSchema);

export const prepareApplyCommandServices = withCommandGuard(
  Effect.fn('Tagging.prepareApplyCommandServices')(function* prepareServices(
    payload: TaggingCommandPayload,
    context: ActionServicePreparationContext,
  ) {
    const preparedAt = yield* DateTime.now;
    yield* prepareTaggingCommand(payload.command, context.scope);
    const factory: ActionServiceFactory<Services> = Effect.fn('Tagging.revalidatePreparedCommand')(
      function* revalidatePreparedCommand(transaction, scope, compositionRevision) {
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
            reason: 'Prepared Tagging permissions expired or belong to another operation',
          });
        }
        return yield* persistenceService(transaction, {
          prepared: { actionInvocationId: context.actionInvocationId, payload },
          scope,
        });
      },
    );
    return factory;
  }),
) satisfies ActionServicePreflight<
  TaggingCommandPayload,
  Services,
  Effect.Error<ReturnType<typeof prepareTaggingCommand>> | TaggingPermissionDenied
>;
