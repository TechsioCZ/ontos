import { Schema } from 'effect';
import type { Effect } from 'effect';
import type { CoreTransaction } from '../db/types.ts';
import type {
  DataAccessEventInput,
  DeclaredDomainEvent,
  DomainEventContractMap,
  DomainEventReference,
  OutboxMessage,
} from './events.ts';
import type { ActionCollectorError } from './errors.ts';
import type { TrustedPrincipalContext } from './principal-context.ts';

export { TrustedPrincipalContextSchema } from './principal-context.ts';
export type { TrustedPrincipalContext } from './principal-context.ts';

const nonEmptyString = Schema.String.check(Schema.isMinLength(1));

export const ActionTransportMetadataSchema = Schema.Struct({
  correlationId: nonEmptyString,
  idempotencyKey: Schema.optionalKey(nonEmptyString),
  targetModuleKey: Schema.optionalKey(nonEmptyString),
  targetResourceId: Schema.optionalKey(nonEmptyString),
  targetResourceType: Schema.optionalKey(nonEmptyString),
  traceId: Schema.optionalKey(nonEmptyString),
});

export type ActionTransportMetadata = Schema.Schema.Type<typeof ActionTransportMetadataSchema>;

/**
 * Handler-facing Drizzle surface. It intentionally omits transaction creation,
 * commit, rollback, and raw driver access.
 */
export interface ActionTransactionExecutor {
  readonly delete: CoreTransaction['delete'];
  readonly insert: CoreTransaction['insert'];
  readonly query: CoreTransaction['query'];
  readonly select: CoreTransaction['select'];
  readonly update: CoreTransaction['update'];
}

export interface ActionCollectorMethods<DomainEvents extends DomainEventContractMap> {
  readonly addDomainEvent: (
    event: DeclaredDomainEvent<DomainEvents>,
  ) => Effect.Effect<DomainEventReference, ActionCollectorError>;
  readonly addOutboxMessage: (
    domainEvent: DomainEventReference,
    message: OutboxMessage,
  ) => Effect.Effect<void, ActionCollectorError>;
  readonly recordDataAccess: (
    event: DataAccessEventInput,
  ) => Effect.Effect<void, ActionCollectorError>;
}

export interface ActionHandlerContext<
  DomainEvents extends DomainEventContractMap,
> extends ActionCollectorMethods<DomainEvents> {
  readonly actionInvocationId: string;
  readonly principal: TrustedPrincipalContext;
  readonly transaction: ActionTransactionExecutor;
}

export const restrictTransactionExecutor = (
  transaction: CoreTransaction,
): ActionTransactionExecutor =>
  Object.freeze({
    delete: transaction.delete.bind(transaction),
    insert: transaction.insert.bind(transaction),
    query: transaction.query,
    select: transaction.select.bind(transaction),
    update: transaction.update.bind(transaction),
  });
