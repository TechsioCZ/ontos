/* eslint-disable effect-native/no-nullable-schema-field, effect-native/no-string-timestamp-schema, effect-native/no-unbranded-identifier-schema -- Privacy cross-owner wire contracts preserve explicit JSON null, canonical UTC string encodings, and owner-issued opaque references; generated API and Resource boundaries validate provenance without a misleading shared brand. expires: 2027-03-31. */
import { Effect, Schema } from 'effect';

const Timestamp = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u));
const Ref = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const Outcome = Schema.Literals([
  'PROVEN_PROVISION',
  'REPEATED_PROVISION',
  'FAILED_PROVISION',
  'INDETERMINATE_PROVISION',
  'DISPLAY_ONLY',
]);

/** Proof emitted by the trusted owner of the concrete delivery channel. */
const PrivacyNoticeChannelProofSchema = Schema.Struct({
  authorityRef: Ref,
  channel: Ref,
  evidenceRef: Ref,
  observedAt: Timestamp,
  proofKind: Schema.Literals(['DELIVERY_CONFIRMED', 'INTERACTIVE_ACKNOWLEDGEMENT', 'IN_PERSON_ACKNOWLEDGEMENT']),
});
export type PrivacyNoticeChannelProof = typeof PrivacyNoticeChannelProofSchema.Type;

/** A minimal, immutable fact about one notice information step. Raw page or transport payloads are deliberately absent. */
const privacyNoticeProvisionFields = {
  actionRef: Schema.NullOr(Ref),
  anonymousContextRef: Schema.NullOr(Ref),
  businessInteractionRef: Schema.NullOr(Ref),
  channel: Schema.NullOr(Ref),
  channelProof: Schema.optional(Schema.NullOr(PrivacyNoticeChannelProofSchema)),
  controllerRef: Ref,
  evidenceRef: Schema.NullOr(Ref),
  failureReason: Schema.NullOr(Ref),
  noticeVersionRef: Ref,
  outcome: Outcome,
  privacySubjectRef: Schema.NullOr(Ref),
  processingPurposeRef: Ref,
  processingScopeRef: Ref,
  providedLanguage: Ref,
  provisionedAt: Timestamp,
  provisionId: Ref,
  recordedAt: Timestamp,
  supersedesProvisionRef: Schema.NullOr(Ref),
} as const;

export const PrivacyNoticeProvisionSchema = Schema.Struct(privacyNoticeProvisionFields);
export type PrivacyNoticeProvision = typeof PrivacyNoticeProvisionSchema.Type;

const RecordPrivacyNoticeProvisionInputSchema = Schema.Struct(privacyNoticeProvisionFields);
export type RecordPrivacyNoticeProvisionInput = typeof RecordPrivacyNoticeProvisionInputSchema.Type;

const { recordedAt: _recordedAt, ...privacyNoticeProvisionDraftFields } = privacyNoticeProvisionFields;
export const PrivacyNoticeProvisionDraftSchema = Schema.Struct(privacyNoticeProvisionDraftFields);

export interface TrustedPrivacyNoticeProvisionContext {
  readonly authoritativeProof: PrivacyNoticeChannelProof | null;
  readonly recordedAt: string;
}

export type PrivacyNoticeProvisionDraft = typeof PrivacyNoticeProvisionDraftSchema.Type;

export class PrivacyNoticeProvisionInvariantError extends Schema.TaggedError<PrivacyNoticeProvisionInvariantError>()(
  'PrivacyNoticeProvisionInvariantError',
  { reason: Schema.String },
) {}

const channelProofsAreEquivalent = Schema.toEquivalence(PrivacyNoticeChannelProofSchema);

export const isProofOfProvision = (outcome: PrivacyNoticeProvision['outcome']): boolean =>
  outcome === 'PROVEN_PROVISION' || outcome === 'REPEATED_PROVISION';

/** Publication, render, queue acceptance, and transport attempts never become proof by inference. */
// fallow-ignore-next-line complexity -- This fail-closed validator intentionally enumerates each independent proof and trusted-context invariant.
export const validatePrivacyNoticeProvision = (
  input: RecordPrivacyNoticeProvisionInput,
  trusted?: TrustedPrivacyNoticeProvisionContext,
): string | undefined => {
  const hasSubject = input.privacySubjectRef !== null;
  const hasAnonymousContext = input.anonymousContextRef !== null;
  if (hasSubject === hasAnonymousContext) {
    return 'Exactly one subject or anonymous context is required';
  }
  if (input.recordedAt < input.provisionedAt) {
    return 'Recorded time cannot precede provision time';
  }
  if (isProofOfProvision(input.outcome)) {
    if (input.channel === null) {
      return 'Proof of provision requires a concrete channel';
    }
    if (input.evidenceRef === null || input.channelProof === null || input.channelProof === undefined) {
      return 'Proof of provision requires channel-specific authoritative proof data';
    }
    if (input.channelProof.channel !== input.channel || input.channelProof.evidenceRef !== input.evidenceRef) {
      return 'Notice provision proof must match the provision channel and evidence reference';
    }
    if (input.channelProof.observedAt !== input.provisionedAt) {
      return 'Notice provision time must come from the authoritative channel proof';
    }
    if (trusted === undefined) {
      return 'Proof of provision requires trusted recording context';
    }
    if (trusted.recordedAt !== input.recordedAt) {
      return 'Recorded time must come from the trusted recording context';
    }
    if (
      trusted.authoritativeProof === null ||
      !channelProofsAreEquivalent(trusted.authoritativeProof, input.channelProof)
    ) {
      return 'Notice provision proof does not match trusted channel evidence';
    }
  } else if (input.channelProof !== null && input.channelProof !== undefined) {
    return 'Non-proof outcomes cannot carry authoritative channel proof';
  }
  if (!isProofOfProvision(input.outcome) && input.outcome === 'DISPLAY_ONLY' && input.evidenceRef !== null) {
    return 'Display-only facts cannot carry provision proof evidence';
  }
  return undefined;
};

/** Materializes an immutable fact without accepting client-controlled proof or recording time. */
export const materializePrivacyNoticeProvision = (
  input: PrivacyNoticeProvisionDraft,
  trusted: TrustedPrivacyNoticeProvisionContext,
): Effect.Effect<PrivacyNoticeProvision, PrivacyNoticeProvisionInvariantError> => {
  const proof = trusted.authoritativeProof;
  const provision: PrivacyNoticeProvision = {
    ...input,
    channelProof: proof,
    evidenceRef: isProofOfProvision(input.outcome) ? (proof?.evidenceRef ?? null) : input.evidenceRef,
    provisionedAt: isProofOfProvision(input.outcome) ? (proof?.observedAt ?? input.provisionedAt) : input.provisionedAt,
    recordedAt: trusted.recordedAt,
  };
  const reason = validatePrivacyNoticeProvision(provision, trusted);
  return reason === undefined
    ? Effect.succeed(provision)
    : Effect.fail(new PrivacyNoticeProvisionInvariantError({ reason }));
};
