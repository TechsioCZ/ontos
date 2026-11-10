import {
  loadModuleOperationAdmission,
  captureShellSystemReadRegistrations,
  isBoundShellSystemRead,
  operationCatalogLoader,
  prepareOperationIntrinsicState,
  validateBoundOperationOwner,
  withModuleOperationExecution,
  withoutModuleOperationExecution,
} from '../modules/module-operation-execution.ts';
import { ActiveApplicationCompositionService } from '../modules/active-application-composition.ts';
import type { ShellSystemReadRegistrations } from '../modules/module-operation-execution.ts';
import type { ActiveApplicationCompositionServiceContract } from '../modules/active-application-composition.ts';
import type { VerticalRuntimeRegistration } from '../modules/runtime-registration.ts';
import type { OntosDeploymentIdentitySchema } from '../modules/manifest.ts';
import { ConnectionError, SqlError, isSqlError } from 'effect/sql/SqlError';
/* oxlint-disable sonarjs/no-duplicate-string, eslint/no-use-before-define, anti-slop/no-unknown-parameters, effect-native/no-throw-in-effect-callback, effect-native/no-native-error-construction -- Opaque owner resolver defects are captured immediately by Effect.try and sanitized to a typed Core failure; expires: 2027-03-31. */
// @effect-diagnostics asyncFunction:off -- Existing compatibility boundary; expires: 2026-12-31.
import { Cause, Context, DateTime, Effect, Exit, Layer, Match, Option, Predicate, Schema } from 'effect';
import type { AccessDeclaration, AccessFieldGroup, AccessTarget } from '../authorization/access-declaration.ts';
import type { AccessDecision, AccessRecordTarget, ParentReadRequirement } from '../access/decision/contract.ts';
import type { GateInput } from '../access/enforcement/contract.ts';
import type { ListAccessResolution } from '../access/decision/engine.ts';
import { capabilityPolicyOf } from '../access/enforcement/capability.ts';
import { withOptional } from '../access/decision/optional.ts';
import type { ListAccessPredicate } from '../access/decision/list-access.ts';
import { ModuleKeySchema, PrincipalIdSchema, RecordKeySchema, TenantIdSchema } from '../access/ids.ts';
import { AccessPrincipalKindSource } from '../access/enforcement/actor.ts';
import type { AccessPrincipalKinds } from '../access/enforcement/actor.ts';
import type { BoundAccessGate } from '../operations/access-gate.ts';
import { bindLiveAccessGate } from '../operations/access-gate.ts';
import type { ActionPolicyTarget } from '../actions/policy.ts';
import { transportIdentifier } from '../actions/string-schemas.ts';
import { computeCanonicalValueHash, recoverSqlTransactionError } from '../actions/repository.ts';
import {
  decodeTrustedPrincipalContext,
  isTrustedSupportRecoveryPrincipalContext,
  readVerifiedGatewayCompositionRevision,
} from '../auth/system-principal-context-provenance.ts';
import { CoreDatabase } from '../db/client.ts';
import { DatabaseIdentityEnrollmentContext } from '../db/database-identities.ts';
import type { DatabaseIdentityEnrollment } from '../db/database-identity-manifest.ts';
import { installOperationalScope } from '../db/scoped-transaction.ts';
import type { CoreDbExecutor, CoreTransaction } from '../db/types.ts';
import { insideDatabaseTransaction } from '../db/transaction-io-guard.ts';
import { lockApplicationCompositionAuthority } from '../modules/application-composition-authority.ts';
import { trustedTransactionTime } from '../operations/transaction-time.ts';
import type { ModuleEntrypointGatewayService } from '../modules/module-entrypoint-gateway.ts';
import { ModuleEntrypointGateway } from '../modules/module-entrypoint-gateway.ts';
import type { OperationalScope, OperationalScopeResolverService } from '../operations/context.ts';
import { OperationalScopeResolver } from '../operations/context.ts';
import {
  ContextAccess,
  isOwnerPermissionAccessTargetValid,
  toContextPermissionAccessKey,
} from '../permissions/context-access.ts';
import { LEGAL_ENTITY_PERMISSION_KEYS } from '../permissions/context-permissions.ts';
import { OwnerAuthorizationOverlay, failClosedOwnerAuthorizationOverlay } from '../access/enforcement/owner-overlay.ts';
import type { OwnerAccessFacts, OwnerAuthorizationTarget } from '../access/enforcement/owner-overlay.ts';
import { validateReadEvidenceMetadata } from './context.ts';
import type { ReadOwnerTransaction } from './context.ts';
import type {
  AtomicResolvedReadPermissionTarget,
  ReadConditionalPermissionDeclaration,
  ReadRegistration,
  ReadResourcePermissionTarget,
  ResolvedReadConditionalPermissionRequirement,
  ResolvedReadPermissionTarget,
} from './definition.ts';
import {
  getReadAccessTargetResolver,
  getReadOwnerFactsResolver,
  getReadConditionalPermissionPlan,
  isReadRegistration,
  getReadDomainErrorSchema,
  getReadPermissionTargetResolver,
  getReadPolicyImplementations,
  getReadResourcePermissionTargetResolver,
  getReadResultPermissionTargetResolver,
  getReadServiceFactory,
  getReadStages,
  projectReadResultFields,
} from './definition.ts';
import type { ReadCoreError } from './errors.ts';
import {
  ReadEvidencePersistenceError,
  ReadHandlerExecutionError,
  ReadHandlerNotFound,
  ReadHandlerUnavailable,
  ReadInputValidationError,
  ReadPermissionDenied,
  ReadPermissionUnavailable,
  ReadPolicyDenied,
  ReadPolicyEvaluationError,
  ReadResultValidationError,
} from './errors.ts';
import { persistReadEvidence, persistScopedReadEvidence } from './repository.ts';
import type { PersistReadEvidenceInput } from './repository.ts';

const withOptionalProperty = <
  const Base extends object,
  const Key extends PropertyKey,
  const Value,
  const Trailing extends object,
>(
  base: Base,
  condition: boolean,
  key: Key,
  value: Value,
  trailing: Trailing,
) => (condition ? { ...base, [key]: value, ...trailing } : { ...base, ...trailing });

// Bounded here as well as at the HTTP adapters: Shell routes call ReadRuntime directly with the raw
// request header, so the transport schema is the only layer every caller passes through.
const CorrelationIdSchema = transportIdentifier.pipe(Schema.brand('ReadCorrelationId'));
const TargetModuleKeySchema = Schema.String.check(Schema.isMinLength(1)).pipe(Schema.brand('ReadTargetModuleKey'));
const TargetResourceIdSchema = Schema.String.check(Schema.isMinLength(1)).pipe(Schema.brand('ReadTargetResourceId'));
const TargetResourceTypeSchema = Schema.String.check(Schema.isMinLength(1)).pipe(
  Schema.brand('ReadTargetResourceType'),
);
const TraceIdSchema = transportIdentifier.pipe(Schema.brand('ReadTraceId'));

const ReadTransportSchema = Schema.Struct({
  correlationId: CorrelationIdSchema,
  targetModuleKey: Schema.optionalKey(TargetModuleKeySchema),
  targetResourceId: Schema.optionalKey(TargetResourceIdSchema),
  targetResourceType: Schema.optionalKey(TargetResourceTypeSchema),
  traceId: Schema.optionalKey(TraceIdSchema),
});

export const READ_RUNTIME_STAGES = [
  'input_decoded',
  'scope_validated',
  'module_state_checked',
  'permission_checked',
  'policies_checked',
  'scope_installed',
  'handler_executed',
  'result_decoded',
  'evidence_persisted',
] as const;
export type ReadRuntimeStage = (typeof READ_RUNTIME_STAGES)[number];

export interface ReadRuntimeOptions {
  /**
   * The access gate bound to this composition's enforcement ports (CUTOVER-PLAN §3.1). Every read
   * that carries a v2 access carrier is decided here and nowhere else, and a composition without it
   * refuses every such read with a retryable 503 instead of an implicit allow (O62). Reads still on a
   * legacy kind keep the legacy checks until the codemod moves them (C05).
   */
  readonly accessDecision?: BoundAccessGate;
  readonly applicationComposition?: ActiveApplicationCompositionServiceContract;
  /**
   * The database-identity enrollment the scope install verifies against. It is owner-neutral: the
   * same enrollment serves every owner's reads, and a governed read never installs a scope the
   * connected request role has no authority for.
   */
  readonly databaseIdentities: DatabaseIdentityEnrollment;
  readonly expectedDeployment?: typeof OntosDeploymentIdentitySchema.Type;
  readonly onStage?: (stage: ReadRuntimeStage) => void;
  readonly ownerAuthorizationOverlay?: (typeof OwnerAuthorizationOverlay)['Service'];
  readonly ownerRegistration?: VerticalRuntimeRegistration;
  /**
   * Core's principal-kind reader. Only with it can a person's selected-company target be answered by the scope
   * resolution; without it every legacy target keeps its legacy relation check.
   */
  readonly principalKinds?: AccessPrincipalKinds;
  readonly shellSystemReads?: ShellSystemReadRegistrations;
}

/**
 * The primary target asks only whether the principal may act in its own selected company: a bare `legal_entity`
 * target, never an `any_of` alternative, an explicit permission or another company.
 */
const isSelectedCompanyTarget = (target: ResolvedReadPermissionTarget, scope: OperationalScope): boolean =>
  target.kind === 'legal_entity' &&
  target.permission === undefined &&
  scope.legalEntityId !== undefined &&
  (target.legalEntityId ?? scope.legalEntityId) === scope.legalEntityId;

const stableTargetKey = (value: string): boolean => value.length > 0 && value.length <= 300;
const targetLegalEntityIdIsValid = Schema.is(Schema.String.check(Schema.isUUID()));
const PermissionDecisionSchema = Schema.Literals(['allowed', 'denied', 'unavailable']);
type PermissionDecision = typeof PermissionDecisionSchema.Type;

const legalEntityTargetIsValid = (
  target: Extract<AtomicResolvedReadPermissionTarget, { readonly kind: 'legal_entity' }>,
): boolean =>
  (target.legalEntityId === undefined || targetLegalEntityIdIsValid(target.legalEntityId)) &&
  (target.permission === undefined ||
    LEGAL_ENTITY_PERMISSION_KEYS.some((permission) => permission === target.permission));

