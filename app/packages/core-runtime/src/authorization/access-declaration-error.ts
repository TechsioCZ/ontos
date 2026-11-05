import { Schema } from 'effect';

export class AccessDeclarationError extends Schema.TaggedError<AccessDeclarationError>()('AccessDeclarationError', {
  code: Schema.Literal('access_declaration_invalid'),
  reason: Schema.String,
}) {}
