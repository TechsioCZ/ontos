import { PrivacyIsoTimestampSchema } from './privacy-subject.ts';
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
const Timestamp = PrivacyIsoTimestampSchema;

export const PrivacyOwnerAvailabilitySchema = Schema.Literals(['AVAILABLE', 'UNAVAILABLE']);
export type PrivacyOwnerAvailability = typeof PrivacyOwnerAvailabilitySchema.Type;

export const PrivacyOwnerActivationStateSchema = Schema.Literals([
  /** No Module State Gate fact was read: the owner's governed answer is the only evidence, and it names no state. */
  'unknown',
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

/**
 * What an owner that answers with more than its coverage adds to its inventory entry (#1410): its configuration gaps per
 * category, its right-specific contribution and the external copies it knows. All three are optional and additive: an owner
 * that answers only coverage never carries them, and an entry without them is exactly the entry it has always been.
 */
const OwnerConfigurationSchema = Schema.Struct({
  category: Text,
  gapInputs: Schema.Array(Schema.Struct({ input: Text, owner: Text })),
  state: Schema.Literals(['CONFIGURATION_GAP', 'CONFIGURED', 'CONFLICTING_CONFIGURATION', 'NOT_APPLICABLE']),
});
const OwnerContributionSummarySchema = Schema.Struct({
  completion: Schema.Literals(['COMPLETE', 'INCOMPLETE']),
  decisions: Schema.Array(
    Schema.Struct({
      category: Text,
      contentRef: Text,
      outcome: Schema.Literals(['EXCLUDE', 'INCLUDE', 'REDACT']),
      reason: Text,
    }),
  ),
  exclusions: Schema.Array(Schema.Struct({ reason: Text, scopeRef: Text })),
  includedContentRefs: Schema.Array(Text),
  right: Text,
  unresolvedCategories: Schema.Array(Text),
});
const OwnerExternalCopySchema = Schema.Struct({
  firstObservedAt: Timestamp,
  holderRef: Text,
  lastObservedAt: Timestamp,
  providerSideDispositionEvidence: Schema.Literal('NOT_HELD_BY_COMMUNICATIONS'),
  relationship: Schema.Literals(['CURRENT_TRANSPORT', 'HISTORICAL_TRANSPORT', 'PRIOR_PROVIDER']),
});
const OwnerAnswerDetailFields = {
  configuration: Schema.optionalKey(Schema.Array(OwnerConfigurationSchema)),
  contribution: Schema.optionalKey(OwnerContributionSummarySchema),
  externalCopies: Schema.optionalKey(Schema.Array(OwnerExternalCopySchema)),
} as const;
const OwnerAnswerDetailSchema = Schema.Struct(OwnerAnswerDetailFields);
export type PrivacyOwnerAnswerDetail = typeof OwnerAnswerDetailSchema.Type;

export const PrivacyOwnerObservationSchema = Schema.Struct({
  ...OwnerAnswerDetailFields,
  moduleId: Schema.toEncoded(Text.pipe(Schema.brand('PrivacyModuleId'))),
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
  ...OwnerAnswerDetailFields,
  moduleId: Schema.toEncoded(Text.pipe(Schema.brand('PrivacyModuleId'))),
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
  tenantId: Schema.toEncoded(Text.pipe(Schema.brand('PrivacyTenantId'))),
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
  // `unknown` is not a refusal: the owner answered through the governed call, so its own gate admitted the read, but which
  // admitting state it was is a fact nobody read, and none is inferred
  if (state !== 'active' && state !== 'read_only' && state !== 'unknown') {
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

const MODULE_STATE_UNKNOWN = 'MODULE_STATE_UNKNOWN_ADMITTED_BY_THE_GOVERNED_CALL';

const reasonFor = (
  status: PrivacyOwnerInventoryStatus,
  observation: PrivacyOwnerObservation | undefined,
  state: PrivacyOwnerActivationState | undefined,
): string | null => {
  const reason =
    status === 'NO_DATA' && observation?.outcome === 'NO_DATA'
      ? (observation.reason ?? 'Owner confirmed complete coverage with no data')
      : (observation?.reason ?? null);
  return state === 'unknown' && observation !== undefined
    ? [reason, MODULE_STATE_UNKNOWN].filter((part) => part !== null).join('; ')
    : reason;
};

/** Only what the owner actually answered: an owner without these (or no observation at all) adds no key to its entry. */
const answerDetailOf = (observation: PrivacyOwnerObservation | undefined): PrivacyOwnerAnswerDetail => {
  const detail: { -readonly [Key in keyof PrivacyOwnerAnswerDetail]: PrivacyOwnerAnswerDetail[Key] } = {};
  if (observation?.configuration !== undefined) {
    detail.configuration = observation.configuration;
  }
  if (observation?.contribution !== undefined) {
    detail.contribution = observation.contribution;
  }
  if (observation?.externalCopies !== undefined) {
    detail.externalCopies = observation.externalCopies;
  }
  return detail;
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
    ...answerDetailOf(observation),
    moduleId,
    observedAt: observation?.observedAt ?? null,
    reason: reasonFor(status, observation, moduleStates.get(moduleId)),
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
