/* eslint-disable max-classes-per-file -- Counterparty Actions share one closed typed domain-error vocabulary. */
import { Schema } from 'effect';
import { CounterpartyUuidSchema } from './counterparty-contract.ts';

export class CounterpartyNotFound extends Schema.TaggedError<CounterpartyNotFound>()(
  'CounterpartyNotFound',
  {
    code: Schema.Literal('counterparty_not_found'),
    counterpartyId: CounterpartyUuidSchema,
    reason: Schema.String,
  },
) {}

export class CounterpartyPartyNotFound extends Schema.TaggedError<CounterpartyPartyNotFound>()(
  'CounterpartyPartyNotFound',
  {
    code: Schema.Literal('counterparty_party_not_found'),
    partyId: CounterpartyUuidSchema,
    reason: Schema.String,
  },
) {}

export class CounterpartyPartyArchived extends Schema.TaggedError<CounterpartyPartyArchived>()(
  'CounterpartyPartyArchived',
  {
    code: Schema.Literal('counterparty_party_archived'),
    partyId: CounterpartyUuidSchema,
    reason: Schema.String,
  },
) {}

export class CounterpartyScopeMismatch extends Schema.TaggedError<CounterpartyScopeMismatch>()(
  'CounterpartyScopeMismatch',
  {
    code: Schema.Literal('counterparty_scope_mismatch'),
    reason: Schema.String,
  },
) {}

export class CounterpartyEvidenceInsufficient extends Schema.TaggedError<CounterpartyEvidenceInsufficient>()(
  'CounterpartyEvidenceInsufficient',
  {
    code: Schema.Literal('counterparty_evidence_insufficient'),
    method: Schema.String,
    reason: Schema.String,
  },
) {}

export class CounterpartyRoleOverlap extends Schema.TaggedError<CounterpartyRoleOverlap>()(
  'CounterpartyRoleOverlap',
  {
    code: Schema.Literal('counterparty_role_overlap'),
    reason: Schema.String,
    roleType: Schema.Literals(['CUSTOMER', 'SUPPLIER']),
  },
) {}

export class CounterpartyRolePeriodNotFound extends Schema.TaggedError<CounterpartyRolePeriodNotFound>()(
  'CounterpartyRolePeriodNotFound',
  {
    code: Schema.Literal('counterparty_role_period_not_found'),
    reason: Schema.String,
    rolePeriodId: CounterpartyUuidSchema,
  },
) {}

export class CounterpartyRoleAlreadyEnded extends Schema.TaggedError<CounterpartyRoleAlreadyEnded>()(
  'CounterpartyRoleAlreadyEnded',
  {
    code: Schema.Literal('counterparty_role_already_ended'),
    reason: Schema.String,
    rolePeriodId: CounterpartyUuidSchema,
  },
) {}

export class CounterpartyTemporalConflict extends Schema.TaggedError<CounterpartyTemporalConflict>()(
  'CounterpartyTemporalConflict',
  {
    code: Schema.Literal('counterparty_temporal_conflict'),
    reason: Schema.String,
  },
) {}

export class CounterpartyPersistenceUnavailable extends Schema.TaggedError<CounterpartyPersistenceUnavailable>()(
  'CounterpartyPersistenceUnavailable',
  {
    code: Schema.Literal('counterparty_persistence_unavailable'),
    reason: Schema.String,
  },
) {}
