import type {
  ActionHandlerContext,
  DataAccessEventInput,
  DomainEventContractMap,
  OutboxMessage,
} from '@app/core-runtime';
import { Effect } from 'effect';
import type { Schema } from 'effect';
import type { CommerceCustomerGroup, CustomerGroupIsoTimestamp } from '../../shared/domain/group-contract.ts';
import {
  CustomerGroupNotFound,
  CustomerGroupRevisionConflict,
  CustomerGroupScopeMismatch,
} from '../../shared/domain/group-errors.ts';
import type { CustomerGroupPersistenceUnavailableError } from '../../shared/domain/group-errors.ts';
import type { CustomerGroupPersistence } from '../../shared/domain/group-service.ts';
import type { CustomerGroupRef } from '../../shared/resources/customer-group.ts';
import {
  customerGroupRecordedAt,
  customerGroupScopeMatches,
  requireCustomerGroupLegalEntityId,
} from './customer-group-action-support.ts';

interface CustomerGroupActionPayload {
  readonly expectedRevision: number;
  readonly groupRef: CustomerGroupRef;
  readonly reason: string;
}

interface CustomerGroupActionCommand {
  readonly actionInvocationId: string;
  readonly expectedRevision: number;
  readonly groupRef: CustomerGroupRef;
  readonly legalEntityId: string;
  readonly principalId: string;
  readonly reason: string;
  readonly recordedAt: CustomerGroupIsoTimestamp;
  readonly tenantId: string;
}

interface CustomerGroupActionInvocation<
  DomainEvents extends DomainEventContractMap,
  Payload extends CustomerGroupActionPayload,
> {
  readonly command: CustomerGroupActionCommand;
  readonly context: ActionHandlerContext<DomainEvents, CustomerGroupPersistence>;
  readonly payload: Payload;
}

interface CustomerGroupActionPersistenceResult {
  readonly _tag: string;
}
/* oxlint-disable effect-native/no-hand-rolled-tagged-union -- These private persistence sentinels mirror the existing adapter protocol; schema migration is outside this lint-only change. */
type CustomerGroupActionCommonPersistenceResult =
  | { readonly _tag: 'not_found' }
  | { readonly _tag: 'revision_conflict'; readonly actualRevision: number };
/* oxlint-enable effect-native/no-hand-rolled-tagged-union */

interface CustomerGroupActionResolvedResult {
  readonly changed: boolean;
  readonly group: CommerceCustomerGroup;
}

// oxlint-disable-next-line effect-native/no-json-schema-as-document-contract -- Audit evidence is an intentionally open JSON metadata bag consumed by the existing action runtime boundary.
type CustomerGroupActionAuditEvidence = Readonly<Record<string, Schema.Schema.Type<typeof Schema.Json>>>;

interface CustomerGroupActionSpec<
  DomainEvents extends DomainEventContractMap,
  Payload extends CustomerGroupActionPayload,
  PersistenceResult extends CustomerGroupActionPersistenceResult,
  ResolvedResult extends CustomerGroupActionResolvedResult,
  OperationError extends { readonly _tag: string },
  EventType extends keyof DomainEvents & string,
> {
  readonly auditEvidence: (input: {
    readonly payload: Payload;
    readonly recordedAt: CustomerGroupIsoTimestamp;
    readonly resolved: NoInfer<ResolvedResult>;
  }) => CustomerGroupActionAuditEvidence;
  readonly dataAccess: (input: {
    readonly payload: Payload;
    readonly resolved: NoInfer<ResolvedResult>;
  }) => DataAccessEventInput;
  readonly event: {
    readonly eventType: EventType;
    readonly outboxMessage: (payload: DomainEvents[EventType]['Type']) => OutboxMessage;
    readonly payload: (
      payload: Payload,
      resolved: NoInfer<ResolvedResult>,
      recordedAt: CustomerGroupIsoTimestamp,
    ) => DomainEvents[EventType]['Type'];
  };
  readonly invoke: (
    input: CustomerGroupActionInvocation<DomainEvents, Payload>,
  ) => Effect.Effect<PersistenceResult, CustomerGroupPersistenceUnavailableError>;
  readonly resolve: (
    result: Exclude<PersistenceResult, CustomerGroupActionCommonPersistenceResult>,
  ) => Effect.Effect<ResolvedResult, OperationError>;
}

