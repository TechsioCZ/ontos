import { v1 } from '@authzed/authzed-node';
import { createHash } from 'node:crypto';
import { Context, Effect, Layer, Match, Result, Schema } from 'effect';
import type { Scope } from 'effect';

import {
  SPICEDB_CHECK_TIMEOUT_MS,
  acquireSpiceDbClientResource,
  createSpiceDbPermissionClient,
  fullyConsistent,
  spiceDbPermissionClientError,
} from './client.ts';
import type { SpiceDbPermissionClient } from './client.ts';
import type { SpiceDbConfigError } from './config-error.ts';
import { loadSpiceDbConfig } from './config.ts';
import type { SpiceDbConfigValue } from './config.ts';
import type { BusinessPermissionCode } from './business-permission.ts';
import type { PrincipalRef } from './principal-ref.ts';
import type {
  IdentityNamespacePermissionKey,
  LegalEntityPermissionKey,
  TenantPermissionKey,
} from './context-permissions.ts';

const ContextAccessDecisionSchema = Schema.Literals(['allowed', 'denied', 'unavailable']);
export type ContextAccessDecision = typeof ContextAccessDecisionSchema.Type;

export interface ContextAccessResult {
  readonly decision: ContextAccessDecision;
  readonly key: string;
}

export interface ResourceAccessTarget {
  readonly moduleId: string;
  readonly resourceId: string;
  readonly resourceType: string;
}

export interface ContextPermissionAccessTarget {
  readonly moduleId: string;
  readonly permission: string;
}

/**
 * Assortment authorization targets are intentionally separate from the legacy
 * BusinessAccessTarget family. Their meaning is an exact immutable policy
 * target, not a grant/revoke mutation target.
 */
const AssortmentPermissionCodeSchema = Schema.Literals([
  'assortment.binding.create',
  'assortment.binding.end',
  'assortment.boundary.create',
  'assortment.boundary.end',
  'assortment.configuration.read',
  'assortment.decision.explain',
  'assortment.rule.create',
  'assortment.rule.revision.create',
  'assortment.rule.retire',
]);
export type AssortmentPermissionCode = typeof AssortmentPermissionCodeSchema.Type;

export interface AssortmentPermissionSelector {
  readonly kind: 'ALL' | 'CATEGORY' | 'PRODUCT' | 'VARIANT' | 'PACKAGE_OPTION';
  readonly target?: ResourceAccessTarget;
}

export interface AssortmentPermissionCommercialScope {
  readonly channel: ResourceAccessTarget;
  readonly market?: ResourceAccessTarget;
  readonly storefront?: ResourceAccessTarget;
}

export type AssortmentPermissionSubject =
  | Readonly<{ readonly kind: 'GUEST' }>
  | Readonly<{
      readonly kind: 'RETAIL_CUSTOMER_PROFILE' | 'COUNTERPARTY';
      readonly ref: ResourceAccessTarget;
    }>;

export type AssortmentPermissionAdmissionSet =
  | Readonly<{
      readonly contentHash: string;
      readonly entries: readonly [];
      readonly memberCount: 0;
      readonly setKind: 'EMPTY';
    }>
  | Readonly<{
      readonly contentHash: string;
      readonly entries: readonly AssortmentPermissionSelector[];
      readonly memberCount: number;
      readonly setKind: 'ENTRIES';
    }>;

export type AssortmentPermissionAccessTarget =
  | Readonly<{
      readonly kind: 'assortment_configuration';
      readonly permission: 'assortment.configuration.read';
      readonly resource: ResourceAccessTarget;
    }>
  | Readonly<{
      readonly catalogSelection: ResourceAccessTarget;
      readonly commercialScope: AssortmentPermissionCommercialScope;
      readonly kind: 'assortment_decision';
      readonly permission: 'assortment.decision.explain';
      readonly purpose: 'VISIBILITY' | 'PURCHASE';
      readonly subject: AssortmentPermissionSubject;
    }>
  | Readonly<{
      readonly effect: 'ALLOW' | 'DENY';
      readonly kind: 'assortment_rule';
      readonly mode: 'create';
      readonly permission: 'assortment.rule.create';
      readonly purpose: 'VISIBILITY' | 'PURCHASE';
      readonly selector: AssortmentPermissionSelector;
      readonly stableCode: string;
    }>
  | Readonly<{
      readonly effect: 'ALLOW' | 'DENY';
      readonly kind: 'assortment_rule';
      readonly mode: 'revision_create';
      readonly permission: 'assortment.rule.revision.create';
      readonly purpose: 'VISIBILITY' | 'PURCHASE';
      readonly selector: AssortmentPermissionSelector;
      readonly stableRule: ResourceAccessTarget;
    }>
  | Readonly<{
      readonly kind: 'assortment_rule';
      readonly mode: 'retire';
      readonly permission: 'assortment.rule.retire';
      readonly stableRule: ResourceAccessTarget;
    }>
  | Readonly<{
      readonly audience:
        | Readonly<{ readonly kind: 'SHARED' }>
        | Readonly<{ readonly group: ResourceAccessTarget; readonly kind: 'COMMERCE_CUSTOMER_GROUP' }>
        | Readonly<{ readonly kind: 'SUBJECT'; readonly subject: AssortmentPermissionSubject }>;
      readonly commercialScope: AssortmentPermissionCommercialScope;
      readonly effectiveFrom: string;
      readonly kind: 'assortment_binding';
      readonly mode: 'create';
      readonly permission: 'assortment.binding.create';
      readonly ruleRevision: ResourceAccessTarget;
    }>
  | Readonly<{
      readonly binding: ResourceAccessTarget;
      readonly kind: 'assortment_binding';
      readonly mode: 'end';
      readonly permission: 'assortment.binding.end';
    }>
  | Readonly<{
      readonly admissionSet: AssortmentPermissionAdmissionSet;
      readonly commercialScope: AssortmentPermissionCommercialScope;
      readonly effectiveFrom: string;
      readonly kind: 'assortment_boundary';
      readonly mode: 'create';
      readonly permission: 'assortment.boundary.create';
      readonly purpose: 'VISIBILITY' | 'PURCHASE';
      readonly subject: Extract<
        AssortmentPermissionSubject,
        { readonly kind: 'RETAIL_CUSTOMER_PROFILE' | 'COUNTERPARTY' }
      >;
    }>
  | Readonly<{
      readonly boundary: ResourceAccessTarget;
      readonly kind: 'assortment_boundary';
      readonly mode: 'end';
      readonly permission: 'assortment.boundary.end';
    }>;

