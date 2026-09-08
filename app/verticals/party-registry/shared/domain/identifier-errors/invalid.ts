import { Schema } from 'effect';

export class OfficialIdentifierInvalid extends Schema.TaggedError<OfficialIdentifierInvalid>()(
  'OfficialIdentifierInvalid',
  {
    code: Schema.Literal('party_official_identifier_invalid'),
    reason: Schema.String,
  }
) {}
