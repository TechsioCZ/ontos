import { declaredEvidenceCallInsideTransaction } from '@app/core-runtime';
import type { DeclaredEvidenceCall } from '@app/core-runtime';

/**
 * Customer Context owner proof reads that main's source-evidence design makes from inside the owner transaction,
 * because their request is derived there. Demo divergence: DEPLOYMENT.md, declared in-transaction evidence calls.
 * The inventory is pinned by `scripts/tests/declared-evidence-calls-ratchet.test.mts`; only remove entries.
 */
export const commerceCustomerContextDeclaredEvidenceCalls = {
  counterpartyOrganizationIcoFacts: {
    evidence: 'commerce.counterparty-organization-ico-facts',
    owner: 'commerce.customer-context',
  },
  legacyIcoInventory: { evidence: 'commerce.legacy-ico-inventory', owner: 'commerce.customer-context' },
  migrationCorrelation: { evidence: 'commerce.counterparty-migration-correlation', owner: 'commerce.customer-context' },
  organizationBusinessEligibility: {
    evidence: 'commerce.organization-business-eligibility',
    owner: 'commerce.customer-context',
  },
  organizationProfileIcoEligibility: {
    evidence: 'commerce.organization-profile-ico-eligibility',
    owner: 'commerce.customer-context',
  },
  sourceCounterpartyAdmission: {
    evidence: 'commerce.source-counterparty-admission',
    owner: 'commerce.customer-context',
  },
  sourcePersonAdmission: { evidence: 'commerce.source-person-admission', owner: 'commerce.customer-context' },
  sourceProcessingEligibility: {
    evidence: 'commerce.source-processing-eligibility',
    owner: 'commerce.customer-context',
  },
} as const satisfies Record<string, DeclaredEvidenceCall>;

export const commerceCustomerContextEvidenceCall = (name: keyof typeof commerceCustomerContextDeclaredEvidenceCalls) =>
  declaredEvidenceCallInsideTransaction(commerceCustomerContextDeclaredEvidenceCalls[name]);