export const AssortmentConfigurationResourceScopeSchema = Schema.Literals(['legal_entity', 'tenant']);
export type AssortmentConfigurationResourceScope = typeof AssortmentConfigurationResourceScopeSchema.Type;

const AssortmentConfigurationResourceTypeSchema = Schema.Literals([
  'commerce.assortment.applicability-binding',
  'commerce.assortment.closed-assortment-boundary',
  'commerce.assortment.rule-revision',
  'commerce.assortment.stable-rule',
]);

const assortmentConfigurationResourceScope = (
  resource: ResourceAccessTarget,
): AssortmentConfigurationResourceScope | undefined => {
  if (resource.moduleId !== 'commerce.assortment' || resource.resourceId.length === 0) {
    return undefined;
  }
  if (!Schema.is(AssortmentConfigurationResourceTypeSchema)(resource.resourceType)) {
    return undefined;
  }
  return Match.value(resource.resourceType).pipe(
    Match.when('commerce.assortment.stable-rule', () => 'tenant' as const),
    Match.when('commerce.assortment.rule-revision', () => 'tenant' as const),
    Match.when('commerce.assortment.applicability-binding', () => 'legal_entity' as const),
    Match.when('commerce.assortment.closed-assortment-boundary', () => 'legal_entity' as const),
    Match.exhaustive,
  );
};

const assortmentRefParts = (ref: ResourceAccessTarget): readonly string[] => [
  ref.moduleId,
  ref.resourceType,
  ref.resourceId,
];

/**
 * Configuration targets are restricted to the four canonical Assortment
 * resources. Scope is derived from that trusted resource type, never from a
 * caller-supplied discriminator.
 */
export const isAssortmentPermissionTargetValid = (target: AssortmentPermissionAccessTarget): boolean =>
  target.kind === 'assortment_configuration'
    ? assortmentConfigurationResourceScope(target.resource) !== undefined
    : target.kind !== 'assortment_boundary' ||
      target.mode !== 'create' ||
      (Array.isArray(target.admissionSet.entries) &&
        Number.isInteger(target.admissionSet.memberCount) &&
        /^[0-9a-f]{64}$/u.test(target.admissionSet.contentHash) &&
        target.admissionSet.memberCount === target.admissionSet.entries.length &&
        (target.admissionSet.setKind === 'EMPTY') === (target.admissionSet.entries.length === 0) &&
        (target.purpose !== 'VISIBILITY' ||
          target.admissionSet.entries.every(
            (entry: AssortmentPermissionSelector) => entry.kind !== 'VARIANT' && entry.kind !== 'PACKAGE_OPTION',
          )) &&
        target.admissionSet.entries.every((entry: AssortmentPermissionSelector) =>
          entry.kind === 'ALL'
            ? entry.target === undefined
            : entry.target !== undefined && assortmentRefParts(entry.target).every((part) => part.length > 0),
        ));

/** Rule lineage and Rule Revisions are tenant-owned; other config is Legal Entity-owned. */
export const assortmentPermissionTargetRequiresLegalEntity = (target: AssortmentPermissionAccessTarget): boolean => {
  if (target.kind === 'assortment_configuration') {
    return assortmentConfigurationResourceScope(target.resource) !== 'tenant';
  }
  return target.kind !== 'assortment_rule';
};

export interface AssortmentPermissionAccessTargetWithTrustedStorefront {
  readonly target: AssortmentPermissionAccessTarget;
}

