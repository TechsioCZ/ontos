import { Schema } from 'effect';

import {
  CatalogRevisionInstantSchema,
  CatalogRevisionNumberSchema,
  CatalogRevisionTenantIdSchema,
} from './catalog-revision-reference.ts';
import { CatalogSelectionAssessmentResultSchema, CatalogSelectionSchema } from './catalog-selection-evidence.ts';
import type { CatalogSelection } from './catalog-selection-evidence.ts';
import type { CatalogSelectionPurpose } from './catalog-selection-purpose.ts';

const nonEmptyText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300), Schema.isTrimmed());
const ownerEvidenceIdSchema = nonEmptyText.pipe(Schema.brand('CatalogSelectionOwnerEvidenceId'));
const externalModuleIdSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(160),
  Schema.isTrimmed(),
).pipe(Schema.brand('CatalogSelectionExternalOwnerModuleId'));
const externalResourceIdSchema = nonEmptyText.pipe(Schema.brand('CatalogSelectionExternalOwnerResourceId'));
const externalRevisionIdSchema = nonEmptyText.pipe(Schema.brand('CatalogSelectionExternalOwnerRevisionId'));

/** Orders other than Catalog whose facts may never be derived, only injected as data. */
export const CatalogSelectionExternalOwnerSchema = Schema.Literals([
  'CART',
  'ORDER',
  'PRICING',
  'ASSORTMENT',
  'AVAILABILITY',
  'PURCHASING_APPROVAL',
]);
export type CatalogSelectionExternalOwner = typeof CatalogSelectionExternalOwnerSchema.Type;

/**
 * An external owner's exact revision. It is deliberately not a Catalog ResourceRef, and a
 * Catalog-owned moduleId is rejected so a Catalog fact can never masquerade as foreign evidence.
 */
export const CatalogSelectionExternalOwnerRevisionSchema = Schema.Struct({
  moduleId: externalModuleIdSchema,
  resourceId: externalResourceIdSchema,
  resourceType: nonEmptyText,
  revision: CatalogRevisionNumberSchema,
  revisionId: Schema.optionalKey(externalRevisionIdSchema),
  tenantId: CatalogRevisionTenantIdSchema,
}).check(
  Schema.makeFilter(({ moduleId }) =>
    moduleId === 'commerce.catalog' ? 'Catalog-owned facts must not be injected as foreign owner evidence' : undefined,
  ),
);
export type CatalogSelectionExternalOwnerRevision = typeof CatalogSelectionExternalOwnerRevisionSchema.Type;

/**
 * Owner-contract evidence is plain data. Catalog never imports another deployment's private
 * source or read service; an absent or unverifiable input fails closed.
 */
export const CatalogSelectionInjectedOwnerEvidenceSchema = Schema.Struct({
  evidenceId: ownerEvidenceIdSchema,
  observedAt: CatalogRevisionInstantSchema,
  owner: CatalogSelectionExternalOwnerSchema,
  ownerRevision: CatalogSelectionExternalOwnerRevisionSchema,
  purpose: nonEmptyText,
  selection: CatalogSelectionSchema,
}).check(
  Schema.makeFilter(({ ownerRevision, selection }) =>
    selection.productRef.tenantId === ownerRevision.tenantId
      ? undefined
      : 'Injected owner evidence must share the Selection tenant',
  ),
);
export type CatalogSelectionInjectedOwnerEvidence = typeof CatalogSelectionInjectedOwnerEvidenceSchema.Type;

export const CatalogSelectionNotCatalogOwnedSchema = Schema.Struct({
  kind: Schema.Literal('NOT_CATALOG_OWNED'),
  owner: CatalogSelectionExternalOwnerSchema,
  purpose: nonEmptyText,
  selection: CatalogSelectionSchema,
});
export type CatalogSelectionNotCatalogOwned = typeof CatalogSelectionNotCatalogOwnedSchema.Type;

export const CatalogSelectionUnverifiableOwnerEvidenceSchema = Schema.Struct({
  kind: Schema.Literal('UNVERIFIABLE_OWNER_EVIDENCE'),
  owner: CatalogSelectionExternalOwnerSchema,
  reason: nonEmptyText,
  selection: CatalogSelectionSchema,
});
export type CatalogSelectionUnverifiableOwnerEvidence = typeof CatalogSelectionUnverifiableOwnerEvidenceSchema.Type;

/** Typed extension of the assessment-result union; operational outcomes stay separate. */
export const CatalogSelectionOwnerAssessmentResultSchema = Schema.Union([
  CatalogSelectionAssessmentResultSchema,
  CatalogSelectionNotCatalogOwnedSchema,
  CatalogSelectionUnverifiableOwnerEvidenceSchema,
]);
export type CatalogSelectionOwnerAssessmentResult = typeof CatalogSelectionOwnerAssessmentResultSchema.Type;

export interface CatalogSelectionOwnerFactRequest {
  readonly owner: CatalogSelectionExternalOwner;
  readonly purpose: CatalogSelectionPurpose;
  readonly selection: CatalogSelection;
}

/** Catalog never decides a foreign owner's fact; it types the boundary explicitly. */
export const catalogSelectionNotCatalogOwned = (
  request: CatalogSelectionOwnerFactRequest,
): CatalogSelectionNotCatalogOwned => ({
  kind: 'NOT_CATALOG_OWNED',
  owner: request.owner,
  purpose: request.purpose,
  selection: request.selection,
});

const sameSelection = Schema.toEquivalence(CatalogSelectionSchema);

export const catalogSelectionInjectedOwnerEvidenceMatches = (
  request: CatalogSelectionOwnerFactRequest,
  evidence: CatalogSelectionInjectedOwnerEvidence,
): boolean =>
  evidence.owner === request.owner &&
  evidence.purpose === request.purpose &&
  sameSelection(evidence.selection, request.selection);

/**
 * Consume injected owner evidence for a request. Missing, foreign-owner, other-purpose, or
 * other-selection data never becomes an estimated Catalog basis; it is typed UNVERIFIABLE.
 */
export const catalogSelectionInjectedOwnerEvidenceResult = (
  request: CatalogSelectionOwnerFactRequest,
  evidence: CatalogSelectionInjectedOwnerEvidence | undefined,
): CatalogSelectionInjectedOwnerEvidence | CatalogSelectionUnverifiableOwnerEvidence =>
  evidence !== undefined && catalogSelectionInjectedOwnerEvidenceMatches(request, evidence)
    ? evidence
    : {
        kind: 'UNVERIFIABLE_OWNER_EVIDENCE',
        owner: request.owner,
        reason: 'Owner-qualified evidence for this exact selection and purpose is unavailable',
        selection: request.selection,
      };
