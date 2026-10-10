import { SqlError, isSqlError } from 'effect/unstable/sql/SqlError';
/* oxlint-disable sonarjs/no-duplicate-string, eslint/no-use-before-define, anti-slop/no-unknown-parameters, effect-native/no-throw-in-effect-callback, effect-native/no-native-error-construction -- Opaque owner resolver defects are captured immediately by Effect.try and sanitized to a typed Core failure; expires: 2027-03-31. */
// @effect-diagnostics asyncFunction:off -- Existing compatibility boundary; expires: 2026-12-31.
import { Cause, Context, Effect, Exit, Layer, Match, Option, Predicate, Schema } from 'effect';
import { computeCanonicalValueHash } from '../actions/repository.ts';
import {
  decodeTrustedPrincipalContext,
  isTrustedSupportRecoveryPrincipalContext,
  readVerifiedGatewayCompositionRevision,
} from '../auth/system-principal-context-provenance.ts';
import { CoreDatabase } from '../db/client.ts';
import { trustedTransactionTime } from '../operations/transaction-time.ts';
import { installOperationalScope } from '../db/scoped-transaction.ts';
import type { CoreDbExecutor, CoreTransaction } from '../db/types.ts';
import { lockApplicationCompositionAuthority } from '../modules/application-composition-authority.ts';
import type { ModuleEntrypointGatewayService } from '../modules/module-entrypoint-gateway.ts';
import { ModuleEntrypointGateway } from '../modules/module-entrypoint-gateway.ts';
import type { OperationalScope, OperationalScopeResolverService } from '../operations/context.ts';
import { OperationalScopeResolver } from '../operations/context.ts';
import {
  ContextAccess,
  hasCanonicalInventoryAuthorizationTarget,
  hasCanonicalPricingAuthorizationTargetIds,
  isBusinessPermissionTargetCompatible,
  isAssortmentPermissionTargetValid,
  toAssortmentPermissionAccessKey,
  toAssortmentPermissionAccessObjectId,
  assortmentPermissionTargetRequiresLegalEntity,
  toBusinessPermissionAccessKey,
  toContextPermissionAccessKey,
} from '../permissions/context-access.ts';
import { LEGAL_ENTITY_PERMISSION_KEYS } from '../permissions/context-permissions.ts';
import {
  OwnerAuthorizationOverlay,
  failClosedOwnerAuthorizationOverlay,
} from '../permissions/owner-authorization-overlay.ts';
import type { OwnerAuthorizationTarget } from '../permissions/owner-authorization-overlay.ts';
import type {
  AssortmentPermissionAccessTarget,
  AssortmentPermissionCommercialScope,
  AssortmentPermissionSubject,
} from '../permissions/context-access.ts';
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
const targetLegalEntityIdIsValid = Schema.is(Schema.String.check(Schema.isUUID()));
const PermissionDecisionSchema = Schema.Literals(['allowed', 'denied', 'unavailable']);
type PermissionDecision = typeof PermissionDecisionSchema.Type;

const assortmentResourceIsValid = (resource: {
  readonly moduleId: string;
  readonly resourceId: string;
  readonly resourceType: string;
}): boolean =>
  stableTargetKey(resource.moduleId) && stableTargetKey(resource.resourceId) && stableTargetKey(resource.resourceType);

const assortmentSelectorIsValid = (
  selector: {
    readonly kind: string;
    readonly target?: { readonly moduleId: string; readonly resourceId: string; readonly resourceType: string };
  },
  purpose?: 'VISIBILITY' | 'PURCHASE',
): boolean =>
  (selector.kind === 'ALL'
    ? selector.target === undefined
    : selector.target !== undefined && assortmentResourceIsValid(selector.target)) &&
  (purpose !== 'VISIBILITY' || !['VARIANT', 'PACKAGE_OPTION'].includes(selector.kind));

