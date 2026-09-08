import { Schema } from 'effect';

export class CounterpartyRoleOverlap extends Schema.TaggedError<CounterpartyRoleOverlap>()(
  'CounterpartyRoleOverlap',
  {
    code: Schema.Literal('counterparty_role_overlap'),
    reason: Schema.String,
    roleType: Schema.Literals(['CUSTOMER', 'SUPPLIER']),
  },
) {}
