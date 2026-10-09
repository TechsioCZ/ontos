import { DateTime, Effect, Result, Schema } from 'effect';

import {
  AssortmentDependencyFailureError,
  AssortmentGovernedDecisionSchema,
  AssortmentRetryExhaustedError,
} from './decision-contracts.ts';
import type {
  AssortmentDecisionEvidence,
  AssortmentEvidenceReference,
  AssortmentFactCurrentnessEvidence,
  AssortmentGovernedDecision,
  AssortmentRevisionReference,
  AssortmentSetCompletenessEvidence,
} from './decision-contracts.ts';
import {
  AssortmentFactCurrentnessRequestSchema,
  AssortmentSetCompletenessRequestSchema,
  AssortmentSetCompositionRequestSchema,
  AssortmentSetCompositionResolutionSchema,
} from './ports/owner-evidence.ts';
import type {
  AssortmentFactCurrentnessRequest,
  AssortmentFactCurrentnessResult,
  AssortmentOwnerFailure,
  AssortmentOwnerEvidencePort,
  AssortmentSetCompletenessRequest,
  AssortmentSetCompletenessResult,
} from './ports/owner-evidence.ts';

const PositiveAttemptsSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

export const AssortmentRevalidationAttemptSchema = Schema.Struct({
  compositionRequest: Schema.optionalKey(AssortmentSetCompositionRequestSchema),
  compositionResolution: Schema.optionalKey(AssortmentSetCompositionResolutionSchema),
  decision: AssortmentGovernedDecisionSchema,
  factRequests: Schema.Array(AssortmentFactCurrentnessRequestSchema),
  setRequests: Schema.Array(AssortmentSetCompletenessRequestSchema),
});
export type AssortmentRevalidationAttempt = typeof AssortmentRevalidationAttemptSchema.Type;

const AssortmentFinalRevalidationPublishedSchema = Schema.Struct({
  attempts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  decision: AssortmentGovernedDecisionSchema,
  kind: Schema.Literal('PUBLISHED'),
});

const AssortmentFinalRevalidationIndeterminateSchema = Schema.Struct({
  attempts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  decision: AssortmentGovernedDecisionSchema,
  kind: Schema.Literal('INDETERMINATE'),
});

export const AssortmentFinalRevalidationResultSchema = Schema.Union([
  AssortmentFinalRevalidationPublishedSchema,
  AssortmentFinalRevalidationIndeterminateSchema,
]);
export type AssortmentFinalRevalidationResult = typeof AssortmentFinalRevalidationResultSchema.Type;

export interface AssortmentFinalRevalidationOptions {
  readonly buildAttempt: (
    attemptNumber: number,
  ) => Effect.Effect<AssortmentRevalidationAttempt, AssortmentOwnerFailure>;
  readonly maxAttempts: typeof PositiveAttemptsSchema.Type;
  readonly ownerEvidence: Pick<
    AssortmentOwnerEvidencePort,
    'resolveSetComposition' | 'verifyFactCurrentness' | 'verifySetCompleteness'
  >;
}

export interface AssortmentFinalRevalidationConstituentOptions extends AssortmentFinalRevalidationOptions {
  readonly key: string;
}

export interface AssortmentFinalRevalidationConstituentResult {
  readonly key: string;
  readonly result: AssortmentFinalRevalidationResult;
}

type Verification =
  | { readonly kind: 'STABLE' }
  | { readonly kind: 'CHANGED' }
  | {
      readonly failure: Extract<AssortmentOwnerFailure, { readonly _tag: 'AssortmentDependencyFailureError' }>;
      readonly kind: 'DEPENDENCY_FAILURE';
    };

const refEquals = (
  left: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
    readonly tenantId: string;
  },
  right: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
    readonly tenantId: string;
  },
): boolean =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

const revisionEquals = (left: AssortmentRevisionReference, right: AssortmentRevisionReference): boolean =>
  left.ownerModuleId === right.ownerModuleId &&
  left.revision === right.revision &&
  refEquals(left.sourceRef, right.sourceRef);

