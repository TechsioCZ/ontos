import { declaredEvidenceCallInsideTransaction } from '@app/core-runtime';
import type { DeclaredEvidenceCall } from '@app/core-runtime';
import { pipe, Record as EffectRecord } from 'effect';

const OWNER = 'party.registry';

/**
 * Party owner proof reads that main's source-evidence design makes from inside the owner write transaction,
 * because their request is derived there. Demo divergence: DEPLOYMENT.md, declared in-transaction evidence calls.
 * The inventory is pinned by `scripts/tests/declared-evidence-calls-ratchet.test.mts`; only remove entries.
 */
export const partyRegistryDeclaredEvidenceCalls = {
  clientSourceOrganizationPrivacy: { evidence: 'party.client-source-organization-privacy', owner: OWNER },
  clientSourcePrivacy: { evidence: 'party.client-source-privacy', owner: OWNER },
  legacyIcoPrivacy: { evidence: 'party.legacy-ico-privacy', owner: OWNER },
} as const satisfies Record<string, DeclaredEvidenceCall>;

/** One combinator per declaration; call sites use `partyRegistryEvidenceCall.<name>`. */
export const partyRegistryEvidenceCall = pipe(
  partyRegistryDeclaredEvidenceCalls,
  EffectRecord.map(declaredEvidenceCallInsideTransaction),
);
