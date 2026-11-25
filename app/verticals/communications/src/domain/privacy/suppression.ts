import { Data, Schema } from 'effect';
import type { DateTime } from 'effect';

import type { MessageIntentIdentity, StaleSourceReason } from '../catalog/decision.ts';
import type { ProtectedEndpoint } from '../recipient/original-binding.ts';
import type { HandoffVerdictCase } from '../recipient/recheck-before-handoff.ts';
import { HandoffVerdict } from '../recipient/recheck-before-handoff.ts';
import { RecipientAssessment } from '../recipient/recipient-assessment.ts';
import type { NotAllowedReason, UnresolvedReason } from '../recipient/recipient-assessment.ts';
import type { RecipientEvidence } from '../recipient/recipient-evidence.ts';
import type { IndeterminateCause, NotAllowedBasis, UnavailableReason } from './eligibility-gate.ts';
import { PrivacyAssessment, privacyStopOf } from './assess-privacy.ts';
import type { PrivacyAssessmentCase } from './assess-privacy.ts';
import type { ProcessingScope } from './processing-scope.ts';
import { processingScopeKey } from './processing-scope.ts';

/**
 * Communication Suppression of ONE message to ONE original recipient (#1396): a reasoned stop before the last
 * stoppable handoff. Categories are business meaning, not API enums (BR-14). Each category names who or what proved or
 * could not prove the stop, so a Privacy prohibition, an uncertain Privacy input, a recipient or channel stop and a
 * provider suppression are never reported as one another (BR-03, BR-10). Nothing here claims transport or delivery,
 * changes the source business fact, or rewrites a handoff that is already proven.
 */
const SuppressionCategorySchema = Schema.Literals([
  'AUDIENCE_GROUP_INCOMPLETE',
  'CHANNEL_UNUSABLE',
  'HANDOFF_INDETERMINATE',
  // Privacy answered but could not evidence a decision (inputs, context, purpose, evidence): not a prohibition.
  'PRIVACY_INDETERMINATE',
  // Privacy PROVED a prohibition of this exact scope with its own evidence. Nothing else is ever reported as this.
  'PRIVACY_NOT_ALLOWED',
  // No decision was reached, and each reason is its own fact: the Principal may not read Privacy eligibility,
  // the owner or its authority could not answer, or the request does not resolve to exactly one Privacy context.
  'PRIVACY_ACCESS_DENIED',
  'PRIVACY_AUTHORITY_UNAVAILABLE',
  'PRIVACY_CONTEXT_AMBIGUOUS',
  'PROVIDER_SUPPRESSED',
  // The recipient rule that governed the decision of this message is no longer the approved one: a catalog fact, not a recipient fact.
  'TYPE_RULE_CHANGED',
  // A mandatory recipient authority did not answer: uncertainty about the recipient, not a recipient fact.
  'RECIPIENT_AUTHORITY_UNAVAILABLE',
  'RECIPIENT_INVALID',
  'SOURCE_PROTECTED',
  'SOURCE_STALE',
]);
export type SuppressionCategory = typeof SuppressionCategorySchema.Type;

/** The concrete fact behind a category. Each is an existing owner vocabulary or an explicit Communications fact. */
export type SuppressionCause =
  | IndeterminateCause
  | NotAllowedBasis
  | NotAllowedReason
  | StaleSourceReason
  | 'SOURCE_NO_LONGER_VALID'
  | UnavailableReason
  | UnresolvedReason
  | 'AUDIENCE_GROUP_INCOMPLETE'
  | 'AUTHORITY_UNAVAILABLE'
  | 'CHANNEL_MISMATCH'
  | 'PROVIDER_BLOCKED'
  | 'PROVIDER_BOUNCED'
  | 'PROVIDER_FACT_UNAVAILABLE'
  | 'PROVIDER_SUPPRESSED'
  | 'RECIPIENT_RULE_CHANGED';