export type BusinessAccessTarget =
  | Readonly<{
      kind: 'retail_profile';
      legalEntityId: string;
      profileId: string;
      tenantId: string;
    }>
  | Readonly<{
      counterpartyId: string;
      kind: 'counterparty';
      legalEntityId: string;
      tenantId: string;
    }>
  | Readonly<{
      counterpartyId: string;
      kind: 'counterparty_storefront';
      legalEntityId: string;
      storefrontId: string;
      tenantId: string;
    }>
  | Readonly<{
      kind: 'pricing_catalog';
      pricingCatalogId: string;
      tenantId: string;
    }>
  | Readonly<{
      kind: 'price_group';
      priceGroupId: string;
      pricingCatalogId: string;
      tenantId: string;
    }>
  | Readonly<{
      kind: 'inventory_resource';
      resource: Readonly<{
        moduleId: 'commerce.inventory';
        resourceId: string;
        resourceType: string;
      }>;
      tenantId: string;
    }>;

const canonicalPricingAuthorizationResourceId = Schema.String.check(Schema.isUUID());

/** Stable Pricing authorization identity. Business codes and display values are never valid targets. */
export const PricingAuthorizationResourceIdSchema = canonicalPricingAuthorizationResourceId.pipe(
  Schema.brand('PricingAuthorizationResourceId'),
  Schema.decodeTo(canonicalPricingAuthorizationResourceId),
);

const canonicalInventoryAuthorizationResourceId = Schema.String.check(Schema.isUUID());
const canonicalInventoryAuthorizationResourceType = Schema.String.check(
  Schema.isPattern(/^commerce\.inventory\.[a-z][a-z0-9-]*$/u),
);

/** Durable Inventory resource identity. Location/item tuples and display keys are never valid targets. */
export const InventoryAuthorizationResourceIdSchema = canonicalInventoryAuthorizationResourceId.pipe(
  Schema.brand('InventoryAuthorizationResourceId'),
  Schema.decodeTo(canonicalInventoryAuthorizationResourceId),
);

export const InventoryAuthorizationResourceTypeSchema = canonicalInventoryAuthorizationResourceType.pipe(
  Schema.brand('InventoryAuthorizationResourceType'),
  Schema.decodeTo(canonicalInventoryAuthorizationResourceType),
);

export interface BusinessPermissionAccessTarget {
  readonly permission: BusinessPermissionCode;
  readonly target: BusinessAccessTarget;
}

export const hasCanonicalPricingAuthorizationTargetIds = (target: BusinessAccessTarget): boolean =>
  target.kind !== 'pricing_catalog' && target.kind !== 'price_group'
    ? true
    : Schema.is(PricingAuthorizationResourceIdSchema)(target.pricingCatalogId) &&
      (target.kind !== 'price_group' || Schema.is(PricingAuthorizationResourceIdSchema)(target.priceGroupId));

export const hasCanonicalInventoryAuthorizationTarget = (target: BusinessAccessTarget): boolean =>
  target.kind !== 'inventory_resource' ||
  (target.resource.moduleId === 'commerce.inventory' &&
    Schema.is(InventoryAuthorizationResourceIdSchema)(target.resource.resourceId) &&
    Schema.is(InventoryAuthorizationResourceTypeSchema)(target.resource.resourceType));

/** Keeps every business Permission family on its declared authorization target vocabulary. */
export const isBusinessPermissionTargetCompatible = ({
  permission,
  target,
}: BusinessPermissionAccessTarget): boolean => {
  if (permission.startsWith('pricing.price_group.')) {
    return target.kind === 'pricing_catalog' || target.kind === 'price_group';
  }
  if (permission.startsWith('retail.')) {
    return target.kind === 'retail_profile';
  }
  if (permission.startsWith('inventory.')) {
    return target.kind === 'inventory_resource';
  }
  return (
    permission.startsWith('counterparty.') &&
    (target.kind === 'counterparty' || target.kind === 'counterparty_storefront')
  );
};

