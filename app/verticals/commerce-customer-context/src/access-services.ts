import { ContextAccess, PrincipalEligibility, OperationContextUnavailable } from '@app/core-runtime';
import type { ActionPrepareContext, OperationalScope } from '@app/core-runtime';
import { Effect, Result } from 'effect';
import type { Crypto } from 'effect';
import { CounterpartyInvitationProofDelivery, CounterpartyAccessUnavailable } from '../shared/domain/access-port.ts';
import type { CounterpartyAccessPortService } from '../shared/domain/access-port.ts';
import {
  counterpartyAccessPortForScopedTransaction,
  counterpartyAccessPortBuilderForScopedTransaction,
} from './persistence/access-persistence.ts';
import type {
  CounterpartyAccessRemoteServices,
  CounterpartyAccessScopedRoutineInvoker,
} from './persistence/access-persistence.ts';
import type { PrincipalRef } from '../shared/domain/access-contract.ts';
import type { ClaimCounterpartyAccessInvitationPayload } from '../shared/actions/claim-counterparty-access-invitation.ts';
import { ownerRoutinePreparation } from './persistence/owner-routine-preparation.ts';

export const unobservedAccessRemotes: CounterpartyAccessRemoteServices =
  Object.freeze<CounterpartyAccessRemoteServices>({
    contextAccess: { businessPermissions: () => Effect.succeed([]) },
    eligibility: {
      resolve: (principal) => Effect.succeed({ decision: 'unavailable', principal, reason: 'indeterminate' }),
    },
    proofDelivery: {
      stage: () =>
        Effect.fail(
          new CounterpartyAccessUnavailable({
            code: 'counterparty_access_unavailable',
            reason: 'Invitation delivery was not prepared for this Action',
          }),
        ),
    },
  });

/** A local reader for one exact Principal observation, never a live identity lookup in write. */
export const prepareAccessRecipient = Effect.fn('CounterpartyAccessServices.prepareAccessRecipient')(
  function* prepareAccessRecipient(
    principal: PrincipalRef,
  ): Effect.fn.Return<CounterpartyAccessRemoteServices, never, PrincipalEligibility> {
    const eligibility = yield* PrincipalEligibility;
    const result = yield* eligibility.resolve(principal);
    return {
      contextAccess: unobservedAccessRemotes.contextAccess,
      proofDelivery: unobservedAccessRemotes.proofDelivery,
      eligibility: {
        resolve: (requested) =>
          requested.tenantId === principal.tenantId && requested.principalId === principal.principalId
            ? Effect.succeed(result)
            : unobservedAccessRemotes.eligibility.resolve(requested),
      },
    };
  },
);

/** Service construction captures only local crypto and the owner executor. */
export const counterpartyPreparedAccessServicesForTransaction = (
  transaction: CounterpartyAccessScopedRoutineInvoker,
  scope: OperationalScope,
): Effect.Effect<
  (prepared: CounterpartyAccessRemoteServices) => CounterpartyAccessPortService,
  OperationContextUnavailable,
  Crypto.Crypto
> =>
  scope.legalEntityId === undefined
    ? Effect.fail(
        new OperationContextUnavailable({
          code: 'operation_context_unavailable',
          reason: 'Counterparty Commerce Access requires a trusted Legal Entity scope',
        }),
      )
    : counterpartyAccessPortBuilderForScopedTransaction(transaction, { ...scope, legalEntityId: scope.legalEntityId });

