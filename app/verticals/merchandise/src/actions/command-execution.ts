import { OperationContextUnavailable, TrustedPrincipalContextSchema } from '@app/core-runtime';
import type {
  ActionHandlerContext,
  ActionServicePreflight,
  ActionServicePreparationContext,
  OperationalScope,
  ScopedTransactionExecutor,
} from '@app/core-runtime';
import { DateTime, Effect, Predicate, Schema } from 'effect';
import { MerchandiseScopeMismatch, MerchandisePermissionDenied } from '../../shared/actions/apply-command.ts';
import type { MerchandiseCommandPayload } from '../../shared/actions/apply-command.ts';
import { AKROS_LEGAL_ENTITY_ID } from '../../shared/actions/command-guard.ts';
import { OutboxPayloadSchema } from '../../shared/outbox/demo-merchandise-search-refresh-requested-v1.ts';
import { createApplyCommandDemoMerchandiseSearchRefreshRequestedV1OutboxMessage } from './apply-command-demo-merchandise-search-refresh-requested-v1.outbox-message.ts';
import { merchandiseSearchRefreshTarget } from '../services/merchandise-search-projection.ts';
import { persistenceService, prepareCommandTax, prepareMerchandiseCommand } from '../services/persistence.service.ts';

const MODULE = 'demo.merchandise';
const SEARCH_REFRESH_EVENT = 'demo.merchandise.search-refresh-requested.v1';
export const domainEvents = { [SEARCH_REFRESH_EVENT]: OutboxPayloadSchema } as const;

type Services = Effect.Success<ReturnType<typeof persistenceService>>;
/** What the handler and its permission preflight need from the Action host. */
type Requirements = Effect.Services<ReturnType<typeof prepareMerchandiseCommand>>;
export const handleApplyCommand = Effect.fn('Merchandise.handleApplyCommand')(function* handleApplyCommand(
  payload: MerchandiseCommandPayload,
  context: ActionHandlerContext<typeof domainEvents, Services>,
) {
  const result = yield* context.services.apply(payload.command, payload.expectedRevision, context.actionInvocationId);
  if (context.scope.legalEntityId === undefined) {
    return yield* new MerchandiseScopeMismatch({
      code: 'merchandise_scope_mismatch',
      reason: 'Merchandise search update requires company scope',
    });
  }
  const target = merchandiseSearchRefreshTarget(payload.command, result.entityIds, context.scope.legalEntityId);
  if (target.rebuild || target.productIds.length > 0 || target.orderIds.length > 0) {
    const event = yield* context.addDomainEvent({
      eventType: SEARCH_REFRESH_EVENT,
      payloadJson: target,
      producerModuleKey: MODULE,
      subjectModuleKey: 'core.identity',
      subjectResourceId: context.scope.tenantId,
      subjectResourceType: 'tenant',
    });
    yield* context.addOutboxMessage(
      event,
      createApplyCommandDemoMerchandiseSearchRefreshRequestedV1OutboxMessage(target),
    );
  }
  return result;
});

const samePrincipal = Schema.toEquivalence(TrustedPrincipalContextSchema);
const PREPARED_GRANTS_TTL_MS = 30_000;

/** Core has admitted the exact narrow Action. Keep the decoded command bound to this invocation and transaction. */
export const prepareApplyCommandServices = Effect.fn('Merchandise.prepareApplyCommandServices')(
  function* prepareApplyCommandServices(payload: MerchandiseCommandPayload, context: ActionServicePreparationContext) {
    if (Predicate.isTagged(payload.command, 'ResetDemoData') && context.scope.legalEntityId !== AKROS_LEGAL_ENTITY_ID) {
      return yield* new MerchandisePermissionDenied({
        code: 'merchandise_permission_denied',
        reason: 'Demo reset is available only in its original demo company',
      });
    }
    const preparedAt = yield* DateTime.now;
    yield* prepareMerchandiseCommand(payload.command, context.scope);
    const taxBook = yield* prepareCommandTax(payload.command, context.scope);
    return Effect.fn('Merchandise.revalidatePreparedGrants')(function* revalidatePreparedGrants(
      transaction: ScopedTransactionExecutor,
      scope: OperationalScope,
      compositionRevision: string,
    ) {
      const age = DateTime.toEpochMillis(yield* DateTime.now) - DateTime.toEpochMillis(preparedAt);
      if (
        age < 0 ||
        age >= PREPARED_GRANTS_TTL_MS ||
        !samePrincipal(scope, context.scope) ||
        scope.tenantId !== context.scope.tenantId ||
        scope.legalEntityId !== context.scope.legalEntityId ||
        scope.correlationId !== context.scope.correlationId ||
        compositionRevision !== context.compositionRevision
      ) {
        return yield* new OperationContextUnavailable({
          code: 'operation_context_unavailable',
          reason: 'Prepared merchandise permissions expired or belong to another operation',
        });
      }
      return yield* persistenceService(transaction, {
        prepared: { actionInvocationId: context.actionInvocationId, payload, taxBook },
        scope,
      });
    });
  },
) satisfies ActionServicePreflight<
  MerchandiseCommandPayload,
  Services,
  MerchandisePermissionDenied | Effect.Error<ReturnType<typeof prepareMerchandiseCommand>>,
  Requirements
>;
