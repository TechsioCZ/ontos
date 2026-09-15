/* eslint-disable effect-native/no-string-timestamp-schema, effect-native/no-unbranded-identifier-schema -- Privacy cross-owner wire contracts preserve explicit JSON null, canonical UTC string encodings, and owner-issued opaque references; generated API and Resource boundaries validate provenance without a misleading shared brand. expires: 2027-03-31. */
import { Schema } from 'effect';

import type { PrivacyOwnerResourceRef } from './privacy-owner-resource-ref.ts';

export interface PrivacyOwnerApplicationComposition {
  readonly modules: readonly { readonly moduleId: string }[];
}

export interface ProcessingActivityOwnerCoverageInput {
  readonly dataCategoryRef: PrivacyOwnerResourceRef;
  readonly systemOfRecordRef: PrivacyOwnerResourceRef;
}

export interface ProcessingActivityOwnerInventoryInput {
  readonly activityRef: { readonly resourceId: string; readonly tenantId: string };
  readonly dataCoverage: readonly ProcessingActivityOwnerCoverageInput[];
}

const Text = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500));
const Timestamp = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T/u));

export const PrivacyOwnerAvailabilitySchema = Schema.Literals(['AVAILABLE', 'UNAVAILABLE']);
export type PrivacyOwnerAvailability = typeof PrivacyOwnerAvailabilitySchema.Type;

export const PrivacyOwnerActivationStateSchema = Schema.Literals([
  'inactive',
  'active',
  'read_only',
  'suspended',
  'quarantined',
  'deprecated',
  'archived',
]);
export type PrivacyOwnerActivationState = typeof PrivacyOwnerActivationStateSchema.Type;

export const PrivacyOwnerObservationOutcomeSchema = Schema.Literals([
  'FOUND',
  'NO_DATA',
  'PARTIAL',
  'UNAVAILABLE',
  'INDETERMINATE',
]);
export type PrivacyOwnerObservationOutcome = typeof PrivacyOwnerObservationOutcomeSchema.Type;

export const PrivacyOwnerObservationSchema = Schema.Struct({
  moduleId: Text,
  observedAt: Timestamp,
  outcome: PrivacyOwnerObservationOutcomeSchema,
  reason: Schema.optional(Text),
  resourceRefs: Schema.Array(Text).check(Schema.isMaxLength(128)),
});
export type PrivacyOwnerObservation = typeof PrivacyOwnerObservationSchema.Type;

export const PrivacyOwnerInventoryStatusSchema = Schema.Literals([
  'FOUND',
  'NO_DATA',
  'PARTIAL',
  'MISSING',
  'DISABLED',
  'UNAVAILABLE',
  'UNCHECKED',
]);
export type PrivacyOwnerInventoryStatus = typeof PrivacyOwnerInventoryStatusSchema.Type;

export const PrivacyOwnerInventoryEntrySchema = Schema.Struct({
  moduleId: Text,
  observedAt: Schema.toEncoded(Schema.OptionFromNullOr(Timestamp)),
  reason: Schema.toEncoded(Schema.OptionFromNullOr(Text)),
  requiredByCoverageRefs: Schema.Array(Text).check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  resourceRefs: Schema.Array(Text).check(Schema.isMaxLength(128)),
  status: PrivacyOwnerInventoryStatusSchema,
});
export type PrivacyOwnerInventoryEntry = typeof PrivacyOwnerInventoryEntrySchema.Type;

export const PrivacyOwnerInventoryResultSchema = Schema.Struct({
  activityRef: Text,
  complete: Schema.Boolean,
  entries: Schema.Array(PrivacyOwnerInventoryEntrySchema),
  tenantId: Text,
});
export type PrivacyOwnerInventoryResult = typeof PrivacyOwnerInventoryResultSchema.Type;

export interface OwnerInventoryLookupInput {
  readonly activity: ProcessingActivityOwnerInventoryInput;
  readonly availability?: ReadonlyMap<string, PrivacyOwnerAvailability>;
  readonly composition: PrivacyOwnerApplicationComposition;
  /** Tenant-scoped module state supplied by Core's Module State Gate. */
  readonly moduleStates?: ReadonlyMap<string, PrivacyOwnerActivationState>;
  readonly observations?: readonly PrivacyOwnerObservation[];
}