export const prepareInvitationClaimRemotes = Effect.fn('CounterpartyAccessServices.prepareInvitationClaimRemotes')(
  function* prepareInvitationClaimRemotes(
    payload: ClaimCounterpartyAccessInvitationPayload,
    context: ActionPrepareContext,
  ) {
    const { scope } = context;
    if (
      scope.legalEntityId === undefined ||
      payload.invitationRef.tenantId !== scope.tenantId ||
      payload.counterpartyRef.tenantId !== scope.tenantId ||
      payload.claimant.tenantId !== scope.tenantId ||
      payload.claimant.principalId !== scope.principalId ||
      (payload.scope.kind === 'storefront' && payload.scope.storefrontKey !== scope.trustedStorefrontId)
    ) {
      return unobservedAccessRemotes;
    }
    const remotes = yield* prepareAccessRecipient(payload.claimant);
    const eligible = yield* remotes.eligibility.resolve(payload.claimant);
    if (eligible.decision !== 'eligible') {
      return remotes;
    }
    const port = yield* counterpartyAccessServicesForTransaction(ownerRoutinePreparation(context.transaction), scope);
    const invitation = yield* port
      .getInvitation({
        actor: { principalId: scope.principalId, tenantId: scope.tenantId },
        counterpartyRef: payload.counterpartyRef,
        invitationRef: payload.invitationRef,
        legalEntityId: scope.legalEntityId,
        scope: payload.scope,
      })
      .pipe(Effect.result);
    if (Result.isFailure(invitation)) {
      return remotes;
    }
    const inviter = invitation.success.invitedBy;
    const access = yield* ContextAccess;
    if (access.businessPermissions === undefined) {
      return remotes;
    }
    const target =
      payload.scope.kind === 'counterparty'
        ? {
            counterpartyId: payload.counterpartyRef.resourceId,
            kind: 'counterparty' as const,
            legalEntityId: scope.legalEntityId,
            tenantId: scope.tenantId,
          }
        : {
            counterpartyId: payload.counterpartyRef.resourceId,
            kind: 'counterparty_storefront' as const,
            legalEntityId: scope.legalEntityId,
            storefrontId: payload.scope.storefrontKey,
            tenantId: scope.tenantId,
          };
    const decisions = yield* access.businessPermissions({
      principal: inviter,
      targets: [{ permission: 'counterparty.access.manage', target }],
      ...(payload.scope.kind === 'storefront' ? { trustedStorefrontId: payload.scope.storefrontKey } : {}),
    });
    const contextAccess: CounterpartyAccessRemoteServices['contextAccess'] = {
      businessPermissions: (request) => {
        const matches =
          request.principal.tenantId === inviter.tenantId &&
          request.principal.principalId === inviter.principalId &&
          request.targets.length === 1 &&
          request.targets.every((requested) => {
            const candidate = requested.target;
            return (
              requested.permission === 'counterparty.access.manage' &&
              (candidate.kind === 'counterparty' || candidate.kind === 'counterparty_storefront') &&
              candidate.kind === target.kind &&
              candidate.counterpartyId === target.counterpartyId &&
              candidate.legalEntityId === target.legalEntityId &&
              candidate.tenantId === target.tenantId &&
              (candidate.kind !== 'counterparty_storefront' ||
                (target.kind === 'counterparty_storefront' &&
                  candidate.storefrontId === target.storefrontId &&
                  request.trustedStorefrontId === target.storefrontId))
            );
          });
        return Effect.succeed(matches ? decisions : []);
      },
    };
    return {
      contextAccess,
      eligibility: remotes.eligibility,
      proofDelivery: remotes.proofDelivery,
    } satisfies CounterpartyAccessRemoteServices;
  },
);

export const counterpartyAccessServicesForTransaction = (
  transaction: CounterpartyAccessScopedRoutineInvoker,
  scope: OperationalScope,
): Effect.Effect<
  CounterpartyAccessPortService,
  OperationContextUnavailable,
  ContextAccess | CounterpartyInvitationProofDelivery | Crypto.Crypto | PrincipalEligibility
> => {
  if (scope.legalEntityId === undefined) {
    return Effect.fail(
      new OperationContextUnavailable({
        code: 'operation_context_unavailable',
        reason: 'Counterparty Commerce Access requires a trusted Legal Entity scope',
      }),
    );
  }
  const trustedScope = { ...scope, legalEntityId: scope.legalEntityId };
  return counterpartyAccessPortForScopedTransaction(transaction, trustedScope);
};

export interface PreparedInvitationDelivery {
  readonly remotes: CounterpartyAccessRemoteServices;
  readonly deliver: Effect.Effect<void>;
}

/**
 * Write registers the proof and its committed release gate, retaining the redacted envelope
 * only for this invocation. The secure queue is contacted after commit. Core logs enqueue
 * failure without changing the committed result; resend rotates the proof for recovery.
 */
export const prepareInvitationDelivery = Effect.fn('CounterpartyAccessServices.prepareInvitationDelivery')(
  function* prepareInvitationDelivery(): Effect.fn.Return<
    PreparedInvitationDelivery,
    never,
    CounterpartyInvitationProofDelivery
  > {
    const delivery = yield* CounterpartyInvitationProofDelivery;
    const pending: Parameters<typeof delivery.stage>[0][] = [];
    return {
      remotes: {
        ...unobservedAccessRemotes,
        proofDelivery: {
          stage: (input) =>
            Effect.sync(() => {
              pending.push(input);
            }),
        },
      },
      deliver: Effect.suspend(() =>
        Effect.forEach(pending, (input) => delivery.stage(input), { concurrency: 1, discard: true }),
      ).pipe(
        Effect.orDie,
        Effect.ensuring(
          Effect.sync(() => {
            pending.length = 0;
          }),
        ),
      ),
    };
  },
);
