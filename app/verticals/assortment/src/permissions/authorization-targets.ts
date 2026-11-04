import type { OperationalScope, ResourceAccessTarget } from '@app/core-runtime';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { Match, Result, Schema } from 'effect';
import { Hex } from 'effect/encoding';

/**
 * Assortment authorization targets are intentionally separate from the legacy
 * BusinessAccessTarget family. Their meaning is an exact immutable policy
 * target, not a grant/revoke mutation target.
 */
const bindingCreatePermissionCode = 'assortment.binding.create';
const bindingEndPermissionCode = 'assortment.binding.end';
const boundaryCreatePermissionCode = 'assortment.boundary.create';
const boundaryEndPermissionCode = 'assortment.boundary.end';
const configurationReadPermissionCode = 'assortment.configuration.read';
const decisionExplainPermissionCode = 'assortment.decision.explain';
const ruleCreatePermissionCode = 'assortment.rule.create';
const ruleRevisionCreatePermissionCode = 'assortment.rule.revision.create';
const ruleRetirePermissionCode = 'assortment.rule.retire';

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
      readonly permission: typeof configurationReadPermissionCode;
      readonly resource: ResourceAccessTarget;
    }>
  | Readonly<{
      readonly catalogSelection: ResourceAccessTarget;
      readonly commercialScope: AssortmentPermissionCommercialScope;
      readonly kind: 'assortment_decision';
      readonly permission: typeof decisionExplainPermissionCode;
      readonly purpose: 'VISIBILITY' | 'PURCHASE';
      readonly subject: AssortmentPermissionSubject;
    }>
  | Readonly<{
      readonly effect: 'ALLOW' | 'DENY';
      readonly kind: 'assortment_rule';
      readonly mode: 'create';
      readonly permission: typeof ruleCreatePermissionCode;
      readonly purpose: 'VISIBILITY' | 'PURCHASE';
      readonly selector: AssortmentPermissionSelector;
      readonly stableCode: string;
    }>
  | Readonly<{
      readonly effect: 'ALLOW' | 'DENY';
      readonly kind: 'assortment_rule';
      readonly mode: 'revision_create';
      readonly permission: typeof ruleRevisionCreatePermissionCode;
      readonly purpose: 'VISIBILITY' | 'PURCHASE';
      readonly selector: AssortmentPermissionSelector;
      readonly stableRule: ResourceAccessTarget;
    }>
  | Readonly<{
      readonly kind: 'assortment_rule';
      readonly mode: 'retire';
      readonly permission: typeof ruleRetirePermissionCode;
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
      readonly permission: typeof bindingCreatePermissionCode;
      readonly ruleRevision: ResourceAccessTarget;
    }>
  | Readonly<{
      readonly binding: ResourceAccessTarget;
      readonly kind: 'assortment_binding';
      readonly mode: 'end';
      readonly permission: typeof bindingEndPermissionCode;
    }>
  | Readonly<{
      readonly admissionSet: AssortmentPermissionAdmissionSet;
      readonly commercialScope: AssortmentPermissionCommercialScope;
      readonly effectiveFrom: string;
      readonly kind: 'assortment_boundary';
      readonly mode: 'create';
      readonly permission: typeof boundaryCreatePermissionCode;
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
      readonly permission: typeof boundaryEndPermissionCode;
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

const ContextAccessObjectIdParts = Schema.fromJsonString(Schema.Array(Schema.String));
const encodeContextAccessObjectIdParts = Schema.encodeResult(ContextAccessObjectIdParts);
const AssortmentDigestParts = Schema.fromJsonString(
  Schema.Struct({
    marker: Schema.String,
    targets: Schema.Array(Schema.Array(Schema.String)),
  }),
);
const encodeAssortmentDigestParts = Schema.encodeResult(AssortmentDigestParts);

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
    : `asp_${Hex.encode(
        sha256(
          utf8ToBytes(
            Result.getOrThrow(
              encodeContextAccessObjectIdParts([...scopeIdentity, target.permission, ...assortmentTargetParts(target)]),
            ),
          ),
        ),
      )}`;
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
  return `asp_${Hex.encode(sha256(utf8ToBytes(encoded)))}`;
};

