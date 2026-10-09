import { Schema } from 'effect';

import {
  AssortmentDiscoveryDisclosureContextSchema,
  AssortmentDiscoveryDisclosureCoverageSchema,
} from './disclosure-contracts.ts';
import { CatalogProductRefSchema } from './decision-contracts.ts';

const contextEquivalence = Schema.toEquivalence(AssortmentDiscoveryDisclosureContextSchema);
const productEquivalence = Schema.toEquivalence(CatalogProductRefSchema);

export class AssortmentSearchProjectionDuplicateSliceError extends Schema.TaggedError<AssortmentSearchProjectionDuplicateSliceError>()(
  'AssortmentSearchProjectionDuplicateSliceError',
  { code: Schema.Literal('DUPLICATE_PROJECTION_SLICE') },
) {}

/**
 * This is a projection verification state, not an Assortment outcome or a
 * claim about authoritative VISIBILITY currentness.
 */
export const AssortmentSearchProjectionVerificationSchema = Schema.Literals([
  'ESTABLISHED',
  'STALE',
  'UNCERTAIN',
  'UNVERIFIABLE',
  'INVALIDATED',
]);

/** One Product's rebuildable disclosure allowance for one exact request context. */
export const AssortmentSearchProjectionEntrySchema = Schema.Struct({
  context: AssortmentDiscoveryDisclosureContextSchema,
  coverage: AssortmentDiscoveryDisclosureCoverageSchema,
  productRef: CatalogProductRefSchema,
  verification: AssortmentSearchProjectionVerificationSchema,
}).check(
  Schema.makeFilter((entry) => {
    const coverageState = entry.coverage.state;
    const verificationMatchesCoverage =
      coverageState === 'INVALIDATED' ? entry.verification === 'INVALIDATED' : entry.verification !== 'INVALIDATED';
    const productMatchesCoverage = productEquivalence(entry.productRef, entry.coverage.productRef);
    const contextMatchesCoverage = contextEquivalence(entry.context, entry.coverage.context);
    return verificationMatchesCoverage && productMatchesCoverage && contextMatchesCoverage
      ? undefined
      : 'Projection entry must bind verification, Product, and coverage to one exact context';
  }),
);
export type AssortmentSearchProjectionEntry = typeof AssortmentSearchProjectionEntrySchema.Type;

const projectionSliceMatches = (
  left: Pick<AssortmentSearchProjectionEntry, 'context' | 'productRef'>,
  right: Pick<AssortmentSearchProjectionEntry, 'context' | 'productRef'>,
): boolean => contextEquivalence(left.context, right.context) && productEquivalence(left.productRef, right.productRef);

/** Rebuildable owner-local state. No event offset, TTL, timestamp, index flag, or page count is included. */
export const AssortmentSearchProjectionStateSchema = Schema.Struct({
  entries: Schema.Array(AssortmentSearchProjectionEntrySchema),
}).check(
  Schema.makeFilter((state) =>
    state.entries.every((entry, index) =>
      state.entries.slice(0, index).every((previous) => !projectionSliceMatches(previous, entry)),
    )
      ? undefined
      : 'Projection state may contain one entry per exact context and Product slice',
  ),
);
export type AssortmentSearchProjectionState = typeof AssortmentSearchProjectionStateSchema.Type;

/** Shared exact-slice comparison for the projection service and its invalidation path. */
export const isAssortmentSearchProjectionSlice = projectionSliceMatches;
