// Adapted generated Action contract error.
import { Schema } from 'effect';

export class AgreementsPersistenceUnavailable extends Schema.TaggedError<AgreementsPersistenceUnavailable>()(
  'AgreementsPersistenceUnavailable',
  { code: Schema.Literal('agreements_persistence_unavailable'), reason: Schema.String },
) {}
