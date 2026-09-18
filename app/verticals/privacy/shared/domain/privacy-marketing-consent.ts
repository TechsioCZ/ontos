/* eslint-disable effect-native/no-nullable-schema-field, effect-native/no-unbranded-identifier-schema -- Privacy cross-owner wire contracts preserve explicit JSON null, canonical UTC string encodings, and owner-issued opaque references; generated API and Resource boundaries validate provenance without a misleading shared brand. expires: 2027-03-31. */
import { Effect, Schema } from 'effect';

import { ConsentScopeSchema, validateConsentScope } from './privacy-consent-scope.ts';
import type { ConsentMaterialDimension, ConsentScope } from './privacy-consent-scope.ts';
import { PrivacyIsoTimestampSchema } from './privacy-subject.ts';

const Ref = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const Version = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(100));

/** Marketing channels are privacy scope dimensions, not Commerce channels. */
export const MarketingCommunicationChannelSchema = Schema.Literals(['EMAIL', 'SMS', 'PHONE', 'PUSH']);
export type MarketingCommunicationChannel = typeof MarketingCommunicationChannelSchema.Type;

export const MarketingConsentScopeSchema = Schema.Struct({
  channel: MarketingCommunicationChannelSchema,
  consentScope: ConsentScopeSchema,
});
export type MarketingConsentScope = typeof MarketingConsentScopeSchema.Type;

const channelDimension = (channel: MarketingCommunicationChannel): ConsentMaterialDimension => ({
  kind: 'COMMUNICATION_CHANNEL',
  value: channel,
});

export class MarketingConsentScopeError extends Schema.TaggedError<MarketingConsentScopeError>()(
  'MarketingConsentScopeError',
  { reason: Schema.String },
) {}

/** Builds an exact channel scope. It never creates a wildcard or transfers another scope. */
export const createMarketingConsentScope = (
  scope: Omit<ConsentScope, 'materialDimensions'> & {
    readonly materialDimensions?: readonly ConsentMaterialDimension[];
  },
  channel: MarketingCommunicationChannel,
): Effect.Effect<MarketingConsentScope, MarketingConsentScopeError> => {
  const existing = scope.materialDimensions ?? [];
  if (existing.some(({ kind }) => kind === 'COMMUNICATION_CHANNEL')) {
    return Effect.fail(
      new MarketingConsentScopeError({
        reason: 'Marketing Consent scope must have exactly one communication channel dimension',
      }),
    );
  }
  const consentScope = { ...scope, materialDimensions: [...existing, channelDimension(channel)] };
  const validation = validateConsentScope({ requiredDimensions: ['COMMUNICATION_CHANNEL'], scope: consentScope });
  if (!validation.valid) {
    return Effect.fail(
      new MarketingConsentScopeError({ reason: validation.errors[0] ?? 'Marketing Consent scope is invalid' }),
    );
  }
  return Effect.succeed({ channel, consentScope });
};

export const ContactPointVerificationStatusSchema = Schema.Literals([
  'UNVERIFIED',
  'PENDING',
  'VERIFIED',
  'EXPIRED',
  'INDETERMINATE',
]);
export type ContactPointVerificationStatus = typeof ContactPointVerificationStatusSchema.Type;

/** Requirement and fact are owned by the Contact Point capability; Privacy only consumes them. */
export const ContactPointVerificationRequirementSchema = Schema.Struct({
  channel: MarketingCommunicationChannelSchema,
  effectiveFrom: PrivacyIsoTimestampSchema,
  required: Schema.Boolean,
  requirementRef: Ref,
  requirementVersion: Version,
  sourceEvidenceRefs: Schema.Array(Ref).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
});
export type ContactPointVerificationRequirement = typeof ContactPointVerificationRequirementSchema.Type;

