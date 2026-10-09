import { Effect, Schema } from 'effect';

import {
  AssortmentDiscoveryDisclosureContextSchema,
  AssortmentDiscoveryInclusionDecisionSchema,
  AssortmentPartialDiscoveryResultSchema,
} from './disclosure-contracts.ts';
import { CatalogProductRefSchema } from './decision-contracts.ts';
import type {
  AssortmentDiscoveryDisclosureContext,
  AssortmentDiscoveryInclusionDecision,
  AssortmentPartialDiscoveryResult,
} from './disclosure-contracts.ts';
import type { CatalogProductRef } from './decision-contracts.ts';

const contextEquivalence = Schema.toEquivalence(AssortmentDiscoveryDisclosureContextSchema);

const compareText = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
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

const sameProductRef = (left: CatalogProductRef, right: CatalogProductRef): boolean =>
  compareProductRefs(left, right) === 0;

const sortedUniqueProductRefs = (productRefs: readonly CatalogProductRef[]): CatalogProductRef[] => {
  const sorted = productRefs.toSorted(compareProductRefs);
  return sorted.filter((productRef, index) => {
    if (index === 0) {
      return true;
    }
    const previous = sorted[index - 1];
    return previous !== undefined && !sameProductRef(productRef, previous);
  });
};

export class AssortmentPartialResultContextMismatchError extends Schema.TaggedError<AssortmentPartialResultContextMismatchError>()(
  'AssortmentPartialResultContextMismatchError',
  {
    code: Schema.Literal('DISCOVERY_CONTEXT_MISMATCH'),
  },
) {}

export type AssortmentDiscoveryDecisionBatch = Readonly<{
  readonly context: AssortmentDiscoveryDisclosureContext;
  readonly decisions: readonly AssortmentDiscoveryInclusionDecision[];
}>;

/**
 * Accumulate only disclosure-safe Product inclusions. A known OMIT (including
 * one with invalidated coverage or no coverage because inclusion was
 * unverifiable) makes the result Partial, while every INCLUDE is retained.
 * No decision is an empty/non-authoritative result, not proof of completeness.
 */
export const accumulateAssortmentDiscoveryDecisions = Effect.fn('AssortmentDiscovery.accumulatePartial')(
  function* accumulateAssortmentDiscoveryDecisions(input: AssortmentDiscoveryDecisionBatch) {
    const context = yield* Schema.decodeEffect(Schema.toType(AssortmentDiscoveryDisclosureContextSchema))(
      input.context,
    );
    const decisions = yield* Effect.forEach(
      input.decisions,
      (decision) => Schema.decodeEffect(Schema.toType(AssortmentDiscoveryInclusionDecisionSchema))(decision),
      { concurrency: 1 },
    );

    if (decisions.some((decision) => !contextEquivalence(context, decision.context))) {
      return yield* new AssortmentPartialResultContextMismatchError({ code: 'DISCOVERY_CONTEXT_MISMATCH' });
    }

    const knownOmission = decisions.some((decision) => decision.decision === 'OMIT');
    const partialResult = knownOmission
      ? yield* Schema.decodeEffect(Schema.toType(AssortmentPartialDiscoveryResultSchema))({
          context,
          includedProductRefs: sortedUniqueProductRefs(
            decisions.flatMap((decision) => (decision.decision === 'INCLUDE' ? [decision.productRef] : [])),
          ),
          knownOmission: true,
        })
      : undefined;
    return partialResult;
  },
);

/** Public discovery output contains only safely includable Product refs. */
export const AssortmentSafeDiscoveryProjectionSchema = Schema.Struct({
  includedProductRefs: Schema.Array(CatalogProductRefSchema),
}).check(
  Schema.makeFilter((projection) => {
    const sorted = sortedUniqueProductRefs(projection.includedProductRefs);
    return sorted.length === projection.includedProductRefs.length &&
      sorted.every((productRef, index) => {
        const actual = projection.includedProductRefs[index];
        return actual !== undefined && sameProductRef(productRef, actual);
      })
      ? undefined
      : 'Safe discovery Product refs must be deterministically sorted and unique';
  }),
);
export type AssortmentSafeDiscoveryProjection = typeof AssortmentSafeDiscoveryProjectionSchema.Type;

/**
 * Encode the public shape by construction. Internal context, proof, Partial,
 * omission, and policy metadata are never copied into the public projection.
 */
export const encodeAssortmentSafeDiscoveryProjection = (
  result: AssortmentPartialDiscoveryResult,
): AssortmentSafeDiscoveryProjection => ({
  includedProductRefs: sortedUniqueProductRefs(result.includedProductRefs),
});
