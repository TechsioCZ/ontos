import type { PartyRelationshipState, RelationshipIsoTimestamp } from './relationship-contract.ts';

interface RelationshipPeriod {
  readonly relationshipId: string;
  readonly validFrom: null | RelationshipIsoTimestamp;
  readonly validTo: null | RelationshipIsoTimestamp;
}

interface RelationshipUpdateState {
  readonly revision: number;
  readonly validFrom: null | RelationshipIsoTimestamp;
  readonly validTo: null | RelationshipIsoTimestamp;
}

interface RelationshipUpdateRequest {
  readonly expectedRevision: number;
  readonly validFrom?: RelationshipIsoTimestamp | undefined;
  readonly validTo?: null | RelationshipIsoTimestamp | undefined;
}

interface RelationshipEndState extends RelationshipUpdateState {
  readonly endProvenanceMethod: null | string;
  readonly endProvenanceSource: null | string;
  readonly endReason: null | string;
}

interface RelationshipEndRequest {
  readonly effectiveAt: RelationshipIsoTimestamp;
  readonly expectedRevision: number;
  readonly provenance: Readonly<{ readonly method: string; readonly source: string }>;
  readonly reason?: string | undefined;
}

export const classifyRelationshipValidity = (
  validFrom: null | RelationshipIsoTimestamp,
  validTo: null | RelationshipIsoTimestamp,
  now: RelationshipIsoTimestamp,
): PartyRelationshipState => {
  if (validFrom !== null && now < validFrom) {
    return 'SCHEDULED';
  }
  return validTo === null || now < validTo ? 'CURRENT' : 'HISTORICAL';
};

const lowerBeforeUpper = (
  lower: null | RelationshipIsoTimestamp,
  upper: null | RelationshipIsoTimestamp,
) => upper === null || lower === null || lower < upper;

const overlaps = (left: RelationshipPeriod, right: RelationshipPeriod): boolean =>
  lowerBeforeUpper(left.validFrom, right.validTo) &&
  lowerBeforeUpper(right.validFrom, left.validTo);

export const decideRelationshipCreate = (
  existingPeriods: readonly RelationshipPeriod[],
  requestedPeriod: RelationshipPeriod,
):
  | Readonly<{ readonly _tag: 'create' }>
  | Readonly<{ readonly _tag: 'overlap'; readonly relationshipId: string }>
  | Readonly<{ readonly _tag: 'reuse'; readonly relationshipId: string }> => {
  const exact = existingPeriods.find(
    (period) =>
      period.validFrom === requestedPeriod.validFrom && period.validTo === requestedPeriod.validTo,
  );
  if (exact !== undefined) {
    return { _tag: 'reuse', relationshipId: exact.relationshipId };
  }
  const overlapping = existingPeriods.find((period) => overlaps(period, requestedPeriod));
  return overlapping === undefined
    ? { _tag: 'create' }
    : { _tag: 'overlap', relationshipId: overlapping.relationshipId };
};

export const decideRelationshipUpdate = (
  current: RelationshipUpdateState,
  request: RelationshipUpdateRequest,
  now: RelationshipIsoTimestamp,
):
  | Readonly<{ readonly _tag: 'correction_required'; readonly fact: 'validFrom' | 'validTo' }>
  | Readonly<{ readonly _tag: 'end_required' }>
  | Readonly<{ readonly _tag: 'invalid_interval' }>
  | Readonly<{ readonly _tag: 'revision_conflict'; readonly actualRevision: number }>
  | Readonly<{ readonly _tag: 'update' }> => {
  if (current.revision !== request.expectedRevision) {
    return { _tag: 'revision_conflict', actualRevision: current.revision };
  }
  const nextValidFrom = request.validFrom ?? current.validFrom;
  const nextValidTo = request.validTo === undefined ? current.validTo : request.validTo;
  if (nextValidFrom !== null && nextValidTo !== null && nextValidTo <= nextValidFrom) {
    return { _tag: 'invalid_interval' };
  }
  if (
    request.validFrom !== undefined &&
    current.validFrom !== null &&
    request.validFrom !== current.validFrom &&
    (current.validFrom <= now || request.validFrom <= now)
  ) {
    return { _tag: 'correction_required', fact: 'validFrom' };
  }
  if (
    request.validTo !== undefined &&
    current.validTo !== null &&
    current.validTo <= now &&
    current.validTo !== request.validTo
  ) {
    return { _tag: 'correction_required', fact: 'validTo' };
  }
  if (
    current.validTo === null &&
    request.validTo !== undefined &&
    request.validTo !== null &&
    request.validTo <= now
  ) {
    return { _tag: 'end_required' };
  }
  return { _tag: 'update' };
};

export const decideRelationshipEnd = (
  current: RelationshipEndState,
  request: RelationshipEndRequest,
  now: RelationshipIsoTimestamp,
):
  | Readonly<{ readonly _tag: 'attach_end_evidence' }>
  | Readonly<{ readonly _tag: 'correction_required'; readonly fact: 'validTo' }>
  | Readonly<{ readonly _tag: 'end' }>
  | Readonly<{ readonly _tag: 'invalid_interval' }>
  | Readonly<{ readonly _tag: 'revision_conflict'; readonly actualRevision: number }>
  | Readonly<{ readonly _tag: 'unchanged' }>
  | Readonly<{ readonly _tag: 'update_required' }> => {
  if (current.revision !== request.expectedRevision) {
    return { _tag: 'revision_conflict', actualRevision: current.revision };
  }
  if (current.validFrom !== null && request.effectiveAt <= current.validFrom) {
    return { _tag: 'invalid_interval' };
  }
  if (current.validTo === request.effectiveAt) {
    if (
      current.endReason === (request.reason ?? null) &&
      current.endProvenanceMethod === request.provenance.method &&
      current.endProvenanceSource === request.provenance.source
    ) {
      return { _tag: 'unchanged' };
    }
    if (
      current.endReason === null &&
      current.endProvenanceMethod === null &&
      current.endProvenanceSource === null
    ) {
      return { _tag: 'attach_end_evidence' };
    }
    return { _tag: 'correction_required', fact: 'validTo' };
  }
  if (current.validTo !== null) {
    return current.validTo > now
      ? { _tag: 'update_required' }
      : { _tag: 'correction_required', fact: 'validTo' };
  }
  return { _tag: 'end' };
};
