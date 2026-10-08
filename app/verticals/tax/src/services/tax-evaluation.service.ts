import type { OperationalScope } from '@app/core-runtime';
import { DateTime, Effect, Option } from 'effect';

import type { ApplicableTaxRuleSetResponse } from '../../shared/apis/applicable-tax-rule-set.ts';
import type { SellingLegalEntityVatRegistrationStateResponse } from '../../shared/apis/selling-legal-entity-vat-registration-state.ts';
import type { TaxEvaluationResponse } from '../../shared/apis/tax-evaluation.ts';
import { projectCustomerSafeTax } from '../domain/customer-safe-tax-projection.ts';
import { evaluateWithBoundedRetry } from '../domain/tax-evaluation-attempt.ts';
import type { TaxEvaluationStateTokens } from '../domain/tax-evaluation-attempt.ts';
import { taxEvaluationRequestRejections } from '../domain/tax-evaluation-request.ts';
import type { TaxEvaluationRequest, TaxEvaluationRequestRejectionReason } from '../domain/tax-evaluation-request.ts';
import { evaluateProspectiveLaunchTax, requiredTaxClassificationCodes } from '../domain/tax-evaluation.ts';
import type { TaxEvaluationOwnState } from '../domain/tax-evaluation.ts';
import { TaxStateIndeterminateSchema } from '../domain/tax-non-success-outcome.ts';
import type { TaxOutcome } from '../domain/tax-outcome.ts';
import { TaxEvaluationTimeSchema } from '../domain/tax-time.ts';
import type { TaxEvaluationTime } from '../domain/tax-time.ts';
import { taxGovernedReadsForScope } from './tax-governed-read.service.ts';
import { taxMeaningFingerprint } from './tax-governance-fingerprint.ts';
import type { PersistenceUnavailable, ScopedTransaction } from './tax-governance-persistence.ts';
import { taxSourceReadsForScope } from './tax-source-read.service.ts';

/**
 * Origin of the foreign owner facts of every evaluation. Before #892 TAX has no owner fetch, so Pricing, Catalog,
 * Shipping and place facts are caller-supplied owner evidence, checked only for permission and structural binding
 * (human decision A on #907). Owner verification, once #892 lands, joins the structural binding check.
 */
const TAX_FOREIGN_EVIDENCE_ORIGIN = 'CALLER_SUPPLIED_UNVERIFIED' as const;

/** Prospective TAX evaluation bound to one scoped transaction. */
export interface TaxEvaluations {
  /** None when the purchase is not visible in the trusted Tenant and Selling Legal Entity scope. */
  readonly evaluate: (
    request: TaxEvaluationRequest,
  ) => Effect.Effect<Option.Option<TaxEvaluationResponse>, PersistenceUnavailable>;
}

/** TAX's own state read by one attempt, kept with the full read evidence. */
interface ObservedTaxState {
  readonly ruleSets: ReadonlyMap<string, ApplicableTaxRuleSetResponse>;
  readonly seller: SellingLegalEntityVatRegistrationStateResponse;
}

const ownStateOf = ({ ruleSets, seller }: ObservedTaxState): TaxEvaluationOwnState => ({
  ruleSets: new Map(
    [...ruleSets].map(([code, ruleSet]) => [
      code,
      {
        applicable: ruleSet.applicable.map((revision) => ({
          ratePercent: revision.ratePercent,
          revisionNumber: revision.revisionNumber,
          taxRuleId: revision.taxRuleRef.resourceId,
          treatmentCategory: revision.treatmentCategory,
        })),
        outcome: ruleSet.outcome,
      },
    ]),
  ),
  sellerVatRegistration: seller.state,
});

const tokensOf = ({ ruleSets, seller }: ObservedTaxState): TaxEvaluationStateTokens => ({
  ruleSets: new Map(
    [...ruleSets].map(([code, ruleSet]) => [
      code,
      { outcome: ruleSet.outcome, setFingerprint: ruleSet.completeness.setFingerprint },
    ]),
  ),
  seller: { reason: seller.reason, setFingerprint: seller.completeness.setFingerprint, state: seller.state },
});

const evidenceOf = (state: ObservedTaxState, request: TaxEvaluationRequest, taxEvaluationTime: TaxEvaluationTime) => ({
  foreignEvidenceOrigin: TAX_FOREIGN_EVIDENCE_ORIGIN,
  ruleSets: [...state.ruleSets].map(([taxClassificationCode, { completeness, outcome }]) => ({
    outcome,
    predicateFingerprint: completeness.predicateFingerprint,
    rowCount: completeness.rowCount,
    setFingerprint: completeness.setFingerprint,
    taxClassificationCode,
  })),
  sellerRegistration: {
    authorityOutcome: state.seller.authority.outcome,
    basisAssertionRefs: state.seller.basisAssertionRefs,
    reason: state.seller.reason,
    setFingerprint: state.seller.completeness.setFingerprint,
    state: state.seller.state,
  },
  taxEvaluationTime,
  taxRelevantTime: request.taxRelevantTime,
});

