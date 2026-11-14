import { declaredEvidenceCallInsideTransaction } from '@app/core-runtime';
import type { DeclaredEvidenceCall } from '@app/core-runtime';

/**
 * Privacy owner proof reads that main's source-evidence design makes from inside a governed read or Action
 * transaction, because their request is derived there. Demo divergence: DEPLOYMENT.md, declared in-transaction
 * evidence calls. The inventory is pinned by `scripts/tests/declared-evidence-calls-ratchet.test.mts`; only remove.
 */
export const privacyDeclaredEvidenceCalls = {
  customerIntakeOwnerContext: { evidence: 'privacy.customer-intake-owner-context', owner: 'privacy.core' },
  organizationBusinessOwnerContext: { evidence: 'privacy.organization-business-owner-context', owner: 'privacy.core' },
  organizationBusinessOwnerFacts: { evidence: 'privacy.organization-business-owner-facts', owner: 'privacy.core' },
  organizationIcoOwnerFacts: { evidence: 'privacy.organization-ico-owner-facts', owner: 'privacy.core' },
  organizationPartyRecordFacts: { evidence: 'privacy.organization-party-record-facts', owner: 'privacy.core' },
  organizationProfileIcoOwnerFacts: { evidence: 'privacy.organization-profile-ico-owner-facts', owner: 'privacy.core' },
  organizationProfileOwnerFacts: { evidence: 'privacy.organization-profile-owner-facts', owner: 'privacy.core' },
  organizationSourceOwnerFacts: { evidence: 'privacy.organization-source-owner-facts', owner: 'privacy.core' },
  sourcePersonPartyOwner: { evidence: 'privacy.source-person-party-owner', owner: 'privacy.core' },
} as const satisfies Record<string, DeclaredEvidenceCall>;

export const privacyEvidenceCall = (name: keyof typeof privacyDeclaredEvidenceCalls) =>
  declaredEvidenceCallInsideTransaction(privacyDeclaredEvidenceCalls[name]);
