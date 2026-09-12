import {
  ActionAuthorizationPreflight,
  ActionAuthorizationPreflightDatabase,
  ActionPermissionCheckError,
  ContextAccess,
  makeActionAuthorizationPreflightPermit,
  PrincipalEligibility,
  scopedRoutineInvokerFromTransaction,
} from '@app/core-runtime';
import type {
  ActionAuthorizationPreflightDatabaseService,
  ActionAuthorizationPreflightInput,
  ActionAuthorizationPreflightService,
  ActionAuthorizationPreflightTransaction,
  ActionTransactionError,
} from '@app/core-runtime';
import { sql } from 'drizzle-orm';
import type { EffectDrizzleQueryError } from 'drizzle-orm/effect-core';
import { Effect, Layer, Result, Schema } from 'effect';

import { ClaimCounterpartyAccessInvitationPayloadSchema } from '../../shared/actions/claim-counterparty-access-invitation.ts';
import { CounterpartyAccessContractViolation } from '../../shared/domain/access-error.ts';
import { verifyCounterpartyInvitationClaimAuthorityForOwnerScope } from './invitation-claim-authority-persistence.ts';
import { currentOwnerAccessForTransaction } from './access-persistence.ts';
import type { CounterpartyAccessDomainError } from '../../shared/domain/access-error.ts';

const claimActionKey = 'commerce.customer-context.claim-counterparty-access-invitation';

type InvitationClaimPreflightFailure =
  | CounterpartyAccessDomainError
  | ActionPermissionCheckError
  | ActionTransactionError
  | EffectDrizzleQueryError;

const actionPermissionCheckUnavailable = (cause?: unknown) => {
  const error = new ActionPermissionCheckError({
    code: 'action_permission_check_failed',
    reason: 'The invitation claim authorization service could not determine permission safely',
  });
  return cause === undefined
    ? error
    : Object.defineProperty(error, 'cause', {
        configurable: false,
        enumerable: false,
        value: cause,
      });
};

const isContractDenial = (failure: InvitationClaimPreflightFailure): boolean =>
  Schema.is(CounterpartyAccessContractViolation)(failure);

const payloadMatchesTrustedClaim = (
  payload: typeof ClaimCounterpartyAccessInvitationPayloadSchema.Type,
  input: ActionAuthorizationPreflightInput,
): boolean => {
  const { principal, scope } = input;
  if (
    payload.claimant.principalId !== principal.principalId ||
    payload.claimant.tenantId !== principal.tenantId ||
    payload.claimant.tenantId !== scope.tenantId ||
    payload.counterpartyRef.tenantId !== scope.tenantId ||
    payload.invitationRef.tenantId !== scope.tenantId ||
    principal.tenantId !== scope.tenantId ||
    scope.legalEntityId === undefined
  ) {
    return false;
  }
  return payload.scope.kind === 'counterparty'
    ? scope.trustedStorefrontId === undefined
    : scope.trustedStorefrontId === payload.scope.storefrontKey;
};

const decodedClaimPayload = (
  input: ActionAuthorizationPreflightInput,
): typeof ClaimCounterpartyAccessInvitationPayloadSchema.Type | undefined => {
  const decoded = Schema.decodeUnknownResult(ClaimCounterpartyAccessInvitationPayloadSchema)(input.payload);
  return Result.isSuccess(decoded) ? decoded.success : undefined;
};

