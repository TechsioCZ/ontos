import { Effect, Option } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  evaluateWithOwnerFacts,
  failClosedOwnerExecutionFacts,
} from '../../src/services/privacy-owner-execution-receipt.service.ts';
import type { OwnerExecutionFacts } from '../../src/services/privacy-owner-execution-receipt.service.ts';
import type { OwnerBlockerAssessment } from '../../shared/privacy-owner/outcome.ts';
import {
  allComplete,
  confirmedAt,
  coverageOf,
  evidenceOf,
  intentRef,
  measureOf,
} from './support/privacy-owner-fixtures.ts';

/**
 * [#1410 AC-06, D.8, GOV-07, audit T3-22 and T2-12 to T2-15, R-D11] What only the owner or Privacy can supply is asked AGAIN at
 * evaluation time and never taken from a copy the dispatch carried. Without an answer the owner fails closed.
 */
const assessment = (blockers: OwnerBlockerAssessment['blockers'] = []): OwnerBlockerAssessment => ({
  assessedByRef: 'FICTIONAL-privacy-assessment-now',
  blockers,
});
const holdNow = assessment([
  { blockerRef: 'FICTIONAL-hold-after-dispatch', contentRefs: [intentRef('a')], kind: 'LEGAL_HOLD' },
]);

const facts = (overrides: Partial<OwnerExecutionFacts> = {}): OwnerExecutionFacts => ({
  ...failClosedOwnerExecutionFacts,
  ...overrides,
});
const enforced = (refs: readonly string[]) => ({
  enforcedContentRefs: refs,
  signalRef: 'FICTIONAL-enforcement-signal',
});

const evaluate = (
  ownerFacts: OwnerExecutionFacts,
  intendedOutcome: 'DELETE' | 'ENFORCE_PROCESSING_RESTRICTION' = 'DELETE',
) =>
  evaluateWithOwnerFacts(ownerFacts, {
    confirmedAt,
    coverage: coverageOf(
      allComplete({
        REQUEST_DECISION_INTENT: {
          foundContentRefs: intendedOutcome === 'DELETE' ? [] : [intentRef('a'), intentRef('b')],
        },
      }),
    ),
    evidence: [
      evidenceOf({
        results: [intentRef('a'), intentRef('b')].map((contentRef) => ({
          contentRef,
          result: intendedOutcome === 'DELETE' ? ('REMOVED' as const) : ('RESTRICTED' as const),
        })),
      }),
    ],
    evidenceRefs: ['FICTIONAL-handoff-evidence'],
    measure: measureOf({ intendedOutcome }),
    outcomeRef: 'FICTIONAL-outcome-1',
  });

describe('Owner execution facts are asked again at evaluation time', () => {
  it.effect(
    'blocks the evidence when a hold appeared after the dispatch (the dispatched copy is never the decision)',
    () =>
      Effect.gen(function* appeared() {
        const outcome = yield* evaluate(
          facts({
            blockers: () => Effect.succeed(Option.some(holdNow)),
            enforcement: () => Effect.succeed(Option.some(enforced([intentRef('a'), intentRef('b')]))),
          }),
        );
        // the held target never counts as achieved: only the unheld one may
        expect(outcome).toMatchObject({
          affectedContentRefs: [intentRef('b')],
          reason: 'LEGAL_HOLD_OR_RETENTION_OBLIGATION_IS_CURRENT_ON_PART_OF_THE_EVIDENCED_TARGETS',
          remainingContentRefs: [intentRef('a')],
          status: 'PARTIAL',
        });
      }),
  );

  it.effect(
    'does not trust the dispatched copy when the current assessment cannot be asked: the measure is unassessed',
    () =>
      Effect.gen(function* unassessed() {
        const outcome = yield* evaluate(
          facts({ enforcement: () => Effect.succeed(Option.some(enforced([intentRef('a'), intentRef('b')]))) }),
        );
        expect(outcome).toMatchObject({ reason: 'HOLD_APPLICABILITY_NOT_ASSESSED', status: 'BLOCKED' });
      }),
  );

  it.effect('reaches ACHIEVED only when the CURRENT assessment is clear and a real signal covers every target', () =>
    Effect.gen(function* achieved() {
      const outcome = yield* evaluate(
        facts({
          blockers: () => Effect.succeed(Option.some(assessment())),
          enforcement: () => Effect.succeed(Option.some(enforced([intentRef('a'), intentRef('b')]))),
        }),
      );
      expect(outcome.status).toBe('ACHIEVED');
    }),
  );

  it.effect('keeps a human-confirmed restriction INDETERMINATE under the production fail-closed facts', () =>
    Effect.gen(function* production() {
      const outcome = yield* evaluate(
        facts({ blockers: () => Effect.succeed(Option.some(assessment())) }),
        'ENFORCE_PROCESSING_RESTRICTION',
      );
      expect(outcome).toMatchObject({
        reason: 'OWNER_RESTRICTION_ENFORCEMENT_NOT_VERIFIABLE',
        reconciliationRequired: true,
        status: 'INDETERMINATE',
      });
    }),
  );
});
