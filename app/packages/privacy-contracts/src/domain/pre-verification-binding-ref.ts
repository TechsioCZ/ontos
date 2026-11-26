import { Schema } from 'effect';

/** The opaque Privacy identity of one bound subject. It is the resource id of the subject's Privacy reference. */
export const PreVerificationBindingRefSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('PrivacyPreVerificationBindingRef'),
);
