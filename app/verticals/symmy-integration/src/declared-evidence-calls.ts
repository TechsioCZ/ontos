import { declaredEvidenceCallInsideTransaction } from '@app/core-runtime';
import type { DeclaredEvidenceCall } from '@app/core-runtime';
import { pipe, Record as EffectRecord } from 'effect';

const OWNER = 'integration.symmy';

/**
 * Symmy owner proof reads that main's source-evidence design makes from inside the owner write transaction,
 * because their request is derived there. Demo divergence: DEPLOYMENT.md, declared in-transaction evidence calls.
 * The inventory is pinned by `scripts/tests/declared-evidence-calls-ratchet.test.mts`; only remove entries.
 */
export const symmyIntegrationDeclaredEvidenceCalls = {
  customerIntakePrivacy: { evidence: 'symmy.customer-intake-privacy', owner: OWNER },
  retentionPrivacyCurrent: { evidence: 'symmy.retention-privacy-current', owner: OWNER },
} as const satisfies Record<string, DeclaredEvidenceCall>;

/** One combinator per declaration; call sites use `symmyIntegrationEvidenceCall.<name>`. */
export const symmyIntegrationEvidenceCall = pipe(
  symmyIntegrationDeclaredEvidenceCalls,
  EffectRecord.map(declaredEvidenceCallInsideTransaction),
);