const atomicTargetIsValid = (target: AtomicResolvedReadPermissionTarget, scope?: OperationalScope): boolean => {
  if (target.kind === 'owner_permission') {
    return scope === undefined ? false : isOwnerPermissionAccessTargetValid(target.ownerPermission, scope);
  }

  if (target.kind === 'tenant') {
    return true;
  }
  if (target.kind === 'legal_entity') {
    return legalEntityTargetIsValid(target);
  }
  if (target.kind === 'module') {
    return stableTargetKey(target.moduleId);
  }
  return (
    stableTargetKey(target.resource.moduleId) &&
    stableTargetKey(target.resource.resourceId) &&
    stableTargetKey(target.resource.resourceType)
  );
};

const usesForbiddenAlternativeTenantPermission = (target: AtomicResolvedReadPermissionTarget): boolean =>
  target.kind === 'tenant' && (target.permission === 'access' || target.permission === 'impersonate');

const canonicalPermissionTarget = (target: ResolvedReadPermissionTarget): AtomicResolvedReadPermissionTarget =>
  target.kind === 'any_of' ? target.targets[0] : target;

const targetIsValid = (
  declared: 'owner_permission' | 'legal_entity' | 'module' | 'resource' | 'tenant',
  target: ResolvedReadPermissionTarget,
  scope: OperationalScope,
): boolean => {
  const canonical = canonicalPermissionTarget(target);
  if (canonical.kind !== declared || !atomicTargetIsValid(canonical, scope)) {
    return false;
  }
  if (target.kind !== 'any_of') {
    return true;
  }
  return (
    target.targets.length >= 2 &&
    target.targets.length <= 5 &&
    target.targets.every(
      (candidate) => atomicTargetIsValid(candidate, scope) && !usesForbiddenAlternativeTenantPermission(candidate),
    )
  );
};

interface ResolvedConditionalPermissionPlan {
  readonly additionalTargets: readonly AtomicResolvedReadPermissionTarget[];
  readonly permissionTarget: AtomicResolvedReadPermissionTarget;
}

const toAtomicConditionalPermissionTarget = (
  requirement: ResolvedReadConditionalPermissionRequirement,
): AtomicResolvedReadPermissionTarget =>
  requirement.kind === 'resource_read' ? { kind: 'resource', resource: requirement.resource } : requirement;

const toOwnerAuthorizationTarget = (
  target: AtomicResolvedReadPermissionTarget,
  scope: OperationalScope,
): OwnerAuthorizationTarget =>
  Match.value(target).pipe(
    Match.discriminatorsExhaustive('kind')({
      legal_entity: (legalEntityTarget) =>
        withOptionalProperty(
          {
            kind: 'legal_entity' as const,
            legalEntityId: legalEntityTarget.legalEntityId ?? scope.legalEntityId ?? '',
          },
          legalEntityTarget.permission !== undefined,
          'permission',
          legalEntityTarget.permission,
          {},
        ),
      module: (moduleTarget) =>
        withOptionalProperty(
          {
            kind: 'module' as const,
            moduleId: moduleTarget.moduleId,
          },
          scope.legalEntityId !== undefined,
          'legalEntityId',
          scope.legalEntityId,
          {},
        ),
      owner_permission: (ownerTarget) => ({
        kind: 'owner_permission' as const,
        target: ownerTarget.ownerPermission,
      }),
      resource: (resourceTarget) => ({
        kind: 'resource' as const,
        permission: 'read' as const,
        resource: resourceTarget.resource,
      }),
      tenant: (tenantTarget) => ({
        kind: 'tenant' as const,
        permission: tenantTarget.permission,
        tenantId: scope.tenantId,
      }),
    }),
  );

const resolveConditionalPermissionPlan = <Input>(
  declaration: ReadConditionalPermissionDeclaration<Input>,
  input: Input,
  scope: OperationalScope,
): Effect.Effect<ResolvedConditionalPermissionPlan, ReadHandlerExecutionError> =>
  Effect.try({
    catch: (resolverDefect) =>
      preserveFailureCause(
        new ReadHandlerExecutionError({
          code: 'read_handler_execution_failed',
          reason: 'The conditional Read permission branch could not be resolved',
        }),
        resolverDefect,
      ),
    try: () => {
      const plan = getReadConditionalPermissionPlan(declaration);
      const selected = plan.select(input);
      const branch = plan.branches[selected.kind];
      if (branch === undefined || !declaration.branchTags.includes(selected.kind)) {
        throw new Error('Unknown conditional Read permission branch');
      }
      const requirements = branch.resolve(input, selected, scope);
      if (
        requirements.length !== branch.requiredKinds.length ||
        requirements.length === 0 ||
        requirements.some((requirement, index) => {
          const declaredKind = branch.requiredKinds[index];
          if (declaredKind !== requirement.kind) {
            return true;
          }
          if (requirement.kind === 'resource_read') {
            return (
              requirement.permission !== 'read' ||
              !atomicTargetIsValid({ kind: 'resource', resource: requirement.resource }, scope)
            );
          }
          if (
            requirement.kind === 'owner_permission' &&
            (plan.ownerContract === undefined || requirement.ownerPermission.contract !== plan.ownerContract)
          ) {
            return true;
          }
          return !atomicTargetIsValid(requirement, scope);
        })
      ) {
        throw new Error('Conditional Read permission branch requirements do not match');
      }
      const [canonical, ...additional] = requirements;
      if (canonical === undefined || canonical.kind === 'resource_read') {
        throw new Error('Conditional Read permission branch requires one canonical target');
      }
      return Object.freeze({
        additionalTargets: Object.freeze(additional.map(toAtomicConditionalPermissionTarget)),
        permissionTarget: toAtomicConditionalPermissionTarget(canonical),
      });
    },
  });

/**
 * The policy/evidence metadata of one legacy permission target, named by the owner contract the
 * policy input and the evidence row share. Every branch is checked against that contract instead of
 * widening into a union of object literals whose absent keys would carry an explicit `undefined`.
 */
const targetMetadata = (target: ResolvedReadPermissionTarget, _scope: OperationalScope): ActionPolicyTarget => {
  const canonical = canonicalPermissionTarget(target);

  if (canonical.kind === 'legal_entity') {
    return canonical.legalEntityId === undefined
      ? {}
      : { targetResourceId: canonical.legalEntityId, targetResourceType: 'core.identity.legal-entity' };
  }
  if (canonical.kind === 'owner_permission') {
    return {
      targetModuleKey: canonical.ownerPermission.transportModuleKey,
      targetResourceId: canonical.ownerPermission.transportObjectId,
      targetResourceType:
        canonical.ownerPermission.transportResourceType ?? canonical.ownerPermission.contract.targetResourceType,
    };
  }
  if (canonical.kind === 'tenant') {
    return {};
  }
  if (canonical.kind === 'module') {
    return { targetModuleKey: canonical.moduleId };
  }
  return {
    targetModuleKey: canonical.resource.moduleId,
    targetResourceId: canonical.resource.resourceId,
    targetResourceType: canonical.resource.resourceType,
  };
};

const decisionFor = (
  decisions: readonly {
    readonly decision: PermissionDecision;
    readonly key: string;
  }[],
  expectedKey: string,
): PermissionDecision => {
  const [decision, ...unexpected] = decisions;
  return unexpected.length === 0 && decision?.key === expectedKey ? decision.decision : 'unavailable';
};

const checkOwnerPermissionTarget = <AccessValue extends (typeof ContextAccess)['Service']>(
  contextAccess: AccessValue,
  scope: OperationalScope,
  target: Extract<AtomicResolvedReadPermissionTarget, { readonly kind: 'owner_permission' }>,
): Effect.Effect<PermissionDecision> => {
  if (
    contextAccess.ownerPermissions === undefined ||
    !isOwnerPermissionAccessTargetValid(target.ownerPermission, scope)
  ) {
    return Effect.succeed('unavailable');
  }
  const principal = { principalId: scope.principalId, tenantId: scope.tenantId };
  const requestBase = { principal, targets: [{ target: target.ownerPermission }] };
  const requestWithEntity =
    scope.legalEntityId === undefined ? requestBase : { ...requestBase, legalEntityId: scope.legalEntityId };
  const request =
    scope.trustedStorefrontId === undefined
      ? requestWithEntity
      : { ...requestWithEntity, trustedStorefrontId: scope.trustedStorefrontId };
  return contextAccess
    .ownerPermissions(request)
    .pipe(Effect.map((decisions) => decisionFor(decisions, target.ownerPermission.key)));
};

const checkAtomicPermissionTarget = <AccessValue extends (typeof ContextAccess)['Service']>(
  contextAccess: AccessValue,
  scope: OperationalScope,
  target: AtomicResolvedReadPermissionTarget,
  allowMissingLegalEntity: boolean,
): Effect.Effect<PermissionDecision> => {
  if (target.kind === 'owner_permission') {
    return checkOwnerPermissionTarget(contextAccess, scope, target);
  }

  if (target.kind === 'tenant') {
    return contextAccess
      .tenants({
        permission: target.permission,
        principalId: scope.principalId,
        tenantIds: [scope.tenantId],
      })
      .pipe(Effect.map((decisions) => decisionFor(decisions, scope.tenantId)));
  }
  if (scope.legalEntityId === undefined && !(target.kind === 'legal_entity' && target.legalEntityId !== undefined)) {
    return Effect.succeed(allowMissingLegalEntity ? 'allowed' : 'unavailable');
  }
  const legalEntityId =
    target.kind === 'legal_entity' ? (target.legalEntityId ?? scope.legalEntityId ?? '') : (scope.legalEntityId ?? '');
  if (target.kind === 'legal_entity') {
    const decision =
      target.permission === undefined
        ? contextAccess.legalEntities({
            legalEntityIds: [legalEntityId],
            principalId: scope.principalId,
            tenantId: scope.tenantId,
          })
        : contextAccess.legalEntities({
            legalEntityIds: [legalEntityId],
            permission: target.permission,
            principalId: scope.principalId,
            tenantId: scope.tenantId,
          });
    return decision.pipe(Effect.map((decisions) => decisionFor(decisions, legalEntityId)));
  }
  if (target.kind === 'module') {
    return contextAccess
      .modules({
        legalEntityId,
        moduleIds: [target.moduleId],
        principalId: scope.principalId,
        tenantId: scope.tenantId,
      })
      .pipe(Effect.map((decisions) => decisionFor(decisions, target.moduleId)));
  }
  const expectedKey = `${target.resource.moduleId}:${target.resource.resourceType}:${target.resource.resourceId}`;
  return contextAccess
    .resources({
      legalEntityId,
      permission: 'read',
      principalId: scope.principalId,
      resources: [target.resource],
      tenantId: scope.tenantId,
    })
    .pipe(Effect.map((decisions) => decisionFor(decisions, expectedKey)));
};

