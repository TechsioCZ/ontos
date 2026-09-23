import { Schema } from 'effect';

export class LocalizedFactsNotFound extends Schema.TaggedError<LocalizedFactsNotFound>()('LocalizedFactsNotFound', {
  code: Schema.Literal('localized_facts_not_found'),
  reason: Schema.String,
}) {}
