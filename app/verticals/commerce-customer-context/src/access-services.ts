import { OperationContextUnavailable } from '@app/core-runtime';
import type { ContextAccess, OperationalScope, PrincipalEligibility } from '@app/core-runtime';
import { Effect } from 'effect';
import type { Crypto } from 'effect';
import type {
  CounterpartyAccessPortService,
  CounterpartyInvitationProofDelivery,
} from '../shared/domain/access-port.ts';
import { counterpartyAccessPortForScopedTransaction } from './persistence/access-persistence.ts';
import type { CounterpartyAccessScopedRoutineInvoker } from './persistence/access-persistence.ts';

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
