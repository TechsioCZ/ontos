import type { OperationalScope } from '@app/core-runtime';
import { DateTime, Match } from 'effect';
import type {
  AssortmentBindingAudience,
  CreateApplicabilityBindingPayload,
  CreateRulePayload,
  CreateRuleRevisionPayload,
  EndApplicabilityBindingPayload,
  ReplaceApplicabilityBindingPayload,
  RetireRulePayload,
} from '../../shared/actions/policy-administration.ts';
import type { AssortmentCommercialScope } from '../../shared/domain/decision-contracts.ts';
import { AssortmentPolicyTargetInvariant } from '../../shared/domain/policy-errors.ts';
import { assortmentMeaningFingerprint } from '../services/policy-administration.service.ts';

interface ResourceRefLike {
  readonly moduleId: string;
  readonly resourceId: string;
  readonly resourceType: string;
}
type TenantResourceRefLike = ResourceRefLike & Readonly<{ readonly tenantId: string }>;
type CommercialScopeTarget = Readonly<{
  readonly channel: ResourceRefLike;
  readonly market?: ResourceRefLike;
  readonly storefront?: ResourceRefLike;
}>;
interface MutableCommercialScopeTarget {
  channel: ResourceRefLike;
  market?: ResourceRefLike;
  storefront?: ResourceRefLike;
}

export const toResourceAccessTarget = (ref: ResourceRefLike) => ({
  moduleId: ref.moduleId,
  resourceId: ref.resourceId,
  resourceType: ref.resourceType,
});

export const toCommercialScopeTarget = (scope: AssortmentCommercialScope) => {
  const target: MutableCommercialScopeTarget = {
    channel: toResourceAccessTarget(scope.channelRef),
  } satisfies CommercialScopeTarget;
  if (scope.commerceMarketRef !== undefined) {
    target.market = toResourceAccessTarget(scope.commerceMarketRef);
  }
  if (scope.storefrontRef !== undefined) {
    target.storefront = toResourceAccessTarget(scope.storefrontRef);
  }
  return target;
};

const categorySelectorRef = ({ categoryRef }: Extract<CreateRulePayload['selector'], { readonly kind: 'CATEGORY' }>) =>
  categoryRef;
const packageOptionSelectorRef = ({
  packageOptionRef,
}: Extract<CreateRulePayload['selector'], { readonly kind: 'PACKAGE_OPTION' }>) => packageOptionRef;
const productSelectorRef = ({ productRef }: Extract<CreateRulePayload['selector'], { readonly kind: 'PRODUCT' }>) =>
  productRef;
const variantSelectorRef = ({ variantRef }: Extract<CreateRulePayload['selector'], { readonly kind: 'VARIANT' }>) =>
  variantRef;

const selectorRef = (selector: Exclude<CreateRulePayload['selector'], { readonly kind: 'ALL' }>) =>
  Match.value(selector).pipe(
    Match.discriminatorsExhaustive('kind')({
      CATEGORY: categorySelectorRef,
      PACKAGE_OPTION: packageOptionSelectorRef,
      PRODUCT: productSelectorRef,
      VARIANT: variantSelectorRef,
    }),
  );

export const toSelectorTarget = (selector: CreateRulePayload['selector']) => {
  if (selector.kind === 'ALL') {
    return { kind: 'ALL' as const };
  }
  return { kind: selector.kind, target: toResourceAccessTarget(selectorRef(selector)) };
};

export const toAudienceTarget = (audience: AssortmentBindingAudience) => {
  if (audience.kind === 'SHARED') {
    return { kind: 'SHARED' as const };
  }
  if (audience.kind === 'COMMERCE_CUSTOMER_GROUP') {
    return { group: toResourceAccessTarget(audience.groupRef), kind: 'COMMERCE_CUSTOMER_GROUP' as const };
  }
  if (audience.subject.kind === 'COUNTERPARTY') {
    return {
      kind: 'SUBJECT' as const,
      subject: { kind: 'COUNTERPARTY' as const, ref: toResourceAccessTarget(audience.subject.counterpartyRef) },
    };
  }
  return {
    kind: 'SUBJECT' as const,
    subject: { kind: 'RETAIL_CUSTOMER_PROFILE' as const, ref: toResourceAccessTarget(audience.subject.profileRef) },
  };
};

const refsForAudience = (audience: AssortmentBindingAudience): readonly TenantResourceRefLike[] => {
  if (audience.kind === 'SHARED') {
    return [];
  }
  if (audience.kind === 'COMMERCE_CUSTOMER_GROUP') {
    return [audience.groupRef];
  }
  if (audience.subject.kind === 'COUNTERPARTY') {
    return [audience.subject.counterpartyRef];
  }
  return [audience.subject.profileRef];
};

const refsForScope = (scope: AssortmentCommercialScope): readonly TenantResourceRefLike[] => {
  const refs: TenantResourceRefLike[] = [scope.channelRef, scope.sellingLegalEntityRef];
  if (scope.commerceMarketRef !== undefined) {
    refs.push(scope.commerceMarketRef);
  }
  if (scope.storefrontRef !== undefined) {
    refs.push(scope.storefrontRef);
  }
  return refs;
};

