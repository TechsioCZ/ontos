import { Schema } from 'effect';
import type { Effect } from 'effect';
import type {
  DataAccessEventInput,
  DeclaredDomainEvent,
  DomainEventContractMap,
  DomainEventReference,
  OutboxMessage,
} from './events.ts';
import type { ActionCollectorError } from './errors.ts';
import type { OperationalScope } from '../operations/context.ts';

export { TrustedPrincipalContextSchema } from './principal-context.ts';
export type { TrustedPrincipalContext } from './principal-context.ts';

const nonEmptyString = Schema.String.check(Schema.isMinLength(1));
const CorrelationIdSchema = nonEmptyString.pipe(
  Schema.brand('CorrelationId'),
  Schema.decodeTo(Schema.String),
);
const IdempotencyKeySchema = nonEmptyString.pipe(
  Schema.brand('IdempotencyKey'),
  Schema.decodeTo(Schema.String),
);
const TargetModuleKeySchema = nonEmptyString.pipe(
  Schema.brand('TargetModuleKey'),
  Schema.decodeTo(Schema.String),
);
const TargetResourceIdSchema = nonEmptyString.pipe(
  Schema.brand('TargetResourceId'),
  Schema.decodeTo(Schema.String),
);
const TraceIdSchema = nonEmptyString.pipe(Schema.brand('TraceId'), Schema.decodeTo(Schema.String));

export const ActionTransportMetadataSchema = Schema.Struct({
  correlationId: CorrelationIdSchema,
  idempotencyKey: Schema.optionalKey(IdempotencyKeySchema),
  targetModuleKey: Schema.optionalKey(TargetModuleKeySchema),
  targetResourceId: Schema.optionalKey(TargetResourceIdSchema),
  targetResourceType: Schema.optionalKey(nonEmptyString),
  traceId: Schema.optionalKey(TraceIdSchema),
});

export type ActionTransportMetadata = Schema.Schema.Type<typeof ActionTransportMetadataSchema>;

export interface ActionCollectorMethods<DomainEvents extends DomainEventContractMap> {
  readonly addDomainEvent: (
    event: DeclaredDomainEvent<DomainEvents>,
  ) => Effect.Effect<DomainEventReference, ActionCollectorError>;
  readonly addOutboxMessage: (
    domainEvent: DomainEventReference,
    message: OutboxMessage,
  ) => Effect.Effect<void, ActionCollectorError>;
  readonly recordAuditEvidence: (
    evidence: Readonly<Record<string, Schema.Schema.Type<typeof Schema.Json>>>,
  ) => Effect.Effect<void, ActionCollectorError>;
  readonly recordDataAccess: (
    event: DataAccessEventInput,
  ) => Effect.Effect<void, ActionCollectorError>;
}

export interface ActionHandlerContext<
  DomainEvents extends DomainEventContractMap,
  Services = Readonly<Record<string, never>>,
> extends ActionCollectorMethods<DomainEvents> {
  readonly actionInvocationId: string;
  readonly scope: OperationalScope;
  readonly services: Services;
}
