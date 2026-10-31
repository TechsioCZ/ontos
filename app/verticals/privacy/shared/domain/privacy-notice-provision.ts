import type { PrivacyIsoTimestampSchema } from './privacy-subject.ts';
import { Effect, Schema } from 'effect';

import { PrivacyNoticeChannelProofSchema } from '@app/consent-authority-contracts';
import type {
  PrivacyNoticeChannelProof,
  PrivacyNoticeProvisionDraft,
  PrivacyNoticeProvision,
  RecordPrivacyNoticeProvisionInput,
} from '@app/consent-authority-contracts';

export { PrivacyNoticeProvisionSchema } from '@app/consent-authority-contracts';
export type {
  PrivacyNoticeChannelProof,
  PrivacyNoticeProvisionDraft,
  PrivacyNoticeProvision,
  RecordPrivacyNoticeProvisionInput,
  PrivacyNoticeAuthorityFact,
} from '@app/consent-authority-contracts';

export interface TrustedPrivacyNoticeProvisionContext {
  readonly authoritativeProof: PrivacyNoticeChannelProof | null;
  readonly recordedAt: typeof PrivacyIsoTimestampSchema.Type;
}

export class PrivacyNoticeProvisionInvariantError extends Schema.TaggedError<PrivacyNoticeProvisionInvariantError>()(
  'PrivacyNoticeProvisionInvariantError',
  { reason: Schema.String },
) {}

const channelProofsAreEquivalent = Schema.toEquivalence(PrivacyNoticeChannelProofSchema);

const proofMatchesRequestedScope = (
  proof: PrivacyNoticeChannelProof,
  request: RecordPrivacyNoticeProvisionInput,
): boolean =>
  [
    [proof.anonymousContextRef, request.anonymousContextRef],
    [proof.businessInteractionRef, request.businessInteractionRef],
    [proof.channel, request.channel],
    [proof.controllerRef, request.controllerRef],
    [proof.noticeVersionRef, request.noticeVersionRef],
    [proof.privacySubjectRef, request.privacySubjectRef],
    [proof.processingPurposeRef, request.processingPurposeRef],
    [proof.processingScopeRef, request.processingScopeRef],
    [proof.providedLanguage, request.providedLanguage],
  ].every(([left, right]) => left === right);

const materializedNoticeScope = (input: PrivacyNoticeProvisionDraft, proof: PrivacyNoticeChannelProof | null) =>
  proof === null
    ? {
        anonymousContextRef: input.anonymousContextRef,
        businessInteractionRef: input.businessInteractionRef,
        controllerRef: input.controllerRef,
        noticeVersionRef: input.noticeVersionRef,
        privacySubjectRef: input.privacySubjectRef,
        processingPurposeRef: input.processingPurposeRef,
        processingScopeRef: input.processingScopeRef,
        providedLanguage: input.providedLanguage,
      }
    : {
        anonymousContextRef: proof.anonymousContextRef,
        businessInteractionRef: proof.businessInteractionRef,
        controllerRef: proof.controllerRef,
        noticeVersionRef: proof.noticeVersionRef,
        privacySubjectRef: proof.privacySubjectRef,
        processingPurposeRef: proof.processingPurposeRef,
        processingScopeRef: proof.processingScopeRef,
        providedLanguage: proof.providedLanguage,
      };

export const isProofOfProvision = (outcome: PrivacyNoticeProvision['outcome']): boolean =>
  outcome === 'PROVEN_PROVISION' || outcome === 'REPEATED_PROVISION';

const materializedDeliveryFields = (input: PrivacyNoticeProvisionDraft, proof: PrivacyNoticeChannelProof | null) =>
  isProofOfProvision(input.outcome)
    ? { evidenceRef: proof?.evidenceRef ?? null, provisionedAt: proof?.observedAt ?? input.provisionedAt }
    : { evidenceRef: input.evidenceRef, provisionedAt: input.provisionedAt };

const validateProvenProofRequirements = (input: RecordPrivacyNoticeProvisionInput): string | undefined => {
  if (input.channel === null) {
    return 'Proof of provision requires a concrete channel';
  }
  if (input.evidenceRef === null || input.channelProof === null || input.channelProof === undefined) {
    return 'Proof of provision requires channel-specific authoritative proof data';
  }
  if (input.channelProof.channel !== input.channel || input.channelProof.evidenceRef !== input.evidenceRef) {
    return 'Notice provision proof must match the provision channel and evidence reference';
  }
  return input.channelProof.observedAt === input.provisionedAt
    ? undefined
    : 'Notice provision time must come from the authoritative channel proof';
};

