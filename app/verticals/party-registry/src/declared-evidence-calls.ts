import { declaredEvidenceCallInsideTransaction } from '@app/core-runtime';
import type { DeclaredEvidenceCall } from '@app/core-runtime';

/**
 * Party owner proof reads that main's source-evidence design makes from inside the owner write transaction,
 * because their request is derived there. Demo divergence: DEPLOYMENT.md, declared in-transaction evidence calls.
 * The inventory is pinned by `scripts/tests/declared-evidence-calls-ratchet.test.mts`; only remove entries.
 */
export const partyRegistryDeclaredEvidenceCalls = {
  clientSourceOrganizationPrivacy: { evidence: 'party.client-source-organization-privacy', owner: 'party.registry' },
  clientSourcePrivacy: { evidence: 'party.client-source-privacy', owner: 'party.registry' },
  legacyIcoPrivacy: { evidence: 'party.legacy-ico-privacy', owner: 'party.registry' },
} as const satisfies Record<string, DeclaredEvidenceCall>;

export const partyRegistryEvidenceCall = (name: keyof typeof partyRegistryDeclaredEvidenceCalls) =>
  declaredEvidenceCallInsideTransaction(partyRegistryDeclaredEvidenceCalls[name]);