export interface ContextAccessService {
  readonly assortmentPermissions?: (input: {
    readonly legalEntityId?: string;
    readonly principal: PrincipalRef;
    readonly targets: readonly AssortmentPermissionAccessTargetWithTrustedStorefront[];
    /** Storefront identity resolved by a trusted application boundary, never raw client input. */
    readonly trustedStorefrontId?: string;
  }) => Effect.Effect<readonly ContextAccessResult[]>;
  readonly businessPermissions?: (input: {
    readonly principal: PrincipalRef;
    readonly targets: readonly BusinessPermissionAccessTarget[];
    /** Storefront identity resolved by a trusted application boundary, never raw client input. */
    readonly trustedStorefrontId?: string;
  }) => Effect.Effect<readonly ContextAccessResult[]>;
  /**
   * Checks an exact named entrypoint permission in trusted Tenant/Legal Entity scope.
   * Optional for compatibility with older adapters; runtimes must treat absence as unavailable.
   */
  readonly contextPermissions?: (input: {
    readonly legalEntityId?: string;
    readonly principalId: string;
    readonly targets: readonly ContextPermissionAccessTarget[];
    readonly tenantId: string;
  }) => Effect.Effect<readonly ContextAccessResult[]>;
  /**
   * Checks the explicit provisioning capability for exact Tenant/namespace pairs.
   * Optional for compatibility with older adapters; identity Actions must treat
   * an absent implementation as unavailable.
   */
  readonly identityNamespaces?: (input: {
    readonly authenticationNamespaceIds: readonly string[];
    readonly permission?: IdentityNamespacePermissionKey;
    readonly principalId: string;
    readonly tenantId: string;
  }) => Effect.Effect<readonly ContextAccessResult[]>;
  readonly legalEntities: (input: {
    readonly legalEntityIds: readonly string[];
    readonly permission?: LegalEntityPermissionKey;
    readonly principalId: string;
    readonly tenantId: string;
  }) => Effect.Effect<readonly ContextAccessResult[]>;
  readonly modules: (input: {
    readonly legalEntityId: string;
    readonly moduleIds: readonly string[];
    readonly principalId: string;
    readonly tenantId: string;
  }) => Effect.Effect<readonly ContextAccessResult[]>;
  readonly resources: (input: {
    readonly legalEntityId: string;
    readonly permission?: 'read' | 'write';
    readonly principalId: string;
    readonly resources: readonly ResourceAccessTarget[];
    readonly tenantId: string;
  }) => Effect.Effect<readonly ContextAccessResult[]>;
  readonly tenants: (input: {
    readonly permission: TenantPermissionKey;
    readonly principalId: string;
    readonly tenantIds: readonly string[];
  }) => Effect.Effect<readonly ContextAccessResult[]>;
}

export class ContextAccess extends Context.Service<ContextAccess, ContextAccessService>()(
  '@app/core-runtime/permissions/context-access/ContextAccess',
) {}

export type ContextAccessClientFactory = (
  configuration: SpiceDbConfigValue,
  timeoutMilliseconds: number,
) => SpiceDbPermissionClient;

interface BatchItem {
  readonly key: string;
  readonly permission: string;
  readonly resourceId: string;
  readonly resourceType: string;
}

const ContextAccessObjectIdParts = Schema.fromJsonString(Schema.Array(Schema.String));
const encodeContextAccessObjectIdParts = Schema.encodeResult(ContextAccessObjectIdParts);
const AssortmentDigestParts = Schema.fromJsonString(
  Schema.Struct({
    marker: Schema.String,
    targets: Schema.Array(Schema.Array(Schema.String)),
  }),
);
const encodeAssortmentDigestParts = Schema.encodeResult(AssortmentDigestParts);

const principalReference = (principalId: string) =>
  v1.SubjectReference.create({
    object: v1.ObjectReference.create({
      objectId: principalId,
      objectType: 'principal',
    }),
  });

const encodeObjectId = (parts: readonly string[]): string | undefined => {
  if (parts.some((part) => part.length === 0)) {
    return undefined;
  }
  const encodedParts = Result.getOrThrow(encodeContextAccessObjectIdParts(parts));
  const encoded = `ctx_${Buffer.from(encodedParts, 'utf-8').toString('base64url')}`;
  return encoded.length <= 1024 ? encoded : undefined;
};

export const toLegalEntityAccessObjectId = (tenantId: string, legalEntityId: string): string | undefined =>
  encodeObjectId([tenantId, legalEntityId]);

export const toModuleAccessObjectId = (tenantId: string, legalEntityId: string, moduleId: string): string | undefined =>
  encodeObjectId([tenantId, legalEntityId, moduleId]);

export const toResourceAccessObjectId = (
  tenantId: string,
  legalEntityId: string,
  resource: ResourceAccessTarget,
): string | undefined =>
  encodeObjectId([tenantId, legalEntityId, resource.moduleId, resource.resourceType, resource.resourceId]);

const businessTargetParts = (target: BusinessAccessTarget): readonly string[] => {
  if (target.kind === 'retail_profile') {
    return [target.tenantId, target.legalEntityId, target.kind, target.profileId];
  }
  if (target.kind === 'counterparty') {
    return [target.tenantId, target.legalEntityId, target.kind, target.counterpartyId];
  }
  if (target.kind === 'counterparty_storefront') {
    return [target.tenantId, target.legalEntityId, target.kind, target.counterpartyId, target.storefrontId];
  }
  if (target.kind === 'pricing_catalog') {
    return [target.tenantId, target.kind, target.pricingCatalogId];
  }
  if (target.kind === 'price_group') {
    return [target.tenantId, target.kind, target.pricingCatalogId, target.priceGroupId];
  }
  return [
    target.tenantId,
    target.kind,
    target.resource.moduleId,
    target.resource.resourceType,
    target.resource.resourceId,
  ];
};

export const toBusinessPermissionAccessObjectId = (
  permission: BusinessPermissionCode,
  target: BusinessAccessTarget,
): string | undefined =>
  isBusinessPermissionTargetCompatible({ permission, target }) &&
  hasCanonicalPricingAuthorizationTargetIds(target) &&
  hasCanonicalInventoryAuthorizationTarget(target)
    ? encodeObjectId([permission, ...businessTargetParts(target)])
    : undefined;

