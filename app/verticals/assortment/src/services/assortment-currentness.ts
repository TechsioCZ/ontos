import { DateTime, Effect, Layer, Match, Schema } from 'effect';
import { failClosedOwnerAuthorizationOverlay, OwnerAuthorizationOverlay } from '@app/core-runtime';
import type {
  OperationalScope,
  OwnerAccessFacts,
  OwnerAuthorizationOverlayService,
  ScopedTransactionExecutor,
} from '@app/core-runtime';
import { AssortmentConfigurationRequestSchema } from '../../shared/domain/governed-read-contracts.ts';
import type {
  AssortmentConfigurationRequest,
  AssortmentConfigurationResponse,
} from '../../shared/domain/governed-read-contracts.ts';
import { AssortmentPolicyPersistenceUnavailable } from '../../shared/domain/policy-errors.ts';
import { assortmentConfigurationReadSourceForScope } from './governed-configuration-read.service.ts';

type Configuration = AssortmentConfigurationResponse['configuration'];
type Failure = InstanceType<typeof AssortmentPolicyPersistenceUnavailable>;

/** One Assortment-owned record a Current check reads. It is never a capability: the gate owns that. */
export interface AssortmentRecordRef {
  readonly moduleId: string;
  readonly resourceId: string;
  readonly resourceType: string;
}

/**
 * The owner-local Current question one command or read asks about its own state.
 *
 * It replaces the removed Assortment permission targets: v2 gates the capability (scope-wide, O67-Q2)
 * and this seam only answers "is the record this command names still live and provable?". The target
 * travels from the payload as `accessOwnerFacts` (O70) so the overlay keeps reading owner state inside
 * Core's operation transaction without becoming a second permission system.
 */
export type AssortmentCurrentnessTarget =
  | Readonly<{ readonly kind: 'assortment_configuration'; readonly resource: AssortmentRecordRef }>
  | Readonly<{ readonly kind: 'assortment_decision' }>
  | Readonly<{
      readonly kind: 'assortment_rule';
      readonly mode: 'create';
      readonly selectorKind: string;
    }>
  | Readonly<{
      readonly kind: 'assortment_rule';
      readonly mode: 'revision_create';
      readonly selectorKind: string;
      readonly stableRule: AssortmentRecordRef;
    }>
  | Readonly<{ readonly kind: 'assortment_rule'; readonly mode: 'retire'; readonly stableRule: AssortmentRecordRef }>
  | Readonly<{
      readonly kind: 'assortment_binding';
      readonly mode: 'create';
      readonly ruleRevision: AssortmentRecordRef;
    }>
  | Readonly<{ readonly binding: AssortmentRecordRef; readonly kind: 'assortment_binding'; readonly mode: 'end' }>
  | Readonly<{
      readonly binding: AssortmentRecordRef;
      readonly kind: 'assortment_binding';
      readonly mode: 'replace';
      readonly ruleRevision: AssortmentRecordRef;
    }>
  | Readonly<{ readonly kind: 'assortment_boundary'; readonly mode: 'create' }>
  | Readonly<{ readonly boundary: AssortmentRecordRef; readonly kind: 'assortment_boundary'; readonly mode: 'end' }>
  | Readonly<{
      readonly boundary: AssortmentRecordRef;
      readonly kind: 'assortment_boundary';
      readonly mode: 'replace';
    }>;

const CURRENTNESS = 'assortment.currentness';
const kindKey = `${CURRENTNESS}.kind` as const;
const modeKey = `${CURRENTNESS}.mode` as const;
const selectorKindKey = `${CURRENTNESS}.selectorKind` as const;
const recordModuleKey = `${CURRENTNESS}.recordModuleKey` as const;
const recordTypeKey = `${CURRENTNESS}.recordType` as const;
const recordIdKey = `${CURRENTNESS}.recordId` as const;
const secondaryModuleKey = `${CURRENTNESS}.secondaryModuleKey` as const;
const secondaryTypeKey = `${CURRENTNESS}.secondaryType` as const;
const secondaryIdKey = `${CURRENTNESS}.secondaryId` as const;

