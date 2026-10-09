import { Effect, Schema } from 'effect';

import {
  AssortmentDiscoveryDisclosureContextSchema,
  AssortmentDiscoveryDisclosureEstablishedCoverageSchema,
} from '../../shared/domain/disclosure-contracts.ts';
import type {
  AssortmentDiscoveryDisclosureContext,
  AssortmentDiscoveryDisclosureCoverage,
  AssortmentDiscoveryDisclosureEstablishedCoverage,
  AssortmentDiscoveryDisclosureEquivalence,
  AssortmentDiscoveryDisclosureInvalidation,
  AssortmentDiscoveryInclusionDecision,
} from '../../shared/domain/disclosure-contracts.ts';
import { CatalogProductRefSchema } from '../../shared/domain/decision-contracts.ts';
import type { AssortmentEvidenceReference, CatalogProductRef } from '../../shared/domain/decision-contracts.ts';
import type {
  AssortmentDecisionEvaluationPort,
  AssortmentVisibilityEvaluationRequest,
  AssortmentTrustedReadScope,
} from '../../shared/domain/ports/decision-evaluation.ts';
import {
  AssortmentSearchProjectionDuplicateSliceError,
  isAssortmentSearchProjectionSlice,
} from '../../shared/domain/search-projection.ts';
import type {
  AssortmentSearchProjectionEntry,
  AssortmentSearchProjectionState,
} from '../../shared/domain/search-projection.ts';

export class AssortmentSearchDetailVisibilityRecheckUnavailableError extends Schema.TaggedError<AssortmentSearchDetailVisibilityRecheckUnavailableError>()(
  'AssortmentSearchDetailVisibilityRecheckUnavailableError',
  { cause: Schema.Unknown, code: Schema.Literal('DETAIL_VISIBILITY_RECHECK_UNAVAILABLE') },
) {}

const contextEquivalence = Schema.toEquivalence(AssortmentDiscoveryDisclosureContextSchema);
const productEquivalence = Schema.toEquivalence(CatalogProductRefSchema);

const compareText = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
};

const resourceKey = (ref: {
  readonly moduleId: string;
  readonly resourceId: string;
  readonly resourceType: string;
  readonly tenantId: string;
}): string => [ref.tenantId, ref.moduleId, ref.resourceType, ref.resourceId].join(':');

const optionalResourceKey = (
  ref:
    | {
        readonly moduleId: string;
        readonly resourceId: string;
        readonly resourceType: string;
        readonly tenantId: string;
      }
    | undefined,
): string => (ref === undefined ? '' : resourceKey(ref));

const evidenceKey = (evidence: AssortmentEvidenceReference): string => {
  const { sourceRevision } = evidence;
  return [
    resourceKey(evidence.evidenceRef),
    evidence.ownerModuleId,
    sourceRevision === undefined
      ? ''
      : [sourceRevision.ownerModuleId, sourceRevision.revision, resourceKey(sourceRevision.sourceRef)].join(':'),
  ].join(':');
};

const contextKey = (context: AssortmentDiscoveryDisclosureContext): string => {
  const subjectKey =
    context.subject.kind === 'GUEST_PURCHASE_CONTEXT'
      ? ['guest', evidenceKey(context.subject.guestEvidence)].join(':')
      : [
          'identified',
          context.subject.subject.kind,
          resourceKey(
            context.subject.subject.kind === 'RETAIL_CUSTOMER_PROFILE'
              ? context.subject.subject.profileRef
              : context.subject.subject.counterpartyRef,
          ),
        ].join(':');
  return [
    context.decisionPurpose,
    subjectKey,
    context.trustedContext.tenantId,
    context.trustedContext.operationTime.toString(),
    resourceKey(context.trustedContext.channelRef),
    optionalResourceKey(context.trustedContext.commerceMarketRef),
    resourceKey(context.trustedContext.sellingLegalEntityRef),
    optionalResourceKey(context.trustedContext.storefrontRef),
  ].join('|');
};