const stableTargetKey = (value: string): boolean => value.length > 0 && value.length <= 300;

const AssortmentResourceTargetSchema = Schema.Struct({
  moduleId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)).pipe(
    Schema.brand('AssortmentModuleId'),
  ),
  resourceId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)).pipe(
    Schema.brand('AssortmentResourceId'),
  ),
  resourceType: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
});
const AssortmentSelectorKindSchema = Schema.Literals(['ALL', 'CATEGORY', 'PRODUCT', 'VARIANT', 'PACKAGE_OPTION']);
const AssortmentPurposeSchema = Schema.Literals(['VISIBILITY', 'PURCHASE']);
const AssortmentEffectSchema = Schema.Literals(['ALLOW', 'DENY']);
const AssortmentSubjectKindSchema = Schema.Literals(['RETAIL_CUSTOMER_PROFILE', 'COUNTERPARTY']);
const AssortmentSelectorSchema = Schema.Struct({
  kind: AssortmentSelectorKindSchema,
  target: Schema.optionalKey(AssortmentResourceTargetSchema),
}).check(
  Schema.makeFilter((selector) =>
    (selector.kind === 'ALL') === (selector.target === undefined)
      ? undefined
      : 'Assortment ALL selectors cannot carry a target and other selectors require one',
  ),
);
const AssortmentScopeSchema = Schema.Struct({
  channel: AssortmentResourceTargetSchema,
  market: Schema.optionalKey(AssortmentResourceTargetSchema),
  storefront: Schema.optionalKey(AssortmentResourceTargetSchema),
});
const AssortmentSubjectSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('GUEST') }),
  Schema.Struct({
    kind: AssortmentSubjectKindSchema,
    ref: AssortmentResourceTargetSchema,
  }),
]);
const AssortmentAdmissionSetSchema = Schema.Union([
  Schema.Struct({
    contentHash: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
    entries: Schema.Tuple([]),
    memberCount: Schema.Literal(0),
    setKind: Schema.Literal('EMPTY'),
  }),
  Schema.Struct({
    contentHash: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
    entries: Schema.Array(AssortmentSelectorSchema).check(Schema.isMinLength(1)),
    memberCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    setKind: Schema.Literal('ENTRIES'),
  }).check(
    Schema.makeFilter((set) =>
      set.entries.length === set.memberCount ? undefined : 'Admission Set count must match its complete entries',
    ),
  ),
]);
export const AssortmentPermissionTargetSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('assortment_configuration'),
    permission: Schema.Literal(configurationReadPermissionCode),
    resource: AssortmentResourceTargetSchema,
  }),
  Schema.Struct({
    catalogSelection: AssortmentResourceTargetSchema,
    commercialScope: AssortmentScopeSchema,
    kind: Schema.Literal('assortment_decision'),
    permission: Schema.Literal(decisionExplainPermissionCode),
    purpose: AssortmentPurposeSchema,
    subject: AssortmentSubjectSchema,
  }),
  Schema.Struct({
    effect: AssortmentEffectSchema,
    kind: Schema.Literal('assortment_rule'),
    mode: Schema.Literal('create'),
    permission: Schema.Literal(ruleCreatePermissionCode),
    purpose: AssortmentPurposeSchema,
    selector: AssortmentSelectorSchema,
    stableCode: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
  }),
  Schema.Struct({
    effect: AssortmentEffectSchema,
    kind: Schema.Literal('assortment_rule'),
    mode: Schema.Literal('revision_create'),
    permission: Schema.Literal(ruleRevisionCreatePermissionCode),
    purpose: AssortmentPurposeSchema,
    selector: AssortmentSelectorSchema,
    stableRule: AssortmentResourceTargetSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal('assortment_rule'),
    mode: Schema.Literal('retire'),
    permission: Schema.Literal(ruleRetirePermissionCode),
    stableRule: AssortmentResourceTargetSchema,
  }),
  Schema.Struct({
    audience: Schema.Union([
      Schema.Struct({ kind: Schema.Literal('SHARED') }),
      Schema.Struct({ group: AssortmentResourceTargetSchema, kind: Schema.Literal('COMMERCE_CUSTOMER_GROUP') }),
      Schema.Struct({
        kind: Schema.Literal('SUBJECT'),
        subject: Schema.Union([
          Schema.Struct({
            kind: AssortmentSubjectKindSchema,
            ref: AssortmentResourceTargetSchema,
          }),
        ]),
      }),
    ]),
    commercialScope: AssortmentScopeSchema,
    effectiveFrom: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
    kind: Schema.Literal('assortment_binding'),
    mode: Schema.Literal('create'),
    permission: Schema.Literal(bindingCreatePermissionCode),
    ruleRevision: AssortmentResourceTargetSchema,
  }),
  Schema.Struct({
    binding: AssortmentResourceTargetSchema,
    kind: Schema.Literal('assortment_binding'),
    mode: Schema.Literal('end'),
    permission: Schema.Literal(bindingEndPermissionCode),
  }),
  Schema.Struct({
    admissionSet: AssortmentAdmissionSetSchema,
    commercialScope: AssortmentScopeSchema,
    effectiveFrom: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
    kind: Schema.Literal('assortment_boundary'),
    mode: Schema.Literal('create'),
    permission: Schema.Literal(boundaryCreatePermissionCode),
    purpose: AssortmentPurposeSchema,
    subject: Schema.Union([
      Schema.Struct({
        kind: AssortmentSubjectKindSchema,
        ref: AssortmentResourceTargetSchema,
      }),
    ]),
  }),
  Schema.Struct({
    boundary: AssortmentResourceTargetSchema,
    kind: Schema.Literal('assortment_boundary'),
    mode: Schema.Literal('end'),
    permission: Schema.Literal(boundaryEndPermissionCode),
  }),
]);
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
  target.permission === configurationReadPermissionCode &&
  isAssortmentPermissionTargetValid(target) &&
  assortmentResourceIsValid(target.resource);