const runInvitationClaimPreflight = Effect.fn('InvitationClaimActionPreflight.run')(
  function* runInvitationClaimPreflight(
    // oxlint-disable-next-line effect-native/no-dependency-parameters -- The operation captures the already-yielded Core preflight database seam; expires: 2027-03-31.
    database: ActionAuthorizationPreflightDatabaseService,
    contextAccess: Pick<(typeof ContextAccess)['Service'], 'businessPermissions'>,
    // oxlint-disable-next-line effect-native/no-dependency-parameters -- The operation captures the already-yielded eligibility service for this owner-local preflight; expires: 2027-03-31.
    eligibility: (typeof PrincipalEligibility)['Service'],
    input: ActionAuthorizationPreflightInput,
    payload: typeof ClaimCounterpartyAccessInvitationPayloadSchema.Type,
  ): Effect.fn.Return<
    void,
    CounterpartyAccessDomainError | ActionPermissionCheckError | ActionTransactionError | EffectDrizzleQueryError
  > {
    const { legalEntityId } = input.scope;
    if (legalEntityId === undefined) {
      return yield* actionPermissionCheckUnavailable();
    }
    const eligible = yield* eligibility.resolve(payload.claimant);
    if (eligible.decision === 'unavailable') {
      return yield* actionPermissionCheckUnavailable();
    }
    if (eligible.decision !== 'eligible') {
      return yield* new CounterpartyAccessContractViolation({
        code: 'principal_not_eligible',
        reason: 'The target Principal is not active and eligible in the trusted Tenant',
      });
    }

    const verifyInScopedTransaction = Effect.fn('InvitationClaimActionPreflight.verifyInScopedTransaction')(
      function* verifyInScopedTransaction(transaction: ActionAuthorizationPreflightTransaction) {
        yield* transaction.execute(
          sql`select set_config('ontos.tenant_id', ${input.scope.tenantId}, true), set_config('ontos.legal_entity_id', ${input.scope.legalEntityId}, true)`,
          'objects',
        );
        const execute = (statement: Parameters<typeof transaction.execute>[0]) =>
          transaction.execute(statement, 'objects');
        const invoker = scopedRoutineInvokerFromTransaction(execute, input.scope);
        const currentOwnerAccess = currentOwnerAccessForTransaction(invoker, {
          legalEntityId,
          tenantId: input.scope.tenantId,
        });
        return yield* verifyCounterpartyInvitationClaimAuthorityForOwnerScope(
          {
            contextAccess,
            currentOwnerAccess,
            transaction: invoker,
          },
          {
            claimant: payload.claimant,
            claimProofReference: payload.claimProofReference,
            counterpartyRef: payload.counterpartyRef,
            invitationRef: payload.invitationRef,
            legalEntityId,
            scope: payload.scope,
          },
        );
      },
    );
    return yield* database.transaction(verifyInScopedTransaction);
  },
);

// oxlint-disable-next-line effect-native/no-wide-factory-signature -- This public factory preserves the direct unit-test seam while capturing three already-yielded Core services; expires: 2027-03-31.
export const makeInvitationClaimActionAuthorizationPreflight = (
  // oxlint-disable-next-line effect-native/no-dependency-parameters -- The factory captures the already-yielded Core preflight database seam; expires: 2027-03-31.
  database: ActionAuthorizationPreflightDatabaseService,
  contextAccess: Pick<(typeof ContextAccess)['Service'], 'businessPermissions'>,
  // oxlint-disable-next-line effect-native/no-dependency-parameters -- The factory captures the already-yielded eligibility service for this owner-local preflight; expires: 2027-03-31.
  eligibility: (typeof PrincipalEligibility)['Service'],
): ActionAuthorizationPreflightService =>
  Object.freeze({
    prepare: (input: ActionAuthorizationPreflightInput) => {
      if (input.actionKey !== claimActionKey) {
        return Effect.succeed({ outcome: 'not_applicable' } as const);
      }
      const payload = decodedClaimPayload(input);
      if (payload === undefined || !payloadMatchesTrustedClaim(payload, input)) {
        return Effect.succeed({ outcome: 'denied' } as const);
      }
      return runInvitationClaimPreflight(database, contextAccess, eligibility, input, payload).pipe(
        Effect.map(() => ({
          outcome: 'allowed' as const,
          permit: makeActionAuthorizationPreflightPermit({
            actionInvocationId: input.actionInvocationId,
            actionKey: input.actionKey,
            principalId: input.principal.principalId,
          }),
        })),
        // oxlint-disable-next-line promise/prefer-await-to-callbacks, promise/prefer-await-to-then -- Effect's typed catch combinator is not Promise chaining.
        Effect.catch((error: InvitationClaimPreflightFailure) =>
          isContractDenial(error)
            ? Effect.succeed({ outcome: 'denied' } as const)
            : Effect.fail(actionPermissionCheckUnavailable(error)),
        ),
      );
    },
  });

export const commerceCustomerContextInvitationClaimActionAuthorizationPreflightLive = Layer.effect(
  ActionAuthorizationPreflight,
  Effect.gen(function* makeInvitationClaimPreflightLive() {
    const [database, contextAccess, eligibility] = yield* Effect.all(
      [ActionAuthorizationPreflightDatabase, ContextAccess, PrincipalEligibility] as const,
      { concurrency: 1 },
    );
    return makeInvitationClaimActionAuthorizationPreflight(database, contextAccess, eligibility);
  }),
);
