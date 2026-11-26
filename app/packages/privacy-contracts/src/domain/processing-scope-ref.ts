import { Schema } from 'effect';

/** The bounded, trimmed identity every Privacy reference shares. */
export const PrivacyBoundedIdSchema = Schema.toEncoded(
  Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300)).pipe(Schema.brand('PrivacyBoundedId')),
);

export const ProcessingScopeRefSchema = Schema.Struct({
  scopeId: PrivacyBoundedIdSchema,
  scopeType: Schema.Literal('privacy.processing-scope'),
});
export type ProcessingScopeRef = typeof ProcessingScopeRefSchema.Type;