const checkPermissionTarget = <AccessValue extends (typeof ContextAccess)['Service']>(
  contextAccess: AccessValue,
  scope: OperationalScope,
  target: ResolvedReadPermissionTarget,
  allowMissingLegalEntity: boolean,
): Effect.Effect<PermissionDecision> => {
  const targets = target.kind === 'any_of' ? target.targets : [target];
  const mayAuthorizeWithoutLegalEntity = allowMissingLegalEntity && target.kind !== 'any_of';
  return Effect.all(
    targets.map((candidate) =>
      checkAtomicPermissionTarget(contextAccess, scope, candidate, mayAuthorizeWithoutLegalEntity),
    ),
    { concurrency: 5 },
  ).pipe(
    Effect.map((decisions) => {
      if (decisions.includes('allowed')) {
        return 'allowed';
      }
      return decisions.includes('unavailable') ? 'unavailable' : 'denied';
    }),
  );
};

const checkEntrypointContextPermission = <AccessValue extends (typeof ContextAccess)['Service']>(
  contextAccess: AccessValue,
  scope: OperationalScope,
  descriptor: Pick<
    ReadRegistration<
      Schema.ConstraintDecoder<unknown>,
      Schema.ConstraintDecoder<unknown>,
      string,
      unknown,
      unknown
    >['descriptor'],
    'entrypoint' | 'legalEntityScope' | 'permissionTarget'
  >,
  permissionTarget: AtomicResolvedReadPermissionTarget,
  primaryDecision: PermissionDecision,
): Effect.Effect<PermissionDecision> => {
  const { entrypoint } = descriptor;
  const { authorization } = entrypoint;
  if (authorization.kind !== 'context_permission') {
    return Effect.succeed('allowed');
  }
  if (
    (authorization.permission === 'module.access' &&
      permissionTarget.kind === 'module' &&
      permissionTarget.moduleId === entrypoint.moduleKey) ||
    (permissionTarget.kind === 'owner_permission' &&
      permissionTarget.ownerPermission.definition.key === authorization.permission)
  ) {
    return Effect.succeed(primaryDecision);
  }
  // Optional tenant-owned Reads keep their module gate at tenant scope. A real
  // context permission is required; absent Legal Entity never implies a grant.
  const tenantModulePermission =
    entrypoint.scope === 'tenant' &&
    descriptor.legalEntityScope === 'optional' &&
    descriptor.permissionTarget === 'tenant' &&
    permissionTarget.kind === 'tenant' &&
    scope.legalEntityId === undefined;
  if (authorization.permission === 'module.access' && !tenantModulePermission) {
    return checkAtomicPermissionTarget(
      contextAccess,
      scope,
      { kind: 'module', moduleId: entrypoint.moduleKey },
      entrypoint.scope === 'system',
    );
  }
  if (contextAccess.contextPermissions === undefined) {
    return Effect.succeed('unavailable');
  }
  const target = {
    moduleId: entrypoint.moduleKey,
    permission: authorization.permission,
  };
  const request =
    scope.legalEntityId === undefined
      ? {
          principalId: scope.principalId,
          targets: [target],
          tenantId: scope.tenantId,
        }
      : {
          legalEntityId: scope.legalEntityId,
          principalId: scope.principalId,
          targets: [target],
          tenantId: scope.tenantId,
        };
  return contextAccess
    .contextPermissions(request)
    .pipe(Effect.map((decisions) => decisionFor(decisions, toContextPermissionAccessKey(target))));
};

const sanitizeReadHandlerFailure = <DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }>>(
  domainErrorSchema: DomainErrorSchema | undefined,
  failure: unknown,
):
  | DomainErrorSchema['Type']
  | ReadHandlerExecutionError
  | ReadHandlerNotFound
  | ReadHandlerUnavailable
  | ReadPermissionDenied => {
  if (
    Schema.is(ReadHandlerUnavailable)(failure) ||
    Schema.is(ReadHandlerNotFound)(failure) ||
    Schema.is(ReadPermissionDenied)(failure)
  ) {
    return failure;
  }
  if (domainErrorSchema !== undefined) {
    const decoded = Schema.decodeUnknownOption(domainErrorSchema)(failure);
    if (Option.isSome(decoded)) {
      return decoded.value;
    }
  }
  return new ReadHandlerExecutionError({
    code: 'read_handler_execution_failed',
    reason: 'The read handler failed unexpectedly',
  });
};

const preserveFailureCause = <Failure extends object>(failure: Failure, cause: unknown): Failure =>
  Object.defineProperty(failure, 'cause', {
    configurable: false,
    enumerable: false,
    value: cause,
    writable: false,
  });

const mapReadTransactionSqlFailure = (failure: SqlError): ReadHandlerExecutionError | ReadHandlerUnavailable =>
  preserveFailureCause(
    Schema.is(ConnectionError)(failure.reason)
      ? new ReadHandlerUnavailable({
          code: 'read_handler_unavailable',
          reason: 'The governed read database connection is temporarily unavailable',
        })
      : new ReadHandlerExecutionError({
          code: 'read_handler_execution_failed',
          reason: 'The governed read transaction failed',
        }),
    failure,
  );

/**
 * Effect promotes a transaction body's typed failure to a defect when SQL settlement also defects.
 * Recover the settlement SqlError only when every other defect is one of this body's own captured
 * failures, so an outage keeps its connection classification. Other defects and interruption stay.
 */
