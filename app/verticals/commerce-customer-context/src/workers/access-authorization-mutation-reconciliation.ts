import type { OutboxWorkerHandlerContext, OutboxWorkerLegalEntityScope } from '@app/core-runtime';
import type {
  OutboxWorkerCompletionDefinition,
  OutboxWorkerCompletionPublicationError,
  OutboxWorkerLegalEntityScopeError,
} from '@app/core-runtime/outbox/worker';
import { OutboxWorkerLegalEntityScopeFanout } from '@app/core-runtime/outbox/worker';
import { Context, DateTime, Effect, Ref, Schema } from 'effect';
import type {
  CounterpartyAccessGrantAuthorizationMutationRequestedPayload,
  CounterpartyAccessInvitationClaimAuthorizationMutationRequestedPayload,
  CounterpartyAccessRevokeAuthorizationMutationRequestedPayload,
} from '../../shared/domain/access-authorization-mutation.ts';
import type { CounterpartyAccessGrant } from '../../shared/domain/access-contract.ts';
import type {
  CounterpartyAccessInvitation,
  VerifiedInvitationClaimAttestation,
} from '../../shared/domain/invitation-contract.ts';
import type {
  CounterpartyAccessAdministratorBootstrappedEventPayloadSchema,
  CounterpartyAccessGrantedEventPayloadSchema,
  CounterpartyAccessInvitationClaimedEventPayloadSchema,
  CounterpartyAccessRevokedEventPayloadSchema,
} from '../../shared/domain/access-outbox-contract.ts';

export type AccessAuthorizationMutationRequest =
  | CounterpartyAccessGrantAuthorizationMutationRequestedPayload
  | CounterpartyAccessInvitationClaimAuthorizationMutationRequestedPayload
  | CounterpartyAccessRevokeAuthorizationMutationRequestedPayload;

type AccessGrantedPayload = typeof CounterpartyAccessGrantedEventPayloadSchema.Type;
type AccessRevokedPayload = typeof CounterpartyAccessRevokedEventPayloadSchema.Type;
type AccessAdministratorBootstrappedPayload = typeof CounterpartyAccessAdministratorBootstrappedEventPayloadSchema.Type;
type AccessInvitationClaimedPayload = typeof CounterpartyAccessInvitationClaimedEventPayloadSchema.Type;

interface CompletionEvidence<Kind extends string, Payload> {
  readonly completionId: string;
  readonly kind: Kind;
  readonly occurredAt: Date;
  readonly payload: Payload;
  readonly sourceActionInvocationId: string;
}

export type AccessAuthorizationMutationCompletion =
  | CompletionEvidence<'ACCESS_GRANTED', AccessGrantedPayload>
  | CompletionEvidence<'ACCESS_REVOKED', AccessRevokedPayload>
  | CompletionEvidence<'ADMINISTRATOR_BOOTSTRAPPED', AccessAdministratorBootstrappedPayload>
  | CompletionEvidence<'INVITATION_CLAIMED', AccessInvitationClaimedPayload>;

type AccessAuthorizationMutationTerminalEvidence =
  | Readonly<{
      readonly completionId: string;
      readonly grant: CounterpartyAccessGrant;
      readonly kind: 'GRANT';
      readonly occurredAt: Date;
      readonly sourceActionInvocationId: string;
    }>
  | Readonly<{
      readonly attestation: VerifiedInvitationClaimAttestation;
      readonly completionId: string;
      readonly invitation: CounterpartyAccessInvitation;
      readonly kind: 'INVITATION_CLAIM';
      readonly occurredAt: Date;
      readonly sourceActionInvocationId: string;
    }>;

type AccessAuthorizationMutationReconciliationResult =
  | Readonly<{
      readonly outcome: 'ALREADY_FINAL' | 'FINALIZED';
      readonly terminal: AccessAuthorizationMutationTerminalEvidence;
    }>
  /** The owner reset/compensation marker is durable; no claim completion event is published. */
  | Readonly<{ readonly outcome: 'COMPENSATED' }>
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
const AccessAuthorizationMutationWorkerRejectedSchema = Schema.TaggedStruct(
  'AccessAuthorizationMutationWorkerRejected',
  rejectedFields,
);
export const AccessAuthorizationMutationWorkerRejected = Schema.TaggedError<
  typeof AccessAuthorizationMutationWorkerRejectedSchema.Type
