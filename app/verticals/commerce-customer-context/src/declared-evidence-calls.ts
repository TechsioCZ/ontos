import { declaredEvidenceCallInsideTransaction } from '@app/core-runtime';
import type { DeclaredEvidenceCall } from '@app/core-runtime';
import { pipe, Record as EffectRecord } from 'effect';

const OWNER = 'commerce.customer-context';

/**
 * Customer Context owner proof reads that main's source-evidence design makes from inside the owner transaction,
 * because their request is derived there. Demo divergence: DEPLOYMENT.md, declared in-transaction evidence calls.
 * The inventory is pinned by `scripts/tests/declared-evidence-calls-ratchet.test.mts`; only remove entries.
 */
export const commerceCustomerContextDeclaredEvidenceCalls = {
  counterpartyOrganizationIcoFacts: {
    evidence: 'commerce.counterparty-organization-ico-facts',
    owner: OWNER,
  },
  legacyIcoInventory: { evidence: 'commerce.legacy-ico-inventory', owner: OWNER },
  migrationCorrelation: { evidence: 'commerce.counterparty-migration-correlation', owner: OWNER },
  organizationBusinessEligibility: {
    evidence: 'commerce.organization-business-eligibility',
    owner: OWNER,
  },
  organizationProfileIcoEligibility: {
    evidence: 'commerce.organization-profile-ico-eligibility',
    owner: OWNER,
  },
  sourceCounterpartyAdmission: {
    evidence: 'commerce.source-counterparty-admission',
    owner: OWNER,
  },
  sourcePersonAdmission: { evidence: 'commerce.source-person-admission', owner: OWNER },
  sourceProcessingEligibility: {
    evidence: 'commerce.source-processing-eligibility',
    owner: OWNER,
  },
} as const satisfies Record<string, DeclaredEvidenceCall>;

/** One combinator per declaration; call sites use `commerceCustomerContextEvidenceCall.<name>`. */
export const commerceCustomerContextEvidenceCall = pipe(
  commerceCustomerContextDeclaredEvidenceCalls,
  EffectRecord.map(declaredEvidenceCallInsideTransaction),
);
