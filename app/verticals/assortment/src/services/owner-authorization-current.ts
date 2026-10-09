import { DateTime, Effect, Layer, Match, Schema } from 'effect';
import { failClosedOwnerAuthorizationOverlay, OwnerAuthorizationOverlay } from '@app/core-runtime';
import type {
  AssortmentPermissionAccessTarget,
  OperationalScope,
  OwnerAuthorizationOverlayService,
  OwnerAuthorizationTarget,
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
  readonly target: AssortmentPermissionAccessTarget;
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
  resource: Readonly<{ moduleId: string; resourceId: string; resourceType: string }>,
  tenantId: string,
): Effect.Effect<AssortmentConfigurationRequest['resource'], Failure> =>
  Schema.decodeUnknownEffect(AssortmentConfigurationRequestSchema)({ resource: { ...resource, tenantId } }).pipe(
    Effect.map((request) => request.resource),
    Effect.mapError(unavailable),
  );

const readConfiguration = (
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
  resource: Readonly<{ moduleId: string; resourceId: string; resourceType: string }>,
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

const ruleTargetCurrentness = (
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
  operationAt: DateTime.Utc,
  target: Extract<AssortmentPermissionAccessTarget, { readonly kind: 'assortment_rule' }>,
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
      const foreignSelector = target.mode === 'revision_create' && target.selector.kind !== 'ALL';
      return foreignSelector ? foreignCurrentnessUnavailable() : current(configuration);
    }),
    Effect.orElseSucceed(() => localCurrentnessUnavailable()),
  );
};

const ownedConfigurationTarget = (
  target: Extract<AssortmentPermissionAccessTarget, { readonly kind: 'assortment_configuration' }>,
) => target.resource;

const bindingResourceTarget = (
  value: Extract<AssortmentPermissionAccessTarget, { readonly kind: 'assortment_binding' }>,
) => (value.mode === 'end' ? value.binding : null);
const boundaryResourceTarget = (
  value: Extract<AssortmentPermissionAccessTarget, { readonly kind: 'assortment_boundary' }>,
) => (value.mode === 'end' ? value.boundary : null);
const noResourceTarget = (
  _value: Extract<AssortmentPermissionAccessTarget, { readonly kind: 'assortment_decision' }>,
) => null;
const noRuleResourceTarget = (
  _value: Extract<AssortmentPermissionAccessTarget, { readonly kind: 'assortment_rule' }>,
) => null;

const resourceTarget = (target: AssortmentPermissionAccessTarget) =>
  Match.value(target).pipe(
    Match.discriminatorsExhaustive('kind')({
      assortment_binding: bindingResourceTarget,
      assortment_boundary: boundaryResourceTarget,
      assortment_configuration: ownedConfigurationTarget,
      assortment_decision: noResourceTarget,
      assortment_rule: noRuleResourceTarget,
    }),
  );

const bindingCreateCurrentness = (
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
  target: Extract<AssortmentPermissionAccessTarget, { readonly kind: 'assortment_binding'; readonly mode: 'create' }>,
): Effect.Effect<AssortmentAuthorizationCurrentResult> =>
  readConfiguration(transaction, scope, target.ruleRevision).pipe(
    Effect.map((configuration) =>
      configuration.kind === 'REVISION' ? foreignCurrentnessUnavailable() : localCurrentnessUnavailable(),
    ),
    Effect.orElseSucceed(() => localCurrentnessUnavailable()),
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
      return bindingCreateCurrentness(transaction, scope, target);
    }
    const resource = resourceTarget(target);
    if (resource === null) {
      return Effect.succeed(foreignCurrentnessUnavailable());
    }
    return readConfiguration(transaction, scope, resource).pipe(
      Effect.map((configuration) => {
        const foreignDependenciesPresent =
          configuration.kind === 'BOUNDARY' ||
          configuration.kind === 'BINDING' ||
          (configuration.kind === 'REVISION' && configuration.value.selector.kind !== 'ALL');
        return currentnessForConfiguration(configuration, foreignDependenciesPresent, operationAt);
      }),
      Effect.orElseSucceed(() => localCurrentnessUnavailable()),
    );
  },
});

/**
 * Core checks exact Permissions independently. Require every Assortment alternative to be
 * Current so a grant on one target cannot borrow the Current state of another target.
 */
export const assortmentOwnerAuthorizationOverlay: OwnerAuthorizationOverlayService = {
  authorize: (transaction, input) => {
    if (input.targets.some((target) => target.kind === 'business_permission')) {
      return failClosedOwnerAuthorizationOverlay.authorize(transaction, input);
    }
    const targets = input.targets.filter(
      (target): target is Extract<OwnerAuthorizationTarget, { readonly kind: 'assortment_permission' }> =>
        target.kind === 'assortment_permission',
    );
    if (targets.length === 0) {
      return failClosedOwnerAuthorizationOverlay.authorize(transaction, input);
    }
    if (
      input.owningModuleKey !== 'commerce.assortment' ||
      transaction.scope.tenantId !== input.scope.tenantId ||
      transaction.scope.legalEntityId !== input.scope.legalEntityId
    ) {
      return Effect.succeed('unavailable' as const);
    }
    const currentService = assortmentAuthorizationCurrentForTransaction(transaction);
    return Effect.forEach(
      targets,
      (target) => currentService.assess({ operationAt: input.operationAt, scope: input.scope, target: target.target }),
      { concurrency: 1 },
    ).pipe(
      Effect.map((results) => {
        if (results.some((result) => result.status === 'UNAVAILABLE')) {
          return 'unavailable' as const;
        }
        return results.every((result) => result.status === 'CURRENT') ? ('allowed' as const) : ('denied' as const);
      }),
    );
  },
};

export const assortmentOwnerAuthorizationOverlayLive = Layer.succeed(
  OwnerAuthorizationOverlay,
  assortmentOwnerAuthorizationOverlay,
);