const recordFacts = (record: AssortmentRecordRef): OwnerAccessFacts => ({
  [recordIdKey]: record.resourceId,
  [recordModuleKey]: record.moduleId,
  [recordTypeKey]: record.resourceType,
});
const secondaryRecordFacts = (record: AssortmentRecordRef): OwnerAccessFacts => ({
  [secondaryIdKey]: record.resourceId,
  [secondaryModuleKey]: record.moduleId,
  [secondaryTypeKey]: record.resourceType,
});

const bindingFacts = (
  value: Extract<AssortmentCurrentnessTarget, { readonly kind: 'assortment_binding' }>,
): OwnerAccessFacts => {
  if (value.mode === 'create') {
    return { [kindKey]: value.kind, [modeKey]: value.mode, ...recordFacts(value.ruleRevision) };
  }
  if (value.mode === 'end') {
    return { [kindKey]: value.kind, [modeKey]: value.mode, ...recordFacts(value.binding) };
  }
  return {
    [kindKey]: value.kind,
    [modeKey]: value.mode,
    ...recordFacts(value.binding),
    ...secondaryRecordFacts(value.ruleRevision),
  };
};

const boundaryFacts = (
  value: Extract<AssortmentCurrentnessTarget, { readonly kind: 'assortment_boundary' }>,
): OwnerAccessFacts =>
  value.mode === 'create'
    ? { [kindKey]: value.kind, [modeKey]: value.mode }
    : { [kindKey]: value.kind, [modeKey]: value.mode, ...recordFacts(value.boundary) };

const ruleFacts = (
  value: Extract<AssortmentCurrentnessTarget, { readonly kind: 'assortment_rule' }>,
): OwnerAccessFacts => {
  if (value.mode === 'create') {
    return { [kindKey]: value.kind, [modeKey]: value.mode, [selectorKindKey]: value.selectorKind };
  }
  if (value.mode === 'retire') {
    return { [kindKey]: value.kind, [modeKey]: value.mode, ...recordFacts(value.stableRule) };
  }
  return {
    [kindKey]: value.kind,
    [modeKey]: value.mode,
    [selectorKindKey]: value.selectorKind,
    ...recordFacts(value.stableRule),
  };
};

/** The owner facts a descriptor declares so the overlay can ask its own Current question (O70). */
export const assortmentCurrentnessFacts = (target: AssortmentCurrentnessTarget): OwnerAccessFacts =>
  Match.value(target).pipe(
    Match.discriminatorsExhaustive('kind')({
      assortment_binding: bindingFacts,
      assortment_boundary: boundaryFacts,
      assortment_configuration: (value) => ({ [kindKey]: value.kind, ...recordFacts(value.resource) }),
      assortment_decision: (value) => ({ [kindKey]: value.kind }),
      assortment_rule: ruleFacts,
    }),
  );

const recordFrom = (
  moduleId: string | undefined,
  resourceType: string | undefined,
  resourceId: string | undefined,
): AssortmentRecordRef | undefined =>
  moduleId === undefined || resourceType === undefined || resourceId === undefined
    ? undefined
    : { moduleId, resourceId, resourceType };

const recordFromFacts = (facts: OwnerAccessFacts): AssortmentRecordRef | undefined =>
  recordFrom(facts[recordModuleKey], facts[recordTypeKey], facts[recordIdKey]);

const secondaryRecordFromFacts = (facts: OwnerAccessFacts): AssortmentRecordRef | undefined =>
  recordFrom(facts[secondaryModuleKey], facts[secondaryTypeKey], facts[secondaryIdKey]);

