import { ReadHandlerNotFound, ReadHandlerUnavailable, ReadPermissionDenied } from '@app/core-runtime';
import type { OperationalScope, ReadServiceFactory, ScopedTransactionExecutor } from '@app/core-runtime';
import { Effect, Match } from 'effect';
import type { HistoryCompositionError } from '../../shared/domain/history-errors.ts';
import { counterpartyAssociationReader } from '../history-production-services.ts';

/** The one owner-local input of a history composition, read inside the transaction. */
export interface CustomerHistoryReadServices {
  readonly counterpartyAssociation: ReturnType<typeof counterpartyAssociationReader>;
}

export const loadCustomerHistoryReadServices: ReadServiceFactory<CustomerHistoryReadServices> = (
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
) =>
  Effect.succeed({
    counterpartyAssociation:
      scope.legalEntityId === undefined
        ? () => Effect.succeed('INDETERMINATE' as const)
        : counterpartyAssociationReader(transaction, { ...scope, legalEntityId: scope.legalEntityId }),
  });

export interface HistoryReadFailureMessages {
  readonly denied: string;
  readonly notFound: string;
  readonly unavailable: string;
}

export const historyReadErrorMapper = (messages: HistoryReadFailureMessages) => (error: HistoryCompositionError) =>
  Match.value(error).pipe(
    Match.tag(
      'HistoryAccessDenied',
      () =>
        new ReadPermissionDenied({
          code: 'read_permission_denied',
          reason: messages.denied,
        }),
    ),
    Match.tag(
      'HistoryOwnerUnavailable',
      () =>
        new ReadHandlerUnavailable({
          code: 'read_handler_unavailable',
          reason: messages.unavailable,
        }),
    ),
    Match.tag(
      'HistoryRecordNotFound',
      () =>
        new ReadHandlerNotFound({
          code: 'read_handler_not_found',
          reason: messages.notFound,
        }),
    ),
    Match.exhaustive,
  );
