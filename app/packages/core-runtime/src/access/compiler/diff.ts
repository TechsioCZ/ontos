import { Option, Schema } from 'effect';

import type { ProjectionPlan, ProjectionUnit } from './plan.ts';
import type { AccessRelationship, ProjectionUnitKey } from './relationship.ts';
import {
  isManagedRelation,
  projectionUnitKeyText,
  relationshipIdentity,
  relationshipKey,
  sortRelationships,
  unitOfRelationship,
} from './relationship.ts';

/**
 * The minimal mutation set, keyed by the identity the engine itself uses.
 *
 * `TOUCH` is sent for a tuple whose identity is new or whose *content* (caveat, expiration) differs,
 * and `DELETE` only for a tuple whose identity intent does not ask for on an object of a unit being
 * reconciled. One identity therefore never appears twice in one write: a changed ceiling, target set or
 * end date is a single `TOUCH`, never a `TOUCH` of the new content beside a `DELETE` of the old one,
 * which the engine refuses for the whole request.
 */
export interface ProjectionUnitDiff {
  readonly deletions: readonly AccessRelationship[];
  readonly key: string;
  readonly touches: readonly AccessRelationship[];
}

export interface ProjectionDiff {
  readonly deletions: readonly AccessRelationship[];
  readonly touches: readonly AccessRelationship[];
  readonly units: readonly ProjectionUnitDiff[];
}

export const ProjectionDriftKindSchema = Schema.Literals(['missing', 'stale', 'unexpected']);
export type ProjectionDriftKind = typeof ProjectionDriftKindSchema.Type;

export interface ProjectionDrift {
  readonly kind: ProjectionDriftKind;
  readonly relationship: AccessRelationship;
  readonly unit: string;
}

export interface ProjectionVerification {
  readonly drift: readonly ProjectionDrift[];
  readonly ok: boolean;
  readonly tupleCount: number;
  readonly units: number;
}

/** Units whose intent is gone and whose tuples are therefore deleted by the same write. */
export type RemovedUnits = readonly ProjectionUnitKey[];

const unitKeyOf = (relationship: AccessRelationship): string =>
  Option.match(unitOfRelationship(relationship), {
    onNone: () => '',
    onSome: projectionUnitKeyText,
  });

/**
 * Restricts a raw read to the units a reconcile names — plus any unit explicitly removed — so a
 * compiler run can never delete another tenant's, scope's or legal entity's tuples.
 */
const scopedActual = (
  desired: ProjectionPlan,
  actual: readonly AccessRelationship[],
  removedUnits: RemovedUnits,
): ReadonlyMap<string, readonly AccessRelationship[]> => {
  const named = new Set([...desired.units.map((planned) => planned.key), ...removedUnits.map(projectionUnitKeyText)]);
  const grouped = new Map<string, AccessRelationship[]>();
  for (const relationship of actual) {
    const unit = unitKeyOf(relationship);
    if (isManagedRelation(relationship) && named.has(unit)) {
      grouped.set(unit, [...(grouped.get(unit) ?? []), relationship]);
    }
  }
  return grouped;
};

const diffUnit = (planned: ProjectionUnit, current: readonly AccessRelationship[]): ProjectionUnitDiff => {
  const currentKeys = new Set(current.map(relationshipKey));
  const desiredIdentities = new Set(planned.relationships.map(relationshipIdentity));
  return {
    deletions: sortRelationships(
      current.filter((relationship) => !desiredIdentities.has(relationshipIdentity(relationship))),
    ),
    key: planned.key,
    touches: sortRelationships(
      planned.relationships.filter((relationship) => !currentKeys.has(relationshipKey(relationship))),
    ),
  };
};

const removedUnitDiffs = (
  desired: ProjectionPlan,
  actualByUnit: ReadonlyMap<string, readonly AccessRelationship[]>,
  removedUnits: RemovedUnits,
): readonly ProjectionUnitDiff[] =>
  removedUnits.flatMap((removed): readonly ProjectionUnitDiff[] => {
    const key = projectionUnitKeyText(removed);
    return desired.units.some((planned) => planned.key === key)
      ? []
      : [{ deletions: sortRelationships(actualByUnit.get(key) ?? []), key, touches: [] }];
  });

export const diffProjection = (
  desired: ProjectionPlan,
  actual: readonly AccessRelationship[],
  removedUnits: RemovedUnits = [],
): ProjectionDiff => {
  const actualByUnit = scopedActual(desired, actual, removedUnits);
  const units = [
    ...desired.units.map((planned) => diffUnit(planned, actualByUnit.get(planned.key) ?? [])),
    ...removedUnitDiffs(desired, actualByUnit, removedUnits),
  ];
  return {
    deletions: units.flatMap((unitDiff) => unitDiff.deletions),
    touches: units.flatMap((unitDiff) => unitDiff.touches),
    units: units.filter((unitDiff) => unitDiff.deletions.length > 0 || unitDiff.touches.length > 0),
  };
};

const unitDrift = (planned: ProjectionUnit, current: readonly AccessRelationship[]): readonly ProjectionDrift[] => {
  const currentKeys = new Set(current.map(relationshipKey));
  const currentIdentities = new Set(current.map(relationshipIdentity));
  const desiredIdentities = new Set(planned.relationships.map(relationshipIdentity));
  return [
    ...planned.relationships.flatMap((relationship): readonly ProjectionDrift[] => {
      const identity = relationshipIdentity(relationship);
      if (!currentIdentities.has(identity)) {
        return [{ kind: 'missing', relationship, unit: planned.key }];
      }
      return currentKeys.has(relationshipKey(relationship)) ? [] : [{ kind: 'stale', relationship, unit: planned.key }];
    }),
    ...current.flatMap((relationship): readonly ProjectionDrift[] =>
      desiredIdentities.has(relationshipIdentity(relationship))
        ? []
        : [{ kind: 'unexpected', relationship, unit: planned.key }],
    ),
  ];
};

/**
 * Compares the complete projection of the named units with intent (D13). A missing tuple, a tuple
 * whose content drifted, an undecodable tuple and a tuple intent does not ask for are all drift: the
 * graph is either exactly the intent or it is a failed operation.
 */
export const verifyProjection = (
  desired: ProjectionPlan,
  actual: readonly AccessRelationship[],
  removedUnits: RemovedUnits = [],
): ProjectionVerification => {
  const actualByUnit = scopedActual(desired, actual, removedUnits);
  const removedDrift = removedUnitDiffs(desired, actualByUnit, removedUnits).flatMap((unitDiff) =>
    unitDiff.deletions.map((relationship): ProjectionDrift => ({
      kind: 'unexpected',
      relationship,
      unit: unitDiff.key,
    })),
  );
  const drift = [
    ...desired.units.flatMap((planned) => unitDrift(planned, actualByUnit.get(planned.key) ?? [])),
    ...removedDrift,
  ];
  return {
    drift,
    ok: drift.length === 0,
    tupleCount: desired.units.reduce((total, planned) => total + planned.relationships.length, 0),
    units: desired.units.length,
  };
};
