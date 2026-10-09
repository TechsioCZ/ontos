import { Schema } from 'effect';

export class SupportedCurrenciesAdministrationRejected extends Schema.TaggedError<SupportedCurrenciesAdministrationRejected>()(
  'SupportedCurrenciesAdministrationRejected',
  {
    code: Schema.Literals([
      'supported_currencies_acknowledgement_mismatch',
      'supported_currencies_launch_set_invalid',
      'supported_currencies_scope_mismatch',
    ]),
    reason: Schema.String,
  },
) {}