export const toBusinessPermissionAccessKey = ({ permission, target }: BusinessPermissionAccessTarget): string =>
  [permission, ...businessTargetParts(target)].join(':');

const assortmentScopeParts = (scope: AssortmentPermissionCommercialScope): readonly string[] => [
  'channel',
  ...assortmentRefParts(scope.channel),
  'market',
  ...(scope.market === undefined ? ['none'] : assortmentRefParts(scope.market)),
  'storefront',
  ...(scope.storefront === undefined ? ['none'] : assortmentRefParts(scope.storefront)),
];

const assortmentSelectorParts = (selector: AssortmentPermissionSelector): readonly string[] => [
  selector.kind,
  ...(selector.target === undefined ? ['none'] : assortmentRefParts(selector.target)),
];

const assortmentSubjectParts = (subject: AssortmentPermissionSubject): readonly string[] => [
  subject.kind,
  ...(subject.kind === 'GUEST' ? [] : assortmentRefParts(subject.ref)),
];

const assortmentTargetParts = (target: AssortmentPermissionAccessTarget): readonly string[] => {
  if (target.kind === 'assortment_configuration') {
    return [target.kind, ...assortmentRefParts(target.resource)];
  }
  if (target.kind === 'assortment_decision') {
    return [
      target.kind,
      target.purpose,
      ...assortmentRefParts(target.catalogSelection),
      ...assortmentScopeParts(target.commercialScope),
      ...assortmentSubjectParts(target.subject),
    ];
  }
  if (target.kind === 'assortment_rule') {
    if (target.mode === 'retire') {
      return [target.kind, target.mode, ...assortmentRefParts(target.stableRule)];
    }
    return [
      target.kind,
      target.mode,
      target.purpose,
      target.effect,
      ...(target.mode === 'create' ? [target.stableCode] : assortmentRefParts(target.stableRule)),
      ...assortmentSelectorParts(target.selector),
    ];
  }
  if (target.kind === 'assortment_binding') {
    if (target.mode === 'end') {
      return [target.kind, target.mode, ...assortmentRefParts(target.binding)];
    }
    let audience: readonly string[];
    if (target.audience.kind === 'SHARED') {
      audience = ['SHARED'];
    } else if (target.audience.kind === 'COMMERCE_CUSTOMER_GROUP') {
      audience = [target.audience.kind, ...assortmentRefParts(target.audience.group)];
    } else {
      audience = [target.audience.kind, ...assortmentSubjectParts(target.audience.subject)];
    }
    return [
      target.kind,
      target.mode,
      ...assortmentRefParts(target.ruleRevision),
      ...audience,
      ...assortmentScopeParts(target.commercialScope),
      target.effectiveFrom,
    ];
  }
  if (target.mode === 'end') {
    return [target.kind, target.mode, ...assortmentRefParts(target.boundary)];
  }
  return [
    target.kind,
    target.mode,
    target.purpose,
    ...assortmentSubjectParts(target.subject),
    ...assortmentScopeParts(target.commercialScope),
    target.effectiveFrom,
    target.admissionSet.setKind,
    String(target.admissionSet.memberCount),
    target.admissionSet.contentHash,
    ...target.admissionSet.entries.flatMap(assortmentSelectorParts),
  ];
};

const assortmentScopeIdentity = (
  tenantId: string,
  legalEntityId: string | undefined,
  target: AssortmentPermissionAccessTarget,
): readonly string[] | undefined => {
  if (tenantId.length === 0) {
    return undefined;
  }
  if (assortmentPermissionTargetRequiresLegalEntity(target)) {
    return legalEntityId === undefined || legalEntityId.length === 0
      ? undefined
      : [tenantId, 'legal_entity', legalEntityId];
  }
  return [tenantId, 'tenant'];
};

export const toAssortmentPermissionAccessKey = (
  tenantId: string,
  legalEntityId: string | undefined,
  target: AssortmentPermissionAccessTarget,
): string | undefined => {
  if (!isAssortmentPermissionTargetValid(target)) {
    return undefined;
  }
  const scopeIdentity = assortmentScopeIdentity(tenantId, legalEntityId, target);
  return scopeIdentity === undefined
    ? undefined
    : [...scopeIdentity, target.permission, ...assortmentTargetParts(target)].join(':');
};

export const toAssortmentPermissionAccessObjectId = (
  tenantId: string,
  legalEntityId: string | undefined,
  target: AssortmentPermissionAccessTarget,
): string | undefined => {
  const scopeIdentity = isAssortmentPermissionTargetValid(target)
    ? assortmentScopeIdentity(tenantId, legalEntityId, target)
    : undefined;
  return scopeIdentity === undefined
    ? undefined
    : `asp_${createHash('sha256')
        .update(
          Result.getOrThrow(
            encodeContextAccessObjectIdParts([...scopeIdentity, target.permission, ...assortmentTargetParts(target)]),
          ),
        )
        .digest('hex')}`;
};