export interface SuppressionReason {
  readonly category: SuppressionCategory;
  readonly cause: SuppressionCause;
  /** True when an owner fact PROVES the stop; false when a mandatory input could not be evidenced. */
  readonly proven: boolean;
}

/** The source request is still justified, or its own owner has moved on (BR-08). Never a Communications failure. */
export type SourceCurrentnessCase = Data.TaggedEnum<{
  Current: object;
  Stale: { readonly reason: StaleSourceReason | 'SOURCE_NO_LONGER_VALID' };
}>;
export const SourceCurrentness = Data.taggedEnum<SourceCurrentnessCase>();

/** Provider-side facts step 22 evidenced for the ORIGINAL endpoint; they are not Privacy facts (BR-10). */
export type ProviderFactCase = Data.TaggedEnum<{
  Clear: object;
  Suppressed: { readonly evidenceRef: string; readonly kind: 'BLOCKED' | 'BOUNCED' | 'SUPPRESSED' };
  /** A mandatory provider or channel fact could not be obtained; never an allow fallback. */
  Unavailable: object;
}>;
export const ProviderFact = Data.taggedEnum<ProviderFactCase>();

/** What is known about a prior handoff of this very message. Timeout and queue status never prove "not sent". */
export type HandoffFactCase = Data.TaggedEnum<{
  /** It is not known whether an irreversible provider effect happened: reconcile first, never resend blindly. */
  EffectUnknown: object;
  NotAttempted: object;
  ProvenHandedOff: object;
}>;
export const HandoffFact = Data.taggedEnum<HandoffFactCase>();

export interface MessageEvidence {
  readonly evaluatedAt: DateTime.Utc;
  /** The Privacy answer this decision was made on: a message that may still be handed off is never decided without one. */
  readonly privacy: PrivacyAssessmentCase;
  readonly provider: ProviderFactCase;
  readonly recipient: RecipientEvidence | null;
  readonly scopeKey: string;
  readonly source: SourceCurrentnessCase;
}

export type MessageHandoffDecisionCase = Data.TaggedEnum<{
  /** Proven handoff stays exactly as it happened; later conditions are recorded, never applied backwards. */
  AlreadyHandedOff: { readonly identity: MessageIntentIdentity; readonly later: readonly SuppressionReason[] };
  /** May be prepared for step 22 now. This claims no provider acceptance and no delivery. */
  Proceed: {
    readonly endpoint: ProtectedEndpoint;
    readonly evidence: MessageEvidence;
    readonly identity: MessageIntentIdentity;
  };
  /** An unknown external effect: reconciliation first, no blind automatic resend, no Privacy verdict invented. */
  ReconciliationRequired: { readonly identity: MessageIntentIdentity };
  /** Stopped with every distinct reason, the proven ones first. The stop evidence is never overwritten. */
  Suppressed: {
    readonly evidence: MessageEvidence;
    readonly identity: MessageIntentIdentity;
    readonly primary: SuppressionReason;
    readonly reasons: readonly [SuppressionReason, ...SuppressionReason[]];
  };
}>;
export const MessageHandoffDecision = Data.taggedEnum<MessageHandoffDecisionCase>();

const stop = (category: SuppressionCategory, cause: SuppressionCause, proven: boolean): SuppressionReason => ({
  category,
  cause,
  proven,
});

/**
 * Only a proven prohibition is `PRIVACY_NOT_ALLOWED`; every other Privacy stop names its own fact and is unproven. The category
 * is the one the decision uses for the same answer (`privacyStopOf`), so the two moments never disagree.
 */
export const privacySuppressionReasons = (assessment: PrivacyAssessmentCase): readonly SuppressionReason[] => {
  const category = privacyStopOf(assessment);
  if (category === undefined) {
    return [];
  }
  return PrivacyAssessment.$match(assessment, {
    Allowed: () => [],
    Indeterminate: ({ cause }) => [stop(category, cause, false)],
    NotAllowed: ({ basis }) => [stop(category, basis, true)],
    Unavailable: ({ reason }) => [stop(category, reason, false)],
  });
};

