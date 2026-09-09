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
} from '@app/core-runtime';
import { sql } from 'drizzle-orm';
import type { EffectDrizzleQueryError } from 'drizzle-orm/effect-core';
import { Effect, Layer, Result, Schema } from 'effect';

import { ClaimCounterpartyAccessInvitationPayloadSchema } from '../../shared/actions/claim-counterparty-access-invitation.ts';
import { CounterpartyAccessContractViolation } from '../../shared/domain/access-error.ts';
import { verifyCounterpartyInvitationClaimAuthorityForOwnerScope } from './invitation-claim-authority-persistence.ts';
import { currentOwnerAccessForTransaction } from './access-persistence.ts';
import type { ActionTransactionError } from '@app/core-runtime';
import type { CounterpartyAccessDomainError } from '../../shared/domain/access-error.ts';

const claimActionKey = 'commerce.customer-context.claim-counterparty-access-invitation';

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

const isContractDenial = (failure: unknown): boolean =>
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
  const decoded = Schema.decodeUnknownResult(ClaimCounterpartyAccessInvitationPayloadSchema)(
    input.payload,
  );
  return Result.isSuccess(decoded) ? decoded.success : undefined;
};

const runInvitationClaimPreflight = Effect.fn('InvitationClaimActionPreflight.run')(
  function* runInvitationClaimPreflight(
    database: ActionAuthorizationPreflightDatabaseService,
    contextAccess: Pick<(typeof ContextAccess)['Service'], 'businessPermissions'>,
    eligibility: (typeof PrincipalEligibility)['Service'],
    input: ActionAuthorizationPreflightInput,
    payload: typeof ClaimCounterpartyAccessInvitationPayloadSchema.Type,
  ): Effect.fn.Return<
    void,
    | CounterpartyAccessDomainError
    | ActionPermissionCheckError
    | ActionTransactionError
    | EffectDrizzleQueryError
  > {
    const legalEntityId = input.scope.legalEntityId;
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

    return yield* database.transaction((transaction) =>
      Effect.gen(function* verifyInScopedTransaction() {
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
      }),
    );
  },
);

export const makeInvitationClaimActionAuthorizationPreflight = (
  database: ActionAuthorizationPreflightDatabaseService,
  contextAccess: Pick<(typeof ContextAccess)['Service'], 'businessPermissions'>,
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
        Effect.catch(
          (
            failure:
              | CounterpartyAccessDomainError
              | ActionPermissionCheckError
              | ActionTransactionError
              | EffectDrizzleQueryError,
          ) =>
            isContractDenial(failure)
              ? Effect.succeed({ outcome: 'denied' } as const)
              : Effect.fail(actionPermissionCheckUnavailable(failure)),
        ),
      );
    },
  });

export const commerceCustomerContextInvitationClaimActionAuthorizationPreflightLive = Layer.effect(
  ActionAuthorizationPreflight,
  Effect.gen(function* makeInvitationClaimPreflightLive() {
    const [database, contextAccess, eligibility] = yield* Effect.all([
      ActionAuthorizationPreflightDatabase,
      ContextAccess,
      PrincipalEligibility,
    ] as const);
    return makeInvitationClaimActionAuthorizationPreflight(database, contextAccess, eligibility);
  }),
);
