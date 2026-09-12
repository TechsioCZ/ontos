import { SqlError, isSqlError } from 'effect/unstable/sql/SqlError';
/* oxlint-disable sonarjs/no-duplicate-string, eslint/no-use-before-define, anti-slop/no-unknown-parameters, effect-native/no-throw-in-effect-callback, effect-native/no-native-error-construction -- Opaque owner resolver defects are captured immediately by Effect.try and sanitized to a typed Core failure; expires: 2027-03-31. */
// @effect-diagnostics asyncFunction:off -- Existing compatibility boundary; expires: 2026-12-31.
import { Cause, Context, Effect, Exit, Layer, Match, Option, Predicate, Schema } from 'effect';
import { computeCanonicalValueHash } from '../actions/repository.ts';
import {
  decodeTrustedPrincipalContext,
  isTrustedSupportRecoveryPrincipalContext,
} from '../auth/system-principal-context-provenance.ts';
import { CoreDatabase } from '../db/client.ts';
import { installOperationalScope } from '../db/scoped-transaction.ts';
import type { CoreTransaction } from '../db/types.ts';
import type { ModuleEntrypointGatewayService } from '../modules/module-entrypoint-gateway.ts';
import { ModuleEntrypointGateway } from '../modules/module-entrypoint-gateway.ts';
import type { OperationalScope, OperationalScopeResolverService } from '../operations/context.ts';
import { OperationalScopeResolver } from '../operations/context.ts';
import {
  ContextAccess,
  LEGAL_ENTITY_PERMISSION_KEYS,
  toBusinessPermissionAccessKey,
  toContextPermissionAccessKey,
} from '../permissions/context-access.ts';
import {
  OwnerAuthorizationOverlay,
  failClosedOwnerAuthorizationOverlay,
} from '../permissions/owner-authorization-overlay.ts';
import type { OwnerAuthorizationTarget } from '../permissions/owner-authorization-overlay.ts';
import { validateReadEvidenceMetadata } from './context.ts';
import type {
  AtomicResolvedReadPermissionTarget,
  ReadConditionalPermissionDeclaration,
  ReadRegistration,
  ReadResourcePermissionTarget,
  ResolvedReadConditionalPermissionRequirement,
  ResolvedReadPermissionTarget,
} from './definition.ts';
import {
  getReadConditionalPermissionPlan,
  getReadDomainErrorSchema,
  getReadHandler,
  getReadPermissionTargetResolver,
  getReadPolicyImplementations,
  getReadResourcePermissionTargetResolver,
  getReadResultPermissionTargetResolver,
  getReadServiceFactory,
} from './definition.ts';
import type { ReadCoreError } from './errors.ts';
import {
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
import { persistReadEvidence } from './repository.ts';

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

const CorrelationIdSchema = Schema.String.check(Schema.isMinLength(1)).pipe(Schema.brand('ReadCorrelationId'));
const TargetModuleKeySchema = Schema.String.check(Schema.isMinLength(1)).pipe(Schema.brand('ReadTargetModuleKey'));
const TargetResourceIdSchema = Schema.String.check(Schema.isMinLength(1)).pipe(Schema.brand('ReadTargetResourceId'));
const TargetResourceTypeSchema = Schema.String.check(Schema.isMinLength(1)).pipe(
  Schema.brand('ReadTargetResourceType'),
);
const TraceIdSchema = Schema.String.check(Schema.isMinLength(1)).pipe(Schema.brand('ReadTraceId'));

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
  readonly onStage?: (stage: ReadRuntimeStage) => void;
  readonly ownerAuthorizationOverlay?: (typeof OwnerAuthorizationOverlay)['Service'];
}

const stableTargetKey = (value: string): boolean => value.length > 0 && value.length <= 300;
const PermissionDecisionSchema = Schema.Literals(['allowed', 'denied', 'unavailable']);
type PermissionDecision = typeof PermissionDecisionSchema.Type;

const businessPermissionTargetIsValid = (
  target: Extract<AtomicResolvedReadPermissionTarget, { readonly kind: 'business_permission' }>,
  scope?: OperationalScope,
): boolean => {
  const business = target.businessPermission.target;
  return (
    stableTargetKey(target.businessPermission.permission) &&
    stableTargetKey(business.tenantId) &&
    stableTargetKey(business.legalEntityId) &&
    (business.kind !== 'counterparty_storefront' ||
      (stableTargetKey(business.storefrontId) &&
        target.trustedStorefrontId === business.storefrontId &&
        scope?.trustedStorefrontId === business.storefrontId))
  );
};