const requiredOwners = (activity: ProcessingActivityOwnerInventoryInput): ReadonlyMap<string, string[]> => {
  const owners = new Map<string, string[]>();
  for (const coverage of activity.dataCoverage) {
    const owner = coverage.systemOfRecordRef.moduleId;
    const refs = owners.get(owner) ?? [];
    refs.push(coverage.systemOfRecordRef.resourceType);
    owners.set(owner, refs);
  }
  return owners;
};

const statusFor = (
  moduleId: string,
  composition: PrivacyOwnerApplicationComposition,
  observation: PrivacyOwnerObservation | undefined,
  moduleStates: ReadonlyMap<string, PrivacyOwnerActivationState>,
  availability: ReadonlyMap<string, PrivacyOwnerAvailability>,
): PrivacyOwnerInventoryStatus => {
  if (!composition.modules.some((module) => module.moduleId === moduleId)) {
    return 'MISSING';
  }
  if (availability.get(moduleId) === 'UNAVAILABLE') {
    return 'UNAVAILABLE';
  }
  const state = moduleStates.get(moduleId);
  if (state === undefined) {
    return 'UNCHECKED';
  }
  if (state !== 'active' && state !== 'read_only') {
    return 'DISABLED';
  }
  if (observation === undefined) {
    return 'UNCHECKED';
  }
  if (observation.outcome === 'UNAVAILABLE' || observation.outcome === 'INDETERMINATE') {
    return 'UNAVAILABLE';
  }
  return observation.outcome;
};

const reasonFor = (
  status: PrivacyOwnerInventoryStatus,
  observation: PrivacyOwnerObservation | undefined,
): string | null => {
  if (status === 'NO_DATA' && observation?.outcome === 'NO_DATA') {
    return observation.reason ?? 'Owner confirmed complete coverage with no data';
  }
  return observation?.reason ?? null;
};

const inventoryEntry = (
  moduleId: string,
  requiredByCoverageRefs: readonly string[],
  composition: PrivacyOwnerApplicationComposition,
  observation: PrivacyOwnerObservation | undefined,
  moduleStates: ReadonlyMap<string, PrivacyOwnerActivationState>,
  availability: ReadonlyMap<string, PrivacyOwnerAvailability>,
): PrivacyOwnerInventoryEntry => {
  const status = statusFor(moduleId, composition, observation, moduleStates, availability);
  return {
    moduleId,
    observedAt: observation?.observedAt ?? null,
    reason: reasonFor(status, observation),
    requiredByCoverageRefs: [...new Set(requiredByCoverageRefs)],
    resourceRefs: observation?.resourceRefs ?? [],
    status,
  };
};

/**
 * Resolves only declared Processing Activity System-of-Record owners against
 * deployed composition. It never searches owner data or treats a missing
 * observation as proof of NO_DATA.
 */
export const lookupPrivacyOwnerInventory = (input: OwnerInventoryLookupInput): PrivacyOwnerInventoryResult => {
  const owners = requiredOwners(input.activity);
  const observations = new Map((input.observations ?? []).map((observation) => [observation.moduleId, observation]));
  const moduleStates = input.moduleStates ?? new Map<string, PrivacyOwnerActivationState>();
  const availability = input.availability ?? new Map<string, PrivacyOwnerAvailability>();
  const entries = [...owners.entries()].map(([moduleId, requiredByCoverageRefs]) =>
    inventoryEntry(
      moduleId,
      requiredByCoverageRefs,
      input.composition,
      observations.get(moduleId),
      moduleStates,
      availability,
    ),
  );
  return {
    activityRef: input.activity.activityRef.resourceId,
    complete: entries.length > 0 && entries.every((entry) => entry.status === 'FOUND' || entry.status === 'NO_DATA'),
    entries,
    tenantId: input.activity.activityRef.tenantId,
  };
};