>()('AccessAuthorizationMutationWorkerRejected', rejectedFields);
export type AccessAuthorizationMutationWorkerError =
  | InstanceType<typeof AccessAuthorizationMutationWorkerRejected>
  | OutboxWorkerCompletionPublicationError;

export interface AccessAuthorizationMutationReconciliationService {
  readonly reconcile: (
    scope: OutboxWorkerLegalEntityScope,
    request: AccessAuthorizationMutationRequest,
  ) => Effect.Effect<AccessAuthorizationMutationReconciliationResult, AccessAuthorizationMutationWorkerError>;
}

export class AccessAuthorizationMutationReconciliation extends Context.Service<
  AccessAuthorizationMutationReconciliation,
  AccessAuthorizationMutationReconciliationService
>()(
  '@app/commerce-customer-context/workers/access-authorization-mutation-reconciliation/AccessAuthorizationMutationReconciliation',
) {}

const rejected = (
  code: Exclude<InstanceType<typeof AccessAuthorizationMutationWorkerRejected>['code'], never>,
  reason: string,
) => new AccessAuthorizationMutationWorkerRejected({ code, reason });

type CompletionKind = AccessAuthorizationMutationCompletion['kind'];

const requestMatchesTenant = (request: AccessAuthorizationMutationRequest, tenantId: string): boolean =>
  request.counterpartyRef.tenantId === tenantId &&
  ('grantRef' in request ? request.grantRef.tenantId === tenantId : true) &&
  ('invitationRef' in request ? request.invitationRef.tenantId === tenantId : true) &&
  ('permissionMutations' in request
    ? request.permissionMutations.every(({ grantRef }) => grantRef.tenantId === tenantId)
    : true);

const grantCompletion = (
  terminal: Extract<AccessAuthorizationMutationTerminalEvidence, { readonly kind: 'GRANT' }>,
  kind: Exclude<CompletionKind, 'INVITATION_CLAIMED'>,
): AccessAuthorizationMutationCompletion | undefined => {
  const common = {
    catalogVersion: terminal.grant.catalogVersion,
    counterpartyRef: terminal.grant.counterpartyRef,
    grantRef: terminal.grant.grantRef,
    permission: terminal.grant.permission,
    recipient: terminal.grant.recipient,
    revision: terminal.grant.revision,
    scope: terminal.grant.scope,
  };
  const occurredAt = DateTime.formatIso(DateTime.makeUnsafe(terminal.occurredAt));
  if (kind === 'ACCESS_GRANTED') {
    return {
      ...terminal,
      kind,
      payload: { ...common, grantedAt: occurredAt, grantedBy: terminal.grant.grantedBy },
    };
  }
  if (kind === 'ADMINISTRATOR_BOOTSTRAPPED') {
    return {
      ...terminal,
      kind,
      payload: { ...common, bootstrappedAt: occurredAt, bootstrappedBy: terminal.grant.grantedBy },
    };
  }
  return terminal.grant.revokedBy === undefined
    ? undefined
    : {
        ...terminal,
        kind,
        payload: { ...common, revokedAt: occurredAt, revokedBy: terminal.grant.revokedBy },
      };
};

const claimCompletion = (
  terminal: Extract<AccessAuthorizationMutationTerminalEvidence, { readonly kind: 'INVITATION_CLAIM' }>,
): AccessAuthorizationMutationCompletion | undefined =>
  terminal.invitation.claimant === undefined
    ? undefined
    : {
        ...terminal,
        kind: 'INVITATION_CLAIMED',
        payload: {
          attestationReference: terminal.attestation.attestationReference,
          catalogVersion: terminal.invitation.catalogVersion,
          claimedBy: terminal.invitation.claimant,
          counterpartyRef: terminal.invitation.counterpartyRef,
          grantProgress: terminal.invitation.grantProgress,
          intendedPermissions: terminal.invitation.intendedPermissions,
          invitationRef: terminal.invitation.invitationRef,
          revision: terminal.invitation.revision,
          scope: terminal.invitation.scope,
          verifiedAt: terminal.attestation.verifiedAt,
        },
      };