const compareProductRefs = (left: CatalogProductRef, right: CatalogProductRef): number => {
  const tenant = compareText(left.tenantId, right.tenantId);
  if (tenant !== 0) {
    return tenant;
  }
  const module = compareText(left.moduleId, right.moduleId);
  if (module !== 0) {
    return module;
  }
  const resourceType = compareText(left.resourceType, right.resourceType);
  if (resourceType !== 0) {
    return resourceType;
  }
  return compareText(left.resourceId, right.resourceId);
};

const compareProjectionEntries = (
  left: AssortmentSearchProjectionEntry,
  right: AssortmentSearchProjectionEntry,
): number => {
  const context = compareText(contextKey(left.context), contextKey(right.context));
  if (context !== 0) {
    return context;
  }
  return compareProductRefs(left.productRef, right.productRef);
};

const omission = (
  context: AssortmentDiscoveryDisclosureContext,
  productRef: CatalogProductRef,
  coverage?: AssortmentDiscoveryDisclosureCoverage,
): AssortmentDiscoveryInclusionDecision => {
  if (coverage === undefined) {
    return { context, decision: 'OMIT', productRef };
  }
  return { context, coverage, decision: 'OMIT', productRef };
};

const inclusion = (
  context: AssortmentDiscoveryDisclosureContext,
  productRef: CatalogProductRef,
  coverage: AssortmentDiscoveryDisclosureEstablishedCoverage,
) => ({ context, coverage, decision: 'INCLUDE' as const, productRef });

type ProjectionDecisionInput = Readonly<{
  readonly context: AssortmentDiscoveryDisclosureContext;
  readonly entry?: AssortmentSearchProjectionEntry;
  readonly equivalence?: AssortmentDiscoveryDisclosureEquivalence;
  readonly productRef: CatalogProductRef;
}>;

const succeedDecision = (
  value: AssortmentDiscoveryInclusionDecision,
): Effect.Effect<AssortmentDiscoveryInclusionDecision> => Effect.succeed(value);

/** Every failure to establish exact disclosure coverage is omission, not INELIGIBLE. */
export const checkAssortmentSearchProjectionInclusion = Effect.fn('AssortmentSearchProjection.checkInclusion')(
  function* checkAssortmentSearchProjectionInclusion(input: ProjectionDecisionInput) {
    const { context, entry, equivalence, productRef } = input;
    const exactEntry =
      entry !== undefined && isAssortmentSearchProjectionSlice(entry, { context, productRef }) ? entry : undefined;
    if (exactEntry !== undefined) {
      if (
        exactEntry.verification === 'ESTABLISHED' &&
        Schema.is(AssortmentDiscoveryDisclosureEstablishedCoverageSchema)(exactEntry.coverage)
      ) {
        return yield* succeedDecision(inclusion(context, productRef, exactEntry.coverage));
      }
      return yield* succeedDecision(omission(context, productRef, exactEntry.coverage));
    }

    // Broader Guest/SHARED slices require explicit Assortment equivalence and a
    // source entry that is itself established. Missing or uncertain source state
    // cannot be upgraded by event silence, cache age, or a matching Product ID.
    if (
      equivalence !== undefined &&
      contextEquivalence(equivalence.target, context) &&
      productEquivalence(equivalence.productRef, productRef) &&
      entry !== undefined &&
      contextEquivalence(entry.context, equivalence.source) &&
      productEquivalence(entry.productRef, productRef) &&
      entry.verification === 'ESTABLISHED' &&
      Schema.is(AssortmentDiscoveryDisclosureEstablishedCoverageSchema)(entry.coverage)
    ) {
      const reusedCoverage = {
        context,
        productRef,
        proof: equivalence.proof,
        state: 'ESTABLISHED' as const,
      } satisfies AssortmentDiscoveryDisclosureEstablishedCoverage;
      return yield* succeedDecision(inclusion(context, productRef, reusedCoverage));
    }

    return yield* succeedDecision(omission(context, productRef));
  },
);

/**
 * Search inclusion is never detail authority. Protected Product detail gets a
 * fresh authoritative VISIBILITY evaluation through the owner port; every
 * non-eligible response is omitted and port failure fails closed.
 */
