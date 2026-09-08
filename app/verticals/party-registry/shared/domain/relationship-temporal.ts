import { DateTime, Option } from 'effect';

import type {
  PartyRelationshipState,
  RelationshipIsoTimestamp,
} from './relationship-contract.ts';

interface RelationshipPeriod {
  readonly relationshipId: string;
  readonly validFrom: Option.Option<RelationshipIsoTimestamp>;
  readonly validTo: Option.Option<RelationshipIsoTimestamp>;
}

interface RelationshipUpdateState {
  readonly revision: number;
  readonly validFrom: Option.Option<RelationshipIsoTimestamp>;
  readonly validTo: Option.Option<RelationshipIsoTimestamp>;
}

interface RelationshipUpdateRequest {
  readonly expectedRevision: number;
  readonly validFrom?: RelationshipIsoTimestamp | undefined;
  readonly validTo?: Option.Option<RelationshipIsoTimestamp> | undefined;
}

interface RelationshipEndState extends RelationshipUpdateState {
  readonly endProvenanceMethod: null | string;
  readonly endProvenanceSource: null | string;
  readonly endReason: null | string;
}

interface RelationshipEndRequest {
  readonly effectiveAt: RelationshipIsoTimestamp;
  readonly expectedRevision: number;
  readonly provenance: Readonly<{
    readonly method: string;
    readonly source: string;
  }>;
  readonly reason?: string | undefined;
}

export const classifyRelationshipValidity = (
  validFrom: Option.Option<RelationshipIsoTimestamp>,
  validTo: Option.Option<RelationshipIsoTimestamp>,
  now: RelationshipIsoTimestamp
): PartyRelationshipState => {
  if (Option.isSome(validFrom) && DateTime.Order(now, validFrom.value) < 0) {
    return 'SCHEDULED';
  }
  return Option.isNone(validTo) || DateTime.Order(now, validTo.value) < 0
    ? 'CURRENT'
    : 'HISTORICAL';
};

const lowerBeforeUpper = (
  lower: Option.Option<RelationshipIsoTimestamp>,
  upper: Option.Option<RelationshipIsoTimestamp>
) =>
  Option.isNone(upper) ||
  Option.isNone(lower) ||
  DateTime.Order(lower.value, upper.value) < 0;

const sameInstant = (
  left: RelationshipIsoTimestamp,
  right: RelationshipIsoTimestamp
): boolean => DateTime.Equivalence(left, right);

const sameOptionalInstant = (
  left: Option.Option<RelationshipIsoTimestamp>,
  right: Option.Option<RelationshipIsoTimestamp>
): boolean =>
  Option.isNone(left)
    ? Option.isNone(right)
    : Option.isSome(right) && sameInstant(left.value, right.value);

const overlaps = (
  left: RelationshipPeriod,
  right: RelationshipPeriod
): boolean =>
  lowerBeforeUpper(left.validFrom, right.validTo) &&
  lowerBeforeUpper(right.validFrom, left.validTo);

export const decideRelationshipCreate = (
  existingPeriods: readonly RelationshipPeriod[],
  requestedPeriod: RelationshipPeriod
):
  | Readonly<{ readonly _tag: 'create' }>
  | Readonly<{ readonly _tag: 'overlap'; readonly relationshipId: string }>
  | Readonly<{ readonly _tag: 'reuse'; readonly relationshipId: string }> => {
  const exact = existingPeriods.find(
    (period) =>
      sameOptionalInstant(period.validFrom, requestedPeriod.validFrom) &&
      sameOptionalInstant(period.validTo, requestedPeriod.validTo)
  );
  if (exact !== undefined) {
    return { _tag: 'reuse', relationshipId: exact.relationshipId };
  }
  const overlapping = existingPeriods.find((period) =>
    overlaps(period, requestedPeriod)
  );
  return overlapping === undefined
    ? { _tag: 'create' }
    : { _tag: 'overlap', relationshipId: overlapping.relationshipId };
};

const requiresStartCorrection = (
  current: RelationshipUpdateState,
  request: RelationshipUpdateRequest,
  now: RelationshipIsoTimestamp
): boolean =>
  request.validFrom !== undefined &&
  Option.isSome(current.validFrom) &&
  !sameInstant(request.validFrom, current.validFrom.value) &&
  (DateTime.Order(current.validFrom.value, now) <= 0 ||
    DateTime.Order(request.validFrom, now) <= 0);

