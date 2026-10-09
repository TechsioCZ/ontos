import type { OperationalScope } from '@app/core-runtime';
import { and, eq, sql } from 'drizzle-orm';
import { DateTime, Effect, Match, Option, Order, Schema } from 'effect';

import type { FinalizeOrderTaxPayload, FinalizeOrderTaxResult } from '../../shared/actions/order-tax-finalization.ts';
import type { FinalOrderTaxRequest, FinalOrderTaxResponse } from '../../shared/apis/final-order-tax.ts';
import { TaxEvaluationEvidenceSchema } from '../../shared/domain/tax-evaluation-contracts.ts';
import { taxOrderTaxFinalizations, taxRuleCorrections, taxRuleRevisions } from '../database/schema.ts';
import type { GoverningTaxRuleRevision } from '../database/schema.ts';
import { CustomerSafeTaxDecompositionNeedSchema } from '../../shared/domain/tax-kernel/customer-safe-tax-projection.ts';
import { TaxRuleIdSchema } from '../../shared/domain/tax-kernel/tax-decision.ts';
import { OrderCommitmentTimeSchema } from '../../shared/domain/tax-kernel/tax-time.ts';
import { projectCustomerSafeTax } from '../domain/customer-safe-tax-projection.ts';
import {
  OrderSubmissionRefSchema,
  finalEvaluationRequest,
  orderTaxIntentFingerprint,
} from '../domain/order-tax-finalization.ts';
import { TaxOutcomeSuccessSchema } from '../domain/tax-outcome.ts';
import type { TaxOutcomeSuccess } from '../domain/tax-outcome.ts';
import { taxEvaluationForScope, visibleInScope } from './tax-evaluation.service.ts';
import { taxMeaningFingerprint } from './tax-governance-fingerprint.ts';
import {
  conflict,
  lockTaxFactFamily,
  mutation,
  notFound,
  query,
  sameAttribution,
  trustedInvocation,
  unavailable,
} from './tax-governance-persistence.ts';
import type {
  GovernanceConflict,
  GovernanceNotFound,
  GovernedInvocation,
  PersistenceUnavailable,
  ScopedTransaction,
} from './tax-governance-persistence.ts';
import { taxRuleRevisionRef } from './tax-rule-governance.service.ts';

const MODULE_KEY = 'commerce.tax' as const;
const FINALIZATION_RESOURCE_TYPE = 'commerce.tax.order-tax-finalization' as const;

export const orderTaxFinalizationRef = (tenantId: string, resourceId: string) => ({
  moduleId: MODULE_KEY,
  resourceId,
  resourceType: FINALIZATION_RESOURCE_TYPE,
  tenantId,
});

type FinalizationRow = typeof taxOrderTaxFinalizations.$inferSelect;
type Invocation<Payload> = Payload & GovernedInvocation;

/** What the Action audits besides the typed result. */
export interface OrderTaxFinalizationOutcome {
  readonly audit: Readonly<{ changed: boolean; meaningFingerprint: string; resourceId: string; resourceType: string }>;
  readonly result: FinalizeOrderTaxResult;
}

export interface OrderTaxFinalizations {
  readonly finalize: (
    input: Invocation<FinalizeOrderTaxPayload>,
  ) => Effect.Effect<OrderTaxFinalizationOutcome | GovernanceConflict | GovernanceNotFound, PersistenceUnavailable>;
  /** None when no final exists for the submission in the trusted Tenant and Selling Legal Entity scope. */
  readonly finalOrderTax: (
    request: FinalOrderTaxRequest,
  ) => Effect.Effect<Option.Option<FinalOrderTaxResponse>, PersistenceUnavailable>;
}

const decodeOutcome = Schema.decodeUnknownEffect(TaxOutcomeSuccessSchema);
const decodeEvidence = Schema.decodeUnknownEffect(TaxEvaluationEvidenceSchema);
const decodeDecompositionNeed = Schema.decodeUnknownEffect(CustomerSafeTaxDecompositionNeedSchema);
const encodeOutcome = Schema.encodeEffect(TaxOutcomeSuccessSchema);
const encodeEvidence = Schema.encodeEffect(TaxEvaluationEvidenceSchema);
const byText = Order.String;