const makeReadSettlementRecovery = () => {
  const bodyFailures = new Set<unknown>();
  return {
    capture: <A, E, R>(body: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      body.pipe(
        Effect.tapCause((cause) =>
          Effect.sync(() => {
            for (const reason of cause.reasons) {
              if (Cause.isFailReason(reason)) {
                bodyFailures.add(reason.error);
              }
            }
          }),
        ),
      ),
    recover: <A, E, R>(transaction: Effect.Effect<A, E, R>): Effect.Effect<A, E | SqlError, R> =>
      transaction.pipe(
        Effect.catchCause((cause): Effect.Effect<never, E | SqlError> => {
          let settlement: SqlError | undefined;
          for (const reason of cause.reasons) {
            if (Cause.isInterruptReason(reason)) {
              return Effect.failCause(cause);
            }
            if (Cause.isDieReason(reason)) {
              if (isSqlError(reason.defect)) {
                settlement = reason.defect;
              } else if (!bodyFailures.has(reason.defect)) {
                return Effect.failCause(cause);
              }
            }
          }
          return settlement === undefined ? Effect.failCause(cause) : Effect.fail(settlement);
        }),
      ),
  };
};

type ReadEvidenceCaptureMode = ReadRegistration<
  Schema.ConstraintDecoder<unknown>,
  Schema.ConstraintDecoder<unknown>,
  string,
  unknown,
  unknown
>['descriptor']['evidencePolicy']['captureMode'];

/* oxlint-disable effect-native/no-nullable-service-outcome -- This private helper uses undefined as the intentional no-hash sentinel when the read evidence capture mode does not request hashing. */
const computeReadQueryHash = (
  captureMode: ReadEvidenceCaptureMode,
  decodedInput: unknown,
): Effect.Effect<string | undefined, ReadInputValidationError> =>
  captureMode === 'hash_only'
    ? Effect.try({
        catch: (normalizationDefect) =>
          preserveFailureCause(
            new ReadInputValidationError({
              code: 'read_input_invalid',
              reason: 'The read input cannot be normalized safely',
            }),
            normalizationDefect,
          ),
        try: () => computeCanonicalValueHash(decodedInput),
      })
    : Effect.void.pipe(
        // oxlint-disable-next-line unicorn/no-useless-undefined -- Effect.as requires the explicit optional hash value.
        Effect.as(undefined),
      );
/* oxlint-enable effect-native/no-nullable-service-outcome */

const resolveReadPermissionTarget = Effect.fn('Runtime.resolveReadPermissionTarget')(
  function* resolveReadPermissionTargetEffect<
    InputSchema extends Schema.ConstraintDecoder<unknown>,
    ResultSchema extends Schema.ConstraintDecoder<unknown>,
    Owner extends string,
    Services,
    HandlerError,
    Requirements,
    DomainErrorSchema extends Schema.ConstraintDecoder<{
      readonly _tag: string;
    }>,
  >(
    registration: ReadRegistration<
      InputSchema,
      ResultSchema,
      Owner,
      Services,
      HandlerError,
      Requirements,
      DomainErrorSchema
    >,
    decodedInput: InputSchema['Type'],
    scope: OperationalScope,
  ) {
    const permissionResolver = getReadPermissionTargetResolver(registration);
    const declaredPermissionTarget = registration.descriptor.permissionTarget;
    if (declaredPermissionTarget === undefined) {
      return yield* new ReadHandlerExecutionError({
        code: 'read_handler_execution_failed',
        reason: 'The legacy Read permission target is unavailable',
      });
    }
    let permissionTarget: ResolvedReadPermissionTarget;
    let conditionalAdditionalTargets: readonly AtomicResolvedReadPermissionTarget[] = [];
    if (declaredPermissionTarget === 'conditional') {
      if (permissionResolver === undefined || Predicate.isFunction(permissionResolver)) {
        return yield* new ReadHandlerExecutionError({
          code: 'read_handler_execution_failed',
          reason: 'The conditional Read permission declaration is unavailable',
        });
      }
      const conditional = yield* resolveConditionalPermissionPlan(permissionResolver, decodedInput, scope);
      ({ additionalTargets: conditionalAdditionalTargets, permissionTarget } = conditional);
    } else {
      if (!Predicate.isFunction(permissionResolver)) {
        return yield* new ReadHandlerExecutionError({
          code: 'read_handler_execution_failed',
          reason: 'The declared read permission target resolver is unavailable',
        });
      }
      permissionTarget = yield* Effect.try({
        catch: (resolverDefect) =>
          Schema.is(ReadPermissionUnavailable)(resolverDefect)
            ? resolverDefect
            : preserveFailureCause(
                new ReadHandlerExecutionError({
                  code: 'read_handler_execution_failed',
                  reason: 'The declared read permission target could not be resolved',
                }),
                resolverDefect,
              ),
        try: () => permissionResolver(decodedInput, scope),
      });
      if (
        !targetIsValid(declaredPermissionTarget, permissionTarget, scope) ||
        (getReadResultPermissionTargetResolver(registration) !== undefined && permissionTarget.kind === 'any_of')
      ) {
        if (permissionTarget.kind === 'owner_permission') {
          return yield* new ReadPermissionUnavailable({
            code: 'read_permission_unavailable',
            reason: 'The owner permission target cannot be verified in the trusted scope',
          });
        }
        return yield* new ReadHandlerExecutionError({
          code: 'read_handler_execution_failed',
          reason: 'The declared read permission target is invalid',
        });
      }
    }
    return { conditionalAdditionalTargets, permissionTarget };
  },
);

const resolveReadResourcePermissionTarget = <Input>(
  input: Input,
  scope: OperationalScope,
  resolver: ((input: Input, scope: OperationalScope) => ReadResourcePermissionTarget) | undefined,
): Effect.Effect<Option.Option<ReadResourcePermissionTarget>, ReadHandlerExecutionError> => {
  if (resolver === undefined) {
    return Effect.succeed(Option.none<ReadResourcePermissionTarget>());
  }
  return Effect.try({
    catch: (resolverDefect) =>
      preserveFailureCause(
        new ReadHandlerExecutionError({
          code: 'read_handler_execution_failed',
          reason: 'The declared Read Resource permission target could not be resolved',
        }),
        resolverDefect,
      ),
    try: () => resolver(input, scope),
  }).pipe(
    Effect.filterOrFail(
      (target) =>
        target.permission === 'read' &&
        stableTargetKey(target.resource.moduleId) &&
        stableTargetKey(target.resource.resourceId) &&
        stableTargetKey(target.resource.resourceType),
      () =>
        new ReadHandlerExecutionError({
          code: 'read_handler_execution_failed',
          reason: 'The declared Read Resource permission target is invalid',
        }),
    ),
    Effect.map((target) =>
      Option.some(
        Object.freeze({
          permission: target.permission,
          resource: Object.freeze({ ...target.resource }),
        }),
      ),
    ),
  );
};

const checkTenantResultPermission = Effect.fnUntraced(function* checkTenantResultPermission<
  AccessValue extends (typeof ContextAccess)['Service'],
>(
  contextAccess: AccessValue,
  scope: OperationalScope,
  permissionTarget: Extract<ResolvedReadPermissionTarget, { kind: 'tenant' }>,
) {
  const decisions = yield* contextAccess.tenants({
    permission: permissionTarget.permission,
    principalId: scope.principalId,
    tenantIds: [scope.tenantId],
  });
  const decision = decisionFor(decisions, scope.tenantId);
  if (decision === 'unavailable') {
    return yield* new ReadPermissionUnavailable({
      code: 'read_permission_unavailable',
      reason: 'Read result authorization is temporarily unavailable',
    });
  }
  if (decision === 'denied') {
    return yield* new ReadPermissionDenied({
      code: 'read_permission_denied',
      reason: 'The read result contains a forbidden resource',
    });
  }
  return yield* Effect.void;
});

const checkResultPermissions = Effect.fn('ReadRuntime.checkResultPermissions')(function* checkResultPermissionsEffect<
  Result,
  AccessValue extends (typeof ContextAccess)['Service'],
>(
  contextAccess: AccessValue,
  result: Result,
  scope: OperationalScope,
  permissionTarget: ResolvedReadPermissionTarget,
  resolver: (
    result: Result,
    scope: OperationalScope,
  ) => readonly {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
  }[],
) {
  const resultTargets = yield* Effect.try({
    catch: (resolverDefect) =>
      preserveFailureCause(
        new ReadHandlerExecutionError({
          code: 'read_handler_execution_failed',
          reason: 'The read result permission targets are invalid',
        }),
        resolverDefect,
      ),
    try: () => resolver(result, scope),
  });
  if (
    resultTargets.some(
      (target) =>
        !stableTargetKey(target.moduleId) ||
        !stableTargetKey(target.resourceId) ||
        !stableTargetKey(target.resourceType),
    )
  ) {
    return yield* new ReadHandlerExecutionError({
      code: 'read_handler_execution_failed',
      reason: 'The read result permission targets are invalid',
    });
  }
  if (resultTargets.length === 0) {
    return yield* Effect.void;
  }
  if (permissionTarget.kind === 'tenant') {
    return yield* checkTenantResultPermission(contextAccess, scope, permissionTarget);
  }
  if (permissionTarget.kind === 'owner_permission') {
    return yield* new ReadHandlerExecutionError({
      code: 'read_handler_execution_failed',
      reason: 'Policy-permission reads must not use generic result resource filtering',
    });
  }
  if (scope.legalEntityId === undefined) {
    return yield* new ReadHandlerExecutionError({
      code: 'read_handler_execution_failed',
      reason: 'The read result permission targets are invalid',
    });
  }
  const decisions = yield* contextAccess.resources({
    legalEntityId: scope.legalEntityId,
    principalId: scope.principalId,
    resources: resultTargets,
    tenantId: scope.tenantId,
  });
  const malformed =
    decisions.length !== resultTargets.length ||
    decisions.some(({ key }, index) => {
      const target = resultTargets[index];
      return target === undefined || key !== `${target.moduleId}:${target.resourceType}:${target.resourceId}`;
    });
  if (malformed || decisions.some(({ decision }) => decision === 'unavailable')) {
    return yield* new ReadPermissionUnavailable({
      code: 'read_permission_unavailable',
      reason: 'Read result authorization is temporarily unavailable',
    });
  }
  if (decisions.some(({ decision }) => decision === 'denied')) {
    return yield* new ReadPermissionDenied({
      code: 'read_permission_denied',
      reason: 'The read result contains a forbidden resource',
    });
  }
  return yield* Effect.void;
});

/**
 * The record target of a record-scoped read, resolved from the declaration's own resolver (O9, O27).
 * A malformed target is a Core authoring defect, so it is a retryable unavailability, never an allow.
 */
const ReadAccessRecordTargetSchema = Schema.Struct({ moduleKey: ModuleKeySchema, recordKey: RecordKeySchema });
const decodeReadAccessRecordTarget = Schema.decodeUnknownOption(ReadAccessRecordTargetSchema);

const resolveReadAccessTarget = <Input>(
  input: Input,
  scope: OperationalScope,
  resolver: ((input: Input, scope: OperationalScope) => AccessTarget) | undefined,
): Effect.Effect<Option.Option<AccessRecordTarget>, ReadPermissionUnavailable> => {
  if (resolver === undefined) {
    return Effect.succeed(Option.none<AccessRecordTarget>());
  }
  return Effect.try({
    catch: (cause) =>
      preserveFailureCause(
        new ReadPermissionUnavailable({
          code: 'read_permission_unavailable',
          reason: 'The declared read access target could not be resolved safely',
        }),
        cause,
      ),
    try: () => resolver(input, scope),
  }).pipe(
    Effect.flatMap((declared) => {
      const decoded = decodeReadAccessRecordTarget(declared);
      return Option.isNone(decoded)
        ? Effect.fail(
            new ReadPermissionUnavailable({
              code: 'read_permission_unavailable',
              reason: 'The declared read access target is invalid',
            }),
          )
        : Effect.succeed(Option.some(decoded.value));
    }),
  );
};

/** The evidence/policy metadata of a v2 record target; a scope-wide read names no record (Q2). */
const accessTargetMetadata = (
  declaration: AccessDeclaration | undefined,
  target: Option.Option<AccessRecordTarget>,
): Readonly<Record<string, string>> =>
  Option.isNone(target)
    ? {}
    : {
        targetModuleKey: target.value.moduleKey,
        targetResourceId: target.value.recordKey,
        targetResourceType: declaration?.key ?? target.value.moduleKey,
      };

/** Reads that answer one row per query: their rows are filtered by the gate's list predicate (O25). */
const ROW_SCOPED_READ_ACCESS_KINDS: ReadonlySet<string> = new Set(['list', 'report', 'search']);

/**
 * The owner-local facts of a governed read (O70): a flat string map naming the owner records the
 * owner's own business rule is about. They are resolved from the decoded input before the decision,
 * handed to the owner overlay only, and never reach the decision engine. An empty map is no facts,
 * and a defect or a non-string fact is a retryable 503, never an allow.
 */
const OwnerAccessFactsSchema = Schema.Record(Schema.String, Schema.String);
const decodeOwnerAccessFacts = Schema.decodeUnknownOption(OwnerAccessFactsSchema);

const resolveReadOwnerFacts = <Input>(
  input: Input,
  scope: OperationalScope,
  resolver: ((input: Input, scope: OperationalScope) => OwnerAccessFacts) | undefined,
): Effect.Effect<Option.Option<OwnerAccessFacts>, ReadPermissionUnavailable> => {
  if (resolver === undefined) {
    return Effect.succeed(Option.none<OwnerAccessFacts>());
  }
  return Effect.try({
    catch: (cause) =>
      preserveFailureCause(
        new ReadPermissionUnavailable({
          code: 'read_permission_unavailable',
          reason: 'The owner-local facts of this read could not be resolved safely',
        }),
        cause,
      ),
    try: () => resolver(input, scope),
  }).pipe(
    Effect.flatMap((declared) => {
      const decoded = decodeOwnerAccessFacts(declared);
      return Option.isNone(decoded)
        ? Effect.fail(
            new ReadPermissionUnavailable({
              code: 'read_permission_unavailable',
              reason: 'The owner-local facts of this read are invalid',
            }),
          )
        : Effect.succeed(Option.some(decoded.value));
    }),
  );
};

const NO_OWNER_AUTHORIZATION_TARGETS: readonly OwnerAuthorizationTarget[] = Object.freeze([]);
const NO_PERMISSION_DECISIONS: readonly PermissionDecision[] = Object.freeze([]);
const NO_ACCESS_FIELD_GROUPS: readonly AccessFieldGroup[] = Object.freeze([]);
/** No declared result path is projected out; one shared empty list, never a fresh mutable array. */
const NO_FIELD_PATHS: readonly (readonly string[])[] = Object.freeze([]);

/**
 * What the access gate answered for one read (CUTOVER-PLAN §3.1): the decision, the row predicate a
 * list hands to its owner (O25) and the declared result paths this caller may not see (O17).
 */
interface ReadGateAuthorization {
  readonly decision: PermissionDecision;
  /** The declared result paths this caller may not see; empty when every field group is granted. */
  readonly deniedFieldPaths: readonly (readonly string[])[];
  /** Present exactly for a row-scoped read; the owner applies it inside its own query (D16, O25). */
  readonly listAccess?: ListAccessPredicate;
}

/** A composition without the gate, and an unavailable gate, answer the same retryable 503 (O62). */
const UNAVAILABLE_GATE_AUTHORIZATION: ReadGateAuthorization = Object.freeze({
  decision: 'unavailable',
  deniedFieldPaths: NO_FIELD_PATHS,
});

/** A read still on a legacy kind is not decided here, so it receives no predicate and no projection. */
const LEGACY_GATE_AUTHORIZATION: ReadGateAuthorization = Object.freeze({
  decision: 'allowed',
  deniedFieldPaths: NO_FIELD_PATHS,
});

/**
 * The parent read of one declared field group (D14, O58, O74). A record-scoped read names the one
 * record it returns; a scope-wide read names none, because its own capability is the parent read,
 * decided scope-wide in this same scope.
 */
const parentReadOf = (
  readTarget: Option.Option<AccessRecordTarget>,
  parent: AccessDeclaration,
): ParentReadRequirement | undefined => {
  const capability = capabilityPolicyOf(parent);
  if (Option.isSome(readTarget)) {
    return { capability, target: readTarget.value };
  }
  return parent.selectors.length === 0 ? { capability } : undefined;
};

/** The legacy targets and metadata of a read still on a legacy kind; removed with those kinds (C03b). */
interface LegacyReadAuthorization {
  readonly conditionalAdditionalTargets: readonly AtomicResolvedReadPermissionTarget[];
  readonly ownerAuthorizationTargets: readonly OwnerAuthorizationTarget[];
  readonly permissionTarget: ResolvedReadPermissionTarget;
  readonly permissionTargetMetadata: ActionPolicyTarget;
  readonly resourcePermissionTarget: Option.Option<ReadResourcePermissionTarget>;
}

const unavailableReadComposition = (cause?: unknown) =>
  preserveFailureCause(
    new ReadHandlerUnavailable({
      code: 'read_handler_unavailable',
      reason: 'The receiving owner release is not approved by the active Application Composition',
    }),
    cause,
  );

const fenceReadRevision = Effect.fn('ReadRuntime.fenceNativeRevision')(function* fenceNativeRevision(
  transaction: CoreTransaction,
  inboundRevision: string | undefined,
  admittedRevision: string | undefined,
) {
  if (inboundRevision !== undefined && admittedRevision !== undefined && inboundRevision !== admittedRevision) {
    return yield* unavailableReadComposition();
  }
  const revision = admittedRevision ?? inboundRevision;
  if (revision !== undefined) {
    yield* lockApplicationCompositionAuthority(transaction, revision, 'read').pipe(
      Effect.mapError(unavailableReadComposition),
    );
  }
  return yield* Effect.void;
});

const readEvidenceFailure = (cause: unknown) =>
  preserveFailureCause(
    new ReadEvidencePersistenceError({
      code: 'read_evidence_persistence_failed',
      reason: 'Required read evidence could not be persisted',
    }),
    cause,
  );

/** Revalidate after remote finish and hold the publication fence through the separate evidence commit. */
const persistReadEvidenceForComposition = (
  executor: CoreDbExecutor,
  input: PersistReadEvidenceInput,
  enrollment: DatabaseIdentityEnrollment,
  revision: string | undefined,
) => {
  if (revision === undefined) {
    return persistScopedReadEvidence(executor, input, enrollment);
  }
  return executor
    .transaction((transaction) =>
      fenceReadRevision(transaction, revision, revision).pipe(
        Effect.andThen(() => installOperationalScope(transaction, input.scope, enrollment)),
        Effect.andThen(() => persistReadEvidence(transaction, input)),
        insideDatabaseTransaction(input.readKey),
      ),
    )
    .pipe(
      recoverSqlTransactionError,
      Effect.catchTags({
        OperationContextUnavailable: (cause) => Effect.fail(readEvidenceFailure(cause)),
        SqlError: (cause) => Effect.fail(readEvidenceFailure(cause)),
      }),
    );
};

const readRuntimeFromDependencies = <
  DatabaseValue extends (typeof CoreDatabase)['Service'],
  GatewayValue extends ModuleEntrypointGatewayService,
  ScopeValue extends OperationalScopeResolverService,
  AccessValue extends (typeof ContextAccess)['Service'],
>(
  database: DatabaseValue,
  gateway: GatewayValue,
  scopeResolver: ScopeValue,
  contextAccess: AccessValue,
  // oxlint-disable-next-line effect-native/no-dependency-parameters -- Runtime construction keeps the owner seams injectable for Core unit and integration harnesses.
  options: ReadRuntimeOptions,
) => {
  const shellSystemReads = captureShellSystemReadRegistrations(options.shellSystemReads);
  const withReadExecution: typeof withModuleOperationExecution = (input, effect) =>
    isBoundShellSystemRead(input.registration, shellSystemReads)
      ? withoutModuleOperationExecution(effect)
      : withModuleOperationExecution(input, effect);
  const operationAuthority = options.expectedDeployment === undefined ? undefined : options.applicationComposition;
  const stage = (value: ReadRuntimeStage): void => options.onStage?.(value);
  const ownerAuthorizationOverlay = options.ownerAuthorizationOverlay ?? failClosedOwnerAuthorizationOverlay;
  const { accessDecision } = options;

  const runReadBoundary = Effect.fn('ReadRuntime.runRead')(function* runReadEffect<
    InputSchema extends Schema.ConstraintDecoder<unknown>,
    ResultSchema extends Schema.ConstraintDecoder<unknown>,
    Owner extends string,
    Services,
    HandlerError,
    Requirements,
    DomainErrorSchema extends Schema.ConstraintDecoder<{
      readonly _tag: string;
    }>,
  >(input: {
    /** Trusted receiving deployment audience for per-operation admission. */
    readonly audience?: string;
    readonly input: unknown;
    readonly principal: unknown;
    readonly registration: ReadRegistration<
      InputSchema,
      ResultSchema,
      Owner,
      Services,
      HandlerError,
      Requirements,
      DomainErrorSchema
    >;
    readonly transport: unknown;
  }): Effect.fn.Return<ResultSchema['Type'], ReadCoreError | DomainErrorSchema['Type'], Requirements> {
    if (!isReadRegistration(input.registration)) {
      return yield* new ReadHandlerUnavailable({
        code: 'read_handler_unavailable',
        reason: 'The Read registration is unavailable',
      });
    }
    const decodedInput = yield* Schema.decodeUnknownEffect(input.registration.descriptor.inputSchema, {
      onExcessProperty: 'error',
    })(input.input).pipe(
      Effect.mapError((parseIssue) =>
        preserveFailureCause(
          new ReadInputValidationError({
            code: 'read_input_invalid',
            reason: 'The read input does not match its declared schema',
          }),
          parseIssue,
        ),
      ),
    );
    const queryHash = yield* computeReadQueryHash(
      input.registration.descriptor.evidencePolicy.captureMode,
      decodedInput,
    );
    // oxlint-disable-next-line effect-native/no-sequential-independent-yields -- Preserve deterministic validation failure ordering: query normalization must fail before trusted-principal decoding.
    const principal = yield* decodeTrustedPrincipalContext(input.principal).pipe(
      Effect.filterOrFail(
        (context) => !isTrustedSupportRecoveryPrincipalContext(context),
        () =>
          new ReadInputValidationError({
            code: 'read_input_invalid',
            reason: 'Support recovery context is not valid for Reads',
          }),
      ),
      Effect.mapError((principalFailure) =>
        preserveFailureCause(
          new ReadInputValidationError({
            code: 'read_input_invalid',
            reason: 'The trusted read identity is invalid',
          }),
          principalFailure,
        ),
      ),
    );
    const compositionRevision = readVerifiedGatewayCompositionRevision(principal);
    const transport = yield* Schema.decodeUnknownEffect(ReadTransportSchema)(input.transport).pipe(
      Effect.mapError((parseIssue) =>
        preserveFailureCause(
          new ReadInputValidationError({
            code: 'read_input_invalid',
            reason: 'The read transport metadata is invalid',
          }),
          parseIssue,
        ),
      ),
    );
    stage('input_decoded');
    const { descriptor } = input.registration;
    const usesAccessGate = descriptor.entrypoint.authorization.kind === 'protected';
    /**
     * The registered, decoded carriers of this read: definition time already decoded, validated and
     * froze them, so no request decodes them again (O5, O58, O59, O72). A protected read without any
     * carrier is answered by the gate's own `deny.declaration_missing`, never by an implicit allow
     * (O62).
     */
    // An absent carrier stays absent, so the gate sees exactly what the descriptor declares (O59, D5).
    const accessCarrier: GateInput['carrier'] = withOptional(
      withOptional(
        withOptional({}, 'accessDeclaration', descriptor.accessDeclaration),
        'accessWorkload',
        descriptor.accessWorkload,
      ),
      'accessActor',
      descriptor.accessActor,
    );
    /**
     * A field group is always decided on rights (D6, O17). An `identity` read admits its relayed subject
     * before any grant is read, so its groups keep the read's callers but decide the subject's own grants
     * for the field capability. A workload subject holds no field grant, so the groups name no workload
     * subject and its governed fields are projected out, whichever mode admitted it to the read.
     */
    const fieldGroupActor =
      descriptor.accessActor === undefined
        ? undefined
        : Object.freeze({
            callers: descriptor.accessActor.callers,
            reason: descriptor.accessActor.reason,
            subject: 'rights' as const,
          });

    /** The legacy resolution of a read still on a legacy kind; removed with those kinds (C03b). */
    const prepareLegacyReadAuthorization = Effect.fn('ReadRuntime.prepareLegacyReadAuthorization')(
      function* prepareLegacyReadAuthorizationEffect(
        legacyInput: InputSchema['Type'],
        scope: OperationalScope,
      ): Effect.fn.Return<LegacyReadAuthorization, ReadCoreError> {
        const { conditionalAdditionalTargets, permissionTarget } = yield* resolveReadPermissionTarget(
          input.registration,
          legacyInput,
          scope,
        );
        // oxlint-disable-next-line effect-native/no-sequential-independent-yields -- Preserve primary-before-resource resolver execution because owner callbacks may throw or observe mutable state.
        const resourcePermissionTarget = yield* resolveReadResourcePermissionTarget(
          legacyInput,
          scope,
          getReadResourcePermissionTargetResolver(input.registration),
        );
        const ownerAuthorizationTargets: readonly OwnerAuthorizationTarget[] = Object.freeze([
          ...(permissionTarget.kind === 'any_of' ? permissionTarget.targets : [permissionTarget]).map((target) =>
            toOwnerAuthorizationTarget(target, scope),
          ),
          ...conditionalAdditionalTargets.map((target) => toOwnerAuthorizationTarget(target, scope)),
          ...(Option.isNone(resourcePermissionTarget)
            ? []
            : [
                {
                  kind: 'resource' as const,
                  permission: 'read' as const,
                  resource: resourcePermissionTarget.value.resource,
                },
              ]),
        ]);
        return Object.freeze({
          conditionalAdditionalTargets,
          ownerAuthorizationTargets,
          permissionTarget,
          permissionTargetMetadata: targetMetadata(permissionTarget, scope),
          resourcePermissionTarget,
        });
      },
    );

    /**
     * The one v2 authorization question this read asks (CUTOVER-PLAN §3.1): a single-record read is
     * decided with its record target, a list, report or search read is decided as a list whose
     * predicate the owner applies inside its own query (O25), and the field groups this caller lacks
     * are projected out of the result (D14, O58, O17).
     * The gate owns its scoped reads and decision evidence; no owner transaction is held over its
     * network calls. Owner SQL and final disclosure reacquire the composition fence independently.
     */
    const authorizeThroughGate = Effect.fn('ReadRuntime.authorizeThroughGate')(function* authorizeThroughGateEffect(
      readScope: OperationalScope,
      readTarget: Option.Option<AccessRecordTarget>,
    ): Effect.fn.Return<ReadGateAuthorization, ReadPermissionUnavailable> {
      if (accessDecision === undefined) {
        return UNAVAILABLE_GATE_AUTHORIZATION;
      }
      const now = yield* DateTime.nowAsDate;
      const question = withOptionalProperty(
        {
          carrier: accessCarrier,
          legalEntityScope: descriptor.legalEntityScope,
          now,
          scope: readScope,
        },
        Option.isSome(readTarget),
        'target',
        Option.getOrUndefined(readTarget),
        {},
      );
      const rowScoped = ROW_SCOPED_READ_ACCESS_KINDS.has(descriptor.accessKind);
      const listing: ListAccessResolution | undefined = rowScoped ? yield* accessDecision.list(question) : undefined;
      const decision: AccessDecision =
        listing === undefined ? yield* accessDecision.decide(question) : listing.decision;
      // A read is never proposable, so only an ALLOWED decision may read (O45).
      if (decision.outcome !== 'ALLOWED') {
        return decision.outcome === 'UNAVAILABLE'
          ? UNAVAILABLE_GATE_AUTHORIZATION
          : { decision: 'denied', deniedFieldPaths: NO_FIELD_PATHS };
      }
      const listAccess = listing?.predicate;
      if (rowScoped && listAccess === undefined) {
        // A list answer without a predicate describes no matching row, so it never widens into an
        // unfiltered read of the scope (B1, D16, O25).
        return { decision: 'denied', deniedFieldPaths: NO_FIELD_PATHS };
      }
      const deniedFieldPaths = yield* decideReadFieldPaths(now, readScope, readTarget);
      return withOptionalProperty(
        { decision: 'allowed' as const, deniedFieldPaths },
        listAccess !== undefined,
        'listAccess',
        listAccess,
        {},
      );
    });

    /**
     * The declared result paths this caller may not read (O17). Field access rides the parent read it
     * belongs to (D14, O58, O74): a record-scoped read decides each group with the record it returns
     * and that record's own parent read; a scope-wide read has no record, so its groups ride the
     * read's own capability decided scope-wide in this same scope; and a row-scoped read applies that
     * same scope-wide shape with its row filter bounding the rows they apply to (O25).
     */
    const decideReadFieldPaths = Effect.fn('ReadRuntime.decideReadFieldPaths')(function* decideReadFieldPathsEffect(
      decidedAt: Date,
      readScope: OperationalScope,
      readTarget: Option.Option<AccessRecordTarget>,
    ): Effect.fn.Return<readonly (readonly string[])[], ReadPermissionUnavailable> {
      const groups = descriptor.accessFieldGroups ?? NO_ACCESS_FIELD_GROUPS;
      const parent = descriptor.accessDeclaration;
      if (groups.length === 0) {
        return NO_FIELD_PATHS;
      }
      if (accessDecision === undefined || parent === undefined) {
        // Definition time refuses a field group without its parent declaration (O58); a registration
        // that lost one is a Core defect, so the read answers a retryable 503, never a projection.
        return yield* new ReadPermissionUnavailable({
          code: 'read_permission_unavailable',
          reason: 'The declared read field groups could not be decided',
        });
      }
      const rowScoped = ROW_SCOPED_READ_ACCESS_KINDS.has(descriptor.accessKind);
      const parentRead = parentReadOf(readTarget, parent);
      const answers = yield* Effect.forEach(
        groups,
        (group) => {
          // A group rides its read's caller contract: a relayed or workload caller the read admits is
          // decided on the group, not refused for a carrier that names no actor (D6).
          const carrier = withOptional({ ...accessCarrier, accessDeclaration: group }, 'accessActor', fieldGroupActor);
          return rowScoped
            ? accessDecision
                .list({ carrier, legalEntityScope: descriptor.legalEntityScope, now: decidedAt, scope: readScope })
                .pipe(Effect.map((listing) => listing.decision))
            : accessDecision.decide(
                withOptionalProperty(
                  withOptionalProperty(
                    {
                      carrier,
                      legalEntityScope: descriptor.legalEntityScope,
                      now: decidedAt,
                      scope: readScope,
                    },
                    parentRead !== undefined,
                    'parentRead',
                    parentRead,
                    {},
                  ),
                  Option.isSome(readTarget),
                  'target',
                  Option.getOrUndefined(readTarget),
                  {},
                ),
              );
        },
        { concurrency: 1 },
      );
      const unavailable = answers.some((answer) => answer.outcome === 'UNAVAILABLE');
      if (unavailable) {
        // An unreadable field decision is retryable, never a silent projection (O48b).
        return yield* new ReadPermissionUnavailable({
          code: 'read_permission_unavailable',
          reason: 'Read field authorization is temporarily unavailable',
        });
      }
      return groups.flatMap((group, index) =>
        answers[index]?.outcome === 'ALLOWED' ? [] : group.fields.map((field) => field.split('.')),
      );
    });

    /** Transitional: the legacy checks of a read still on a legacy kind; removed with those kinds (C03b). */
    /**
     * A person's selected-company access is the scope resolution's own gate question (O28): this read resolved its
     * scope, and resolution refuses every company the person may not select. A v2 person holds no tuple of the
     * retired `legal_entity#access` relation, so it is not asked for them. Only a principal Core reads as human is
     * answered here; a workload, an agent or an unreadable kind keeps the legacy relation check.
     */
    const isPersonInSelectedCompany = Effect.fn('ReadRuntime.isPersonInSelectedCompany')(
      function* isPersonInSelectedCompanyEffect(target: ResolvedReadPermissionTarget, readScope: OperationalScope) {
        if (options.principalKinds === undefined || !isSelectedCompanyTarget(target, readScope)) {
          return false;
        }
        const kind = yield* options.principalKinds
          .readKind({
            principalId: PrincipalIdSchema.make(readScope.principalId),
            scope: readScope,
            tenantId: TenantIdSchema.make(readScope.tenantId),
          })
          .pipe(Effect.option);
        return Option.contains(Option.flatten(kind), 'human');
      },
    );

    const checkLegacyReadAuthorization = Effect.fn('ReadRuntime.checkLegacyReadAuthorization')(
      function* checkLegacyReadAuthorizationEffect(legacy: LegacyReadAuthorization, readScope: OperationalScope) {
        const permissionDecision = (yield* isPersonInSelectedCompany(legacy.permissionTarget, readScope))
          ? 'allowed'
          : yield* checkPermissionTarget(
              contextAccess,
              readScope,
              legacy.permissionTarget,
              input.registration.descriptor.legalEntityScope === 'forbidden',
            );
        const resourcePermissionDecision: PermissionDecision = Option.isSome(legacy.resourcePermissionTarget)
          ? yield* checkAtomicPermissionTarget(
              contextAccess,
              readScope,
              { kind: 'resource', resource: legacy.resourcePermissionTarget.value.resource },
              false,
            )
          : 'allowed';
        const conditionalAdditionalDecisions = yield* Effect.forEach(
          legacy.conditionalAdditionalTargets,
          (target) => checkAtomicPermissionTarget(contextAccess, readScope, target, false),
          { concurrency: 3 },
        );
        const entrypointPermissionDecision = yield* checkEntrypointContextPermission(
          contextAccess,
          readScope,
          input.registration.descriptor,
          canonicalPermissionTarget(legacy.permissionTarget),
          permissionDecision,
        );
        return [
          permissionDecision,
          resourcePermissionDecision,
          ...conditionalAdditionalDecisions,
          entrypointPermissionDecision,
        ];
      },
    );

    /** The receiving owner release must be the one the active Application Composition admits. */
    const admitReadComposition = Effect.fn('ReadRuntime.admitReadComposition')(function* admitReadCompositionEffect(
      earlyCompositionRevision: string | undefined,
    ) {
      const admission =
        options.applicationComposition !== undefined && options.expectedDeployment !== undefined
          ? yield* loadModuleOperationAdmission(
              options.applicationComposition,
              options.expectedDeployment,
              input.registration,
              principal,
              options.ownerRegistration,
              shellSystemReads,
            ).pipe(Effect.mapError(unavailableReadComposition))
          : undefined;
      const admittedCompositionRevision = admission?.revision ?? compositionRevision;
      if (earlyCompositionRevision !== undefined && earlyCompositionRevision !== admittedCompositionRevision) {
        return yield* unavailableReadComposition();
      }
      if (admission?.catalog !== undefined) {
        yield* validateBoundOperationOwner(input.registration, admission.catalog, options.ownerRegistration).pipe(
          Effect.mapError(unavailableReadComposition),
        );
      }
      return admittedCompositionRevision;
    });

    const executeTrustedRead = Effect.fn('ReadRuntime.executeTrustedRead')(function* executeTrustedReadEffect(
      executor: CoreDbExecutor,
    ) {
      const scope = yield* scopeResolver.resolve(
        withOptionalProperty(
          withOptionalProperty(
            {
              correlationId: transport.correlationId,
              legalEntityScope: input.registration.descriptor.legalEntityScope,
              principal,
            },
            transport.traceId !== undefined,
            'traceId',
            transport.traceId,
            {},
          ),
          input.audience !== undefined,
          'audience',
          input.audience,
          {},
        ),
      );
      stage('scope_validated');
      // The descriptor decides which authority answers (O62, O68): a v2 carrier is decided by the one
      // access gate, and a descriptor still on a legacy kind keeps the legacy checks until C05 moves it.
      const accessTarget = usesAccessGate
        ? yield* resolveReadAccessTarget(decodedInput, scope, getReadAccessTargetResolver(input.registration))
        : Option.none<AccessRecordTarget>();
      const accessOwnerFacts = usesAccessGate
        ? yield* resolveReadOwnerFacts(decodedInput, scope, getReadOwnerFactsResolver(input.registration))
        : Option.none<OwnerAccessFacts>();
      const legacyAuthorization = usesAccessGate
        ? Option.none<LegacyReadAuthorization>()
        : Option.some(yield* prepareLegacyReadAuthorization(decodedInput, scope));
      const permissionTarget = Option.isSome(legacyAuthorization)
        ? legacyAuthorization.value.permissionTarget
        : undefined;
      const ownerAuthorizationTargets: readonly OwnerAuthorizationTarget[] = Option.isSome(legacyAuthorization)
        ? legacyAuthorization.value.ownerAuthorizationTargets
        : NO_OWNER_AUTHORIZATION_TARGETS;
      const permissionTargetMetadata = Option.isSome(legacyAuthorization)
        ? legacyAuthorization.value.permissionTargetMetadata
        : accessTargetMetadata(descriptor.accessDeclaration, accessTarget);
      const { earlyCompositionRevision, intrinsicDependencies } = yield* prepareOperationIntrinsicState(
        input.registration,
        principal,
        { ...options, shellSystemReads },
      ).pipe(Effect.mapError(unavailableReadComposition));
      const snapshot = yield* gateway.prepareSnapshot(
        scope,
        [input.registration.descriptor.entrypoint],
        intrinsicDependencies,
      );
      yield* gateway.check(snapshot, input.registration.descriptor.entrypoint);
      stage('module_state_checked');

      const gateAuthorization: ReadGateAuthorization = usesAccessGate
        ? yield* authorizeThroughGate(scope, accessTarget)
        : LEGACY_GATE_AUTHORIZATION;
      const gatePermissionDecision: PermissionDecision = gateAuthorization.decision;
      const legacyPermissionDecisions: readonly PermissionDecision[] = Option.isSome(legacyAuthorization)
        ? yield* checkLegacyReadAuthorization(legacyAuthorization.value, scope)
        : NO_PERMISSION_DECISIONS;
      const authorizationDecisions: readonly PermissionDecision[] = [
        gatePermissionDecision,
        ...legacyPermissionDecisions,
      ];
      stage('permission_checked');
      if (authorizationDecisions.includes('denied')) {
        yield* persistReadEvidenceForComposition(
          executor,
          withOptionalProperty(
            {
              accessKind: input.registration.descriptor.accessKind,
              captureMode: input.registration.descriptor.evidencePolicy.captureMode,
              outcome: 'denied',
              outcomeCode: usesAccessGate ? 'access_denied' : 'spicedb_permission_denied',
              outcomeStage: 'authz',
              policyKey: input.registration.descriptor.evidencePolicy.policyKey,
            },
            queryHash !== undefined,
            'queryHash',
            queryHash,
            {
              readKey: input.registration.descriptor.readKey,
              resultCount: 0,
              scope,
              servingModuleKey: input.registration.descriptor.owningModuleKey,
              ...permissionTargetMetadata,
            },
          ),
          options.databaseIdentities,
          earlyCompositionRevision ?? compositionRevision,
        );
        return yield* new ReadPermissionDenied({
          code: 'read_permission_denied',
          reason: 'The principal is not permitted to perform this read',
        });
      }
      if (authorizationDecisions.some((decision) => decision !== 'allowed')) {
        return yield* new ReadPermissionUnavailable({
          code: 'read_permission_unavailable',
          reason: 'Read authorization is temporarily unavailable',
        });
      }

      const admittedCompositionRevision = yield* admitReadComposition(earlyCompositionRevision);
      const executionRevision = admittedCompositionRevision ?? '';
      const policies = getReadPolicyImplementations(input.registration);
      yield* withReadExecution(
        {
          loadCatalog: operationCatalogLoader(operationAuthority, executionRevision),
          ownerRegistration: options.ownerRegistration,
          phase: 'execution',
          registration: input.registration,
          revision: executionRevision,
          scope,
        },
        Effect.forEach(
          input.registration.descriptor.policies.entries(),
          ([index, policyDescriptor]): Effect.Effect<void, ReadCoreError> => {
            const policy = policies[index];
            if (policy === undefined) {
              return Effect.fail(
                new ReadPolicyEvaluationError({
                  code: 'read_policy_evaluation_failed',
                  reason: 'A required read Policy is unavailable',
                }),
              );
            }
            return policy
              .evaluate({
                action: {
                  actionKey: descriptor.readKey,
                  owningModuleKey: descriptor.owningModuleKey,
                  schemaVersion: descriptor.schemaVersion,
                },
                payload: decodedInput,
                principal: scope,
                target: permissionTargetMetadata,
                transport: withOptionalProperty(
                  { correlationId: transport.correlationId },
                  transport.traceId !== undefined,
                  'traceId',
                  transport.traceId,
                  {},
                ),
              })
              .pipe(
                Effect.catchTag('PolicyDenied', (failure) =>
                  persistReadEvidenceForComposition(
                    executor,
                    withOptionalProperty(
                      {
                        accessKind: descriptor.accessKind,
                        captureMode: descriptor.evidencePolicy.captureMode,
                        outcome: 'denied',
                        outcomeCode: failure.reasonCode,
                        outcomeStage: 'policy',
                        policyKey: descriptor.evidencePolicy.policyKey,
                      },
                      queryHash !== undefined,
                      'queryHash',
                      queryHash,
                      {
                        readKey: descriptor.readKey,
                        resultCount: 0,
                        scope,
                        servingModuleKey: descriptor.owningModuleKey,
                        ...permissionTargetMetadata,
                      },
                    ),
                    options.databaseIdentities,
                    admittedCompositionRevision,
                  ).pipe(
                    Effect.andThen(
                      Effect.fail(
                        new ReadPolicyDenied({
                          code: 'read_policy_denied',
                          httpStatus: policyDescriptor.denialStatus,
                          policyReasonCode: failure.reasonCode,
                          reason: failure.reason,
                        }),
                      ),
                    ),
                  ),
                ),
              );
          },
          { concurrency: 1, discard: true },
        ),
      );
      stage('policies_checked');

      const trustedSettlement = makeReadSettlementRecovery();
      const sanitizeOwnerFailure = Effect.mapError((failure: unknown) =>
        sanitizeReadHandlerFailure(getReadDomainErrorSchema(input.registration), failure),
      );
      /**
       * A short, admitted, scoped, guarded owner transaction for `finish`: an evaluation that
       * interleaves remote owner calls with owner-state reads opens one per read, and no remote call
       * ever runs while one is open (D14).
       */
      const ownerTransaction: ReadOwnerTransaction = (use) =>
        executor
          .transaction((transaction) =>
            fenceReadRevision(transaction, compositionRevision, admittedCompositionRevision).pipe(
              Effect.andThen(() => installOperationalScope(transaction, scope, options.databaseIdentities)),
              Effect.flatMap((nextScoped) => use(nextScoped)),
              insideDatabaseTransaction(descriptor.readKey),
            ),
          )
          .pipe(
            Effect.mapError((cause) =>
              new ReadHandlerUnavailable({
                code: 'read_handler_unavailable',
                reason: 'The owner transaction scope is unavailable',
              }).pipe((failure) => preserveFailureCause(failure, cause)),
            ),
          );
      // The gate's own row and field answers reach every owner step, exactly as a single-handler Read
      // receives them (O17, O25): a staged `load` applies the row filter in its own query and a staged
      // `finish` filters fields with the same answer.
      const ownerStepsContext = Object.freeze(
        withOptional(
          withOptional(
            withOptional(
              { readKey: descriptor.readKey, scope, transaction: ownerTransaction },
              'compositionRevision',
              admittedCompositionRevision,
            ),
            'listAccess',
            gateAuthorization.listAccess,
          ),
          'deniedFieldPaths',
          usesAccessGate ? gateAuthorization.deniedFieldPaths : undefined,
        ),
      );
      const authorizedReadProgram = Effect.gen(function* executeAuthorizedRead() {
        // Owner `prepare`: SpiceDB grants and other remote calls, before any transaction exists, so a
        // slow authorization round trip never holds a pooled connection. It yields the transaction step.
        const loadWith = yield* Effect.suspend(() =>
          getReadStages(input.registration)(decodedInput, ownerStepsContext),
        ).pipe(sanitizeOwnerFailure);
        const readTransactionBody = Effect.fn('ReadRuntime.readTransactionBody')(function* readTransactionBodyEffect(
          transaction: CoreTransaction,
        ) {
          yield* fenceReadRevision(transaction, compositionRevision, admittedCompositionRevision);
          const scoped = yield* installOperationalScope(transaction, scope, options.databaseIdentities);
          stage('scope_installed');
          const operationAt = yield* trustedTransactionTime(transaction);
          const ownerAuthorizationDecision = yield* ownerAuthorizationOverlay.authorize(
            scoped,
            Object.freeze(
              withOptionalProperty(
                withOptionalProperty(
                  {
                    capabilityKey: descriptor.accessDeclaration?.key ?? descriptor.readKey,
                    operation: 'read' as const,
                    operationAt,
                    operationKey: input.registration.descriptor.readKey,
                    owningModuleKey: input.registration.descriptor.owningModuleKey,
                    scope,
                    targets: ownerAuthorizationTargets,
                  },
                  Option.isSome(accessTarget),
                  'target',
                  Option.getOrUndefined(accessTarget),
                  {},
                ),
                Option.isSome(accessOwnerFacts),
                'ownerFacts',
                Option.getOrUndefined(accessOwnerFacts),
                {},
              ),
            ),
          );
          if (ownerAuthorizationDecision === 'denied') {
            return yield* new ReadPermissionDenied({
              code: 'read_permission_denied',
              reason: 'The owner-local authorization state denies this Read',
            });
          }
          if (ownerAuthorizationDecision === 'unavailable') {
            return yield* new ReadPermissionUnavailable({
              code: 'read_permission_unavailable',
              reason: 'Owner-local Read authorization is temporarily unavailable',
            });
          }
          const services = yield* getReadServiceFactory(input.registration)(
            scoped,
            scope,
            admittedCompositionRevision,
            gateAuthorization.listAccess,
          );
          // Owner `load` (scoped database reads only) runs inside this transaction and returns the
          // after-commit `finish`; the connection is back in the pool before `finish` runs.
          const finish = yield* loadWith(services).pipe(sanitizeOwnerFailure);
          stage('handler_executed');
          // @effect-diagnostics-next-line returnEffectInGen:off -- The after-commit step leaves the transaction unevaluated.
          return finish;
        });
        const transactionResult = executor
          .transaction((transaction) =>
            readTransactionBody(transaction).pipe(
              insideDatabaseTransaction(descriptor.readKey),
              trustedSettlement.capture,
            ),
          )
          .pipe(
            trustedSettlement.recover,
            Effect.tapError((failure) =>
              Schema.is(SqlError)(failure)
                ? Effect.logError('Unexpected governed read transaction failure', failure)
                : Effect.void,
            ),
            Effect.mapError((transactionFailure) =>
              Schema.is(SqlError)(transactionFailure)
                ? mapReadTransactionSqlFailure(transactionFailure)
                : transactionFailure,
            ),
          );
        // The connection is back in the pool: owner `finish`, result validation, result authorization,
        // and evidence. A `finish` that must read owner state between remote calls uses the same short
        // `ownerTransaction`, and no remote call ever runs while one is open.
        // The transaction's own failures (scope install, settlement, an unavailable transaction time)
        // propagate untouched; only the owner's after-commit step is sanitized as an owner failure.
        const finish = yield* transactionResult;
        const handlerResult = yield* finish.pipe(sanitizeOwnerFailure);
        const result = yield* Schema.decodeUnknownEffect(Schema.toType(input.registration.descriptor.resultSchema), {
          onExcessProperty: 'error',
        })(handlerResult.result).pipe(
          Effect.mapError((parseIssue) =>
            preserveFailureCause(
              new ReadResultValidationError({
                code: 'read_result_invalid',
                reason: 'The read result does not match its declared schema',
              }),
              parseIssue,
            ),
          ),
        );
        stage('result_decoded');
        const resultPermissionResolver = getReadResultPermissionTargetResolver(input.registration);
        if (resultPermissionResolver !== undefined && permissionTarget !== undefined) {
          // Legacy result filtering; a v2 row-scoped read applies the gate's list predicate in its
          // own query instead (O25), so this path belongs to the legacy kinds only (C03b).
          yield* checkResultPermissions(contextAccess, result, scope, permissionTarget, resultPermissionResolver);
        }
        const evidence = yield* validateReadEvidenceMetadata(
          input.registration.descriptor.evidencePolicy.captureMode,
          handlerResult.evidence,
        );
        // The governed read committed with the connection back in the pool, so the allowed evidence
        // opens its own short scoped transaction instead of riding a transaction that is already gone.
        yield* persistReadEvidenceForComposition(
          executor,
          withOptionalProperty(
            withOptionalProperty(
              withOptionalProperty(
                {
                  accessKind: input.registration.descriptor.accessKind,
                  captureMode: input.registration.descriptor.evidencePolicy.captureMode,
                  outcome: 'allowed',
                  outcomeCode: 'read_allowed',
                  outcomeStage: 'evidence',
                  policyKey: input.registration.descriptor.evidencePolicy.policyKey,
                },
                queryHash !== undefined,
                'queryHash',
                queryHash,
                {
                  readKey: input.registration.descriptor.readKey,
                  resultCount: evidence.resultCount,
                },
              ),
              evidence.resultFingerprintHash !== undefined,
              'resultFingerprintHash',
              evidence.resultFingerprintHash,
              {},
            ),
            evidence.resultFingerprintSchema !== undefined,
            'resultFingerprintSchema',
            evidence.resultFingerprintSchema,
            {
              scope,
              servingModuleKey: input.registration.descriptor.owningModuleKey,
              ...permissionTargetMetadata,
            },
          ),
          options.databaseIdentities,
          admittedCompositionRevision,
        );
        stage('evidence_persisted');
        // The complete payload was decoded, validated and hashed by its owner above; the caller
        // receives the projection of the field groups it may read (O17).
        const projected = projectReadResultFields(
          result,
          gateAuthorization.deniedFieldPaths,
          input.registration.descriptor.resultSchema,
        );
        if (Option.isNone(projected)) {
          return yield* new ReadPermissionUnavailable({
            code: 'read_permission_unavailable',
            reason: 'The read result could not be projected onto the field groups this caller may read',
          });
        }
        return projected.value;
      });
      const transactionExit = yield* Effect.exit(
        withReadExecution(
          {
            loadCatalog: operationCatalogLoader(operationAuthority, executionRevision),
            ownerRegistration: options.ownerRegistration,
            phase: 'execution',
            registration: input.registration,
            revision: executionRevision,
            scope,
          },
          authorizedReadProgram,
        ),
      );
      if (Exit.isSuccess(transactionExit)) {
        return transactionExit.value;
      }
      const { cause } = transactionExit;
      if (
        !cause.reasons.some((reason) => Cause.isFailReason(reason) && Schema.is(ReadPermissionDenied)(reason.error))
      ) {
        return yield* Effect.failCause(cause);
      }
      const evidenceExit = yield* Effect.exit(
        persistReadEvidenceForComposition(
          executor,
          withOptionalProperty(
            {
              accessKind: input.registration.descriptor.accessKind,
              captureMode: input.registration.descriptor.evidencePolicy.captureMode,
              outcome: 'denied',
              outcomeCode: 'read_permission_denied',
              outcomeStage: 'authz',
              policyKey: input.registration.descriptor.evidencePolicy.policyKey,
            },
            queryHash !== undefined,
            'queryHash',
            queryHash,
            {
              readKey: input.registration.descriptor.readKey,
              resultCount: 0,
              scope,
              servingModuleKey: input.registration.descriptor.owningModuleKey,
              ...permissionTargetMetadata,
            },
          ),
          options.databaseIdentities,
          admittedCompositionRevision,
        ),
      );
      return yield* Effect.failCause(Exit.isFailure(evidenceExit) ? Cause.combine(evidenceExit.cause, cause) : cause);
    });
    if (compositionRevision !== undefined) {
      // Verified admission must settle before any owner prepare or authorization network work.
      // Each later SQL phase reacquires the fence, including evidence after remote finish.
      const governedSettlement = makeReadSettlementRecovery();
      yield* database.executor
        .transaction(
          Effect.fn('ReadRuntime.governedReadTransaction')(function* governedReadTransaction(
            transaction: CoreTransaction,
          ) {
            yield* lockApplicationCompositionAuthority(transaction, compositionRevision, 'read').pipe(
              Effect.mapError((cause) =>
                preserveFailureCause(
                  new ReadHandlerUnavailable({
                    code: 'read_handler_unavailable',
                    reason: 'The approved Application Composition no longer admits this Read',
                  }),
                  cause,
                ),
              ),
            );
            return yield* Effect.void;
          }, governedSettlement.capture),
        )
        .pipe(
          governedSettlement.recover,
          Effect.catchCause((cause) =>
            Effect.failCause(
              cause.pipe(
                Cause.map((transactionFailure) =>
                  Schema.is(SqlError)(transactionFailure)
                    ? mapReadTransactionSqlFailure(transactionFailure)
                    : transactionFailure,
                ),
              ),
            ),
          ),
        );
    }
    return yield* executeTrustedRead(database.executor);
  });

  const runRead: typeof runReadBoundary = (input) => withoutModuleOperationExecution(runReadBoundary(input));
  return Object.freeze({ runRead });
};

export { readRuntimeFromDependencies as makeReadRuntime };

export type ReadRuntimeService = ReturnType<typeof readRuntimeFromDependencies>;

export class ReadRuntime extends Context.Service<ReadRuntime, ReadRuntimeService>()(
  '@app/core-runtime/reads/runtime/ReadRuntime',
) {}

const readRuntimeDependencies = Effect.gen(function* readRuntimeDependencies() {
  const ownerAuthorizationOverlay = yield* Effect.serviceOption(OwnerAuthorizationOverlay);
  const databaseIdentities = yield* DatabaseIdentityEnrollmentContext;
  const database = yield* CoreDatabase;
  const gateway = yield* ModuleEntrypointGateway;
  const scopeResolver = yield* OperationalScopeResolver;
  const contextAccess = yield* ContextAccess;
  const accessDecision = yield* bindLiveAccessGate;
  const principalKinds = yield* AccessPrincipalKindSource;
  return {
    accessDecision,
    contextAccess,
    database,
    databaseIdentities,
    gateway,
    ownerAuthorizationOverlay: Option.isSome(ownerAuthorizationOverlay)
      ? ownerAuthorizationOverlay.value
      : failClosedOwnerAuthorizationOverlay,
    principalKinds,
    scopeResolver,
  };
});

/** Core system reads use their own gates without an owner deployment's Composition admission. */
export const ReadRuntimeLive = Layer.effect(
  ReadRuntime,
  readRuntimeDependencies.pipe(
    Effect.map(
      ({
        accessDecision,
        contextAccess,
        database,
        databaseIdentities,
        gateway,
        ownerAuthorizationOverlay,
        principalKinds,
        scopeResolver,
      }) =>
        readRuntimeFromDependencies(database, gateway, scopeResolver, contextAccess, {
          accessDecision,
          databaseIdentities,
          ownerAuthorizationOverlay,
          principalKinds,
        }),
    ),
  ),
);

/** Bind the actual receiving artifact and existing authority without reading the source at startup. */
export const makeReadRuntimeLive = (
  expectedDeployment: typeof OntosDeploymentIdentitySchema.Type,
  hosting?: VerticalRuntimeRegistration | { readonly shellSystemReads: ShellSystemReadRegistrations },
) =>
  Layer.effect(
    ReadRuntime,
    Effect.gen(function* makeOwnedReadRuntimeService() {
      const applicationComposition = yield* ActiveApplicationCompositionService;
      const {
        accessDecision,
        contextAccess,
        database,
        databaseIdentities,
        gateway,
        ownerAuthorizationOverlay,
        principalKinds,
        scopeResolver,
      } = yield* readRuntimeDependencies;
      const ownerRegistration = hosting !== undefined && 'shellSystemReads' in hosting ? undefined : hosting;
      const shellSystemReads =
        hosting !== undefined && 'shellSystemReads' in hosting ? hosting.shellSystemReads : undefined;
      const options: ReadRuntimeOptions =
        ownerRegistration === undefined
          ? {
              accessDecision,
              applicationComposition,
              databaseIdentities,
              expectedDeployment,
              ownerAuthorizationOverlay,
              principalKinds,
            }
          : {
              accessDecision,
              applicationComposition,
              databaseIdentities,
              expectedDeployment,
              ownerAuthorizationOverlay,
              ownerRegistration,
              principalKinds,
            };
      return readRuntimeFromDependencies(
        database,
        gateway,
        scopeResolver,
        contextAccess,
        shellSystemReads === undefined ? options : { ...options, shellSystemReads },
      );
    }),
  );
