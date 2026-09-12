import { Schema } from 'effect';
import type { Effect } from 'effect';

import type { OperationalScope } from '../operations/context.ts';
import type { ActionCollectorError } from './errors.ts';
import type {
  DataAccessEventInput,
  DeclaredDomainEvent,
  DomainEventContractMap,
  DomainEventReference,
  OutboxMessage,
} from './events.ts';
import { decodedStringBrand, nonEmptyString, TargetModuleKeySchema, TargetResourceIdSchema } from './string-schemas.ts';

const committedActionDomainRejection: unique symbol = Symbol('@app/core-runtime/actions/committed-domain-rejection');

class CommittedActionDomainRejectionStorage<DomainError extends { readonly _tag: string }> {
  readonly [committedActionDomainRejection] = true;
  readonly #domainError: DomainError;

  constructor(domainError: DomainError) {
    this.#domainError = domainError;
    Object.freeze(this);
  }

  static domainError<DomainError extends { readonly _tag: string }>(
    rejection: CommittedActionDomainRejectionStorage<DomainError>,
  ): DomainError {
    return rejection.#domainError;
  }
}

/**
 * Opaque successful handler value requesting that Core commit the Action transaction and then
 * raise the enclosed declared domain error to the caller.
 */
export type CommittedActionDomainRejection<DomainError extends { readonly _tag: string }> =
  CommittedActionDomainRejectionStorage<DomainError>;

export const commitActionThenReject = <DomainError extends { readonly _tag: string }>(
  domainError: DomainError,
): CommittedActionDomainRejection<DomainError> => new CommittedActionDomainRejectionStorage(domainError);

/** Internal Core runtime schema for the opaque committed-domain-rejection value. */
export const CommittedActionDomainRejectionSchema = Schema.instanceOf(CommittedActionDomainRejectionStorage);

/** Internal Core runtime accessor. The public package root intentionally does not export it. */
export const getCommittedActionDomainError = <DomainError extends { readonly _tag: string }>(
  rejection: CommittedActionDomainRejection<DomainError>,
): DomainError => CommittedActionDomainRejectionStorage.domainError(rejection);

export { TrustedPrincipalContextSchema } from './principal-context.ts';
export type { TrustedPrincipalContext } from './principal-context.ts';

const CorrelationIdSchema = decodedStringBrand(nonEmptyString, 'CorrelationId');
const IdempotencyKeySchema = decodedStringBrand(nonEmptyString, 'IdempotencyKey');
const TraceIdSchema = decodedStringBrand(nonEmptyString, 'TraceId');

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
  readonly recordDataAccess: (event: DataAccessEventInput) => Effect.Effect<void, ActionCollectorError>;
}

export interface ActionHandlerContext<
  DomainEvents extends DomainEventContractMap,
  Services = Readonly<Record<string, never>>,
> extends ActionCollectorMethods<DomainEvents> {
  readonly actionInvocationId: string;
  readonly scope: OperationalScope;
  readonly services: Services;
}