/** A recipient stop keeps its owner reason; an ended or unsafe endpoint is a channel stop, an ended source a source stop. */
const recipientReasons = (verdict: HandoffVerdictCase): readonly SuppressionReason[] =>
  HandoffVerdict.$match(verdict, {
    AlreadyHandedOff: () => [],
    GroupStopped: () => [],
    Proceed: () => [],
    RuleChanged: () => [stop('TYPE_RULE_CHANGED', 'RECIPIENT_RULE_CHANGED', true)],
    Stopped: ({ assessment }) =>
      RecipientAssessment.$match(assessment, {
        RecipientAllowed: () => [],
        RecipientNotAllowed: ({ reason }): readonly SuppressionReason[] => {
          if (reason === 'SOURCE_NO_LONGER_VALID') {
            return [stop('SOURCE_STALE', reason, true)];
          }
          return reason === 'ORIGINAL_ENDPOINT_UNUSABLE' || reason === 'ENDPOINT_MASK_UNSAFE'
            ? [stop('CHANNEL_UNUSABLE', reason, true)]
            : [stop('RECIPIENT_INVALID', reason, true)];
        },
        RecipientUnresolved: ({ reason }) => [stop('RECIPIENT_INVALID', reason, false)],
        SourceUnavailable: () => [stop('RECIPIENT_AUTHORITY_UNAVAILABLE', 'AUTHORITY_UNAVAILABLE', false)],
      }),
  });

const sourceReasons = (source: SourceCurrentnessCase): readonly SuppressionReason[] =>
  SourceCurrentness.$match(source, {
    Current: () => [],
    Stale: ({ reason }) => [stop('SOURCE_STALE', reason, true)],
  });

const providerReasons = (provider: ProviderFactCase): readonly SuppressionReason[] =>
  ProviderFact.$match(provider, {
    Clear: () => [],
    Suppressed: ({ kind }) => [stop('PROVIDER_SUPPRESSED', `PROVIDER_${kind}`, true)],
    Unavailable: () => [stop('CHANNEL_UNUSABLE', 'PROVIDER_FACT_UNAVAILABLE', false)],
  });

/** The approved channel of the Privacy scope is the only channel the original endpoint may carry. */
const channelReasons = (verdict: HandoffVerdictCase, scope: ProcessingScope): readonly SuppressionReason[] =>
  HandoffVerdict.$is('Proceed')(verdict) && verdict.endpoint.channel !== scope.channel
    ? [stop('CHANNEL_UNUSABLE', 'CHANNEL_MISMATCH', true)]
    : [];

const CATEGORY_RANK: readonly SuppressionCategory[] = [
  'SOURCE_STALE',
  'TYPE_RULE_CHANGED',
  'PRIVACY_NOT_ALLOWED',
  'RECIPIENT_INVALID',
  'CHANNEL_UNUSABLE',
  'PROVIDER_SUPPRESSED',
  'SOURCE_PROTECTED',
  'PRIVACY_INDETERMINATE',
  'PRIVACY_CONTEXT_AMBIGUOUS',
  'PRIVACY_ACCESS_DENIED',
  'PRIVACY_AUTHORITY_UNAVAILABLE',
  'RECIPIENT_AUTHORITY_UNAVAILABLE',
  'HANDOFF_INDETERMINATE',
  'AUDIENCE_GROUP_INCOMPLETE',
];

/** A proven stop always outranks an uncertain one, so an evidenced prohibition survives any other unavailability (BR-04). */
const orderedReasons = (reasons: readonly SuppressionReason[]): readonly SuppressionReason[] =>
  reasons.toSorted(
    (a, b) =>
      Number(!a.proven) - Number(!b.proven) || CATEGORY_RANK.indexOf(a.category) - CATEGORY_RANK.indexOf(b.category),
  );

interface MessageFactsBase {
  readonly evaluatedAt: DateTime.Utc;
  readonly identity: MessageIntentIdentity;
  readonly provider: ProviderFactCase;
  readonly recipient: HandoffVerdictCase;
  readonly scope: ProcessingScope;
  readonly source: SourceCurrentnessCase;
}

