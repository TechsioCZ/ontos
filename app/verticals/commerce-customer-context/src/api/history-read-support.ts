import { ReadHandlerNotFound, ReadHandlerUnavailable, ReadPermissionDenied } from '@app/core-runtime';
import type {
  OperationalScope,
  ReadFinishContext,
  ReadLoadContext,
  ReadServiceFactory,
  ScopedTransactionExecutor,
} from '@app/core-runtime';
import { DateTime, Effect, Match, Option } from 'effect';
import type { Schema } from 'effect';
import type { HistoryCompositionError } from '../../shared/domain/history-errors.ts';
import { CustomerHistoryPortsService, unavailableCustomerHistoryPorts } from '../../shared/domain/history-ports.ts';
import type { CustomerHistoryPorts } from '../../shared/domain/history-ports.ts';
import { counterpartyAssociationReader, customerHistoryPortsAfterCommit } from '../history-production-services.ts';
import type { CounterpartyAssociationRefs, PreloadedCounterpartyAssociation } from '../history-production-services.ts';

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

interface HistoryCompositionInput {
  readonly now: string;
  readonly principalId: string;
}

/**
 * The owner pipeline of every customer history Read. The transaction reads only the owner-local Counterparty
 * association the request names; the composition, which calls external record owners and Core Resource
 * authorization (SpiceDB), runs after commit over that preloaded association.
 */
export const customerHistoryReadPipeline = <
  InputSchema extends Schema.Top & { readonly Type: object },
  Result,
  Failure,
>(options: {
  /** The Counterparty association the request names; Retail requests name none. */
  readonly association?: (input: InputSchema['Type']) => CounterpartyAssociationRefs | undefined;
  readonly compose: (
    ports: CustomerHistoryPorts,
    input: InputSchema['Type'] & HistoryCompositionInput,
  ) => Effect.Effect<Result, HistoryCompositionError>;
  /** The Read's input schema: it fixes the input type every step receives. */
  readonly inputSchema: InputSchema;
  readonly mapError: (error: HistoryCompositionError) => Failure;
  readonly resultCount: (result: Result) => number;
}) => ({
  // oxlint-disable perfectionist/sort-objects -- Steps stay in execution order: each step's types infer from the previous one.
  load: (
    input: InputSchema['Type'],
    context: ReadLoadContext<CustomerHistoryReadServices>,
  ): Effect.Effect<Option.Option<PreloadedCounterpartyAssociation>> => {
    const refs = options.association?.(input);
    return refs === undefined
      ? Effect.succeedNone
      : context.services.counterpartyAssociation(refs).pipe(
          Effect.exit,
          Effect.map((outcome) => Option.some({ outcome, refs })),
        );
  },
  finish: Effect.fn('CustomerHistoryRead.finish')(function* composeCustomerHistory(
    input: InputSchema['Type'],
    context: ReadFinishContext<undefined, Option.Option<PreloadedCounterpartyAssociation>>,
  ) {
    const base = yield* Effect.serviceOption(CustomerHistoryPortsService);
    const ports = yield* customerHistoryPortsAfterCommit(
      Option.getOrElse(base, unavailableCustomerHistoryPorts),
      Option.getOrUndefined(context.loaded),
      context.scope,
    );
    const now = DateTime.formatIso(yield* DateTime.now);
    const result = yield* options
      .compose(ports, { ...input, now, principalId: context.scope.principalId })
      .pipe(Effect.mapError(options.mapError));
    return { evidence: { resultCount: options.resultCount(result) }, result };
  }),
  // oxlint-enable perfectionist/sort-objects
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