const proofEquals = (left: AssortmentEvidenceReference, right: AssortmentEvidenceReference): boolean => {
  if (left.ownerModuleId !== right.ownerModuleId || !refEquals(left.evidenceRef, right.evidenceRef)) {
    return false;
  }
  if ((left.sourceRevision === undefined) !== (right.sourceRevision === undefined)) {
    return false;
  }
  if (left.sourceRevision === undefined || right.sourceRevision === undefined) {
    return true;
  }
  return revisionEquals(left.sourceRevision, right.sourceRevision);
};

const factEvidenceEquals = (
  request: AssortmentFactCurrentnessRequest,
  expected: AssortmentFactCurrentnessEvidence,
  actual: AssortmentFactCurrentnessResult,
): boolean =>
  DateTime.toEpochMillis(actual.observedAt) === DateTime.toEpochMillis(request.observedAt) &&
  actual.evidence.state === 'CURRENT' &&
  expected.state === 'CURRENT' &&
  refEquals(actual.evidence.factRef, request.factRef) &&
  refEquals(expected.factRef, request.factRef) &&
  proofEquals(actual.evidence.proof, expected.proof);

const setEvidenceEquals = (
  request: AssortmentSetCompletenessRequest,
  expected: AssortmentSetCompletenessEvidence,
  actual: AssortmentSetCompletenessResult,
): boolean =>
  expected.state === 'COMPLETE' &&
  actual.evidence.state === 'COMPLETE' &&
  expected.predicate === request.predicate &&
  expected.scope === request.scope &&
  actual.evidence.predicate === request.predicate &&
  actual.evidence.scope === request.scope &&
  proofEquals(actual.evidence.proof, expected.proof);

const decisionEvidence = (decision: AssortmentGovernedDecision): AssortmentDecisionEvidence | undefined =>
  decision.evidence;

const changed = (): Verification => ({ kind: 'CHANGED' });
const stable = (): Verification => ({ kind: 'STABLE' });

const verifyAttempt = Effect.fn('FinalRevalidation.verifyAttempt')(function* verifyAttempt(
  attempt: AssortmentRevalidationAttempt,
  ownerEvidence: AssortmentFinalRevalidationOptions['ownerEvidence'],
) {
  if (attempt.decision.outcome === 'INDETERMINATE') {
    return stable();
  }
  const evidence = decisionEvidence(attempt.decision);
  if (evidence === undefined) {
    return changed();
  }
  if (evidence.factCurrentness.length !== attempt.factRequests.length) {
    return changed();
  }
  const factVerifications = yield* Effect.forEach(
    attempt.factRequests,
    (request, index) => {
      const previousMatches = attempt.factRequests
        .slice(0, index)
        .filter((previous) => refEquals(previous.factRef, request.factRef)).length;
      const expected = evidence.factCurrentness.filter((item) => refEquals(item.factRef, request.factRef))[
        previousMatches
      ];
      if (expected === undefined) {
        return Effect.succeed<Verification>(changed());
      }
      return Effect.result(ownerEvidence.verifyFactCurrentness(request)).pipe(
        Effect.map((result) => {
          if (Result.isFailure(result)) {
            return { failure: result.failure, kind: 'DEPENDENCY_FAILURE' as const };
          }
          return factEvidenceEquals(request, expected, result.success) ? stable() : changed();
        }),
      );
    },
    { concurrency: 1 },
  );
  const factDependency = factVerifications.find((verification) => verification.kind === 'DEPENDENCY_FAILURE');
  if (factDependency?.kind === 'DEPENDENCY_FAILURE') {
    return factDependency;
  }
  if (factVerifications.some((verification) => verification.kind === 'CHANGED')) {
    return changed();
  }
  if (evidence.setCompleteness.length !== attempt.setRequests.length) {
    return changed();
  }
  const setVerifications = yield* Effect.forEach(
    attempt.setRequests,
    (request, index) => {
      const previousMatches = attempt.setRequests
        .slice(0, index)
        .filter((previous) => previous.predicate === request.predicate && previous.scope === request.scope).length;
      const expected = evidence.setCompleteness.filter(
        (item) => item.predicate === request.predicate && item.scope === request.scope,
      )[previousMatches];
      if (expected === undefined) {
        return Effect.succeed<Verification>(changed());
      }
      return Effect.result(ownerEvidence.verifySetCompleteness(request)).pipe(
        Effect.map((result) => {
          if (Result.isFailure(result)) {
            return { failure: result.failure, kind: 'DEPENDENCY_FAILURE' as const };
          }
          return setEvidenceEquals(request, expected, result.success) ? stable() : changed();
        }),
      );
    },
    { concurrency: 1 },
  );
  const setDependency = setVerifications.find((verification) => verification.kind === 'DEPENDENCY_FAILURE');
  if (setDependency?.kind === 'DEPENDENCY_FAILURE') {
    return setDependency;
  }
  if (setVerifications.some((verification) => verification.kind === 'CHANGED')) {
    return changed();
  }
  if (attempt.compositionRequest !== undefined) {
    if (attempt.compositionResolution === undefined) {
      return changed();
    }
    const result = yield* Effect.result(ownerEvidence.resolveSetComposition(attempt.compositionRequest));
    if (Result.isFailure(result)) {
      return { failure: result.failure, kind: 'DEPENDENCY_FAILURE' };
    }
    if (
      !Schema.toEquivalence(AssortmentSetCompositionResolutionSchema)(attempt.compositionResolution, result.success)
    ) {
      return changed();
    }
  }
  return stable();
});

