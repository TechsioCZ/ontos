import { Schema } from 'effect';

export class SymmyJobRetentionError extends Schema.TaggedError<SymmyJobRetentionError>()('SymmyJobRetentionError', {
  code: Schema.Literals([
    'retention_authority_conflict',
    'retention_configuration_unavailable',
    'retention_scope_denied',
  ]),
}) {}