export const ContactPointVerificationFactSchema = Schema.Struct({
  channel: MarketingCommunicationChannelSchema,
  contactPointRef: Ref,
  evidenceRefs: Schema.Array(Ref).check(Schema.isMaxLength(32)),
  status: ContactPointVerificationStatusSchema,
  verifiedAt: Schema.toEncoded(Schema.OptionFromNullOr(PrivacyIsoTimestampSchema)),
});
export type ContactPointVerificationFact = typeof ContactPointVerificationFactSchema.Type;

export type MarketingVerificationGate =
  | { readonly outcome: 'NOT_REQUIRED' }
  | { readonly fact: ContactPointVerificationFact; readonly outcome: 'ALLOWED' }
  | { readonly outcome: 'BLOCKED'; readonly reason: 'NOT_VERIFIED' | 'EXPIRED' }
  | { readonly outcome: 'INDETERMINATE'; readonly reason: 'VERIFICATION_UNRESOLVED' };

const evaluateVerificationFact = (fact: ContactPointVerificationFact): MarketingVerificationGate => {
  if (fact.status === 'VERIFIED' && fact.verifiedAt !== null) {
    return { fact, outcome: 'ALLOWED' };
  }
  if (fact.status === 'EXPIRED') {
    return { outcome: 'BLOCKED', reason: 'EXPIRED' };
  }
  if (fact.status === 'UNVERIFIED' || fact.status === 'PENDING') {
    return { outcome: 'BLOCKED', reason: 'NOT_VERIFIED' };
  }
  return { outcome: 'INDETERMINATE', reason: 'VERIFICATION_UNRESOLVED' };
};

/** Verification is an independent current gate, never a consent or identity proof. */
export const evaluateMarketingVerification = (input: {
  readonly channel: MarketingCommunicationChannel;
  readonly fact?: ContactPointVerificationFact;
  readonly requirement?: ContactPointVerificationRequirement;
}): MarketingVerificationGate => {
  if (input.requirement?.channel !== undefined && input.requirement.channel !== input.channel) {
    return { outcome: 'INDETERMINATE', reason: 'VERIFICATION_UNRESOLVED' };
  }
  if (input.requirement === undefined || !input.requirement.required) {
    return { outcome: 'NOT_REQUIRED' };
  }
  if (input.fact === undefined || input.fact.channel !== input.channel) {
    return { outcome: 'INDETERMINATE', reason: 'VERIFICATION_UNRESOLVED' };
  }
  return evaluateVerificationFact(input.fact);
};

export const CommunicationsSubscriptionChangeSchema = Schema.Struct({
  action: Schema.Literals(['SUBSCRIBE', 'UNSUBSCRIBE']),
  programRef: Ref,
  subscriptionId: Ref,
});
export type CommunicationsSubscriptionChange = typeof CommunicationsSubscriptionChangeSchema.Type;

export const CommunicationPreferenceChangeSchema = Schema.Struct({
  preference: Schema.Literals(['FREQUENCY', 'MESSAGE_TYPE', 'CHANNEL']),
  value: Ref,
});
export type CommunicationPreferenceChange = typeof CommunicationPreferenceChangeSchema.Type;

/** Explicitly carries independent owner transitions; no change is inferred from another fact. */
export const MarketingCommunicationTransitionSchema = Schema.Struct({
  consentDecisionId: Schema.NullOr(Ref),
  preferenceChange: Schema.NullOr(CommunicationPreferenceChangeSchema),
  subscriptionChange: Schema.NullOr(CommunicationsSubscriptionChangeSchema),
  transitionId: Ref,
});
export type MarketingCommunicationTransition = typeof MarketingCommunicationTransitionSchema.Type;

export const validateMarketingCommunicationTransition = (
  transition: MarketingCommunicationTransition,
): string | undefined => {
  if (
    transition.subscriptionChange === null &&
    transition.preferenceChange === null &&
    transition.consentDecisionId === null
  ) {
    return 'Marketing transition must contain an explicit owner change';
  }
  return undefined;
};