/**
 * Canonical digest for an ordered conjunctive Assortment authorization request.
 * The ordered target list is part of the meaning: Replace operations must retain
 * both the old exact target and the proposed exact target in audit/transport data.
 */
export const toAssortmentPermissionAccessObjectIdForTargets = (
  tenantId: string,
  legalEntityId: string | undefined,
  targets: readonly AssortmentPermissionAccessTarget[],
): string | undefined => {
  if (tenantId.length === 0 || targets.length === 0) {
    return undefined;
  }
  const scopeIdentities: string[][] = [];
  for (const target of targets) {
    if (!isAssortmentPermissionTargetValid(target)) {
      return undefined;
    }
    const scopeIdentity = assortmentScopeIdentity(tenantId, legalEntityId, target);
    if (scopeIdentity === undefined) {
      return undefined;
    }
    scopeIdentities.push([...scopeIdentity, target.permission, ...assortmentTargetParts(target)]);
  }
  const encoded = Result.getOrThrow(
    encodeAssortmentDigestParts({ marker: 'assortment_permission_conjunction', targets: scopeIdentities }),
  );
  return `asp_${createHash('sha256').update(encoded).digest('hex')}`;
};

export const toContextPermissionAccessKey = ({ moduleId, permission }: ContextPermissionAccessTarget): string =>
  `${moduleId}:${permission}`;

export const toContextPermissionAccessObjectId = (
  tenantId: string,
  legalEntityId: string | undefined,
  target: ContextPermissionAccessTarget,
): string | undefined =>
  encodeObjectId([
    tenantId,
    legalEntityId === undefined ? 'tenant' : 'legal_entity',
    legalEntityId ?? tenantId,
    target.moduleId,
    target.permission,
  ]);

export const toIdentityNamespaceAccessObjectId = (
  tenantId: string,
  authenticationNamespaceId: string,
): string | undefined => encodeObjectId([tenantId, authenticationNamespaceId]);

const unavailable = (keys: readonly string[]): readonly ContextAccessResult[] =>
  keys.map((key) => ({ decision: 'unavailable' as const, key }));

const classifyPair = (pair: v1.CheckBulkPermissionsPair): ContextAccessDecision => {
  if (pair.response.oneofKind !== 'item') {
    return 'unavailable';
  }
  const { permissionship } = pair.response.item;
  if (permissionship === v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION) {
    return 'allowed';
  }
  if (permissionship === v1.CheckPermissionResponse_Permissionship.NO_PERMISSION) {
    return 'denied';
  }
  return 'unavailable';
};

const assortmentTargetHasTrustedStorefront = (
  target: AssortmentPermissionAccessTarget,
  trustedStorefrontId: string | undefined,
): boolean => {
  const storefront =
    target.kind === 'assortment_decision' ||
    (target.kind === 'assortment_binding' && target.mode === 'create') ||
    (target.kind === 'assortment_boundary' && target.mode === 'create')
      ? target.commercialScope.storefront
      : undefined;
  return storefront === undefined
    ? true
    : trustedStorefrontId !== undefined && trustedStorefrontId === storefront.resourceId;
};

const foldAlternativeDecisions = (decisions: readonly ContextAccessDecision[]): ContextAccessDecision => {
  if (decisions.includes('allowed')) {
    return 'allowed';
  }
  return decisions.includes('unavailable') ? 'unavailable' : 'denied';
};

const contextAccessDecisions = (results: readonly ContextAccessResult[]): readonly ContextAccessDecision[] =>
  results.map(({ decision }) => decision);

const resultsForBatchItems = (
  items: readonly BatchItem[],
  resultsByKey: ReadonlyMap<string, ContextAccessResult>,
): readonly ContextAccessResult[] =>
  items.flatMap((item) => {
    const result = resultsByKey.get(item.key);
    return result === undefined ? [] : [result];
  });

const makeRequestItem = (item: BatchItem, principalId: string) =>
  v1.CheckBulkPermissionsRequestItem.create({
    permission: item.permission,
    resource: v1.ObjectReference.create({
      objectId: item.resourceId,
      objectType: item.resourceType,
    }),
    subject: principalReference(principalId),
  });

const sameObjectReference = (
  expected: v1.ObjectReference | undefined,
  actual: v1.ObjectReference | undefined,
): boolean => actual?.objectId === expected?.objectId && actual?.objectType === expected?.objectType;

const sameRequest = (
  expected: v1.CheckBulkPermissionsRequestItem,
  actual: v1.CheckBulkPermissionsRequestItem | undefined,
): boolean =>
  actual?.permission === expected.permission &&
  sameObjectReference(expected.resource, actual.resource) &&
  sameObjectReference(expected.subject?.object, actual.subject?.object);

