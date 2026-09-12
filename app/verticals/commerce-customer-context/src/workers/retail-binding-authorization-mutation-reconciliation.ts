import type { OutboxWorkerHandlerContext, OutboxWorkerLegalEntityScope } from '@app/core-runtime';
import type {
  OutboxWorkerCompletionDefinition,
  OutboxWorkerCompletionPublicationError,
  OutboxWorkerLegalEntityScopeError,
} from '@app/core-runtime/outbox/worker';
import { OutboxWorkerLegalEntityScopeFanout } from '@app/core-runtime/outbox/worker';
import type { OutboxPayload as ActivatedPayload } from '@app/commerce-customer-context/outbox/commerce-customer-context-retail-portal-profile-binding-activated-v1';
import type { OutboxPayload as ActivationRequest } from '@app/commerce-customer-context/outbox/commerce-customer-context-retail-portal-profile-binding-activation-authorization-mutation-requested-v1';
import type { OutboxPayload as RecoveredPayload } from '@app/commerce-customer-context/outbox/commerce-customer-context-retail-portal-profile-binding-recovered-v1';
import type { OutboxPayload as RecoveryRequest } from '@app/commerce-customer-context/outbox/commerce-customer-context-retail-portal-profile-binding-recovery-authorization-mutation-requested-v1';
import type { OutboxPayload as RevokedPayload } from '@app/commerce-customer-context/outbox/commerce-customer-context-retail-portal-profile-binding-revoked-v1';
import type { OutboxPayload as RevocationRequest } from '@app/commerce-customer-context/outbox/commerce-customer-context-retail-portal-profile-binding-revocation-authorization-mutation-requested-v1';
import { Context, Effect, Ref, Schema } from 'effect';

export type RetailBindingAuthorizationMutationRequest = ActivationRequest | RecoveryRequest | RevocationRequest;

type RetailBindingAuthorizationMutationTerminalEvidence =
  | Readonly<{
      readonly completionId: string;
      readonly kind: 'ACTIVATION';
      readonly occurredAt: Date;
      readonly payload: ActivatedPayload;
      readonly sourceActionInvocationId: string;
    }>
  | Readonly<{
      readonly completionId: string;
      readonly kind: 'RECOVERY';
      readonly occurredAt: Date;
      readonly payload: RecoveredPayload;
      readonly sourceActionInvocationId: string;
    }>
  | Readonly<{
      readonly completionId: string;
      readonly kind: 'REVOCATION';
      readonly occurredAt: Date;
      readonly payload: RevokedPayload;
      readonly sourceActionInvocationId: string;
    }>;

export type RetailBindingAuthorizationMutationReconciliationResult =
  | Readonly<{
      readonly outcome: 'ALREADY_FINAL' | 'FINALIZED';
      readonly terminal: RetailBindingAuthorizationMutationTerminalEvidence;
    }>
  | Readonly<{ readonly outcome: 'INDETERMINATE' }>;

const rejectedFields = {
  code: Schema.Literals([
    'WORKER_CONTEXT_INVALID',
    'CROSS_TENANT_REQUEST',
    'RECONCILIATION_INDETERMINATE',
    'RECONCILIATION_RESULT_INVALID',
    'RECONCILIATION_UNAVAILABLE',
  ]),
  reason: Schema.String,
} as const;
const RetailBindingAuthorizationMutationWorkerRejectedSchema = Schema.TaggedStruct(
  'RetailBindingAuthorizationMutationWorkerRejected',
  rejectedFields,
);
export const RetailBindingAuthorizationMutationWorkerRejected = Schema.TaggedError<
  typeof RetailBindingAuthorizationMutationWorkerRejectedSchema.Type
>()('RetailBindingAuthorizationMutationWorkerRejected', rejectedFields);
export type RetailBindingAuthorizationMutationWorkerError =
  | InstanceType<typeof RetailBindingAuthorizationMutationWorkerRejected>
  | OutboxWorkerCompletionPublicationError;

export interface RetailBindingAuthorizationMutationReconciliationService {
  readonly reconcile: (
    scope: OutboxWorkerLegalEntityScope,
    request: RetailBindingAuthorizationMutationRequest,
    actorPrincipalId?: string,
  ) => Effect.Effect<
    RetailBindingAuthorizationMutationReconciliationResult,
    RetailBindingAuthorizationMutationWorkerError
  >;
}

export class RetailBindingAuthorizationMutationReconciliation extends Context.Service<
  RetailBindingAuthorizationMutationReconciliation,
  RetailBindingAuthorizationMutationReconciliationService
>()(
  '@app/commerce-customer-context/workers/retail-binding-authorization-mutation-reconciliation/RetailBindingAuthorizationMutationReconciliation',
) {}

const rejected = (
  code: InstanceType<typeof RetailBindingAuthorizationMutationWorkerRejected>['code'],
  reason: string,
) => new RetailBindingAuthorizationMutationWorkerRejected({ code, reason });