const assortmentDecisionTargetIsValid = (
  target: Extract<AssortmentPermissionAccessTarget, { readonly kind: 'assortment_decision' }>,
  scope: OperationalScope,
): boolean =>
  target.permission === decisionExplainPermissionCode &&
  assortmentResourceIsValid(target.catalogSelection) &&
  assortmentScopeIsValid(target.commercialScope) &&
  assortmentSubjectIsValid(target.subject) &&
  storefrontScopeIsValid(target.commercialScope, scope);

const assortmentRuleTargetIsValid = (
  target: Extract<AssortmentPermissionAccessTarget, { readonly kind: 'assortment_rule' }>,
): boolean => {
  if (target.mode === 'retire') {
    return target.permission === ruleRetirePermissionCode && assortmentResourceIsValid(target.stableRule);
  }
  const expectedPermission = target.mode === 'create' ? ruleCreatePermissionCode : ruleRevisionCreatePermissionCode;
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
    return target.permission === bindingEndPermissionCode && assortmentResourceIsValid(target.binding);
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
    target.permission === bindingCreatePermissionCode &&
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
    return target.permission === boundaryEndPermissionCode && assortmentResourceIsValid(target.boundary);
  }
  const admissionSetValid =
    ((target.admissionSet.setKind === 'EMPTY' && target.admissionSet.memberCount === 0) ||
      (target.admissionSet.setKind === 'ENTRIES' && target.admissionSet.memberCount > 0)) &&
    target.admissionSet.memberCount === target.admissionSet.entries.length &&
    target.admissionSet.contentHash.length === 64 &&
    /^[0-9a-f]{64}$/u.test(target.admissionSet.contentHash) &&
    target.admissionSet.entries.every((entry) => assortmentSelectorIsValid(entry, target.purpose));
  return (
    target.permission === boundaryCreatePermissionCode &&
    assortmentSubjectIsValid(target.subject) &&
    assortmentScopeIsValid(target.commercialScope) &&
    stableTargetKey(target.effectiveFrom) &&
    storefrontScopeIsValid(target.commercialScope, scope) &&
    admissionSetValid
  );
};

export const assortmentPermissionTargetIsValid = (
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
