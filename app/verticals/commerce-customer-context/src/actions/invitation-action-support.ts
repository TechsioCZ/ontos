import { Effect } from 'effect';
import type { CounterpartyAccessInvitation } from '../../shared/domain/invitation-contract.ts';
import { invitationHasUniquePermissions } from '../../shared/domain/invitation-contract.ts';
import { CounterpartyAccessContractViolation } from '../../shared/domain/access-port.ts';
import {
  permissionAllowsScope,
  permissionDescriptor,
} from '../../shared/domain/permission-catalog.ts';

export const validateInvitationIntent = (
  invitation: Pick<CounterpartyAccessInvitation, 'intendedPermissions' | 'scope'>,
): Effect.Effect<void, CounterpartyAccessContractViolation> => {
  if (!invitationHasUniquePermissions(invitation.intendedPermissions)) {
    return Effect.fail(
      new CounterpartyAccessContractViolation({
        code: 'invitation_invalid',
        reason: 'An invitation must contain a non-empty set of unique permissions',
      }),
    );
  }
  if (
    invitation.intendedPermissions.some(
      (permission) =>
        !permissionDescriptor(permission).customerDelegable ||
        !permissionAllowsScope(permission, invitation.scope.kind),
    )
  ) {
    return Effect.fail(
      new CounterpartyAccessContractViolation({
        code: 'permission_not_delegable',
        reason: 'Every invited permission must be customer-delegable in the intended scope',
      }),
    );
  }
  return Effect.void;
};