export const makeContextAccess = (client: SpiceDbPermissionClient): ContextAccessService => {
  const checkBatch = (
    items: readonly BatchItem[],
    principalId: string,
  ): Effect.Effect<readonly ContextAccessResult[]> => {
    const keys = items.map(({ key }) => key);
    if (
      principalId.length === 0 ||
      new Set(keys).size !== keys.length ||
      items.some(({ resourceId }) => resourceId.length === 0)
    ) {
      return Effect.succeed(unavailable(keys));
    }
    if (items.length === 0) {
      return Effect.succeed([]);
    }
    const requests = items.map((item) => makeRequestItem(item, principalId));
    return client
      .checkBulkPermissions(
        v1.CheckBulkPermissionsRequest.create({
          consistency: fullyConsistent,
          items: requests,
          withTracing: false,
        }),
      )
      .pipe(
        Effect.map((response) => {
          if (response.pairs.length !== requests.length) {
            return unavailable(keys);
          }
          const seen = new Set<string>();
          const decisions = response.pairs.map((pair, index) => {
            const expected = requests[index];
            const key = keys[index];
            if (expected === undefined || key === undefined || !sameRequest(expected, pair.request) || seen.has(key)) {
              return null;
            }
            seen.add(key);
            return { decision: classifyPair(pair), key };
          });
          return decisions.every((decision): decision is ContextAccessResult => decision !== null)
            ? decisions
            : unavailable(keys);
        }),
        Effect.catchTag('SpiceDbPermissionClientError', () => Effect.succeed(unavailable(keys))),
      );
  };

  const service: ContextAccessService = {
    assortmentPermissions: ({ legalEntityId, principal, targets, trustedStorefrontId }) => {
      const invalid =
        principal.principalId.length === 0 ||
        principal.tenantId.length === 0 ||
        targets.some(({ target }) => !isAssortmentPermissionTargetValid(target)) ||
        new Set(targets.map(({ target }) => toAssortmentPermissionAccessKey(principal.tenantId, legalEntityId, target)))
          .size !== targets.length ||
        targets.some(
          ({ target }) =>
            assortmentPermissionTargetRequiresLegalEntity(target) &&
            (legalEntityId === undefined || legalEntityId.length === 0),
        ) ||
        targets.some(({ target }) => {
          const effectiveStorefront = trustedStorefrontId;
          return (
            !assortmentTargetHasTrustedStorefront(target, effectiveStorefront) ||
            assortmentTargetParts(target).some((part) => part.length === 0)
          );
        });
      if (invalid) {
        return Effect.succeed(unavailable(targets.map(({ target }) => `${target.permission}:${target.kind}`)));
      }
      const items = targets.map((entry): BatchItem => ({
        key: toAssortmentPermissionAccessKey(principal.tenantId, legalEntityId, entry.target) ?? '',
        permission: 'use',
        resourceId: toAssortmentPermissionAccessObjectId(principal.tenantId, legalEntityId, entry.target) ?? '',
        resourceType: 'business_permission',
      }));
      return checkBatch(items, principal.principalId);
    },
    businessPermissions: ({ principal, targets, trustedStorefrontId }) => {
      const alternatives = targets.map((target) => {
        const hasTrustedTenant = target.target.tenantId === principal.tenantId;
        const hasCompatibleTarget =
          isBusinessPermissionTargetCompatible(target) &&
          hasCanonicalPricingAuthorizationTargetIds(target.target) &&
          hasCanonicalInventoryAuthorizationTarget(target.target);
        const hasTrustedStorefront =
          target.target.kind !== 'counterparty_storefront' ||
          (trustedStorefrontId !== undefined && trustedStorefrontId === target.target.storefrontId);
        const requestedKey = toBusinessPermissionAccessKey(target);
        if (!hasTrustedTenant || !hasCompatibleTarget || !hasTrustedStorefront) {
          const noItems: readonly BatchItem[] = [];
          return { items: noItems, requestedKey };
        }
        const exactItem: BatchItem = {
          key: requestedKey,
          permission: 'use',
          resourceId: toBusinessPermissionAccessObjectId(target.permission, target.target) ?? '',
          resourceType: 'business_permission',
        };
        if (target.target.kind !== 'counterparty_storefront') {
          return { items: [exactItem], requestedKey };
        }
        const counterpartyTarget: BusinessPermissionAccessTarget = {
          permission: target.permission,
          target: {
            counterpartyId: target.target.counterpartyId,
            kind: 'counterparty',
            legalEntityId: target.target.legalEntityId,
            tenantId: target.target.tenantId,
          },
        };
        const counterpartyKey = toBusinessPermissionAccessKey(counterpartyTarget);
        return {
          items: [
            exactItem,
            {
              key: counterpartyKey,
              permission: 'use',
              resourceId:
                toBusinessPermissionAccessObjectId(counterpartyTarget.permission, counterpartyTarget.target) ?? '',
              resourceType: 'business_permission',
            },
          ],
          requestedKey,
        };
      });
      if (alternatives.some(({ items }) => items.length === 0)) {
        return Effect.succeed(unavailable(alternatives.map(({ requestedKey }) => requestedKey)));
      }
      const batchItems = alternatives.flatMap(({ items: alternativeItems }) => alternativeItems);
      const uniqueBatchItems = [...new Map(batchItems.map((item) => [item.key, item])).values()];
      return checkBatch(uniqueBatchItems, principal.principalId).pipe(
        Effect.map((results) => {
          const resultsByKey = new Map(results.map((result) => [result.key, result]));
          return alternatives.map(({ items: targetItems, requestedKey }) => {
            const targetResults = resultsForBatchItems(targetItems, resultsByKey);
            return {
              decision:
                targetResults.length === targetItems.length
                  ? foldAlternativeDecisions(contextAccessDecisions(targetResults))
                  : ('unavailable' as const),
              key: requestedKey,
            };
          });
        }),
      );
    },
    contextPermissions: ({ legalEntityId, principalId, targets, tenantId }) =>
      checkBatch(
        targets.map((target) => ({
          key: toContextPermissionAccessKey(target),
          permission: 'access',
          resourceId: toContextPermissionAccessObjectId(tenantId, legalEntityId, target) ?? '',
          resourceType: 'context_permission',
        })),
        principalId,
      ),
    identityNamespaces: ({ authenticationNamespaceIds, permission = 'provision', principalId, tenantId }) =>
      checkBatch(
        authenticationNamespaceIds.map((authenticationNamespaceId) => ({
          key: authenticationNamespaceId,
          permission,
          resourceId: toIdentityNamespaceAccessObjectId(tenantId, authenticationNamespaceId) ?? '',
          resourceType: 'identity_namespace',
        })),
        principalId,
      ),
    legalEntities: ({ legalEntityIds, permission = 'access', principalId, tenantId }) =>
      checkBatch(
        legalEntityIds.map((legalEntityId) => ({
          key: legalEntityId,
          permission,
          resourceId: toLegalEntityAccessObjectId(tenantId, legalEntityId) ?? '',
          resourceType: 'legal_entity',
        })),
        principalId,
      ),
    modules: ({ legalEntityId, moduleIds, principalId, tenantId }) =>
      checkBatch(
        moduleIds.map((moduleId) => ({
          key: moduleId,
          permission: 'access',
          resourceId: toModuleAccessObjectId(tenantId, legalEntityId, moduleId) ?? '',
          resourceType: 'module_access',
        })),
        principalId,
      ),
    resources: ({ legalEntityId, permission = 'read', principalId, resources, tenantId }) =>
      checkBatch(
        resources.map((resource) => ({
          key: `${resource.moduleId}:${resource.resourceType}:${resource.resourceId}`,
          permission,
          resourceId: toResourceAccessObjectId(tenantId, legalEntityId, resource) ?? '',
          resourceType: 'resource',
        })),
        principalId,
      ),
    tenants: ({ permission, principalId, tenantIds }) =>
      checkBatch(
        tenantIds.map((tenantId) => ({
          key: tenantId,
          permission,
          resourceId: tenantId,
          resourceType: 'tenant',
        })),
        principalId,
      ),
  };
  return Object.freeze(service);
};

