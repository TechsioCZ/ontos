import { scopedRoutineInvokerFromTransaction } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { sql } from 'drizzle-orm';
import { Effect, Exit, Layer, Schema } from 'effect';
import type { Crypto } from 'effect';

import {
  CounterpartyAccessContractViolation,
  CounterpartyAccessUnavailable,
} from '../../shared/domain/access-error.ts';
import { CounterpartyInvitationClaimRedemption } from '../../shared/domain/invitation-claim-redemption.ts';
import type { CounterpartyInvitationClaimRedemptionService } from '../../shared/domain/invitation-claim-redemption.ts';
import type { CommerceCustomerContextDatabase } from '../database/client.ts';
import type { CommerceCustomerContextTransaction } from '../database/types.ts';
import { counterpartyInvitationClaimRedemptionForTransaction } from './invitation-claim-authority-persistence.ts';

export type AuthenticatedInvitationRedemptionScope = OperationalScope & {
  readonly legalEntityId: string;
};

const unavailable = (cause?: unknown) => {
  const error = new CounterpartyAccessUnavailable({
    code: 'counterparty_access_unavailable',
    reason: 'Invitation claim verification is temporarily unavailable',
  });
  return cause === undefined
    ? error
    : Object.defineProperty(error, 'cause', { enumerable: false, value: cause });
};

const redeemInTransaction = Effect.fn('InvitationClaimRedemptionProduction.redeem')(
  function* redeemInTransactionEffect(
    transaction: CommerceCustomerContextTransaction,
    crypto: Crypto.Crypto,
    trustedScope: AuthenticatedInvitationRedemptionScope,
    input: Parameters<CounterpartyInvitationClaimRedemptionService['redeem']>[0],
  ) {
    yield* transaction.execute(
      sql`select set_config('ontos.tenant_id', ${trustedScope.tenantId}, true), set_config('ontos.legal_entity_id', ${trustedScope.legalEntityId}, true)`,
      'objects',
    );
    const execute = (statement: Parameters<typeof transaction.execute>[0]) =>
      transaction.execute<Record<string, never>>(statement, 'objects');
    const invoker = scopedRoutineInvokerFromTransaction(execute, trustedScope);
    return yield* counterpartyInvitationClaimRedemptionForTransaction(
      invoker,
      crypto,
      trustedScope,
    ).redeem(input);
  },
);

/**
 * Bind raw-secret redemption to a Core-verified OperationalScope. Domain rejections are captured
 * as data inside the database callback so claimant attempt/expiry updates commit, then are
 * re-raised only after commit. The public input cannot choose claimant, Tenant, or Legal Entity.
 */
export const counterpartyInvitationClaimRedemptionForOperationalScope = (
  database: typeof CommerceCustomerContextDatabase.Service,
  crypto: Crypto.Crypto,
  trustedScope: AuthenticatedInvitationRedemptionScope,
): CounterpartyInvitationClaimRedemptionService => ({
  redeem: (input) =>
    database.executor
      .transaction((transaction) =>
        Effect.exit(redeemInTransaction(transaction, crypto, trustedScope, input)),
      )
      .pipe(
        Effect.mapError(unavailable),
        Effect.flatMap((exit) =>
          Exit.isSuccess(exit) ? Effect.succeed(exit.value) : Effect.failCause(exit.cause),
        ),
        Effect.mapError((failure) =>
          Schema.is(CounterpartyAccessContractViolation)(failure) ||
          Schema.is(CounterpartyAccessUnavailable)(failure)
            ? failure
            : unavailable(failure),
        ),
      ),
});

export const counterpartyInvitationClaimRedemptionLayerForOperationalScope = (
  database: typeof CommerceCustomerContextDatabase.Service,
  crypto: Crypto.Crypto,
  trustedScope: AuthenticatedInvitationRedemptionScope,
) =>
  Layer.succeed(
    CounterpartyInvitationClaimRedemption,
    counterpartyInvitationClaimRedemptionForOperationalScope(database, crypto, trustedScope),
  );