type CompletionKind = RetailBindingAuthorizationMutationTerminalEvidence['kind'];

const sameRef = (
  left: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
    readonly tenantId: string;
  },
  right: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
    readonly tenantId: string;
  },
): boolean =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

const requestMatchesTenant = (request: RetailBindingAuthorizationMutationRequest, tenantId: string): boolean =>
  request.bindingRef.tenantId === tenantId &&
  request.principalRef.tenantId === tenantId &&
  request.profileRef.tenantId === tenantId &&
  request.sellingLegalEntityRef.tenantId === tenantId &&
  request.sellingLegalEntityRef.resourceId === request.legalEntityId;

const terminalMatchesRequest = (
  terminal: RetailBindingAuthorizationMutationTerminalEvidence,
  request: RetailBindingAuthorizationMutationRequest,
  expectedKind: CompletionKind,
): boolean =>
  terminal.kind === expectedKind &&
  terminal.completionId === request.mutationId &&
  sameRef(terminal.payload.bindingRef, request.bindingRef) &&
  sameRef(terminal.payload.principalRef, request.principalRef) &&
  sameRef(terminal.payload.profileRef, request.profileRef) &&
  sameRef(terminal.payload.sellingLegalEntityRef, request.sellingLegalEntityRef) &&
  ((expectedKind === 'REVOCATION' && terminal.payload.state === 'REVOKED') ||
    (expectedKind !== 'REVOCATION' && terminal.payload.state === 'ACTIVE'));

export const handleRetailBindingAuthorizationMutation = Effect.fn('RetailBindingAuthorizationMutationWorker.handle')(
  function* handleRetailBindingAuthorizationMutationEffect(
    request: RetailBindingAuthorizationMutationRequest,
    context: OutboxWorkerHandlerContext,
    expected: {
      readonly completion: OutboxWorkerCompletionDefinition<Schema.ConstraintDecoder<unknown>>;
      readonly completionKind: CompletionKind;
      readonly requestTopic: string;
      readonly workerKey: string;
    },
  ): Effect.fn.Return<
    void,
    RetailBindingAuthorizationMutationWorkerError | OutboxWorkerLegalEntityScopeError,
    RetailBindingAuthorizationMutationReconciliation | OutboxWorkerLegalEntityScopeFanout
  > {
    if (
      context.workerKey !== expected.workerKey ||
      context.consumerModuleKey !== 'commerce.customer-context' ||
      context.producerModuleKey !== 'commerce.customer-context' ||
      context.topic !== expected.requestTopic ||
      !requestMatchesTenant(request, context.tenantId)
    ) {
      return yield* rejected(
        'CROSS_TENANT_REQUEST',
        'The Retail binding authorization request does not match its verified worker delivery',
      );
    }

    const indeterminate = yield* Ref.make(false);
    const matchedScope = yield* Ref.make(false);
    const fanout = yield* OutboxWorkerLegalEntityScopeFanout;
    yield* fanout.forEachScope(context, (scope) =>
      scope.legalEntityId === request.legalEntityId
        ? Effect.gen(function* reconcileExactScope() {
            yield* Ref.set(matchedScope, true);
            const reconciliation = yield* RetailBindingAuthorizationMutationReconciliation;
            const result = yield* reconciliation.reconcile(scope, request, context.actorPrincipalId);
            if (result.outcome === 'INDETERMINATE') {
              yield* Ref.set(indeterminate, true);
              return yield* Effect.void;
            }
            if (!terminalMatchesRequest(result.terminal, request, expected.completionKind)) {
              return yield* rejected(
                'RECONCILIATION_RESULT_INVALID',
                'The reconciler returned terminal evidence for a different mutation or scope',
              );
            }
            yield* scope.completionPublisher.publish(expected.completion, {
              completionId: result.terminal.completionId,
              occurredAt: result.terminal.occurredAt,
              payloadJson: result.terminal.payload,
              sourceActionInvocationId: result.terminal.sourceActionInvocationId,
              subjectModuleKey: result.terminal.payload.bindingRef.moduleId,
              subjectResourceId: result.terminal.payload.bindingRef.resourceId,
              subjectResourceType: result.terminal.payload.bindingRef.resourceType,
            });
            return yield* Effect.void;
          })
        : Effect.void,
    );
    if (!(yield* Ref.get(matchedScope))) {
      return yield* rejected(
        'WORKER_CONTEXT_INVALID',
        'The requested Legal Entity is not available in the verified Tenant scope',
      );
    }
    if (yield* Ref.get(indeterminate)) {
      return yield* rejected(
        'RECONCILIATION_INDETERMINATE',
        'The Retail binding authorization mutation is not yet durably finalized',
      );
    }
    return yield* Effect.void;
  },
);