const requiresEndCorrection = (
  current: RelationshipUpdateState,
  request: RelationshipUpdateRequest,
  now: RelationshipIsoTimestamp
): boolean =>
  request.validTo !== undefined &&
  Option.isSome(current.validTo) &&
  DateTime.Order(current.validTo.value, now) <= 0 &&
  !sameOptionalInstant(current.validTo, request.validTo);

const requiresExplicitEnd = (
  current: RelationshipUpdateState,
  request: RelationshipUpdateRequest,
  now: RelationshipIsoTimestamp
): boolean =>
  Option.isNone(current.validTo) &&
  request.validTo !== undefined &&
  Option.isSome(request.validTo) &&
  DateTime.Order(request.validTo.value, now) <= 0;

export const decideRelationshipUpdate = (
  current: RelationshipUpdateState,
  request: RelationshipUpdateRequest,
  now: RelationshipIsoTimestamp
):
  | Readonly<{
      readonly _tag: 'correction_required';
      readonly fact: 'validFrom' | 'validTo';
    }>
  | Readonly<{ readonly _tag: 'end_required' }>
  | Readonly<{ readonly _tag: 'invalid_interval' }>
  | Readonly<{
      readonly _tag: 'revision_conflict';
      readonly actualRevision: number;
    }>
  | Readonly<{ readonly _tag: 'update' }> => {
  if (current.revision !== request.expectedRevision) {
    return { _tag: 'revision_conflict', actualRevision: current.revision };
  }
  const nextValidFrom =
    request.validFrom === undefined
      ? current.validFrom
      : Option.some(request.validFrom);
  const nextValidTo =
    request.validTo === undefined ? current.validTo : request.validTo;
  if (
    Option.isSome(nextValidFrom) &&
    Option.isSome(nextValidTo) &&
    DateTime.Order(nextValidTo.value, nextValidFrom.value) <= 0
  ) {
    return { _tag: 'invalid_interval' };
  }
  if (requiresStartCorrection(current, request, now)) {
    return { _tag: 'correction_required', fact: 'validFrom' };
  }
  if (requiresEndCorrection(current, request, now)) {
    return { _tag: 'correction_required', fact: 'validTo' };
  }
  if (requiresExplicitEnd(current, request, now)) {
    return { _tag: 'end_required' };
  }
  return { _tag: 'update' };
};

const decideRepeatedRelationshipEnd = (
  current: RelationshipEndState,
  request: RelationshipEndRequest
) => {
  if (
    current.endReason === (request.reason ?? null) &&
    current.endProvenanceMethod === request.provenance.method &&
    current.endProvenanceSource === request.provenance.source
  ) {
    return { _tag: 'unchanged' } as const;
  }
  if (
    current.endReason === null &&
    current.endProvenanceMethod === null &&
    current.endProvenanceSource === null
  ) {
    return { _tag: 'attach_end_evidence' } as const;
  }
  return { _tag: 'correction_required', fact: 'validTo' } as const;
};

export const decideRelationshipEnd = (
  current: RelationshipEndState,
  request: RelationshipEndRequest,
  now: RelationshipIsoTimestamp
):
  | Readonly<{ readonly _tag: 'attach_end_evidence' }>
  | Readonly<{ readonly _tag: 'correction_required'; readonly fact: 'validTo' }>
  | Readonly<{ readonly _tag: 'end' }>
  | Readonly<{ readonly _tag: 'invalid_interval' }>
  | Readonly<{
      readonly _tag: 'revision_conflict';
      readonly actualRevision: number;
    }>
  | Readonly<{ readonly _tag: 'unchanged' }>
  | Readonly<{ readonly _tag: 'update_required' }> => {
  if (current.revision !== request.expectedRevision) {
    return { _tag: 'revision_conflict', actualRevision: current.revision };
  }
  if (
    Option.isSome(current.validFrom) &&
    DateTime.Order(request.effectiveAt, current.validFrom.value) <= 0
  ) {
    return { _tag: 'invalid_interval' };
  }
  if (
    Option.isSome(current.validTo) &&
    sameInstant(current.validTo.value, request.effectiveAt)
  ) {
    return decideRepeatedRelationshipEnd(current, request);
  }
  if (Option.isSome(current.validTo)) {
    return DateTime.Order(current.validTo.value, now) > 0
      ? { _tag: 'update_required' }
      : { _tag: 'correction_required', fact: 'validTo' };
  }
  return { _tag: 'end' };
};
