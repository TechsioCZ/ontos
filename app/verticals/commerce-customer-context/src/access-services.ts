import { OperationContextUnavailable } from '@app/core-runtime';
import type { OperationalScope, PrincipalEligibility } from '@app/core-runtime';
import type { AccessPortalTransaction } from '@app/core-runtime/access/portal';
import { Effect } from 'effect';
import type { SecureRandom } from 'effect/crypto';
import type { CommerceAuthSha256 } from './portal-auth/sha256.ts';
import type {
  CounterpartyAccessPortService,
  CounterpartyInvitationProofDelivery,
} from '../shared/domain/access-port.ts';
import { counterpartyAccessPortForScopedTransaction } from './persistence/access-persistence.ts';
import type { CounterpartyAccessScopedRoutineInvoker } from './persistence/access-persistence.ts';

export const counterpartyAccessServicesForTransaction = (
  transaction: CounterpartyAccessScopedRoutineInvoker & AccessPortalTransaction,
  scope: OperationalScope,
): Effect.Effect<
  CounterpartyAccessPortService,
  OperationContextUnavailable,
  CounterpartyInvitationProofDelivery | CommerceAuthSha256 | SecureRandom.SecureRandom | PrincipalEligibility
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
