import type { DateTime } from 'effect';
import type { PrivacyOwnerCoveragePartEncoded, PrivacyOwnerCoverageResultEncoded } from '@app/shared-contracts';

import { categoryOfScopeRef, COMMUNICATIONS_OWNER_CAPABILITY } from './inventory.ts';
import type { InventoryCategoryId } from './inventory.ts';

/**
 * Owner Coverage Result of Communications (#595-#597). The assessment only combines what the owner actually observed per
 * requested scope part. A requested part Communications does not own, a foreign owner capability and a missing or duplicate
 * observation stay INDETERMINATE and never become NO_DATA; NO_DATA exists only when EVERY requested part is completely
 * evidenced with no found content. An empty table, a fixed module list and a manual receipt are not evidence.
 */

/** Opaque, safe reference to one Communications record. It names no address, body or secret. */
export const communicationsContentRef = (kind: string, recordId: string): string =>
  `${COMMUNICATIONS_OWNER_CAPABILITY}.${kind}:${recordId}`;

export interface CategoryObservation {
  readonly category: InventoryCategoryId;
  readonly coverageStatus: PrivacyOwnerCoveragePartEncoded['coverageStatus'];
  readonly evidenceRefs: readonly string[];
  readonly foundContentRefs: readonly string[];
  readonly observedAt: PrivacyOwnerCoveragePartEncoded['observedAt'];
  readonly unresolvedReason?: string;
}

export interface CommunicationsCoverageInput {
  readonly assessedAt: PrivacyOwnerCoverageResultEncoded['assessedAt'];
  readonly evidenceRefs: readonly string[];
  readonly observations: readonly CategoryObservation[];
  readonly scope: PrivacyOwnerCoverageResultEncoded['scope'];
}

const incompleteCoveragePriority = [
  'INDETERMINATE',
  'UNAVAILABLE',
  'PARTIAL',
] as const satisfies readonly PrivacyOwnerCoverageResultEncoded['coverageStatus'][];

const aggregateCoverageStatus = (
  parts: readonly PrivacyOwnerCoveragePartEncoded[],
): PrivacyOwnerCoverageResultEncoded['coverageStatus'] => {
  if (parts.length > 0 && parts.every(({ coverageStatus }) => coverageStatus === 'COMPLETE')) {
    return 'COMPLETE';
  }
  return (
    incompleteCoveragePriority.find((status) => parts.some(({ coverageStatus }) => coverageStatus === status)) ??
    'INDETERMINATE'
  );
};

const indeterminatePart = (
  scopeRef: string,
  assessedAt: string,
  unresolvedReason: string,
  observations: readonly CategoryObservation[] = [],
): PrivacyOwnerCoveragePartEncoded => ({
  coverageStatus: 'INDETERMINATE',
  evidenceRefs: observations.flatMap(({ evidenceRefs }) => evidenceRefs),
  foundContentRefs: observations.flatMap(({ foundContentRefs }) => foundContentRefs),
  observedAt: assessedAt,
  scopeRef,
  unresolvedReason,
});

const coveragePartOf = (
  scopeRef: string,
  observations: readonly CategoryObservation[],
  assessedAt: string,
): PrivacyOwnerCoveragePartEncoded => {
  const [observation] = observations;
  if (observations.length !== 1 || observation === undefined) {
    return indeterminatePart(
      scopeRef,
      assessedAt,
      observations.length === 0
        ? 'REQUIRED_COMMUNICATIONS_OWNER_SCOPE_NOT_OBSERVED'
        : 'DUPLICATE_COMMUNICATIONS_OWNER_SCOPE_OBSERVATION',
      observations,
    );
  }
  const part = {
    coverageStatus: observation.coverageStatus,
    evidenceRefs: [...observation.evidenceRefs],
    foundContentRefs: [...observation.foundContentRefs],
    observedAt: observation.observedAt,
    scopeRef,
  };
  return observation.coverageStatus === 'COMPLETE'
    ? part
    : {
        ...part,
        unresolvedReason: observation.unresolvedReason ?? 'COMMUNICATIONS_OWNER_SCOPE_NOT_COMPLETELY_VERIFIED',
      };
};

/**
 * Adapts the observations to the shared Privacy Owner Contract for exactly the requested scope parts. Each part keeps its
 * own observation time: the result never claims an atomic snapshot across parts or with other owners.
 */
export const assessCommunicationsOwnerCoverage = (
  input: CommunicationsCoverageInput,
): PrivacyOwnerCoverageResultEncoded => {
  const isOwnScope = input.scope.ownerCapability === COMMUNICATIONS_OWNER_CAPABILITY;
  const coverageParts = input.scope.requestedScopePartRefs.map((scopeRef) => {
    const category = categoryOfScopeRef(scopeRef);
    if (!isOwnScope) {
      return indeterminatePart(scopeRef, input.assessedAt, 'NOT_A_COMMUNICATIONS_OWNER_CAPABILITY_SCOPE');
    }
    if (category === undefined) {
      return indeterminatePart(scopeRef, input.assessedAt, 'NOT_A_COMMUNICATIONS_OWNER_SCOPE_PART');
    }
    return coveragePartOf(
      scopeRef,
      input.observations.filter((observation) => observation.category === category),
      input.assessedAt,
    );
  });
  const coverageStatus = aggregateCoverageStatus(coverageParts);
  let contentStatus: PrivacyOwnerCoverageResultEncoded['contentStatus'] = 'UNKNOWN';
  if (coverageParts.some(({ foundContentRefs }) => foundContentRefs.length > 0)) {
    contentStatus = 'FOUND';
  } else if (coverageStatus === 'COMPLETE') {
    contentStatus = 'NO_DATA';
  }
  return {
    assessedAt: input.assessedAt,
    contentStatus,
    coverageParts,
    coverageStatus,
    evidenceRefs: [...input.evidenceRefs],
    scope: input.scope,
  };
};

/* ------------------------------------------------------------------------------------------------ */
/* Backup and recovery copies                                                                       */
/* ------------------------------------------------------------------------------------------------ */

/**
 * What the deployment owner can say about platform backups and recovery copies. Communications cannot observe them, so
 * the production default is the explicit unavailable form: the provider-copy and protection part is then PARTIAL and
 * the whole result can never be NO_DATA (AC-08). Only an authoritative evaluation completes it.
 */
export type OwnerBackupCoverage =
  | { readonly evidenceRef: string; readonly kind: 'EVALUATED'; readonly observedAt: DateTime.Utc }
  | { readonly kind: 'UNAVAILABLE' };

export const unavailableOwnerBackupCoverage: OwnerBackupCoverage = Object.freeze({ kind: 'UNAVAILABLE' });
