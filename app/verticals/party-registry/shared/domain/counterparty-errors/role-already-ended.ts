import { Schema } from 'effect';

import { CounterpartyUuidSchema } from '../counterparty-contract.ts';

export class CounterpartyRoleAlreadyEnded extends Schema.TaggedError<CounterpartyRoleAlreadyEnded>()(
  'CounterpartyRoleAlreadyEnded',
  {
    code: Schema.Literal('counterparty_role_already_ended'),
    reason: Schema.String,
    rolePeriodId: CounterpartyUuidSchema,
  }
) {}