const resolveCustomerGroupActionResult = <
  PersistenceResult extends CustomerGroupActionPersistenceResult,
  ResolvedResult extends CustomerGroupActionResolvedResult,
  OperationError extends { readonly _tag: string },
>(
  result: PersistenceResult,
  resolveOperation: (
    result: Exclude<PersistenceResult, CustomerGroupActionCommonPersistenceResult>,
  ) => Effect.Effect<ResolvedResult, OperationError>,
): Effect.Effect<
  ResolvedResult,
  InstanceType<typeof CustomerGroupNotFound> | InstanceType<typeof CustomerGroupRevisionConflict> | OperationError
> => {
  // oxlint-disable-next-line effect-native/no-manual-tag-comparison -- This generic helper needs the local short-circuit before its operation-result assertion; Match does not preserve the required generic narrowing.
  if (result._tag === 'not_found') {
    return Effect.fail(
      new CustomerGroupNotFound({
        code: 'customer_group_not_found',
        reason: 'The customer group does not exist',
      }),
    );
  }
  // oxlint-disable-next-line effect-native/no-manual-tag-comparison -- This generic helper needs the local short-circuit before reading revision data and excluding shared outcomes from the resolver branch.
  if (result._tag === 'revision_conflict') {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: The persistence result contract guarantees actualRevision whenever the discriminant is revision_conflict.
    const revisionConflict = result as Extract<
      PersistenceResult,
      { readonly _tag: 'revision_conflict'; readonly actualRevision: number }
    >;
    return Effect.fail(
      new CustomerGroupRevisionConflict({
        actualRevision: revisionConflict.actualRevision,
        code: 'customer_group_revision_conflict',
        reason: 'The customer group was changed by another operation',
      }),
    );
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: Both shared persistence-result discriminants have returned, leaving only the operation-specific result accepted by the resolver.
  return resolveOperation(result as Exclude<PersistenceResult, CustomerGroupActionCommonPersistenceResult>);
};

export const executeCustomerGroupAction = Effect.fn('CustomerGroupActionHandler.executeCustomerGroupAction')(
  function* executeCustomerGroupActionEffect<
    DomainEvents extends DomainEventContractMap,
    Payload extends CustomerGroupActionPayload,
    PersistenceResult extends CustomerGroupActionPersistenceResult,
    ResolvedResult extends CustomerGroupActionResolvedResult,
    OperationError extends { readonly _tag: string },
    EventType extends keyof DomainEvents & string,
  >(
    payload: Payload,
    context: ActionHandlerContext<DomainEvents, CustomerGroupPersistence>,
    spec: CustomerGroupActionSpec<DomainEvents, Payload, PersistenceResult, ResolvedResult, OperationError, EventType>,
  ) {
    if (!customerGroupScopeMatches(context.scope.tenantId, payload.groupRef)) {
      return yield* new CustomerGroupScopeMismatch({
        code: 'customer_group_scope_mismatch',
        reason: 'The customer-group reference must belong to the trusted Tenant',
      });
    }
    const recordedAt = yield* customerGroupRecordedAt;
    const legalEntityId = yield* requireCustomerGroupLegalEntityId(context.scope.legalEntityId);
    const command = {
      actionInvocationId: context.actionInvocationId,
      expectedRevision: payload.expectedRevision,
      groupRef: payload.groupRef,
      legalEntityId,
      principalId: context.scope.principalId,
      reason: payload.reason,
      recordedAt,
      tenantId: context.scope.tenantId,
    } as const;
    const result = yield* spec.invoke({ command, context, payload });
    const resolved = yield* resolveCustomerGroupActionResult(result, spec.resolve);
    yield* context.recordAuditEvidence(spec.auditEvidence({ payload, recordedAt, resolved }));
    yield* context.recordDataAccess(spec.dataAccess({ payload, resolved }));
    if (resolved.changed) {
      const eventPayload = spec.event.payload(payload, resolved, recordedAt);
      const event = yield* context.addDomainEvent({
        eventType: spec.event.eventType,
        payloadJson: eventPayload,
        producerModuleKey: 'commerce.customer-context',
        subjectModuleKey: 'commerce.customer-context',
        subjectResourceId: resolved.group.groupRef.resourceId,
        subjectResourceType: resolved.group.groupRef.resourceType,
      });
      yield* context.addOutboxMessage(event, spec.event.outboxMessage(eventPayload));
    }
    return resolved;
  },
);