const assortmentScopeIsValid = (scope: {
  readonly channel: { readonly moduleId: string; readonly resourceId: string; readonly resourceType: string };
  readonly market?: { readonly moduleId: string; readonly resourceId: string; readonly resourceType: string };
  readonly storefront?: { readonly moduleId: string; readonly resourceId: string; readonly resourceType: string };
}): boolean =>
  assortmentResourceIsValid(scope.channel) &&
  (scope.market === undefined || assortmentResourceIsValid(scope.market)) &&
  (scope.storefront === undefined || assortmentResourceIsValid(scope.storefront));

const AssortmentSubjectKindSchema = Schema.Literals(['RETAIL_CUSTOMER_PROFILE', 'COUNTERPARTY']);
const assortmentSubjectIsValid = (subject: AssortmentPermissionSubject): boolean =>
  subject.kind === 'GUEST' ||
  (Schema.is(AssortmentSubjectKindSchema)(subject.kind) && assortmentResourceIsValid(subject.ref));

const storefrontScopeIsValid = (
  commercialScope: AssortmentPermissionCommercialScope,
  scope: OperationalScope,
): boolean =>
  commercialScope.storefront === undefined || scope.trustedStorefrontId === commercialScope.storefront.resourceId;

const assortmentConfigurationTargetIsValid = (
  target: Extract<AssortmentPermissionAccessTarget, { readonly kind: 'assortment_configuration' }>,
): boolean =>
  target.permission === 'assortment.configuration.read' &&
  isAssortmentPermissionTargetValid(target) &&
  assortmentResourceIsValid(target.resource);

const assortmentDecisionTargetIsValid = (
  target: Extract<AssortmentPermissionAccessTarget, { readonly kind: 'assortment_decision' }>,
  scope: OperationalScope,
): boolean =>
  target.permission === 'assortment.decision.explain' &&
  assortmentResourceIsValid(target.catalogSelection) &&
  assortmentScopeIsValid(target.commercialScope) &&
  assortmentSubjectIsValid(target.subject) &&
  storefrontScopeIsValid(target.commercialScope, scope);

const assortmentRuleTargetIsValid = (
  target: Extract<AssortmentPermissionAccessTarget, { readonly kind: 'assortment_rule' }>,
): boolean => {
  if (target.mode === 'retire') {
    return target.permission === 'assortment.rule.retire' && assortmentResourceIsValid(target.stableRule);
  }
  const expectedPermission = target.mode === 'create' ? 'assortment.rule.create' : 'assortment.rule.revision.create';
  const lineageValid =
    target.mode === 'create' ? stableTargetKey(target.stableCode) : assortmentResourceIsValid(target.stableRule);
  return (
    target.permission === expectedPermission &&
    assortmentSelectorIsValid(target.selector, target.purpose) &&
    lineageValid
  );
};

const assortmentBindingTargetIsValid = (
  target: Extract<AssortmentPermissionAccessTarget, { readonly kind: 'assortment_binding' }>,
  scope: OperationalScope,
): boolean => {
  if (target.mode === 'end') {
    return target.permission === 'assortment.binding.end' && assortmentResourceIsValid(target.binding);
  }
  let audienceValid = false;
  if (target.audience.kind === 'SHARED') {
    audienceValid = true;
  } else if (target.audience.kind === 'COMMERCE_CUSTOMER_GROUP') {
    audienceValid = assortmentResourceIsValid(target.audience.group);
  } else {
    audienceValid = assortmentSubjectIsValid(target.audience.subject);
  }
  return (
    target.permission === 'assortment.binding.create' &&
    assortmentResourceIsValid(target.ruleRevision) &&
    audienceValid &&
    assortmentScopeIsValid(target.commercialScope) &&
    stableTargetKey(target.effectiveFrom) &&
    storefrontScopeIsValid(target.commercialScope, scope)
  );
};

