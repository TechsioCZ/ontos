import type { AssortmentPermissionSelector, OperationalScope } from '@app/core-runtime';
import { DateTime, Match, Result, Schema } from 'effect';
import type {
  CreateClosedAssortmentBoundaryPayload,
  ReplaceClosedAssortmentBoundaryPayload,
} from '../../shared/actions/boundary-administration.ts';
import { AssortmentCollectionRevisionRefSchema } from '../../shared/actions/boundary-administration.ts';
import type {
  AssortmentCatalogSelector,
  AssortmentCommercialScope,
  AssortmentPurchasingSubject,
} from '../../shared/domain/decision-contracts.ts';
import { AssortmentPolicyTargetInvariant } from '../../shared/domain/policy-errors.ts';
import { assortmentMeaningFingerprint } from '../services/policy-administration.service.ts';

type Ref = Readonly<{ moduleId: string; resourceId: string; resourceType: string }>;
type TenantRef = Ref & Readonly<{ tenantId: string }>;
interface ScopeTarget {
  channel: Ref;
  market?: Ref;
  storefront?: Ref;
}

const target = (ref: Ref) => ({ moduleId: ref.moduleId, resourceId: ref.resourceId, resourceType: ref.resourceType });
const scopeTarget = (scope: AssortmentCommercialScope) => {
  const value: ScopeTarget = { channel: target(scope.channelRef) };
  if (scope.commerceMarketRef !== undefined) {
    value.market = target(scope.commerceMarketRef);
  }
  if (scope.storefrontRef !== undefined) {
    value.storefront = target(scope.storefrontRef);
  }
  return value;
};
const subjectTarget = (subject: AssortmentPurchasingSubject) =>
  subject.kind === 'COUNTERPARTY'
    ? { kind: subject.kind, ref: target(subject.counterpartyRef) }
    : { kind: subject.kind, ref: target(subject.profileRef) };

const allAdmissionTarget = () => ({ kind: 'ALL' as const });
const categoryAdmissionTarget = (value: Extract<AssortmentCatalogSelector, { readonly kind: 'CATEGORY' }>) => ({
  kind: 'CATEGORY' as const,
  target: target(value.categoryRef),
});
const packageAdmissionTarget = (value: Extract<AssortmentCatalogSelector, { readonly kind: 'PACKAGE_OPTION' }>) => ({
  kind: 'PACKAGE_OPTION' as const,
  target: target(value.packageOptionRef),
});
const productAdmissionTarget = (value: Extract<AssortmentCatalogSelector, { readonly kind: 'PRODUCT' }>) => ({
  kind: 'PRODUCT' as const,
  target: target(value.productRef),
});
const variantAdmissionTarget = (value: Extract<AssortmentCatalogSelector, { readonly kind: 'VARIANT' }>) => ({
  kind: 'VARIANT' as const,
  target: target(value.variantRef),
});

const admissionSelectorTarget = (selector: AssortmentCatalogSelector): AssortmentPermissionSelector =>
  Match.value(selector).pipe(
    Match.discriminatorsExhaustive('kind')({
      ALL: allAdmissionTarget,
      CATEGORY: categoryAdmissionTarget,
      PACKAGE_OPTION: packageAdmissionTarget,
      PRODUCT: productAdmissionTarget,
      VARIANT: variantAdmissionTarget,
    }),
  );

const admissionTargetKey = (selector: ReturnType<typeof admissionSelectorTarget>): string =>
  [
    selector.kind,
    selector.target?.moduleId ?? '',
    selector.target?.resourceType ?? '',
    selector.target?.resourceId ?? '',
  ].join('\u0000');

const assertRefs = (scope: OperationalScope, refs: readonly TenantRef[], sellingLegalEntityRef?: TenantRef) => {
  if (refs.some((ref) => ref.tenantId !== scope.tenantId)) {
    throw new AssortmentPolicyTargetInvariant({ reason: 'Assortment boundary target tenant mismatch' });
  }
  if (sellingLegalEntityRef !== undefined && sellingLegalEntityRef.resourceId !== scope.legalEntityId) {
    throw new AssortmentPolicyTargetInvariant({ reason: 'Assortment boundary target Legal Entity mismatch' });
  }
  const storefront = refs.find((ref) => ref.resourceType.endsWith('.storefront'));
  if (storefront !== undefined && scope.trustedStorefrontId !== storefront.resourceId) {
    throw new AssortmentPolicyTargetInvariant({ reason: 'Assortment boundary target Storefront is not trusted' });
  }
};

const refsForScope = (value: AssortmentCommercialScope): TenantRef[] => [
  value.channelRef,
  value.sellingLegalEntityRef,
  ...(value.commerceMarketRef === undefined ? [] : [value.commerceMarketRef]),
  ...(value.storefrontRef === undefined ? [] : [value.storefrontRef]),
];
const refsForSubject = (value: AssortmentPurchasingSubject): TenantRef[] =>
  value.kind === 'COUNTERPARTY' ? [value.counterpartyRef] : [value.profileRef];
