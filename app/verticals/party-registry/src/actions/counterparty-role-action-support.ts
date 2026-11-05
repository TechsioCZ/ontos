import { Effect } from 'effect';

import { CounterpartyNotFound } from '../../shared/domain/counterparty-errors.ts';

export const failCounterpartyNotFound = ({ counterpartyId }: Pick<CounterpartyNotFound, 'counterpartyId'>) =>
  Effect.fail(
    new CounterpartyNotFound({
      code: 'counterparty_not_found',
      counterpartyId,
      reason: 'The Counterparty does not exist in the selected Legal Entity',
    }),
  );