const assertTrustedRefs = (scope: OperationalScope, refs: readonly TenantResourceRefLike[]): void => {
  if (refs.some((ref) => ref.tenantId !== scope.tenantId)) {
    throw new AssortmentPolicyTargetInvariant({ reason: 'Assortment permission target tenant mismatch' });
  }
  const storefront = refs.find((ref) => ref.resourceType.endsWith('.storefront'));
  if (storefront !== undefined && scope.trustedStorefrontId !== storefront.resourceId) {
    throw new AssortmentPolicyTargetInvariant({ reason: 'Assortment permission target Storefront is not trusted' });
  }
};

export const createRulePermissionTarget = (payload: CreateRulePayload, scope: OperationalScope) => {
  const refs = payload.selector.kind === 'ALL' ? [] : [selectorRef(payload.selector)];
  assertTrustedRefs(scope, refs);
  return {
    effect: payload.effect,
    kind: 'assortment_rule' as const,
    mode: 'create' as const,
    permission: 'assortment.rule.create' as const,
    purpose: payload.purpose,
    selector: toSelectorTarget(payload.selector),
    stableCode: payload.stableCode,
  };
};

export const createRuleRevisionPermissionTarget = (payload: CreateRuleRevisionPayload, scope: OperationalScope) => {
  const refs: TenantResourceRefLike[] = [payload.stableRuleRef];
  if (payload.selector.kind !== 'ALL') {
    refs.push(selectorRef(payload.selector));
  }
  assertTrustedRefs(scope, refs);
  return {
    effect: payload.effect,
    kind: 'assortment_rule' as const,
    mode: 'revision_create' as const,
    permission: 'assortment.rule.revision.create' as const,
    purpose: payload.purpose,
    selector: toSelectorTarget(payload.selector),
    stableRule: toResourceAccessTarget(payload.stableRuleRef),
  };
};

export const createBindingPermissionTarget = (payload: CreateApplicabilityBindingPayload, scope: OperationalScope) => {
  assertTrustedRefs(scope, [
    payload.ruleRevisionRef.sourceRef,
    ...refsForAudience(payload.audience),
    ...refsForScope(payload.commercialScope),
  ]);
  if (scope.legalEntityId !== payload.commercialScope.sellingLegalEntityRef.resourceId) {
    throw new AssortmentPolicyTargetInvariant({ reason: 'Assortment permission target Legal Entity mismatch' });
  }
  return {
    audience: toAudienceTarget(payload.audience),
    commercialScope: toCommercialScopeTarget(payload.commercialScope),
    effectiveFrom: DateTime.formatIso(payload.effectiveFrom),
    kind: 'assortment_binding' as const,
    mode: 'create' as const,
    permission: 'assortment.binding.create' as const,
    ruleRevision: toResourceAccessTarget(payload.ruleRevisionRef.sourceRef),
  };
};

export const replaceBindingPermissionTargets = (
  payload: ReplaceApplicabilityBindingPayload,
  scope: OperationalScope,
) => {
  assertTrustedRefs(scope, [
    payload.existingBindingRef,
    payload.proposedRuleRevisionRef.sourceRef,
    ...refsForAudience(payload.proposedAudience),
    ...refsForScope(payload.proposedCommercialScope),
  ]);
  if (scope.legalEntityId !== payload.proposedCommercialScope.sellingLegalEntityRef.resourceId) {
    throw new AssortmentPolicyTargetInvariant({ reason: 'Assortment permission target Legal Entity mismatch' });
  }
  return [
    {
      binding: toResourceAccessTarget(payload.existingBindingRef),
      kind: 'assortment_binding' as const,
      mode: 'end' as const,
      permission: 'assortment.binding.end' as const,
    },
    createBindingPermissionTarget(
      {
        audience: payload.proposedAudience,
        commercialScope: payload.proposedCommercialScope,
        effectiveFrom: payload.proposedEffectiveFrom,
        provenanceRef: payload.provenanceRef,
        reason: payload.reason,
        ruleRevisionRef: payload.proposedRuleRevisionRef,
      },
      scope,
    ),
  ] as const;
};

export const endBindingPermissionTarget = (payload: EndApplicabilityBindingPayload, scope: OperationalScope) => {
  assertTrustedRefs(scope, [payload.applicabilityBindingRef]);
  return {
    binding: toResourceAccessTarget(payload.applicabilityBindingRef),
    kind: 'assortment_binding' as const,
    mode: 'end' as const,
    permission: 'assortment.binding.end' as const,
  };
};

export const retireRulePermissionTarget = (payload: RetireRulePayload, scope: OperationalScope) => {
  assertTrustedRefs(scope, [payload.stableRuleRef]);
  return {
    kind: 'assortment_rule' as const,
    mode: 'retire' as const,
    permission: 'assortment.rule.retire' as const,
    stableRule: toResourceAccessTarget(payload.stableRuleRef),
  };
};

export const bindingMeaningFingerprint = (payload: CreateApplicabilityBindingPayload): string =>
  assortmentMeaningFingerprint({
    audience: payload.audience,
    commercialScope: payload.commercialScope,
    effectiveFrom: DateTime.formatIso(payload.effectiveFrom),
    ruleRevisionRef: payload.ruleRevisionRef,
  });
