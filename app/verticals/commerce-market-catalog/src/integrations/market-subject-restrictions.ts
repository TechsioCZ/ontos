import type { MarketSubjectRestrictionsCurrentResponse } from '@app/customer-market-retirement-contracts/market-subject-restrictions-current';
import { Option } from 'effect';

type OwnerCurrentRestrictions = Extract<
  MarketSubjectRestrictionsCurrentResponse,
  { readonly outcome: 'SUBJECT_RESTRICTIONS_CURRENT' }
>;

export interface MarketSubjectRestrictionSnapshot {
  readonly allowedChannels: readonly ('B2B' | 'B2C')[];
  readonly allowedMarketIds?: readonly string[];
  readonly allowedSellerIds: readonly string[];
  readonly decision: 'ALLOWED' | 'DENIED';
  readonly evidenceRefs: readonly string[];
  readonly observedAt: OwnerCurrentRestrictions['observedAt'];
  readonly ownerRevision: string;
  readonly profileState: 'ACTIVE' | 'ARCHIVED' | 'SUSPENDED';
  readonly subjectIdentityRef: string;
  readonly subjectKind: 'COUNTERPARTY' | 'RETAIL_PROFILE';
}

/** The owner's answer as the snapshot Market resolution uses: only a current restriction set is one. */
export const currentSubjectRestrictionSnapshot = (
  response: MarketSubjectRestrictionsCurrentResponse,
): Option.Option<MarketSubjectRestrictionSnapshot> => {
  if (response.outcome !== 'SUBJECT_RESTRICTIONS_CURRENT') {
    return Option.none();
  }
  const base = {
    allowedChannels: response.channelConstraint.allowedChannels,
    allowedSellerIds:
      response.sellerConstraint.kind === 'FIXED_SELLER'
        ? [response.sellerConstraint.sellerRef.resourceId]
        : response.sellerConstraint.sellerRefs.map(({ resourceId }) => resourceId),
    decision: response.decision,
    evidenceRefs: response.evidenceRefs,
    observedAt: response.observedAt,
    ownerRevision: response.ownerRevision,
    profileState: response.profileState,
    subjectIdentityRef: response.subject.profileRef.resourceId,
    subjectKind: response.subject.kind,
  } satisfies Omit<MarketSubjectRestrictionSnapshot, 'allowedMarketIds'>;
  return Option.some(
    response.marketConstraint.kind === 'ALLOWED_MARKETS'
      ? {
          ...base,
          allowedMarketIds: response.marketConstraint.marketRefs.map(({ resourceId }) => resourceId),
        }
      : base,
  );
};
