import { Schema } from 'effect';

export class IdentityPersistenceUnavailableError extends Schema.TaggedError<IdentityPersistenceUnavailableError>()(
  'IdentityPersistenceUnavailableError',
  { code: Schema.Literal('identity_persistence_unavailable'), reason: Schema.String },
) {}
