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
import type { AssortmentCurrentnessTarget } from '../services/assortment-currentness.ts';
import { assortmentMeaningFingerprint } from '../services/policy-administration.service.ts';

interface ResourceRefLike {
  readonly moduleId: string;
  readonly resourceId: string;
  readonly resourceType: string;
}
type TenantResourceRefLike = ResourceRefLike & Readonly<{ readonly tenantId: string }>;
export const toResourceAccessTarget = (ref: ResourceRefLike) => ({
  moduleId: ref.moduleId,
  resourceId: ref.resourceId,
  resourceType: ref.resourceType,
});

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

export const createRuleCurrentnessTarget = (
  payload: CreateRulePayload,
  scope: OperationalScope,
): AssortmentCurrentnessTarget => {
  assertTrustedRefs(scope, payload.selector.kind === 'ALL' ? [] : [selectorRef(payload.selector)]);
  return { kind: 'assortment_rule', mode: 'create', selectorKind: payload.selector.kind };
};

export const createRuleRevisionCurrentnessTarget = (
  payload: CreateRuleRevisionPayload,
  scope: OperationalScope,
): AssortmentCurrentnessTarget => {
  const refs: TenantResourceRefLike[] = [payload.stableRuleRef];
  if (payload.selector.kind !== 'ALL') {
    refs.push(selectorRef(payload.selector));
  }
  assertTrustedRefs(scope, refs);
  return {
    kind: 'assortment_rule',
    mode: 'revision_create',
    selectorKind: payload.selector.kind,
    stableRule: toResourceAccessTarget(payload.stableRuleRef),
  };
};

export const createBindingCurrentnessTarget = (
  payload: CreateApplicabilityBindingPayload,
  scope: OperationalScope,
): AssortmentCurrentnessTarget => {
  assertTrustedRefs(scope, [
    payload.ruleRevisionRef.sourceRef,
    ...refsForAudience(payload.audience),
    ...refsForScope(payload.commercialScope),
  ]);
  if (scope.legalEntityId !== payload.commercialScope.sellingLegalEntityRef.resourceId) {
    throw new AssortmentPolicyTargetInvariant({ reason: 'Assortment permission target Legal Entity mismatch' });
  }
  return {
    kind: 'assortment_binding',
    mode: 'create',
    ruleRevision: toResourceAccessTarget(payload.ruleRevisionRef.sourceRef),
  };
};

export const replaceBindingCurrentnessTarget = (
  payload: ReplaceApplicabilityBindingPayload,
  scope: OperationalScope,
): AssortmentCurrentnessTarget => {
  assertTrustedRefs(scope, [
    payload.existingBindingRef,
    payload.proposedRuleRevisionRef.sourceRef,
    ...refsForAudience(payload.proposedAudience),
    ...refsForScope(payload.proposedCommercialScope),
  ]);
  if (scope.legalEntityId !== payload.proposedCommercialScope.sellingLegalEntityRef.resourceId) {
    throw new AssortmentPolicyTargetInvariant({ reason: 'Assortment permission target Legal Entity mismatch' });
  }
  return {
    binding: toResourceAccessTarget(payload.existingBindingRef),
    kind: 'assortment_binding',
    mode: 'replace',
    ruleRevision: toResourceAccessTarget(payload.proposedRuleRevisionRef.sourceRef),
  };
};

export const endBindingCurrentnessTarget = (
  payload: EndApplicabilityBindingPayload,
  scope: OperationalScope,
): AssortmentCurrentnessTarget => {
  assertTrustedRefs(scope, [payload.applicabilityBindingRef]);
  return { binding: toResourceAccessTarget(payload.applicabilityBindingRef), kind: 'assortment_binding', mode: 'end' };
};

export const retireRuleCurrentnessTarget = (
  payload: RetireRulePayload,
  scope: OperationalScope,
): AssortmentCurrentnessTarget => {
  assertTrustedRefs(scope, [payload.stableRuleRef]);
  return { kind: 'assortment_rule', mode: 'retire', stableRule: toResourceAccessTarget(payload.stableRuleRef) };
};

export const bindingMeaningFingerprint = (payload: CreateApplicabilityBindingPayload): string =>
  assortmentMeaningFingerprint({
    audience: payload.audience,
    commercialScope: payload.commercialScope,
    effectiveFrom: DateTime.formatIso(payload.effectiveFrom),
    ruleRevisionRef: payload.ruleRevisionRef,
  });