const legalEntityTargetIsValid = (
  target: Extract<AtomicResolvedReadPermissionTarget, { readonly kind: 'legal_entity' }>,
): boolean =>
  target.permission === undefined ||
  LEGAL_ENTITY_PERMISSION_KEYS.some((permission) => permission === target.permission);

const atomicTargetIsValid = (target: AtomicResolvedReadPermissionTarget, scope?: OperationalScope): boolean => {
  if (target.kind === 'business_permission') {
    return businessPermissionTargetIsValid(target, scope);
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
  declared: 'business_permission' | 'legal_entity' | 'module' | 'resource' | 'tenant',
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
      // oxlint-disable-next-line sonarjs/function-name -- Match's discriminator key is the encoded domain vocabulary.
      business_permission: (businessTarget) =>
        withOptionalProperty(
          {
            kind: 'business_permission' as const,
            permission: businessTarget.businessPermission.permission,
            target: businessTarget.businessPermission.target,
          },
          businessTarget.trustedStorefrontId !== undefined,
          'trustedStorefrontId',
          businessTarget.trustedStorefrontId,
          {},
        ),
      // oxlint-disable-next-line sonarjs/function-name -- Match's discriminator key is the encoded domain vocabulary.
      legal_entity: (legalEntityTarget) =>
        withOptionalProperty(
          {
            kind: 'legal_entity' as const,
            legalEntityId: scope.legalEntityId ?? '',
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

const readBusinessTargetResourceId = (
  target: Extract<AtomicResolvedReadPermissionTarget, { kind: 'business_permission' }>['businessPermission']['target'],
): string => {
  if (target.kind === 'retail_profile') {
    return target.profileId;
  }
  return target.kind === 'counterparty' ? target.counterpartyId : `${target.counterpartyId}:${target.storefrontId}`;
};

const targetMetadata = (target: ResolvedReadPermissionTarget) => {
  const canonical = canonicalPermissionTarget(target);
  if (canonical.kind === 'business_permission') {
    const business = canonical.businessPermission.target;
    return {
      targetModuleKey: canonical.businessPermission.permission,
      targetResourceId: readBusinessTargetResourceId(business),
      targetResourceType: business.kind,
    };
  }
  if (canonical.kind === 'legal_entity' || canonical.kind === 'tenant') {
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

const checkBusinessPermissionTarget = <AccessValue extends (typeof ContextAccess)['Service']>(
  contextAccess: AccessValue,
  scope: OperationalScope,
  target: Extract<AtomicResolvedReadPermissionTarget, { readonly kind: 'business_permission' }>,
): Effect.Effect<PermissionDecision> => {
  const business = target.businessPermission.target;
  if (
    business.tenantId !== scope.tenantId ||
    business.legalEntityId !== scope.legalEntityId ||
    (business.kind === 'counterparty_storefront'
      ? scope.trustedStorefrontId !== business.storefrontId || target.trustedStorefrontId !== scope.trustedStorefrontId
      : target.trustedStorefrontId !== undefined)
  ) {
    return Effect.succeed('unavailable');
  }
  if (contextAccess.businessPermissions === undefined) {
    return Effect.succeed('unavailable');
  }
  const checkInput = withOptionalProperty(
    {
      principal: { principalId: scope.principalId, tenantId: scope.tenantId },
      targets: [target.businessPermission],
    },
    scope.trustedStorefrontId !== undefined,
    'trustedStorefrontId',
    scope.trustedStorefrontId,
    {},
  );
  return contextAccess
    .businessPermissions(checkInput)
    .pipe(Effect.map((decisions) => decisionFor(decisions, toBusinessPermissionAccessKey(target.businessPermission))));
};

const checkAtomicPermissionTarget = <AccessValue extends (typeof ContextAccess)['Service']>(
  contextAccess: AccessValue,
  scope: OperationalScope,
  target: AtomicResolvedReadPermissionTarget,
  allowMissingLegalEntity: boolean,
): Effect.Effect<PermissionDecision> => {
  if (target.kind === 'business_permission') {
    return checkBusinessPermissionTarget(contextAccess, scope, target);
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
  if (scope.legalEntityId === undefined) {
    return Effect.succeed(allowMissingLegalEntity ? 'allowed' : 'unavailable');
  }
  const { legalEntityId } = scope;
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
  entrypoint: ReadRegistration<
    Schema.ConstraintDecoder<unknown>,
    Schema.ConstraintDecoder<unknown>,
    string,
    unknown,
    unknown
  >['descriptor']['entrypoint'],
  permissionTarget: AtomicResolvedReadPermissionTarget,
  primaryDecision: PermissionDecision,
): Effect.Effect<PermissionDecision> => {
  const { authorization } = entrypoint;
  if (authorization.kind !== 'context_permission') {
    return Effect.succeed('allowed');
  }
  if (
    (authorization.permission === 'module.access' &&
      permissionTarget.kind === 'module' &&
      permissionTarget.moduleId === entrypoint.moduleKey) ||
    (permissionTarget.kind === 'business_permission' &&
      permissionTarget.businessPermission.permission === authorization.permission)
  ) {
    return Effect.succeed(primaryDecision);
  }
  if (authorization.permission === 'module.access') {
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
    let permissionTarget: ResolvedReadPermissionTarget;
    let conditionalAdditionalTargets: readonly AtomicResolvedReadPermissionTarget[] = [];
    if (registration.descriptor.permissionTarget === 'conditional') {
      if (Predicate.isFunction(permissionResolver)) {
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
          preserveFailureCause(
            new ReadHandlerExecutionError({
              code: 'read_handler_execution_failed',
              reason: 'The declared read permission target could not be resolved',
            }),
            resolverDefect,
          ),
        try: () => permissionResolver(decodedInput, scope),
      });
      if (
        !targetIsValid(registration.descriptor.permissionTarget, permissionTarget, scope) ||
        (getReadResultPermissionTargetResolver(registration) !== undefined && permissionTarget.kind === 'any_of')
      ) {
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
  if (permissionTarget.kind === 'business_permission') {
    return yield* new ReadHandlerExecutionError({
      code: 'read_handler_execution_failed',
      reason: 'Business-permission reads must not use generic result resource filtering',
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
  // oxlint-disable-next-line effect-native/no-dependency-parameters -- Runtime construction keeps the optional owner seam injectable for Core unit and integration harnesses.
  options: ReadRuntimeOptions = {},
) => {
  const stage = (value: ReadRuntimeStage): void => options.onStage?.(value);
  const ownerAuthorizationOverlay = options.ownerAuthorizationOverlay ?? failClosedOwnerAuthorizationOverlay;

  const runRead = Effect.fn('ReadRuntime.runRead')(function* runReadEffect<
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
  }) {
    const decodedInput = yield* Schema.decodeUnknownEffect(input.registration.descriptor.inputSchema)(input.input).pipe(
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
    const scope = yield* scopeResolver.resolve(
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
    );
    stage('scope_validated');
    const { conditionalAdditionalTargets, permissionTarget } = yield* resolveReadPermissionTarget(
      input.registration,
      decodedInput,
      scope,
    );
    // oxlint-disable-next-line effect-native/no-sequential-independent-yields -- Preserve primary-before-resource resolver execution because owner callbacks may throw or observe mutable state.
    const resourcePermissionTarget = yield* resolveReadResourcePermissionTarget(
      decodedInput,
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
    const permissionTargetMetadata = targetMetadata(permissionTarget);
    const snapshot = yield* gateway.prepareSnapshot(scope, [input.registration.descriptor.entrypoint]);
    yield* gateway.check(snapshot, input.registration.descriptor.entrypoint);
    stage('module_state_checked');

    const permissionDecision = yield* checkPermissionTarget(
      contextAccess,
      scope,
      permissionTarget,
      input.registration.descriptor.legalEntityScope === 'forbidden',
    );
    const resourcePermissionDecision = Option.isNone(resourcePermissionTarget)
      ? 'allowed'
      : yield* checkAtomicPermissionTarget(
          contextAccess,
          scope,
          {
            kind: 'resource',
            resource: resourcePermissionTarget.value.resource,
          },
          false,
        );
    const conditionalAdditionalDecisions = yield* Effect.forEach(
      conditionalAdditionalTargets,
      (target) => checkAtomicPermissionTarget(contextAccess, scope, target, false),
      { concurrency: 3 },
    );
    const entrypointPermissionDecision = yield* checkEntrypointContextPermission(
      contextAccess,
      scope,
      input.registration.descriptor.entrypoint,
      canonicalPermissionTarget(permissionTarget),
      permissionDecision,
    );
    const authorizationDecisions = [
      permissionDecision,
      resourcePermissionDecision,
      ...conditionalAdditionalDecisions,
      entrypointPermissionDecision,
    ];
    stage('permission_checked');
    if (authorizationDecisions.includes('denied')) {
      yield* persistReadEvidence(
        database.executor,
        withOptionalProperty(
          {
            accessKind: input.registration.descriptor.accessKind,
            captureMode: input.registration.descriptor.evidencePolicy.captureMode,
            outcome: 'denied',
            outcomeCode: 'spicedb_permission_denied',
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

    const policies = getReadPolicyImplementations(input.registration);
    yield* Effect.forEach(
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
        const { descriptor } = input.registration;
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
              persistReadEvidence(
                database.executor,
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
    );
    stage('policies_checked');

    const transactionResult = database.executor
      .transaction(
        Effect.fn('ReadRuntime.readTransactionBody')(function* readTransactionBody(transaction: CoreTransaction) {
          const scoped = yield* installOperationalScope(transaction, scope);
          stage('scope_installed');
          const ownerAuthorizationDecision = yield* ownerAuthorizationOverlay.authorize(
            scoped,
            Object.freeze({
              operation: 'read' as const,
              operationKey: input.registration.descriptor.readKey,
              owningModuleKey: input.registration.descriptor.owningModuleKey,
              scope,
              targets: ownerAuthorizationTargets,
            }),
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
          const services = yield* getReadServiceFactory(input.registration)(scoped, scope);
          const handlerResult = yield* Effect.suspend(() =>
            getReadHandler(input.registration)(
              decodedInput,
              Object.freeze({
                readKey: input.registration.descriptor.readKey,
                scope,
                services,
              }),
            ),
          ).pipe(
            Effect.mapError((failure) =>
              sanitizeReadHandlerFailure(getReadDomainErrorSchema(input.registration), failure),
            ),
          );
          stage('handler_executed');
          const result = yield* Schema.decodeUnknownEffect(Schema.toType(input.registration.descriptor.resultSchema))(
            handlerResult.result,
          ).pipe(
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
          if (resultPermissionResolver !== undefined) {
            yield* checkResultPermissions(contextAccess, result, scope, permissionTarget, resultPermissionResolver);
          }
          const evidence = yield* validateReadEvidenceMetadata(
            input.registration.descriptor.evidencePolicy.captureMode,
            handlerResult.evidence,
          );
          yield* persistReadEvidence(
            transaction,
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
          );
          stage('evidence_persisted');
          return result;
        }),
      )
      .pipe(
        Effect.catchDefect((defect) => (isSqlError(defect) ? Effect.fail(defect) : Effect.die(defect))),
        Effect.tapError((failure) =>
          Schema.is(SqlError)(failure)
            ? Effect.logError('Unexpected governed read transaction failure', failure)
            : Effect.void,
        ),
        Effect.mapError((transactionFailure) =>
          Schema.is(SqlError)(transactionFailure)
            ? preserveFailureCause(
                new ReadHandlerExecutionError({
                  code: 'read_handler_execution_failed',
                  reason: 'The governed read transaction failed',
                }),
                transactionFailure,
              )
            : transactionFailure,
        ),
      );
    const transactionExit = yield* Effect.exit(transactionResult);
    if (Exit.isSuccess(transactionExit)) {
      return transactionExit.value;
    }
    const { cause } = transactionExit;
    if (!cause.reasons.some((reason) => Cause.isFailReason(reason) && Schema.is(ReadPermissionDenied)(reason.error))) {
      return yield* Effect.failCause(cause);
    }
    const evidenceExit = yield* Effect.exit(
      persistReadEvidence(
        database.executor,
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
      ),
    );
    return yield* Effect.failCause(Exit.isFailure(evidenceExit) ? Cause.combine(evidenceExit.cause, cause) : cause);
  });

  return Object.freeze({ runRead });
};

export { readRuntimeFromDependencies as makeReadRuntime };

export type ReadRuntimeService = ReturnType<typeof readRuntimeFromDependencies>;

export class ReadRuntime extends Context.Service<ReadRuntime, ReadRuntimeService>()(
  '@app/core-runtime/reads/runtime/ReadRuntime',
) {}

export const ReadRuntimeLive = Layer.effect(
  ReadRuntime,
  Effect.gen(function* makeReadRuntimeService() {
    const ownerAuthorizationOverlay = yield* Effect.serviceOption(OwnerAuthorizationOverlay);
    const database = yield* CoreDatabase;
    const gateway = yield* ModuleEntrypointGateway;
    const scopeResolver = yield* OperationalScopeResolver;
    const contextAccess = yield* ContextAccess;
    return readRuntimeFromDependencies(database, gateway, scopeResolver, contextAccess, {
      ownerAuthorizationOverlay: Option.isSome(ownerAuthorizationOverlay)
        ? ownerAuthorizationOverlay.value
        : failClosedOwnerAuthorizationOverlay,
    });
  }),
);
