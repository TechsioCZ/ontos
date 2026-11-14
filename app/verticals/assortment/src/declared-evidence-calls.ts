import { declaredEvidenceCallInsideTransaction } from '@app/core-runtime';
import type { DeclaredEvidenceCall } from '@app/core-runtime';
import { pipe, Record as EffectRecord } from 'effect';

const OWNER = 'commerce.assortment';

/**
 * Assortment owner proof reads that main's source-evidence design makes from inside the owner transaction: the owner
 * authorization overlay of the enrolled Symmy rule fixture import proves current Catalog, Customer Context, Market
 * Catalog and Storefront Registry facts there. Demo divergence: DEPLOYMENT.md, declared in-transaction evidence calls.
 * The inventory is pinned by `scripts/tests/declared-evidence-calls-ratchet.test.mts`; only remove entries.
 */
export const assortmentDeclaredEvidenceCalls = {
  symmyRuleFixtureOwnerCurrentness: { evidence: 'assortment.symmy-rule-fixture-owner-currentness', owner: OWNER },
} as const satisfies Record<string, DeclaredEvidenceCall>;

/** One combinator per declaration; call sites use `assortmentEvidenceCall.<name>`. */
export const assortmentEvidenceCall = pipe(
  assortmentDeclaredEvidenceCalls,
  EffectRecord.map(declaredEvidenceCallInsideTransaction),
);