/** Distinct governing revisions of the Decision in identity order, kept for read-time correction evidence. */
const governingRuleRevisions = ({ decision }: TaxOutcomeSuccess): readonly GoverningTaxRuleRevision[] =>
  [
    ...new Map(
      decision.units.map(({ governingTaxRuleRevisionRef: { revision, taxRuleId } }) => [
        `${taxRuleId}@${revision}`,
        { revision, taxRuleId },
      ]),
    ).values(),
  ].toSorted((left, right) => byText(left.taxRuleId, right.taxRuleId) || left.revision - right.revision);

/**
 * The stored final echoed exactly; a stored value that no longer decodes is an unavailable read, never a guessed
 * result. The customer-safe view is projected again, never stored (#940 F19).
 */
const storedFinal = Effect.fn('orderTaxFinalization.storedFinal')(function* storedFinalEffect(row: FinalizationRow) {
  const { decompositionNeed, evidence, outcome } = yield* Effect.all(
    {
      decompositionNeed: decodeDecompositionNeed(row.decompositionNeed),
      evidence: decodeEvidence(row.evidence),
      outcome: decodeOutcome(row.outcome),
    },
    { concurrency: 3 },
  );
  return {
    customerSafe: projectCustomerSafeTax(outcome, decompositionNeed),
    evidence,
    finalOrderTaxRef: orderTaxFinalizationRef(row.tenantId, row.taxOrderTaxFinalizationId),
    handoff: {
      foreignEvidenceOrigin: evidence.foreignEvidenceOrigin,
      orderCommitmentTime: OrderCommitmentTimeSchema.make(DateTime.makeUnsafe(row.orderCommitmentTime)),
      outcome,
      submissionRef: OrderSubmissionRefSchema.make(row.submissionRef),
    },
  };
}, Effect.mapError(unavailable));

const finalized = (row: FinalizationRow, created: boolean) =>
  storedFinal(row).pipe(
    Effect.map((final): OrderTaxFinalizationOutcome => ({
      audit: {
        changed: created,
        meaningFingerprint: row.intentFingerprint,
        resourceId: row.taxOrderTaxFinalizationId,
        resourceType: FINALIZATION_RESOURCE_TYPE,
      },
      result: { _tag: 'FINALIZED', created, ...final },
    })),
  );

/** A non-finalizing answer stores nothing; the audited finalization resource is named by its submission (#944 F12). */
const unstored = (
  input: Invocation<FinalizeOrderTaxPayload>,
  intentFingerprint: string,
  result: FinalizeOrderTaxResult,
): OrderTaxFinalizationOutcome => ({
  audit: {
    changed: false,
    meaningFingerprint: intentFingerprint,
    resourceId: input.submissionRef,
    resourceType: FINALIZATION_RESOURCE_TYPE,
  },
  result,
});