const assortmentBoundaryTargetIsValid = (
  target: Extract<AssortmentPermissionAccessTarget, { readonly kind: 'assortment_boundary' }>,
  scope: OperationalScope,
): boolean => {
  if (target.mode === 'end') {
    return target.permission === 'assortment.boundary.end' && assortmentResourceIsValid(target.boundary);
  }
  const admissionSetValid =
    ((target.admissionSet.setKind === 'EMPTY' && target.admissionSet.memberCount === 0) ||
      (target.admissionSet.setKind === 'ENTRIES' && target.admissionSet.memberCount > 0)) &&
    target.admissionSet.memberCount === target.admissionSet.entries.length &&
    target.admissionSet.contentHash.length === 64 &&
    /^[0-9a-f]{64}$/u.test(target.admissionSet.contentHash) &&
    target.admissionSet.entries.every((entry) => assortmentSelectorIsValid(entry, target.purpose));
  return (
    target.permission === 'assortment.boundary.create' &&
    assortmentSubjectIsValid(target.subject) &&
    assortmentScopeIsValid(target.commercialScope) &&
    stableTargetKey(target.effectiveFrom) &&
    storefrontScopeIsValid(target.commercialScope, scope) &&
    admissionSetValid
  );
};

const assortmentPermissionTargetIsValid = (
  target: AssortmentPermissionAccessTarget,
  scope: OperationalScope,
): boolean => {
  if (target.kind === 'assortment_configuration') {
    return assortmentConfigurationTargetIsValid(target);
  }
  if (target.kind === 'assortment_decision') {
    return assortmentDecisionTargetIsValid(target, scope);
  }
  if (target.kind === 'assortment_rule') {
    return assortmentRuleTargetIsValid(target);
  }
  if (target.kind === 'assortment_binding') {
    return assortmentBindingTargetIsValid(target, scope);
  }
  return assortmentBoundaryTargetIsValid(target, scope);
};

const assortmentPermissionTargetHasTrustedStorefrontMismatch = (
  target: AssortmentPermissionAccessTarget,
  scope: OperationalScope,
): boolean => {
  const storefront =
    target.kind === 'assortment_decision' ||
    (target.kind === 'assortment_binding' && target.mode === 'create') ||
    (target.kind === 'assortment_boundary' && target.mode === 'create')
      ? target.commercialScope.storefront
      : undefined;
  if (storefront === undefined) {
    return false;
  }
  return (
    scope.trustedStorefrontId !== storefront.resourceId &&
    assortmentPermissionTargetIsValid(target, { ...scope, trustedStorefrontId: storefront.resourceId })
  );
};

