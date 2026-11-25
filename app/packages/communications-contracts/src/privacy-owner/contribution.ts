import { Schema } from 'effect';
import type { PrivacyOwnerCoverageResultEncoded } from '@app/shared-contracts';

import type { InventoryCategoryId } from './inventory.ts';

/**
 * Right-specific Owner Contribution of Communications (#597, #598). It is built from the exact content the coverage found
 * and from the right asked for. It never decides completeness from absence in a portal or admin list, never uses the
 * ordinary history view as a blanket limit on a lawful request, and withholds or redacts what belongs to other data
 * subjects. It returns references and decisions only; the owner's records are never copied.
 */

export const PRIVACY_RIGHTS = [
  'ACCESS',
  'PORTABILITY',
  'RECTIFICATION',
  'ERASURE',
  'RESTRICTION',
  'OBJECTION',
] as const;
export type PrivacyRight = (typeof PRIVACY_RIGHTS)[number];

/** One piece of found content, with what the owner knows about the people it concerns. */
export interface FoundContentItem {
  readonly category: InventoryCategoryId;
  readonly containsOtherDataSubjects: boolean;
  readonly contentRef: string;
  /** Whether the other subjects' part can be separated from the requester's (a recipient list can, a whole intent cannot). */
  readonly separable: boolean;
}

/** Per-right, per-category eligibility the Privacy owner supplies where a right depends on the legal basis (portability). */
export type SuppliedRightEligibility = Readonly<
  Partial<Record<PrivacyRight, Readonly<Partial<Record<InventoryCategoryId, boolean>>>>>
>;

export const ProtectionOutcomeSchema = Schema.Literals(['EXCLUDE', 'INCLUDE', 'REDACT']);
export type ProtectionOutcome = typeof ProtectionOutcomeSchema.Type;

export interface ProtectedContentDecision {
  readonly category: InventoryCategoryId;
  readonly contentRef: string;
  readonly outcome: ProtectionOutcome;
  readonly reason: string;
}

export interface CommunicationsOwnerContribution {
  readonly completion: 'COMPLETE' | 'INCOMPLETE';
  readonly decisions: readonly ProtectedContentDecision[];
  readonly exclusions: readonly { readonly reason: string; readonly scopeRef: string }[];
  readonly includedContentRefs: readonly string[];
  readonly right: PrivacyRight;
  /** The categories this right cannot be answered for without a supplied input. */
  readonly unresolvedCategories: readonly InventoryCategoryId[];
}

/**
 * Access, rectification, erasure, restriction and objection concern all personal data the owner actually holds. Portability
 * is limited by the legal basis and the way the data was provided, which Communications cannot decide: a category without a
 * supplied eligibility is UNRESOLVED and keeps the contribution INCOMPLETE rather than being included or silently dropped.
 */
const eligibilityOf = (
  right: PrivacyRight,
  category: InventoryCategoryId,
  supplied: SuppliedRightEligibility,
): boolean | undefined => (right === 'PORTABILITY' ? supplied.PORTABILITY?.[category] : true);

const decide = (item: FoundContentItem, eligible: boolean): ProtectedContentDecision => {
  const base = { category: item.category, contentRef: item.contentRef };
  if (!eligible) {
    return { ...base, outcome: 'EXCLUDE', reason: 'OUTSIDE_THE_APPROVED_RIGHT_SPECIFIC_ELIGIBILITY' };
  }
  if (!item.containsOtherDataSubjects) {
    return { ...base, outcome: 'INCLUDE', reason: 'ELIGIBLE_AND_NO_PROTECTED_THIRD_PARTY_SCOPE' };
  }
  return item.separable
    ? { ...base, outcome: 'REDACT', reason: 'ONLY_THE_SEPARABLE_THIRD_PARTY_SCOPE_IS_PROTECTED' }
    : { ...base, outcome: 'EXCLUDE', reason: 'PROTECTED_THIRD_PARTY_CONTENT_IS_NOT_REASONABLY_SEPARABLE' };
};

/**
 * Completion is COMPLETE only when the coverage is COMPLETE, nothing is unresolved, and every found item has a decision.
 * A lawful exclusion of another person's data does not make it incomplete; a missing eligibility or incomplete coverage does.
 */
export const assembleCommunicationsContribution = (input: {
  readonly coverage: PrivacyOwnerCoverageResultEncoded;
  readonly eligibility?: SuppliedRightEligibility;
  readonly items: readonly FoundContentItem[];
  readonly right: PrivacyRight;
}): CommunicationsOwnerContribution => {
  const eligibility = input.eligibility ?? {};
  const unresolved = new Set<InventoryCategoryId>();
  const decisions = input.items.flatMap((item): ProtectedContentDecision[] => {
    const eligible = eligibilityOf(input.right, item.category, eligibility);
    if (eligible === undefined) {
      unresolved.add(item.category);
      return [];
    }
    return [decide(item, eligible)];
  });
  const exclusions: { reason: string; scopeRef: string }[] = [];
  const includedContentRefs: string[] = [];
  for (const { contentRef, outcome, reason } of decisions) {
    if (outcome === 'EXCLUDE') {
      exclusions.push({ reason, scopeRef: contentRef });
    } else {
      includedContentRefs.push(contentRef);
    }
  }
  return {
    completion: input.coverage.coverageStatus === 'COMPLETE' && unresolved.size === 0 ? 'COMPLETE' : 'INCOMPLETE',
    decisions,
    exclusions,
    includedContentRefs,
    right: input.right,
    unresolvedCategories: [...unresolved].toSorted(),
  };
};
