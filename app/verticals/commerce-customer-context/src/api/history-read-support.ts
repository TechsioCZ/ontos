import {
  ReadHandlerNotFound,
  ReadHandlerUnavailable,
  ReadPermissionDenied,
} from '@app/core-runtime';
import type { OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import { Effect, Match, Option } from 'effect';
import type { HistoryCompositionError } from '../../shared/domain/history-errors.ts';
import {
  CustomerHistoryPortsService,
  unavailableCustomerHistoryPorts,
} from '../../shared/domain/history-ports.ts';
import { customerHistoryPortsForOperation } from '../history-production-services.ts';

/** Production loader; the API host chooses live or explicit fail-closed owner adapters. */
export const loadCustomerHistoryReadServices = (
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
) =>
  Effect.serviceOption(CustomerHistoryPortsService).pipe(
    Effect.flatMap((ports) =>
      customerHistoryPortsForOperation(
        Option.getOrElse(ports, unavailableCustomerHistoryPorts),
        transaction,
        scope,
      ),
    ),
    Effect.map((ports) => ({ ports })),
  );

export interface HistoryReadFailureMessages {
  readonly denied: string;
  readonly notFound: string;
  readonly unavailable: string;
}

export const historyReadErrorMapper =
  (messages: HistoryReadFailureMessages) => (error: HistoryCompositionError) =>
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