const businessPermissionTargetIsValid = (
  target: Extract<AtomicResolvedReadPermissionTarget, { readonly kind: 'business_permission' }>,
  scope?: OperationalScope,
): boolean => {
  const business = target.businessPermission.target;
  if (
    !stableTargetKey(target.businessPermission.permission) ||
    !stableTargetKey(business.tenantId) ||
    !isBusinessPermissionTargetCompatible(target.businessPermission) ||
    !hasCanonicalPricingAuthorizationTargetIds(business) ||
    !hasCanonicalInventoryAuthorizationTarget(business)
  ) {
    return false;
  }
  if (business.kind === 'pricing_catalog' || business.kind === 'price_group') {
    return (
      scope?.legalEntityId === undefined &&
      scope?.trustedStorefrontId === undefined &&
      target.trustedStorefrontId === undefined
    );
  }
  if (business.kind === 'inventory_resource') {
    return target.trustedStorefrontId === undefined;
  }
  return (
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
  (target.legalEntityId === undefined || targetLegalEntityIdIsValid(target.legalEntityId)) &&
  (target.permission === undefined ||
    LEGAL_ENTITY_PERMISSION_KEYS.some((permission) => permission === target.permission));

const atomicTargetIsValid = (target: AtomicResolvedReadPermissionTarget, scope?: OperationalScope): boolean => {
  if (target.kind === 'assortment_permission') {
    return scope === undefined ? false : assortmentPermissionTargetIsValid(target.assortmentPermission, scope);
  }
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
  declared: 'assortment_permission' | 'business_permission' | 'legal_entity' | 'module' | 'resource' | 'tenant',
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
      assortment_permission: (assortmentTarget) => ({
        kind: 'assortment_permission' as const,
        target: assortmentTarget.assortmentPermission,
      }),
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
  if (target.kind === 'counterparty') {
    return target.counterpartyId;
  }
  if (target.kind === 'counterparty_storefront') {
    return `${target.counterpartyId}:${target.storefrontId}`;
  }
  if (target.kind === 'pricing_catalog') {
    return target.pricingCatalogId;
  }
  if (target.kind === 'price_group') {
    return `${target.pricingCatalogId}:${target.priceGroupId}`;
  }
  if (target.kind === 'tax_selling_legal_entity') {
    return target.legalEntityId;
  }
  return target.resource.resourceId;
};

const targetMetadata = (target: ResolvedReadPermissionTarget, scope: OperationalScope) => {
  const canonical = canonicalPermissionTarget(target);
  if (canonical.kind === 'business_permission') {
    const business = canonical.businessPermission.target;
    if (business.kind === 'inventory_resource') {
      return {
        targetModuleKey: business.resource.moduleId,
        targetResourceId: business.resource.resourceId,
        targetResourceType: business.resource.resourceType,
      };
    }
    return {
      targetModuleKey: canonical.businessPermission.permission,
      targetResourceId: readBusinessTargetResourceId(business),
      targetResourceType: business.kind,
    };
  }
  if (canonical.kind === 'legal_entity') {
    return canonical.legalEntityId === undefined
      ? {}
      : { targetResourceId: canonical.legalEntityId, targetResourceType: 'core.identity.legal-entity' };
  }
  if (canonical.kind === 'assortment_permission') {
    return {
      targetModuleKey: canonical.assortmentPermission.kind,
      targetResourceId:
        toAssortmentPermissionAccessObjectId(
          scope.tenantId,
          scope.legalEntityId ?? '',
          canonical.assortmentPermission,
        ) ?? 'assortment-unavailable',
      targetResourceType: 'assortment_permission',
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

const checkBusinessPermissionTarget = <AccessValue extends (typeof ContextAccess)['Service']>(
  contextAccess: AccessValue,
  scope: OperationalScope,
  target: Extract<AtomicResolvedReadPermissionTarget, { readonly kind: 'business_permission' }>,
): Effect.Effect<PermissionDecision> => {
  const business = target.businessPermission.target;
  const tenantOnlyPricingTarget = business.kind === 'pricing_catalog' || business.kind === 'price_group';
  if (business.tenantId !== scope.tenantId) {
    return Effect.succeed('unavailable');
  }
  let scopeMismatch: boolean;
  if (business.kind === 'inventory_resource') {
    scopeMismatch = target.trustedStorefrontId !== undefined;
  } else if (tenantOnlyPricingTarget) {
    scopeMismatch =
      scope.legalEntityId !== undefined ||
      scope.trustedStorefrontId !== undefined ||
      target.trustedStorefrontId !== undefined;
  } else {
    scopeMismatch =
      business.legalEntityId !== scope.legalEntityId ||
      (business.kind === 'counterparty_storefront'
        ? scope.trustedStorefrontId !== business.storefrontId ||
          target.trustedStorefrontId !== scope.trustedStorefrontId
        : target.trustedStorefrontId !== undefined);
  }
  if (scopeMismatch) {
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

const checkAssortmentPermissionTarget = <AccessValue extends (typeof ContextAccess)['Service']>(
  contextAccess: AccessValue,
  scope: OperationalScope,
  target: Extract<AtomicResolvedReadPermissionTarget, { readonly kind: 'assortment_permission' }>,
): Effect.Effect<PermissionDecision> => {
  if (
    contextAccess.assortmentPermissions === undefined ||
    (scope.legalEntityId === undefined && assortmentPermissionTargetRequiresLegalEntity(target.assortmentPermission))
  ) {
    return Effect.succeed('unavailable');
  }
  const { legalEntityId } = scope;
  const targetEntry = {
    target: target.assortmentPermission,
  };
  const principal = { principalId: scope.principalId, tenantId: scope.tenantId };
  const requestWithoutLegalEntity =
    scope.trustedStorefrontId === undefined
      ? { principal, targets: [targetEntry] }
      : { principal, targets: [targetEntry], trustedStorefrontId: scope.trustedStorefrontId };
  const request =
    legalEntityId === undefined ? requestWithoutLegalEntity : { ...requestWithoutLegalEntity, legalEntityId };
  return contextAccess.assortmentPermissions(request).pipe(
    Effect.map((decisions) => {
      const expectedKey = toAssortmentPermissionAccessKey(scope.tenantId, legalEntityId, targetEntry.target);
      if (expectedKey === undefined) {
        return 'unavailable';
      }
      return decisionFor(decisions, expectedKey);
    }),
  );
};

const checkAtomicPermissionTarget = <AccessValue extends (typeof ContextAccess)['Service']>(
  contextAccess: AccessValue,
  scope: OperationalScope,
  target: AtomicResolvedReadPermissionTarget,
  allowMissingLegalEntity: boolean,
): Effect.Effect<PermissionDecision> => {
  if (target.kind === 'assortment_permission') {
    return checkAssortmentPermissionTarget(contextAccess, scope, target);
  }
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
      permissionTarget.businessPermission.permission === authorization.permission) ||
    (permissionTarget.kind === 'assortment_permission' &&
      permissionTarget.assortmentPermission.permission === authorization.permission)
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
        if (
          permissionTarget.kind === 'assortment_permission' &&
          assortmentPermissionTargetHasTrustedStorefrontMismatch(permissionTarget.assortmentPermission, scope)
        ) {
          return yield* new ReadPermissionUnavailable({
            code: 'read_permission_unavailable',
            reason: 'The trusted storefront scope does not match the requested Assortment target',
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
  if (permissionTarget.kind === 'business_permission' || permissionTarget.kind === 'assortment_permission') {
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
      const permissionTargetMetadata = targetMetadata(permissionTarget, scope);
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
          executor,
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

      const transactionResult = executor
        .transaction(
          Effect.fn('ReadRuntime.readTransactionBody')(function* readTransactionBody(transaction: CoreTransaction) {
            const scoped = yield* installOperationalScope(transaction, scope);
            stage('scope_installed');
            const operationAt = yield* trustedTransactionTime(transaction);
            const ownerAuthorizationDecision = yield* ownerAuthorizationOverlay.authorize(
              scoped,
              Object.freeze({
                operation: 'read' as const,
                operationAt,
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
            const services = yield* getReadServiceFactory(input.registration)(scoped, scope, compositionRevision);
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
            const result = yield* Schema.decodeUnknownEffect(
              Schema.toType(input.registration.descriptor.resultSchema),
              {
                onExcessProperty: 'error',
              },
            )(handlerResult.result).pipe(
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
      if (
        !cause.reasons.some((reason) => Cause.isFailReason(reason) && Schema.is(ReadPermissionDenied)(reason.error))
      ) {
        return yield* Effect.failCause(cause);
      }
      const evidenceExit = yield* Effect.exit(
        persistReadEvidence(
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
        ),
      );
      return yield* Effect.failCause(Exit.isFailure(evidenceExit) ? Cause.combine(evidenceExit.cause, cause) : cause);
    });
    if (compositionRevision === undefined) {
      return yield* executeTrustedRead(database.executor);
    }
    const governedExit = yield* database.executor
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
          const executionExit = yield* Effect.exit(executeTrustedRead(transaction));
          if (
            Exit.isFailure(executionExit) &&
            !executionExit.cause.reasons.every(
              (reason) =>
                Cause.isFailReason(reason) &&
                (Schema.is(ReadPermissionDenied)(reason.error) || Schema.is(ReadPolicyDenied)(reason.error)),
            )
          ) {
            return yield* Effect.failCause(executionExit.cause);
          }
          return executionExit;
        }),
      )
      .pipe(
        Effect.catchDefect((defect) => (isSqlError(defect) ? Effect.fail(defect) : Effect.die(defect))),
        Effect.catchCause((cause) =>
          Effect.failCause(
            cause.pipe(
              Cause.map((transactionFailure) =>
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
            ),
          ),
        ),
      );
    if (Exit.isSuccess(governedExit)) {
      return governedExit.value;
    }
    return yield* Effect.failCause(governedExit.cause);
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