const completionForRoute = (
  terminal: AccessAuthorizationMutationTerminalEvidence,
  kind: CompletionKind,
): AccessAuthorizationMutationCompletion | undefined => {
  if (terminal.kind === 'INVITATION_CLAIM') {
    return kind === 'INVITATION_CLAIMED' ? claimCompletion(terminal) : undefined;
  }
  return kind === 'INVITATION_CLAIMED' ? undefined : grantCompletion(terminal, kind);
};

export const handleAccessAuthorizationMutation = Effect.fn('AccessAuthorizationMutationWorker.handle')(
  function* handleAccessAuthorizationMutationEffect(
    request: AccessAuthorizationMutationRequest,
    context: OutboxWorkerHandlerContext,
    expected: {
      readonly completion: OutboxWorkerCompletionDefinition<Schema.ConstraintDecoder<unknown>>;
      readonly completionKind: CompletionKind;
      readonly requestTopic: string;
      readonly workerKey: string;
    },
  ): Effect.fn.Return<
    void,
    AccessAuthorizationMutationWorkerError | OutboxWorkerLegalEntityScopeError,
    AccessAuthorizationMutationReconciliation | OutboxWorkerLegalEntityScopeFanout
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
        'The access authorization request does not match its verified worker delivery',
      );
    }

    const indeterminate = yield* Ref.make(false);
    const matchedScope = yield* Ref.make(false);
    const fanout = yield* OutboxWorkerLegalEntityScopeFanout;
    yield* fanout.forEachScope(context, (scope) =>
      scope.legalEntityId === request.legalEntityId
        ? Effect.gen(function* reconcileExactScope() {
            yield* Ref.set(matchedScope, true);
            const reconciliation = yield* AccessAuthorizationMutationReconciliation;
            const result = yield* reconciliation.reconcile(scope, request);
            if (result.outcome === 'INDETERMINATE') {
              yield* Ref.set(indeterminate, true);
              return yield* Effect.void;
            }
            if (result.outcome === 'COMPENSATED') {
              // Compensation is a terminal owner-side deny/reset. Publishing the claim
              // completion here would re-grant the invitation in downstream projections.
              return yield* Effect.void;
            }
            const completion = completionForRoute(result.terminal, expected.completionKind);
            if (
              completion === undefined ||
              completion.completionId !== request.mutationId ||
              completion.payload.counterpartyRef.tenantId !== context.tenantId
            ) {
              return yield* rejected(
                'RECONCILIATION_RESULT_INVALID',
                'The reconciler returned completion evidence for a different mutation or scope',
              );
            }
            yield* scope.completionPublisher.publish(expected.completion, {
              completionId: completion.completionId,
              occurredAt: completion.occurredAt,
              payloadJson: completion.payload,
              sourceActionInvocationId: completion.sourceActionInvocationId,
              subjectModuleKey:
                completion.kind === 'INVITATION_CLAIMED'
                  ? completion.payload.invitationRef.moduleId
                  : completion.payload.grantRef.moduleId,
              subjectResourceId:
                completion.kind === 'INVITATION_CLAIMED'
                  ? completion.payload.invitationRef.resourceId
                  : completion.payload.grantRef.resourceId,
              subjectResourceType:
                completion.kind === 'INVITATION_CLAIMED'
                  ? completion.payload.invitationRef.resourceType
                  : completion.payload.grantRef.resourceType,
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
      return yield* rejected('RECONCILIATION_INDETERMINATE', 'The authorization mutation is not yet durably finalized');
    }
    return yield* Effect.void;
  },
);
