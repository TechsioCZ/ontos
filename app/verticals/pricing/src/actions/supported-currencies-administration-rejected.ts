import { Schema } from 'effect';

export class SupportedCurrenciesAdministrationRejected extends Schema.TaggedError<SupportedCurrenciesAdministrationRejected>()(
  'SupportedCurrenciesAdministrationRejected',
  {
    code: Schema.Literals(['supported_currencies_scope_mismatch', 'supported_currencies_effective_time_conflict']),
    reason: Schema.String,
  },
) {}
