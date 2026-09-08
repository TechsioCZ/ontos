import { Effect } from 'effect';
import type { CounterpartyRoleAddPayload } from '../../shared/actions/counterparty-role-add.ts';
import { CounterpartyNotFound } from '../../shared/domain/counterparty-errors.ts';

export const counterpartyRoleWritePermission = (
  payload: Pick<CounterpartyRoleAddPayload, 'counterpartyRef'>,
) => ({
  permission: 'write' as const,
  resource: {
    moduleId: payload.counterpartyRef.moduleId,
    resourceId: payload.counterpartyRef.resourceId,
    resourceType: payload.counterpartyRef.resourceType,
  },
});

export const failCounterpartyNotFound = ({
  counterpartyId,
}: Pick<CounterpartyNotFound, 'counterpartyId'>) =>
  Effect.fail(
    new CounterpartyNotFound({
      code: 'counterparty_not_found',
      counterpartyId,
      reason: 'The Counterparty does not exist in the selected Legal Entity',
    }),
  );