const validateTrustedProvenProof = (
  input: RecordPrivacyNoticeProvisionInput,
  trusted: TrustedPrivacyNoticeProvisionContext | undefined,
): string | undefined => {
  if (trusted === undefined) {
    return 'Proof of provision requires trusted recording context';
  }
  if (trusted.recordedAt !== input.recordedAt) {
    return 'Recorded time must come from the trusted recording context';
  }
  const proof = input.channelProof;
  if (proof === null || proof === undefined) {
    return 'Proof of provision requires channel-specific authoritative proof data';
  }
  if (trusted.authoritativeProof === null) {
    return 'Notice provision proof does not match trusted channel evidence';
  }
  if (!channelProofsAreEquivalent(trusted.authoritativeProof, proof)) {
    return 'Notice provision proof does not match trusted channel evidence';
  }
  return proofMatchesRequestedScope(proof, input)
    ? undefined
    : 'Notice provision proof does not match the requested notice scope';
};

const validateProvenOutcome = (input: RecordPrivacyNoticeProvisionInput): string | undefined => {
  if (input.failureReason !== null) {
    return 'Proven Notice Provision cannot carry a failure reason';
  }
  if (input.outcome === 'PROVEN_PROVISION' && input.supersedesProvisionRef !== null) {
    return 'Initial proven Notice Provision cannot supersede another provision';
  }
  return input.outcome === 'REPEATED_PROVISION' && input.supersedesProvisionRef === null
    ? 'Repeated Notice Provision must identify the provision it supersedes'
    : undefined;
};

const validateProvenProvision = (
  input: RecordPrivacyNoticeProvisionInput,
  trusted: TrustedPrivacyNoticeProvisionContext | undefined,
): string | undefined =>
  validateProvenProofRequirements(input) ?? validateTrustedProvenProof(input, trusted) ?? validateProvenOutcome(input);

const validateNonProvenProvision = (input: RecordPrivacyNoticeProvisionInput): string | undefined => {
  if (input.channelProof !== null && input.channelProof !== undefined) {
    return 'Non-proof outcomes cannot carry authoritative channel proof';
  }
  if (input.outcome === 'DISPLAYED_WITHOUT_ACKNOWLEDGEMENT' && input.failureReason !== null) {
    return 'Displayed-without-acknowledgement cannot carry a failure reason';
  }
  if (
    (input.outcome === 'PROVISION_FAILED' || input.outcome === 'PROVISION_INDETERMINATE') &&
    input.failureReason === null
  ) {
    return 'Failed or indeterminate Notice Provision requires an authoritative reason';
  }
  return undefined;
};

/** Publication, render, queue acceptance, and transport attempts never become proof by inference. */
export const validatePrivacyNoticeProvision = (
  input: RecordPrivacyNoticeProvisionInput,
  trusted?: TrustedPrivacyNoticeProvisionContext,
): string | undefined => {
  if ((input.privacySubjectRef === null) === (input.anonymousContextRef === null)) {
    return 'Exactly one subject or anonymous context is required';
  }
  if (input.recordedAt < input.provisionedAt) {
    return 'Recorded time cannot precede provision time';
  }
  return isProofOfProvision(input.outcome)
    ? validateProvenProvision(input, trusted)
    : validateNonProvenProvision(input);
};

/** Materializes an immutable fact without accepting client-controlled proof or recording time. */
export const materializePrivacyNoticeProvision = (
  input: PrivacyNoticeProvisionDraft,
  trusted: TrustedPrivacyNoticeProvisionContext,
): Effect.Effect<PrivacyNoticeProvision, PrivacyNoticeProvisionInvariantError> => {
  const proof = trusted.authoritativeProof;
  const provision: PrivacyNoticeProvision = {
    ...input,
    ...materializedNoticeScope(input, proof),
    channelProof: proof,
    ...materializedDeliveryFields(input, proof),
    recordedAt: trusted.recordedAt,
  };
  const reason = validatePrivacyNoticeProvision(provision, trusted);
  return reason === undefined
    ? Effect.succeed(provision)
    : Effect.fail(new PrivacyNoticeProvisionInvariantError({ reason }));
};