export const orderTaxFinalizationsForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
): OrderTaxFinalizations => {
  const { tenantId } = scope;
  const legalEntityId = scope.legalEntityId ?? '';

  const finalByInvocation = (input: GovernedInvocation) =>
    query(
      transaction
        .select()
        .from(taxOrderTaxFinalizations)
        .where(
          and(
            eq(taxOrderTaxFinalizations.tenantId, input.tenantId),
            eq(taxOrderTaxFinalizations.idempotencyKey, input.actionInvocationId),
          ),
        )
        .limit(1),
    );

  const finalBySubmission = (submissionRef: string) =>
    query(
      transaction
        .select()
        .from(taxOrderTaxFinalizations)
        .where(
          and(
            eq(taxOrderTaxFinalizations.tenantId, tenantId),
            eq(taxOrderTaxFinalizations.legalEntityId, legalEntityId),
            eq(taxOrderTaxFinalizations.submissionRef, submissionRef),
          ),
        )
        .limit(1),
    );

  const storeFinal = Effect.fn('orderTaxFinalization.storeFinal')(function* storeFinalEffect(
    input: Invocation<FinalizeOrderTaxPayload>,
    intentFingerprint: string,
    success: TaxOutcomeSuccess,
    evidence: typeof TaxEvaluationEvidenceSchema.Type,
  ) {
    const inserted = yield* mutation(
      transaction
        .insert(taxOrderTaxFinalizations)
        .values({
          actionInvocationId: input.actionInvocationId,
          actorPrincipalId: input.actorPrincipalId,
          decisionId: success.decision.decisionId,
          decompositionNeed: input.candidate.decompositionNeed,
          evidence: yield* encodeEvidence(evidence).pipe(Effect.mapError(unavailable)),
          governingRuleRevisions: governingRuleRevisions(success),
          idempotencyKey: input.actionInvocationId,
          intentFingerprint,
          legalEntityId: input.legalEntityId,
          orderCommitmentTime: DateTime.toDateUtc(input.orderCommitmentTime),
          outcome: yield* encodeOutcome(success).pipe(Effect.mapError(unavailable)),
          provenanceRef: input.provenanceRef,
          reason: input.reason,
          submissionRef: input.submissionRef,
          taxEvaluationTime: DateTime.toDateUtc(evidence.taxEvaluationTime),
          tenantId: input.tenantId,
        })
        .returning(),
    );
    if ('kind' in inserted) {
      return inserted;
    }
    const [row] = inserted;
    return row === undefined ? yield* unavailable() : yield* finalized(row, true);
  });

  /** Evaluates the frozen candidate at T and stores the final only when it is TAX_DETERMINED (#944 F8-F12). */
  const finalizeNew = Effect.fn('orderTaxFinalization.finalizeNew')(function* finalizeNewEffect(
    input: Invocation<FinalizeOrderTaxPayload>,
    intentFingerprint: string,
  ) {
    const evaluation = yield* taxEvaluationForScope(transaction, scope).evaluate(
      finalEvaluationRequest(input.candidate, input.orderCommitmentTime),
    );
    if (Option.isNone(evaluation)) {
      return notFound;
    }
    return yield* Match.value(evaluation.value).pipe(
      Match.tag('TAX_EVALUATION_REQUEST_REJECTED', ({ reasons }) =>
        Effect.succeed(unstored(input, intentFingerprint, { _tag: 'FINALIZATION_REJECTED', reasons })),
      ),
      Match.tag('EVALUATED', ({ evidence, outcome }) =>
        Match.value(outcome).pipe(
          Match.tag('TAX_DETERMINED', (success) => storeFinal(input, intentFingerprint, success, evidence)),
          Match.orElse((nonSuccess) =>
            Effect.succeed(
              unstored(input, intentFingerprint, { _tag: 'NOT_FINALIZED', evidence, outcome: nonSuccess }),
            ),
          ),
        ),
      ),
      Match.exhaustive,
    );
  });

  const finalize: OrderTaxFinalizations['finalize'] = Effect.fn('orderTaxFinalization.finalize')(
    function* finalizeEffect(input) {
      if (!trustedInvocation(scope, input, [])) {
        return yield* unavailable();
      }
      // A candidate of another Tenant or Selling Legal Entity is invisible before any lock or read (#950 F24).
      if (!visibleInScope(scope, input.candidate)) {
        return notFound;
      }
      const intentFingerprint = orderTaxIntentFingerprint(
        input.candidate,
        input.orderCommitmentTime,
        taxMeaningFingerprint,
      );
      // Core-invocation replay: the identical attribution and intent echoes the original (#955 G).
      const [byInvocation] = yield* finalByInvocation(input);
      if (byInvocation !== undefined) {
        const matches =
          sameAttribution(byInvocation, input) &&
          byInvocation.submissionRef === input.submissionRef &&
          byInvocation.intentFingerprint === intentFingerprint;
        return matches ? yield* finalized(byInvocation, false) : conflict('IDEMPOTENCY_REUSED');
      }
      // Concurrent requests for one submission converge on one canonical final (#944 F11).
      yield* lockTaxFactFamily(transaction, input, `ORDER_TAX_FINALIZATION:${input.submissionRef}`);
      const [existing] = yield* finalBySubmission(input.submissionRef);
      // The same frozen intent recovers the original without any rule or source read; a different intent conflicts;
      // only a submission without a final is evaluated (#944 F10-F12, #942 H).
      return yield* Option.match(Option.fromUndefinedOr(existing), {
        onNone: () => finalizeNew(input, intentFingerprint),
        onSome: (row) =>
          row.intentFingerprint === intentFingerprint
            ? finalized(row, false)
            : Effect.succeed(conflict('SUBMISSION_INTENT_CHANGED')),
      });
    },
  );

  /**
   * The final with any confirmed correction of its governing revisions in ONE statement (#930 F13): the stored row
   * is immutable and corrections are append-only, so a concurrent correction is wholly visible or wholly absent.
   */
  const finalOrderTax: OrderTaxFinalizations['finalOrderTax'] = Effect.fn('orderTaxFinalization.finalOrderTax')(
    function* finalOrderTaxEffect(request) {
      if (scope.legalEntityId === undefined) {
        return Option.none();
      }
      const rows = yield* query(
        transaction
          .select({ correction: taxRuleCorrections, final: taxOrderTaxFinalizations, revision: taxRuleRevisions })
          .from(taxOrderTaxFinalizations)
          .leftJoin(
            taxRuleRevisions,
            and(
              eq(taxRuleRevisions.tenantId, taxOrderTaxFinalizations.tenantId),
              eq(taxRuleRevisions.legalEntityId, taxOrderTaxFinalizations.legalEntityId),
              sql`${taxOrderTaxFinalizations.governingRuleRevisions} @> jsonb_build_array(jsonb_build_object('taxRuleId', ${taxRuleRevisions.taxRuleId}::text, 'revision', ${taxRuleRevisions.revisionNumber}))`,
            ),
          )
          .leftJoin(
            taxRuleCorrections,
            and(
              eq(taxRuleCorrections.tenantId, taxRuleRevisions.tenantId),
              eq(taxRuleCorrections.legalEntityId, taxRuleRevisions.legalEntityId),
              eq(taxRuleCorrections.wrongRevisionId, taxRuleRevisions.taxRuleRevisionId),
            ),
          )
          .where(
            and(
              eq(taxOrderTaxFinalizations.tenantId, tenantId),
              eq(taxOrderTaxFinalizations.legalEntityId, legalEntityId),
              eq(taxOrderTaxFinalizations.submissionRef, request.submissionRef),
            ),
          ),
      );
      const [first] = rows;
      if (first === undefined) {
        return Option.none();
      }
      const final = yield* storedFinal(first.final);
      const governingRevisionCorrections = rows
        .flatMap(({ correction, revision }) =>
          correction === null || revision === null
            ? []
            : [
                {
                  confirmedAt: DateTime.makeUnsafe(correction.confirmedAt),
                  correctingRevisionRef: taxRuleRevisionRef(tenantId, correction.correctingRevisionId),
                  governingTaxRuleRevisionRef: {
                    revision: revision.revisionNumber,
                    taxRuleId: TaxRuleIdSchema.make(revision.taxRuleId),
                  },
                  wrongRevisionRef: taxRuleRevisionRef(tenantId, correction.wrongRevisionId),
                },
              ],
        )
        .toSorted(
          (left, right) =>
            byText(left.wrongRevisionRef.resourceId, right.wrongRevisionRef.resourceId) ||
            byText(left.correctingRevisionRef.resourceId, right.correctingRevisionRef.resourceId),
        );
      return Option.some({
        ...final,
        finalizedAt: DateTime.makeUnsafe(first.final.recordedAt),
        governingRevisionCorrections,
      });
    },
  );

  return Object.freeze({ finalize, finalOrderTax });
};

export const orderTaxFinalizationServiceFactory = (transaction: ScopedTransaction, scope: OperationalScope) =>
  Effect.succeed(orderTaxFinalizationsForScope(transaction, scope));