const ruleTargetFromFacts = (
  facts: OwnerAccessFacts,
  mode: string | undefined,
  selectorKind: string,
): AssortmentCurrentnessTarget | undefined => {
  if (mode === 'create') {
    return { kind: 'assortment_rule', mode, selectorKind };
  }
  const stableRule = recordFromFacts(facts);
  if (stableRule === undefined) {
    return undefined;
  }
  if (mode === 'retire') {
    return { kind: 'assortment_rule', mode, stableRule };
  }
  return mode === 'revision_create' ? { kind: 'assortment_rule', mode, selectorKind, stableRule } : undefined;
};

const bindingTargetFromFacts = (
  facts: OwnerAccessFacts,
  mode: string | undefined,
): AssortmentCurrentnessTarget | undefined => {
  const primary = recordFromFacts(facts);
  if (mode === 'create') {
    return primary === undefined ? undefined : { kind: 'assortment_binding', mode, ruleRevision: primary };
  }
  if (mode === 'end') {
    return primary === undefined ? undefined : { binding: primary, kind: 'assortment_binding', mode };
  }
  const ruleRevision = secondaryRecordFromFacts(facts);
  return mode === 'replace' && primary !== undefined && ruleRevision !== undefined
    ? { binding: primary, kind: 'assortment_binding', mode, ruleRevision }
    : undefined;
};

const boundaryTargetFromFacts = (
  facts: OwnerAccessFacts,
  mode: string | undefined,
): AssortmentCurrentnessTarget | undefined => {
  if (mode === 'create') {
    return { kind: 'assortment_boundary', mode };
  }
  const boundary = recordFromFacts(facts);
  if (boundary === undefined) {
    return undefined;
  }
  return mode === 'end' || mode === 'replace' ? { boundary, kind: 'assortment_boundary', mode } : undefined;
};

/**
 * The Current question a request asks, decoded fail-safe: a fact bag that does not name one exact
 * target answers no question, so the caller keeps whatever the gate alone decided.
 */
export const assortmentCurrentnessTargetFromFacts = (
  facts?: OwnerAccessFacts,
): AssortmentCurrentnessTarget | undefined => {
  const kind = facts?.[kindKey];
  if (facts === undefined || kind === undefined) {
    return undefined;
  }
  const mode = facts[modeKey];
  const selectorKind = facts[selectorKindKey] ?? 'ALL';
  if (kind === 'assortment_decision') {
    return { kind };
  }
  if (kind === 'assortment_configuration') {
    const resource = recordFromFacts(facts);
    return resource === undefined ? undefined : { kind, resource };
  }
  if (kind === 'assortment_rule') {
    return ruleTargetFromFacts(facts, mode, selectorKind);
  }
  if (kind === 'assortment_binding') {
    return bindingTargetFromFacts(facts, mode);
  }
  return kind === 'assortment_boundary' ? boundaryTargetFromFacts(facts, mode) : undefined;
};

/** The configuration read asks the same Current question about the exact requested resource. */
export const configurationCurrentnessFacts = (request: AssortmentConfigurationRequest) => ({
  [kindKey]: 'assortment_configuration',
  [recordIdKey]: request.resource.resourceId,
  [recordModuleKey]: request.resource.moduleId,
  [recordTypeKey]: request.resource.resourceType,
});

/** The explanation read proves Current meaning of one exact decision, which no owner contract does yet. */
export const decisionExplanationCurrentnessFacts = () => ({ [kindKey]: 'assortment_decision' });

export type AssortmentAuthorizationCurrentResult =
  | Readonly<{ readonly configuration: Configuration; readonly status: 'CURRENT' }>
  | Readonly<{
      readonly reason: 'resource_ended' | 'resource_not_yet_effective' | 'rule_retired';
      readonly status: 'NOT_CURRENT';
    }>
  | Readonly<{
      readonly reason: 'foreign_currentness_unavailable' | 'local_currentness_unavailable';
      readonly status: 'UNAVAILABLE';
    }>;