export const recheckAssortmentSearchDetailVisibility = Effect.fn('AssortmentSearchProjection.recheckDetailVisibility')(
  function* recheckAssortmentSearchDetailVisibility(
    input: Readonly<{
      readonly evaluation: AssortmentDecisionEvaluationPort;
      readonly request: AssortmentVisibilityEvaluationRequest;
      readonly scope: AssortmentTrustedReadScope;
    }>,
  ) {
    const response = yield* input.evaluation.evaluateVisibility(input.request, input.scope).pipe(
      Effect.mapError(
        (cause) =>
          new AssortmentSearchDetailVisibilityRecheckUnavailableError({
            cause,
            code: 'DETAIL_VISIBILITY_RECHECK_UNAVAILABLE',
          }),
      ),
    );
    return response.outcome === 'ELIGIBLE'
      ? ({ decision: 'INCLUDE_DETAIL' } as const)
      : ({ decision: 'OMIT_DETAIL' } as const);
  },
);

/** Rebuildable state intentionally has no event offset, TTL, timestamp, index flag, or page count. */
export const rebuildAssortmentSearchProjection = Effect.fn('AssortmentSearchProjection.rebuild')(
  function* rebuildAssortmentSearchProjection(entries: readonly AssortmentSearchProjectionEntry[]) {
    const sortedEntries = yield* Effect.succeed(entries.toSorted(compareProjectionEntries));
    const hasDuplicate = sortedEntries.some((entry, index) => {
      const previous = sortedEntries[index - 1];
      return previous !== undefined && isAssortmentSearchProjectionSlice(previous, entry);
    });
    if (hasDuplicate) {
      return yield* new AssortmentSearchProjectionDuplicateSliceError({ code: 'DUPLICATE_PROJECTION_SLICE' });
    }
    return { entries: sortedEntries } satisfies AssortmentSearchProjectionState;
  },
);

/** Apply one exact invalidation; unrelated contexts and Products remain untouched. */
export const applyAssortmentSearchProjectionInvalidation = Effect.fn('AssortmentSearchProjection.applyInvalidation')((
  state: AssortmentSearchProjectionState,
  invalidation: AssortmentDiscoveryDisclosureInvalidation,
) => {
  const entries = state.entries.map((entry) =>
    isAssortmentSearchProjectionSlice(entry, invalidation)
      ? { ...entry, coverage: invalidation, verification: 'INVALIDATED' as const }
      : entry,
  );
  return Effect.succeed({ entries } satisfies AssortmentSearchProjectionState);
});

type ProjectionQueryInput = Readonly<{
  readonly context: AssortmentDiscoveryDisclosureContext;
  readonly equivalences?: readonly AssortmentDiscoveryDisclosureEquivalence[];
  readonly productRefs: readonly CatalogProductRef[];
  readonly state: AssortmentSearchProjectionState;
}>;

/** Evaluates a batch against exact slices and returns only disclosure decisions. */
export const evaluateAssortmentSearchProjection = Effect.fn('AssortmentSearchProjection.evaluate')(
  function* evaluateAssortmentSearchProjection(input: ProjectionQueryInput) {
    const { context, productRefs, state } = input;
    const equivalences = input.equivalences ?? [];

    return yield* Effect.forEach(
      productRefs,
      (productRef) => {
        const exactEntry = state.entries.find((entry) =>
          isAssortmentSearchProjectionSlice(entry, { context, productRef }),
        );
        if (exactEntry !== undefined) {
          return checkAssortmentSearchProjectionInclusion({ context, entry: exactEntry, productRef });
        }
        const equivalence = equivalences.find(
          (candidate) =>
            contextEquivalence(candidate.target, context) && productEquivalence(candidate.productRef, productRef),
        );
        if (equivalence === undefined) {
          return checkAssortmentSearchProjectionInclusion({ context, productRef });
        }
        const sourceEntry = state.entries.find(
          (entry) =>
            contextEquivalence(entry.context, equivalence.source) && productEquivalence(entry.productRef, productRef),
        );
        if (sourceEntry === undefined) {
          return checkAssortmentSearchProjectionInclusion({ context, equivalence, productRef });
        }
        return checkAssortmentSearchProjectionInclusion({
          context,
          entry: sourceEntry,
          equivalence,
          productRef,
        });
      },
      { concurrency: 1 },
    );
  },
);
