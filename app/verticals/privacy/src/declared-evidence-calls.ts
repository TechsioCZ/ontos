import { declaredEvidenceCallInsideTransaction } from '@app/core-runtime';
import type { DeclaredEvidenceCall } from '@app/core-runtime';
import { Record as EffectRecord } from 'effect';

const OWNER = 'privacy.core';

/**
 * Privacy owner proof reads that main's source-evidence design makes from inside a governed read or Action
 * transaction, because their request is derived there. Demo divergence: DEPLOYMENT.md, declared in-transaction
 * evidence calls. The inventory is pinned by `scripts/tests/declared-evidence-calls-ratchet.test.mts`; only remove.
 */
export const privacyDeclaredEvidenceCalls = {
  customerIntakeOwnerContext: { evidence: 'privacy.customer-intake-owner-context', owner: OWNER },
  organizationBusinessOwnerContext: { evidence: 'privacy.organization-business-owner-context', owner: OWNER },
  organizationBusinessOwnerFacts: { evidence: 'privacy.organization-business-owner-facts', owner: OWNER },
  organizationIcoOwnerFacts: { evidence: 'privacy.organization-ico-owner-facts', owner: OWNER },
  organizationPartyRecordFacts: { evidence: 'privacy.organization-party-record-facts', owner: OWNER },
  organizationProfileIcoOwnerFacts: { evidence: 'privacy.organization-profile-ico-owner-facts', owner: OWNER },
  organizationProfileOwnerFacts: { evidence: 'privacy.organization-profile-owner-facts', owner: OWNER },
  organizationSourceOwnerFacts: { evidence: 'privacy.organization-source-owner-facts', owner: OWNER },
  sourcePersonPartyOwner: { evidence: 'privacy.source-person-party-owner', owner: OWNER },
} as const satisfies Record<string, DeclaredEvidenceCall>;

/** One combinator per declaration; call sites use `privacyEvidenceCall.<name>`. */
export const privacyEvidenceCall = EffectRecord.map(privacyDeclaredEvidenceCalls, declaredEvidenceCallInsideTransaction);