type TaxEvaluationEvidence = Extract<TaxEvaluationResponse, { readonly _tag: 'EVALUATED' }>['evidence'];

const evaluated = (outcome: TaxOutcome, request: TaxEvaluationRequest, evidence: TaxEvaluationEvidence) => ({
  _tag: 'EVALUATED' as const,
  customerSafe: projectCustomerSafeTax(outcome, request.decompositionNeed),
  evidence,
  outcome,
});

/** Tenant and Selling Legal Entity come from the trusted Operational Scope; the payload must name the same (#950 F24). */
const visibleInScope = (scope: OperationalScope, request: TaxEvaluationRequest) =>
  scope.legalEntityId !== undefined &&
  request.purchase.tenantId === scope.tenantId &&
  request.purchase.sellingLegalEntityRef === scope.legalEntityId;

export const taxEvaluationForScope = (transaction: ScopedTransaction, scope: OperationalScope): TaxEvaluations => {
  const governed = taxGovernedReadsForScope(transaction, scope);
  const sources = taxSourceReadsForScope(transaction, scope);

  const ruleSetFor = (taxClassificationCode: string, request: TaxEvaluationRequest) =>
    governed
      .applicableTaxRuleSet({
        jurisdiction: 'CZ_DOMESTIC',
        taxClassificationCode,
        taxRelevantTime: request.taxRelevantTime,
      })
      .pipe(Effect.map((ruleSet) => [taxClassificationCode, ruleSet] as const));

  const evaluate: TaxEvaluations['evaluate'] = Effect.fn('taxEvaluations.evaluate')(function* evaluateEffect(request) {
    if (!visibleInScope(scope, request)) {
      return Option.none();
    }
    // Trusted server operation time; the caller never supplies Tax Evaluation Time (#941 F1, F3).
    const taxEvaluationTime = TaxEvaluationTimeSchema.make(yield* DateTime.now);
    // A future Tax-Relevant Time has no complete authoritative rule state yet (#942 F22).
    const rejections: readonly TaxEvaluationRequestRejectionReason[] = [
      ...taxEvaluationRequestRejections(request),
      ...(DateTime.isGreaterThan(request.taxRelevantTime, taxEvaluationTime)
        ? (['FUTURE_TAX_RELEVANT_TIME'] as const)
        : []),
    ];
    const [firstRejection, ...otherRejections] = rejections;
    if (firstRejection !== undefined) {
      return Option.some({
        _tag: 'TAX_EVALUATION_REQUEST_REJECTED' as const,
        reasons: [firstRejection, ...otherRejections],
      });
    }
    const codes = requiredTaxClassificationCodes(request);
    // Seller currentness at Tax Evaluation Time, rule meaning at Tax-Relevant Time (#942 F21).
    const observe = Effect.gen(function* observeTaxState() {
      const seller = yield* sources.sellingLegalEntityVatRegistrationState({ evaluationTime: taxEvaluationTime });
      const ruleSets = yield* Effect.forEach(codes, (code) => ruleSetFor(code, request), { concurrency: 1 });
      return { ruleSets: new Map(ruleSets), seller };
    });
    const run = yield* evaluateWithBoundedRetry({
      evaluate: (state: ObservedTaxState) =>
        evaluateProspectiveLaunchTax(request, ownStateOf(state), {
          fingerprint: taxMeaningFingerprint,
          taxEvaluationTime,
        }),
      observe,
      tokensOf,
    });
    const attempts = { attempts: run.attempts, discarded: run.discarded };
    return Option.some(
      Option.match(run.published, {
        // Exhausted: the approved indeterminate outcome, never the last candidate (#942 F19).
        onNone: () =>
          evaluated(TaxStateIndeterminateSchema.make({}), request, {
            ...evidenceOf(run.lastObserved, request, taxEvaluationTime),
            ...attempts,
            exhausted: 'EVALUATION_RACE_UNRESOLVED' as const,
          }),
        onSome: ({ output, state }) =>
          evaluated(output, request, { ...evidenceOf(state, request, taxEvaluationTime), ...attempts }),
      }),
    );
  });

  return Object.freeze({ evaluate });
};
