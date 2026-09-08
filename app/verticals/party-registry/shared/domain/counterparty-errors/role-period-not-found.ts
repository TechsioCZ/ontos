import { Schema } from 'effect';

import { CounterpartyUuidSchema } from '../counterparty-contract.ts';

export class CounterpartyRolePeriodNotFound extends Schema.TaggedError<CounterpartyRolePeriodNotFound>()(
  'CounterpartyRolePeriodNotFound',
  {
    code: Schema.Literal('counterparty_role_period_not_found'),
    reason: Schema.String,
    rolePeriodId: CounterpartyUuidSchema,
  }
) {}
