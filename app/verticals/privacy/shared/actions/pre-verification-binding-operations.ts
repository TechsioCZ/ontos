import { Schema } from 'effect';

import {
  PreVerificationBindingRefSchema,
  PreVerificationBindingStatusSchema,
  PreVerificationSourceSubjectSchema,
} from '../domain/pre-verification-binding.ts';
import { IntendedProcessingScopeSchema } from '../domain/privacy-processing-eligibility.ts';
import { PrivacyIsoTimestampSchema } from '../domain/privacy-subject.ts';

const Ref = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300));

export { PreVerificationBindingRecordSchema as WithdrawPreVerificationBindingResultSchema } from '../domain/pre-verification-binding.ts';

/**
 * The source owner binds the Privacy subject of ONE account it has not verified yet, for ONE of its purposes. It names
 * only its OWN account reference and the occurrence that needs it (for Portal Auth: the issuance and its expiry); no
 * address, token, link or code has a field here. Privacy, not the source, supplies the scope.
 */
export const BindPreVerificationSubjectPayloadSchema = Schema.Struct({
  occurrence: Schema.Struct({
    occurrenceId: Ref.pipe(Schema.brand('PrivacyPreVerificationOccurrenceId'), Schema.decodeTo(Schema.String)),
    validUntil: PrivacyIsoTimestampSchema,
  }),
  source: PreVerificationSourceSubjectSchema,
  sourcePurposeRef: Ref,
});
export type BindPreVerificationSubjectPayload = typeof BindPreVerificationSubjectPayloadSchema.Type;

/**
 * The binding Privacy holds and the exact scope its current policy allows for it. `status` is Privacy's own fact: a
 * subject Privacy withdrew stays withdrawn when the source binds it again, and its every eligibility is NOT_ALLOWED.
 */
export const BindPreVerificationSubjectResultSchema = Schema.Struct({
  bindingRef: PreVerificationBindingRefSchema,
  policy: Schema.Struct({ policyRef: Ref, revision: Ref }),
  scope: IntendedProcessingScopeSchema,
  status: PreVerificationBindingStatusSchema,
  validUntil: PrivacyIsoTimestampSchema,
});
export type BindPreVerificationSubjectResult = typeof BindPreVerificationSubjectResultSchema.Type;

/**
 * A Privacy decision that a bound pre-verification subject may no longer be processed (an objection, a restriction, an
 * erasure request, or a binding found invalid). `evidenceRef` is Privacy's own reference to the decision behind it, for
 * example its DSR case. The withdrawal is final for this binding: a later bind of the same account stays withdrawn.
 */
export const WithdrawPreVerificationBindingPayloadSchema = Schema.Struct({
  bindingRef: PreVerificationBindingRefSchema,
  evidenceRef: Ref,
});
export type WithdrawPreVerificationBindingPayload = typeof WithdrawPreVerificationBindingPayloadSchema.Type;