type AssortmentAuthorizationCurrentService = Readonly<{
  readonly assess: (input: AssortmentAuthorizationCurrentInput) => Effect.Effect<AssortmentAuthorizationCurrentResult>;
}>;

export interface AssortmentAuthorizationCurrentInput {
  /** Core-minted transaction start time; callers must not derive this from request data. */
  readonly operationAt: DateTime.Utc;
  readonly scope: OperationalScope;
  readonly target: AssortmentCurrentnessTarget;
}

const localCurrentnessUnavailable = (): AssortmentAuthorizationCurrentResult => ({
  reason: 'local_currentness_unavailable',
  status: 'UNAVAILABLE',
});
const foreignCurrentnessUnavailable = (): AssortmentAuthorizationCurrentResult => ({
  reason: 'foreign_currentness_unavailable',
  status: 'UNAVAILABLE',
});
const unavailable = (cause?: unknown): Failure => {
  const failure = new AssortmentPolicyPersistenceUnavailable({
    code: 'assortment_policy_persistence_unavailable',
    reason: 'Assortment configuration is temporarily unavailable',
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};
const resourceEnded = (): AssortmentAuthorizationCurrentResult => ({ reason: 'resource_ended', status: 'NOT_CURRENT' });
const resourceNotYetEffective = (): AssortmentAuthorizationCurrentResult => ({
  reason: 'resource_not_yet_effective',
  status: 'NOT_CURRENT',
});
const ruleRetired = (): AssortmentAuthorizationCurrentResult => ({ reason: 'rule_retired', status: 'NOT_CURRENT' });
const current = (configuration: Configuration): AssortmentAuthorizationCurrentResult => ({
  configuration,
  status: 'CURRENT',
});

const resourceFor = (
  resource: AssortmentRecordRef,
  tenantId: string,
): Effect.Effect<AssortmentConfigurationRequest['resource'], Failure> =>
  Schema.decodeUnknownEffect(AssortmentConfigurationRequestSchema)({ resource: { ...resource, tenantId } }).pipe(
    Effect.map((request) => request.resource),
    Effect.mapError(unavailable),
  );

const readConfiguration = (
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
  resource: AssortmentRecordRef,
): Effect.Effect<Configuration, Failure> =>
  resourceFor(resource, scope.tenantId).pipe(
    Effect.flatMap((request) => assortmentConfigurationReadSourceForScope(transaction, scope).resolve(request, scope)),
    Effect.map((response) => response.configuration),
  );

const currentnessForConfiguration = (
  configuration: Configuration,
  foreignDependenciesPresent: boolean,
  operationAt: DateTime.Utc,
): AssortmentAuthorizationCurrentResult => {
  if (configuration.kind === 'BOUNDARY' || configuration.kind === 'BINDING') {
    const operationEpoch = DateTime.toEpochMillis(operationAt);
    if (DateTime.toEpochMillis(configuration.value.effectiveFrom) > operationEpoch) {
      return resourceNotYetEffective();
    }
    if (
      configuration.value.effectiveTo !== undefined &&
      DateTime.toEpochMillis(configuration.value.effectiveTo) <= operationEpoch
    ) {
      return resourceEnded();
    }
  }
  if (
    configuration.kind === 'RULE' &&
    configuration.value.retiredAt !== undefined &&
    DateTime.toEpochMillis(configuration.value.retiredAt) <= DateTime.toEpochMillis(operationAt)
  ) {
    return ruleRetired();
  }
  return foreignDependenciesPresent ? foreignCurrentnessUnavailable() : current(configuration);
};

/** Current meaning of one exact configuration record, as the removed configuration target read it. */
const configurationCurrentness = (
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
  operationAt: DateTime.Utc,
  resource: AssortmentRecordRef,
): Effect.Effect<AssortmentAuthorizationCurrentResult> =>
  readConfiguration(transaction, scope, resource).pipe(
    Effect.map((configuration) => {
      const foreignDependenciesPresent =
        configuration.kind === 'BOUNDARY' ||
        configuration.kind === 'BINDING' ||
        (configuration.kind === 'REVISION' && configuration.value.selector.kind !== 'ALL');
      return currentnessForConfiguration(configuration, foreignDependenciesPresent, operationAt);
    }),
    Effect.orElseSucceed(() => localCurrentnessUnavailable()),
  );

const ruleTargetCurrentness = (
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
  operationAt: DateTime.Utc,
  target: Extract<AssortmentCurrentnessTarget, { readonly kind: 'assortment_rule' }>,
): Effect.Effect<AssortmentAuthorizationCurrentResult> => {
  if (target.mode === 'create') {
    return Effect.succeed(localCurrentnessUnavailable());
  }
  return readConfiguration(transaction, scope, target.stableRule).pipe(
    Effect.map((configuration) => {
      if (configuration.kind !== 'RULE') {
        return localCurrentnessUnavailable();
      }
      if (
        configuration.value.retiredAt !== undefined &&
        DateTime.toEpochMillis(configuration.value.retiredAt) <= DateTime.toEpochMillis(operationAt)
      ) {
        return ruleRetired();
      }
      const foreignSelector = target.mode === 'revision_create' && target.selectorKind !== 'ALL';
      return foreignSelector ? foreignCurrentnessUnavailable() : current(configuration);
    }),
    Effect.orElseSucceed(() => localCurrentnessUnavailable()),
  );
};

const bindingCreateCurrentness = (
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
  ruleRevision: AssortmentRecordRef,
): Effect.Effect<AssortmentAuthorizationCurrentResult> =>
  readConfiguration(transaction, scope, ruleRevision).pipe(
    Effect.map((configuration) =>
      configuration.kind === 'REVISION' ? foreignCurrentnessUnavailable() : localCurrentnessUnavailable(),
    ),
    Effect.orElseSucceed(() => localCurrentnessUnavailable()),
  );

/** Every part of a conjunction must be CURRENT: one unprovable alternative cannot borrow another's state. */
const conjunction = (
  results: readonly AssortmentAuthorizationCurrentResult[],
): AssortmentAuthorizationCurrentResult => {
  const notCurrent = results.find((result) => result.status !== 'CURRENT');
  return notCurrent ?? results[0] ?? localCurrentnessUnavailable();
};

const replacementCurrentness = (
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
  operationAt: DateTime.Utc,
  target: Extract<AssortmentCurrentnessTarget, { readonly kind: 'assortment_binding'; readonly mode: 'replace' }>,
): Effect.Effect<AssortmentAuthorizationCurrentResult> =>
  // A replacement must end a live Binding and pin a Revision that is not itself unverified foreign
  // state: the same conjunction the removed end + create permission targets demanded.
  Effect.all(
    [
      configurationCurrentness(transaction, scope, operationAt, target.binding),
      bindingCreateCurrentness(transaction, scope, target.ruleRevision),
    ] as const,
    { concurrency: 1 },
  ).pipe(Effect.map(conjunction));

const boundaryReplacementCurrentness = (
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
  operationAt: DateTime.Utc,
  target: Extract<AssortmentCurrentnessTarget, { readonly kind: 'assortment_boundary'; readonly mode: 'replace' }>,
): Effect.Effect<AssortmentAuthorizationCurrentResult> =>
  // The old Boundary must still be live and the replacement Boundary needs the owner-evidence contract
  // that does not exist yet, so a replacement stays unavailable exactly as before.
  Effect.all(
    [
      configurationCurrentness(transaction, scope, operationAt, target.boundary),
      Effect.succeed(foreignCurrentnessUnavailable()),
    ] as const,
    { concurrency: 1 },
  ).pipe(Effect.map(conjunction));

/** The single record a configuration-shaped question reads; every other kind reads nothing. */
const recordTarget = (target: AssortmentCurrentnessTarget): AssortmentRecordRef | null =>
  Match.value(target).pipe(
    Match.discriminatorsExhaustive('kind')({
      assortment_binding: (value) => (value.mode === 'create' ? null : value.binding),
      assortment_boundary: (value) => (value.mode === 'create' ? null : value.boundary),
      assortment_configuration: (value) => value.resource,
      assortment_decision: () => null,
      assortment_rule: () => null,
    }),
  );

/**
 * Reads only Assortment-owned Current meaning inside Core's operation transaction. Temporal facts
 * are evaluated against Core's trusted transaction start instant. A CURRENT result is limited to
 * targets with no unverified foreign references; other live local records remain unavailable
 * until their referenced owners publish matching Current contracts.
 */
export const assortmentAuthorizationCurrentForTransaction = (
  transaction: ScopedTransactionExecutor,
): AssortmentAuthorizationCurrentService => ({
  assess: ({ operationAt, scope, target }) => {
    if (transaction.scope.tenantId !== scope.tenantId || transaction.scope.legalEntityId !== scope.legalEntityId) {
      return Effect.succeed(localCurrentnessUnavailable());
    }
    if (scope.legalEntityId === undefined && target.kind !== 'assortment_rule') {
      return Effect.succeed(localCurrentnessUnavailable());
    }
    if (target.kind === 'assortment_rule') {
      return ruleTargetCurrentness(transaction, scope, operationAt, target);
    }
    if (target.kind === 'assortment_binding' && target.mode === 'create') {
      return bindingCreateCurrentness(transaction, scope, target.ruleRevision);
    }
    if (target.kind === 'assortment_binding' && target.mode === 'replace') {
      return replacementCurrentness(transaction, scope, operationAt, target);
    }
    if (target.kind === 'assortment_boundary' && target.mode === 'replace') {
      return boundaryReplacementCurrentness(transaction, scope, operationAt, target);
    }
    const resource = recordTarget(target);
    return resource === null
      ? Effect.succeed(foreignCurrentnessUnavailable())
      : configurationCurrentness(transaction, scope, operationAt, resource);
  },
});

/** A Current verdict becomes the owner decision; anything unproven keeps failing closed. */
const ownerDecisionFor = (status: AssortmentAuthorizationCurrentResult['status']) => {
  if (status === 'CURRENT') {
    return 'allowed' as const;
  }
  return status === 'NOT_CURRENT' ? ('denied' as const) : ('unavailable' as const);
};

/**
 * The Assortment owner rule over its own state (O67-Q1, O70). The gate decides the capability; this
 * seam only answers the Current question the descriptor's `accessOwnerFacts` names, and it keeps
 * failing closed: a Current question it cannot prove denies (or reports unavailable), never allows.
 */
export const assortmentOwnerAuthorizationOverlay: OwnerAuthorizationOverlayService = {
  authorize: (transaction, input) => {
    const target = assortmentCurrentnessTargetFromFacts(input.ownerFacts);
    if (target === undefined) {
      // No Assortment Current question: the entrypoint gate alone answers this operation. Anything the
      // owner cannot place (a leftover owner-held target) keeps the Core fail-closed default.
      return input.targets.length === 0
        ? Effect.succeed('allowed' as const)
        : failClosedOwnerAuthorizationOverlay.authorize(transaction, input);
    }
    if (
      input.owningModuleKey !== 'commerce.assortment' ||
      transaction.scope.tenantId !== input.scope.tenantId ||
      transaction.scope.legalEntityId !== input.scope.legalEntityId
    ) {
      return Effect.succeed('unavailable' as const);
    }
    const currentService = assortmentAuthorizationCurrentForTransaction(transaction);
    return currentService
      .assess({ operationAt: input.operationAt, scope: input.scope, target })
      .pipe(Effect.map((result) => ownerDecisionFor(result.status)));
  },
};

export const assortmentOwnerAuthorizationOverlayLive = Layer.succeed(
  OwnerAuthorizationOverlay,
  assortmentOwnerAuthorizationOverlay,
);
