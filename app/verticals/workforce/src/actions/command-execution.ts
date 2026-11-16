import { OperationContextUnavailable, TrustedPrincipalContextSchema } from '@app/core-runtime';
import type {
  ActionHandlerContext,
  ActionServiceFactory,
  ActionServicePreflight,
  ActionServicePreparationContext,
  ActionTargetSetAdmission,
} from '@app/core-runtime';
import { DateTime, Effect, Match, Option, Schema } from 'effect';
import type { EmployeeId } from '../../shared/apis/records.ts';
import type { WorkforceCommandPayload } from '../../shared/actions/apply-command.ts';
import { WorkforceSearchRequestIdSchema } from '../../shared/actions/request-search-rebuild.ts';
import { persistenceService, prepareWorkforceCommand } from '../services/persistence.service.ts';
import {
  OutboxPayloadSchema,
  outboxProducerModuleKey,
  outboxTopic,
} from '../../shared/outbox/demo-workforce-search-refresh-requested-v1.ts';
import { createApplyCommandDemoWorkforceSearchRefreshRequestedV1OutboxMessage } from './apply-command-demo-workforce-search-refresh-requested-v1.outbox-message.ts';

export const domainEvents = { [outboxTopic]: OutboxPayloadSchema } as const;

type Services = Effect.Success<ReturnType<typeof persistenceService>>;
export const handleApplyCommand = Effect.fn('Workforce.applyAndEnqueueSearch')(function* applyAndEnqueueSearch(
  payload: WorkforceCommandPayload,
  context: ActionHandlerContext<typeof domainEvents, Services>,
) {
  const result = yield* context.services.apply(payload.command, payload.expectedRevision);
  // Core flushes this request with the owner write, never before commit or after the transaction.
  // Every employee command matters, including bulk deactivation and removal of approved evidence.
  const refresh = { requestId: WorkforceSearchRequestIdSchema.make(context.actionInvocationId) };
  const event = yield* context.addDomainEvent({
    eventType: outboxTopic,
    payloadJson: refresh,
    producerModuleKey: outboxProducerModuleKey,
    subjectModuleKey: 'core.identity',
    subjectResourceId: context.scope.tenantId,
    subjectResourceType: 'tenant',
  });
  yield* context.addOutboxMessage(event, createApplyCommandDemoWorkforceSearchRefreshRequestedV1OutboxMessage(refresh));
  return result;
});

const samePrincipal = Schema.toEquivalence(TrustedPrincipalContextSchema);

/** Remote facts are command-local. The final transaction reloads Workforce and checks revision and principal eligibility. */
export const prepareApplyCommandServices = Effect.fn('Workforce.prepareApplyCommandServices')(
  function* prepareApplyCommandServices(
    payload: WorkforceCommandPayload,
    context: ActionServicePreparationContext & { readonly targetSetAdmission?: ActionTargetSetAdmission },
  ) {
    const preparedAt = yield* DateTime.now;
    const { targetSetAdmission } = context;
    const ids = Match.value(payload.command).pipe(
      Match.tag('CreateEmployee', () => Option.none<readonly EmployeeId[]>()),
      Match.tag('UpdateEmployee', ({ id }) => Option.some<readonly EmployeeId[]>([id])),
      Match.tag('BulkUpdateEmployees', ({ ids: employeeIds }) => Option.some<readonly EmployeeId[]>(employeeIds)),
      Match.exhaustive,
      Option.getOrUndefined,
    );
    const expectedIds = new Set<string>(ids);
    if (
      ids !== undefined &&
      (targetSetAdmission === undefined ||
        targetSetAdmission.actionInvocationId !== context.actionInvocationId ||
        targetSetAdmission.actionKey !== 'demo.workforce.update-employee' ||
        targetSetAdmission.targetSet.targets.length !== ids.length ||
        targetSetAdmission.targetDecisions.length !== ids.length ||
        targetSetAdmission.targetSet.targets.some(
          ({ moduleKey, recordKey }) => moduleKey !== 'demo.workforce' || !expectedIds.has(recordKey),
        ))
    ) {
      return yield* new OperationContextUnavailable({
        code: 'operation_context_unavailable',
        reason: 'Workforce requires its complete invocation-local employee target set',
      });
    }
    yield* prepareWorkforceCommand(payload.command, context.scope);
    const factory: ActionServiceFactory<Services> = Effect.fn('Workforce.revalidatePreparedCommand')(
      function* revalidatePreparedCommand(transaction, scope, compositionRevision) {
        const now = DateTime.toEpochMillis(yield* DateTime.now);
        const age = now - DateTime.toEpochMillis(preparedAt);
        const deadline = targetSetAdmission?.decision.admissionDeadline;
        if (
          age < 0 ||
          age >= 30_000 ||
          (deadline !== undefined && now >= deadline.getTime()) ||
          !samePrincipal(scope, context.scope) ||
          scope.tenantId !== context.scope.tenantId ||
          scope.legalEntityId !== context.scope.legalEntityId ||
          scope.correlationId !== context.scope.correlationId ||
          compositionRevision !== context.compositionRevision
        ) {
          return yield* new OperationContextUnavailable({
            code: 'operation_context_unavailable',
            reason: 'Prepared Workforce permissions expired or belong to another operation',
          });
        }
        return yield* persistenceService(transaction, { prepared: payload, scope });
      },
    );
    return factory;
  },
) satisfies ActionServicePreflight<
  WorkforceCommandPayload,
  Services,
  Effect.Error<ReturnType<typeof prepareWorkforceCommand>>
>;