const dependencyResult = (
  attempts: number,
  failure: Extract<AssortmentOwnerFailure, { readonly _tag: 'AssortmentDependencyFailureError' }>,
): AssortmentFinalRevalidationResult => ({
  attempts,
  decision: { failure, outcome: 'INDETERMINATE' },
  kind: 'INDETERMINATE',
});

const exhaustedResult = (attempts: number, maxAttempts: number): AssortmentFinalRevalidationResult => ({
  attempts,
  decision: {
    failure: new AssortmentRetryExhaustedError({
      attempts,
      code: 'RETRY_EXHAUSTED',
      maxAttempts,
      safeReasonCode: 'RETRY_EXHAUSTED',
    }),
    outcome: 'INDETERMINATE',
  },
  kind: 'INDETERMINATE',
});

/** Revalidate one immutable attempt; a changed proof discards it before rebuilding. */
export const revalidateAssortmentAttempt = Effect.fn('FinalRevalidation.revalidateAssortmentAttempt')(
  function* revalidateAssortmentAttempt(options: AssortmentFinalRevalidationOptions) {
    const maxAttempts = yield* Schema.decodeEffect(PositiveAttemptsSchema)(options.maxAttempts);
    const runAttempt: (attemptNumber: number) => Effect.Effect<AssortmentFinalRevalidationResult> = Effect.fn(
      'FinalRevalidation.runAttempt',
    )(function* executeAttempt(attemptNumber: number) {
      const built = yield* Effect.result(options.buildAttempt(attemptNumber));
      if (Result.isFailure(built)) {
        if (!Schema.is(AssortmentDependencyFailureError)(built.failure)) {
          return exhaustedResult(attemptNumber, maxAttempts);
        }
        return dependencyResult(attemptNumber, built.failure);
      }
      if (!Schema.is(AssortmentRevalidationAttemptSchema)(built.success)) {
        return exhaustedResult(attemptNumber, maxAttempts);
      }
      const verification = yield* verifyAttempt(built.success, options.ownerEvidence);
      if (verification.kind === 'DEPENDENCY_FAILURE') {
        return dependencyResult(attemptNumber, verification.failure);
      }
      if (verification.kind === 'STABLE') {
        return { attempts: attemptNumber, decision: built.success.decision, kind: 'PUBLISHED' };
      }
      if (attemptNumber === maxAttempts) {
        return exhaustedResult(attemptNumber, maxAttempts);
      }
      return yield* runAttempt(attemptNumber + 1);
    });
    return yield* runAttempt(1);
  },
);

/** Revalidate Set constituents independently, preserving each constituent's complete attempt boundary. */
export const revalidateAssortmentConstituents = Effect.fn('FinalRevalidation.revalidateAssortmentConstituents')(
  function* revalidateAssortmentConstituents(constituents: readonly AssortmentFinalRevalidationConstituentOptions[]) {
    return yield* Effect.forEach(
      constituents,
      (constituent) =>
        revalidateAssortmentAttempt(constituent).pipe(
          Effect.map((result): AssortmentFinalRevalidationConstituentResult => ({
            key: constituent.key,
            result,
          })),
        ),
      { concurrency: 1 },
    );
  },
);