/**
 * A message that may still be stopped or handed off. Privacy MUST have been asked for its exact scope: the type has no
 * way to state "not asked", so a `Proceed` without a Privacy question cannot compile (#1396 BR-01, T4-04).
 */
export interface AskedMessageFacts extends MessageFactsBase {
  readonly handoff: Extract<HandoffFactCase, { readonly _tag: 'NotAttempted' }>;
  readonly privacy: PrivacyAssessmentCase;
}

/** A message that is not asked about: its handoff is already proven, or its effect is unknown and is reconciled first. */
export interface UnaskedMessageFacts extends MessageFactsBase {
  readonly handoff: Exclude<HandoffFactCase, { readonly _tag: 'NotAttempted' }>;
  readonly privacy?: PrivacyAssessmentCase;
}

const recipientEvidenceOf = (verdict: HandoffVerdictCase): RecipientEvidence | null =>
  HandoffVerdict.$match(verdict, {
    AlreadyHandedOff: () => null,
    GroupStopped: ({ evidence }) => evidence,
    Proceed: ({ evidence }) => evidence,
    RuleChanged: () => null,
    Stopped: ({ evidence }) => evidence,
  });

const allReasonsOf = (facts: AskedMessageFacts | UnaskedMessageFacts): readonly SuppressionReason[] =>
  orderedReasons([
    ...sourceReasons(facts.source),
    ...(facts.privacy === undefined ? [] : privacySuppressionReasons(facts.privacy)),
    ...recipientReasons(facts.recipient),
    ...channelReasons(facts.recipient, facts.scope),
    ...providerReasons(facts.provider),
  ]);

/**
 * Decide a message that is NOT asked about. A proven handoff is historical truth: it stays exactly as it happened and a later
 * condition is recorded, governing only further processing. An unknown external effect is reconciled first, never resent
 * blindly, and is never given a Privacy verdict.
 */
export const decideUnaskedMessage = (facts: UnaskedMessageFacts): MessageHandoffDecisionCase => {
  const { identity } = facts;
  return HandoffFact.$is('ProvenHandedOff')(facts.handoff)
    ? MessageHandoffDecision.AlreadyHandedOff({ identity, later: allReasonsOf(facts) })
    : MessageHandoffDecision.ReconciliationRequired({ identity });
};

/**
 * Decide ONE message that may still be stopped or handed off from the independent facts about it. Its Privacy answer is a
 * required input (`AskedMessageFacts`). One message's facts never reach another message, so one denial never denies the
 * others; an approved indivisible audience is applied afterwards, over decisions, by `applyAudienceGroup`. Pure and total:
 * absence of any preference record is simply not an input.
 */
export const decideMessage = (facts: AskedMessageFacts): MessageHandoffDecisionCase => {
  const { identity } = facts;
  const evidence: MessageEvidence = {
    evaluatedAt: facts.evaluatedAt,
    privacy: facts.privacy,
    provider: facts.provider,
    recipient: recipientEvidenceOf(facts.recipient),
    scopeKey: processingScopeKey(facts.scope),
    source: facts.source,
  };
  const [primary, ...rest] = allReasonsOf(facts);
  if (primary !== undefined) {
    return MessageHandoffDecision.Suppressed({ evidence, identity, primary, reasons: [primary, ...rest] });
  }
  if (HandoffVerdict.$is('Proceed')(facts.recipient)) {
    return MessageHandoffDecision.Proceed({ endpoint: facts.recipient.endpoint, evidence, identity });
  }
  // Individually allowed by every owner, but the recipient algorithm already holds it back with its approved group.
  const held: SuppressionReason = {
    category: 'AUDIENCE_GROUP_INCOMPLETE',
    cause: 'AUDIENCE_GROUP_INCOMPLETE',
    proven: true,
  };
  return MessageHandoffDecision.Suppressed({ evidence, identity, primary: held, reasons: [held] });
};