const unavailableContextAccess = (): ContextAccessService => {
  const service: ContextAccessService = {
    assortmentPermissions: ({ targets }) =>
      Effect.succeed(unavailable(targets.map(({ target }) => `${target.permission}:${target.kind}`))),
    businessPermissions: ({ targets }) => Effect.succeed(unavailable(targets.map(toBusinessPermissionAccessKey))),
    contextPermissions: ({ targets }) => Effect.succeed(unavailable(targets.map(toContextPermissionAccessKey))),
    identityNamespaces: ({ authenticationNamespaceIds }) => Effect.succeed(unavailable(authenticationNamespaceIds)),
    legalEntities: ({ legalEntityIds }) => Effect.succeed(unavailable(legalEntityIds)),
    modules: ({ moduleIds }) => Effect.succeed(unavailable(moduleIds)),
    resources: ({ resources }) =>
      Effect.succeed(
        unavailable(
          resources.map(({ moduleId, resourceId, resourceType }) => `${moduleId}:${resourceType}:${resourceId}`),
        ),
      ),
    tenants: ({ tenantIds }) => Effect.succeed(unavailable(tenantIds)),
  };
  return Object.freeze(service);
};

export const makeContextAccessLive = (
  clientFactory: ContextAccessClientFactory = createSpiceDbPermissionClient,
  loadConfiguration: () => Effect.Effect<SpiceDbConfigValue, SpiceDbConfigError> = loadSpiceDbConfig,
): Effect.Effect<ContextAccessService, never, Scope.Scope> =>
  loadConfiguration().pipe(
    Effect.flatMap((configuration) =>
      acquireSpiceDbClientResource(
        () => clientFactory(configuration, SPICEDB_CHECK_TIMEOUT_MS),
        spiceDbPermissionClientError,
      ).pipe(
        Effect.map(makeContextAccess),
        Effect.catchTag('SpiceDbPermissionClientError', () => Effect.succeed(unavailableContextAccess())),
      ),
    ),
    Effect.catchTag('SpiceDbConfigError', () => Effect.succeed(unavailableContextAccess())),
  );

export const ContextAccessLive = Layer.effect(ContextAccess, makeContextAccessLive());