type AdmissionEntry = CreateClosedAssortmentBoundaryPayload['admissionSet']['entries'][number];
const allAdmissionEntryRef = () => null;
const categoryAdmissionEntryRef = (entry: Extract<AdmissionEntry, { readonly kind: 'CATEGORY' }>) => entry.categoryRef;
const packageAdmissionEntryRef = (entry: Extract<AdmissionEntry, { readonly kind: 'PACKAGE_OPTION' }>) =>
  entry.packageOptionRef;
const productAdmissionEntryRef = (entry: Extract<AdmissionEntry, { readonly kind: 'PRODUCT' }>) => entry.productRef;
const variantAdmissionEntryRef = (entry: Extract<AdmissionEntry, { readonly kind: 'VARIANT' }>) => entry.variantRef;
const admissionEntryRef = (entry: AdmissionEntry) =>
  Match.value(entry).pipe(
    Match.discriminatorsExhaustive('kind')({
      ALL: allAdmissionEntryRef,
      CATEGORY: categoryAdmissionEntryRef,
      PACKAGE_OPTION: packageAdmissionEntryRef,
      PRODUCT: productAdmissionEntryRef,
      VARIANT: variantAdmissionEntryRef,
    }),
  );
const refsForAdmissionSet = (value: CreateClosedAssortmentBoundaryPayload['admissionSet']): TenantRef[] =>
  value.entries.flatMap((entry) => {
    const reference = admissionEntryRef(entry);
    return reference === null ? [] : [reference];
  });

export const boundaryAdmissionEvidence = (payload: CreateClosedAssortmentBoundaryPayload) => {
  const contentHash = assortmentMeaningFingerprint({ entries: payload.admissionSet.entries });
  return {
    contentHash,
    memberCount: payload.admissionSet.entries.length,
    setKind: payload.admissionSet.entries.length === 0 ? ('EMPTY' as const) : ('ENTRIES' as const),
  };
};

export type BoundaryAdmissionEvidence = ReturnType<typeof boundaryAdmissionEvidence>;

export const collectionRevisionRef = (tenantId: string, resourceId: string) =>
  Result.getOrThrow(
    Schema.decodeResult(AssortmentCollectionRevisionRefSchema)({
      moduleId: 'commerce.assortment',
      resourceId,
      resourceType: 'commerce.assortment.collection-revision',
      tenantId,
    }),
  );

export const createBoundaryPermissionTarget = (
  payload: CreateClosedAssortmentBoundaryPayload,
  scope: OperationalScope,
) => {
  assertRefs(
    scope,
    [
      ...refsForScope(payload.commercialScope),
      ...refsForSubject(payload.subject),
      ...refsForAdmissionSet(payload.admissionSet),
    ],
    payload.commercialScope.sellingLegalEntityRef,
  );
  const evidence = boundaryAdmissionEvidence(payload);
  const entries = payload.admissionSet.entries
    .map(admissionSelectorTarget)
    .toSorted((left, right) => admissionTargetKey(left).localeCompare(admissionTargetKey(right), 'en'));
  const admissionSet =
    evidence.setKind === 'EMPTY'
      ? {
          contentHash: evidence.contentHash,
          entries: [] as const,
          memberCount: 0 as const,
          setKind: 'EMPTY' as const,
        }
      : {
          contentHash: evidence.contentHash,
          entries,
          memberCount: payload.admissionSet.entries.length,
          setKind: 'ENTRIES' as const,
        };
  return {
    admissionSet,
    commercialScope: scopeTarget(payload.commercialScope),
    effectiveFrom: DateTime.formatIso(payload.effectiveFrom),
    kind: 'assortment_boundary' as const,
    mode: 'create' as const,
    permission: 'assortment.boundary.create' as const,
    purpose: payload.decisionPurpose,
    subject: subjectTarget(payload.subject),
  };
};

export const endBoundaryPermissionTarget = (payload: { boundaryRef: TenantRef }, scope: OperationalScope) => {
  assertRefs(scope, [payload.boundaryRef]);
  return {
    boundary: target(payload.boundaryRef),
    kind: 'assortment_boundary' as const,
    mode: 'end' as const,
    permission: 'assortment.boundary.end' as const,
  };
};

export const replaceBoundaryPermissionTargets = (
  payload: ReplaceClosedAssortmentBoundaryPayload,
  scope: OperationalScope,
) =>
  [
    endBoundaryPermissionTarget({ boundaryRef: payload.existingBoundaryRef }, scope),
    createBoundaryPermissionTarget(
      {
        admissionSet: payload.proposedAdmissionSet,
        commercialScope: payload.proposedCommercialScope,
        decisionPurpose: payload.proposedDecisionPurpose,
        effectiveFrom: payload.proposedEffectiveFrom,
        provenanceRef: payload.provenanceRef,
        reason: payload.reason,
        subject: payload.proposedSubject,
      },
      scope,
    ),
  ] as const;

export const boundaryMeaningFingerprint = (payload: CreateClosedAssortmentBoundaryPayload) =>
  assortmentMeaningFingerprint({
    admissionSet: boundaryAdmissionEvidence(payload),
    commercialScope: payload.commercialScope,
    decisionPurpose: payload.decisionPurpose,
    effectiveFrom: DateTime.formatIso(payload.effectiveFrom),
    subject: payload.subject,
  });
