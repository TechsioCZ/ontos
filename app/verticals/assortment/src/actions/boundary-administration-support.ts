import type { OperationalScope } from '@app/core-runtime';
import { DateTime, Match, Result, Schema } from 'effect';
import type {
  CreateClosedAssortmentBoundaryPayload,
  ReplaceClosedAssortmentBoundaryPayload,
} from '../../shared/actions/boundary-administration.ts';
import { AssortmentCollectionRevisionRefSchema } from '../../shared/actions/boundary-administration.ts';
import type { AssortmentCommercialScope, AssortmentPurchasingSubject } from '../../shared/domain/decision-contracts.ts';
import { AssortmentPolicyTargetInvariant } from '../../shared/domain/policy-errors.ts';
import type { AssortmentCurrentnessTarget } from '../services/assortment-currentness.ts';
import { assortmentMeaningFingerprint } from '../services/policy-administration.service.ts';

type Ref = Readonly<{ moduleId: string; resourceId: string; resourceType: string }>;
type TenantRef = Ref & Readonly<{ tenantId: string }>;
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

export const createBoundaryCurrentnessTarget = (
  payload: CreateClosedAssortmentBoundaryPayload,
  scope: OperationalScope,
): AssortmentCurrentnessTarget => {
  assertRefs(
    scope,
    [
      ...refsForScope(payload.commercialScope),
      ...refsForSubject(payload.subject),
      ...refsForAdmissionSet(payload.admissionSet),
    ],
    payload.commercialScope.sellingLegalEntityRef,
  );
  return { kind: 'assortment_boundary', mode: 'create' };
};

export const endBoundaryCurrentnessTarget = (
  payload: { readonly boundaryRef: TenantRef },
  scope: OperationalScope,
): AssortmentCurrentnessTarget => {
  assertRefs(scope, [payload.boundaryRef]);
  return {
    boundary: {
      moduleId: payload.boundaryRef.moduleId,
      resourceId: payload.boundaryRef.resourceId,
      resourceType: payload.boundaryRef.resourceType,
    },
    kind: 'assortment_boundary',
    mode: 'end',
  };
};

export const replaceBoundaryCurrentnessTarget = (
  payload: ReplaceClosedAssortmentBoundaryPayload,
  scope: OperationalScope,
): AssortmentCurrentnessTarget => {
  assertRefs(scope, [payload.existingBoundaryRef]);
  createBoundaryCurrentnessTarget(
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
  );
  return {
    boundary: {
      moduleId: payload.existingBoundaryRef.moduleId,
      resourceId: payload.existingBoundaryRef.resourceId,
      resourceType: payload.existingBoundaryRef.resourceType,
    },
    kind: 'assortment_boundary',
    mode: 'replace',
  };
};

export const boundaryMeaningFingerprint = (payload: CreateClosedAssortmentBoundaryPayload) =>
  assortmentMeaningFingerprint({
    admissionSet: boundaryAdmissionEvidence(payload),
    commercialScope: payload.commercialScope,
    decisionPurpose: payload.decisionPurpose,
    effectiveFrom: DateTime.formatIso(payload.effectiveFrom),
    subject: payload.subject,
  });
