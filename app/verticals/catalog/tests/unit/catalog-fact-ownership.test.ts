import { describe, expect, it } from 'effect-rstest';
import { Schema } from 'effect';

import {
  assessCatalogCanonicalAddress,
  assessCatalogCanonicalFactMutation,
  assessCatalogDocumentApplicability,
  assessCatalogDocumentReference,
  assessCatalogFactClaims,
  assessLiveDocumentReferenceAsEvidence,
  assessMediaDepictionIdentity,
  assessPublicExistenceEntitlement,
  CatalogAcceptedDocumentEvidenceSchema,
  CatalogDocumentReferenceSchema,
  CatalogFactClaimSchema,
  CatalogFactMutationAuthoritySchema,
  catalogFactMeaningOwner,
  CatalogFactRefSchema,
  CatalogLiveDocumentReferenceSchema,
  CatalogProtectedEntitlementSchema,
  CatalogPublicExistenceKindSchema,
  preserveAcceptedDocumentEvidence,
} from '../../shared/domain/catalog-fact-ownership.ts';
import type {
  CatalogFactClaim,
  CatalogFactClaimant,
  CatalogFactMeaning,
  CatalogFactOwner,
} from '../../shared/domain/catalog-fact-ownership.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const otherTenantId = '99999999-9999-4999-8999-999999999999';
const productId = '22222222-2222-4222-8222-222222222222';
const variantId = '33333333-3333-4333-8333-333333333333';
const otherVariantId = '33333333-3333-4333-8333-333333333334';
const principalId = '44444444-4444-4444-8444-444444444444';
const documentId = '55555555-5555-4555-8555-555555555555';
const otherDocumentId = '66666666-6666-4666-8666-666666666666';

const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: productId,
  resourceType: 'commerce.catalog.product',
  tenantId,
} as const;
const variantRef = {
  moduleId: 'commerce.catalog',
  resourceId: variantId,
  resourceType: 'commerce.catalog.variant',
  tenantId,
} as const;
const otherVariantRef = { ...variantRef, resourceId: otherVariantId } as const;
const documentRef = {
  moduleId: 'documents.center',
  resourceId: documentId,
  resourceType: 'documents.center.resource',
  tenantId,
} as const;
const otherDocumentRef = { ...documentRef, resourceId: otherDocumentId } as const;

const decodeFactRef = Schema.decodeUnknownSync(CatalogFactRefSchema, { onExcessProperty: 'error' });
const decodeAuthority = Schema.decodeUnknownSync(CatalogFactMutationAuthoritySchema, { onExcessProperty: 'error' });
const decodeClaim = Schema.decodeUnknownSync(CatalogFactClaimSchema, { onExcessProperty: 'error' });
const decodeLiveReference = Schema.decodeUnknownSync(CatalogLiveDocumentReferenceSchema, {
  onExcessProperty: 'error',
});
const decodeDocumentReference = Schema.decodeUnknownSync(CatalogDocumentReferenceSchema, { onExcessProperty: 'error' });
const decodeAcceptedEvidence = Schema.decodeUnknownSync(CatalogAcceptedDocumentEvidenceSchema, {
  onExcessProperty: 'error',
});

interface FactTargetInput {
  readonly moduleId: string;
  readonly resourceId: string;
  readonly resourceType: string;
  readonly tenantId: string;
}

const fact = (meaning: CatalogFactMeaning, target: FactTargetInput = productRef) =>
  decodeFactRef({ factKey: 'width', meaning, target });

const authorityWithPermission = (operationOwner: CatalogFactOwner, origin: CatalogFactOwner) =>
  decodeAuthority({
    operationOwner,
    origin,
    permission: { permissionKey: 'commerce.catalog.product.edit', scope: productRef },
    principalId,
  });
const authorityWithoutPermission = (operationOwner: CatalogFactOwner) =>
  decodeAuthority({ operationOwner, origin: 'CONTENT', principalId });

const claim = (
  claimant: CatalogFactClaimant,
  meaning: CatalogFactMeaning,
  observedAt: string,
  value: number | string,
): CatalogFactClaim => decodeClaim({ claimant, meaning, observedAt, value });

const liveReference = (resourceRef: FactTargetInput, target: FactTargetInput = productRef) =>
  decodeLiveReference({ mode: 'LIVE_CURRENT', resourceRef, target });
const acceptedEvidence = (
  revision: number,
  acceptedResultRef = 'order-1',
  resourceRef: FactTargetInput = documentRef,
) => decodeAcceptedEvidence({ acceptedResultRef, exact: { resourceRef, revision } });

describe('Catalog fact ownership boundaries', () => {
  it('assigns one authoritative owner to each business meaning, not to a screen or storage location', () => {
    expect(catalogFactMeaningOwner('PRODUCT_IDENTITY')).toBe('CATALOG');
    expect(catalogFactMeaningOwner('STRUCTURED_PROPERTY')).toBe('CATALOG');
    expect(catalogFactMeaningOwner('CATALOG_NAME')).toBe('CATALOG');
    expect(catalogFactMeaningOwner('FACTUAL_DESCRIPTION')).toBe('CATALOG');
    expect(catalogFactMeaningOwner('PRODUCT_DOCUMENT_MEDIA_ASSIGNMENT')).toBe('CATALOG');
    expect(catalogFactMeaningOwner('MARKETING_HEADLINE')).toBe('CONTENT');
    expect(catalogFactMeaningOwner('SELLING_COPY')).toBe('CONTENT');
    expect(catalogFactMeaningOwner('THEMATIC_CONTENT')).toBe('CONTENT');
    expect(catalogFactMeaningOwner('DOCUMENT_RESOURCE_CONTENT')).toBe('DOCUMENTS_CENTER');
    expect(catalogFactMeaningOwner('DOCUMENT_VERSION_ACCESS_RETENTION')).toBe('DOCUMENTS_CENTER');
    expect(catalogFactMeaningOwner('STOREFRONT_ROUTING_RENDER_LAYOUT_SEO')).toBe('STOREFRONT');
    expect(catalogFactMeaningOwner('PUBLICATION_OUTPUT')).toBe('CHANNEL_PUBLICATION');
  });

  it('accepts a Catalog name edited from Content only through the Catalog operation with a real permission', () => {
    const input = { fact: fact('CATALOG_NAME'), targetVerified: true, valueValid: true };
    expect(assessCatalogCanonicalFactMutation({ ...input, authority: null })).toEqual({
      reason: 'Mutation authority is missing',
      status: 'UNVERIFIABLE',
    });
    expect(
      assessCatalogCanonicalFactMutation({
        ...input,
        authority: authorityWithPermission('CONTENT', 'CONTENT'),
      }),
    ).toEqual({ owner: 'CONTENT', status: 'NOT_OWNER' });
    expect(assessCatalogCanonicalFactMutation({ ...input, authority: authorityWithoutPermission('CATALOG') })).toEqual({
      status: 'PERMISSION_REQUIRED',
    });
    expect(
      assessCatalogCanonicalFactMutation({
        ...input,
        authority: authorityWithPermission('CATALOG', 'CONTENT'),
      }),
    ).toEqual({ status: 'ACCEPTED' });
  });

  it('fails closed for unverified targets, invalid values and cross-Tenant permission scopes', () => {
    const authority = authorityWithPermission('CATALOG', 'CATALOG');
    expect(
      assessCatalogCanonicalFactMutation({
        authority,
        fact: fact('CATALOG_NAME'),
        targetVerified: false,
        valueValid: true,
      }),
    ).toEqual({ reason: 'Exact Catalog target is not verified', status: 'UNVERIFIABLE' });
    expect(
      assessCatalogCanonicalFactMutation({
        authority,
        fact: fact('CATALOG_NAME'),
        targetVerified: true,
        valueValid: false,
      }),
    ).toEqual({ reason: 'Catalog fact value is invalid', status: 'UNVERIFIABLE' });
    expect(
      assessCatalogCanonicalFactMutation({
        authority,
        fact: fact('CATALOG_NAME', { ...productRef, tenantId: otherTenantId }),
        targetVerified: true,
        valueValid: true,
      }),
    ).toEqual({ status: 'PERMISSION_REQUIRED' });
  });

  it('refuses foreign-owner content as a Catalog canonical fact', () => {
    const authority = authorityWithPermission('CATALOG', 'CATALOG');
    for (const [meaning, owner] of [
      ['MARKETING_HEADLINE', 'CONTENT'],
      ['SELLING_COPY', 'CONTENT'],
      ['DOCUMENT_VERSION_ACCESS_RETENTION', 'DOCUMENTS_CENTER'],
      ['STOREFRONT_ROUTING_RENDER_LAYOUT_SEO', 'STOREFRONT'],
      ['PUBLICATION_OUTPUT', 'CHANNEL_PUBLICATION'],
    ] as const) {
      expect(
        assessCatalogCanonicalFactMutation({
          authority,
          fact: fact(meaning),
          targetVerified: true,
          valueValid: true,
        }),
      ).toEqual({ owner, status: 'NOT_OWNER' });
    }
  });

  it('keeps a marketing headline and a catalog name as distinct meanings, and decides a conflict only at the owner', () => {
    const name = claim('CATALOG', 'CATALOG_NAME', '2026-09-16T08:00:00.000Z', 'Predlozka 80 cm');
    const headline = claim('CONTENT', 'MARKETING_HEADLINE', '2026-09-17T08:00:00.000Z', 'The loudest offer');
    expect(assessCatalogFactClaims({ claims: [name, headline] })).toEqual({
      meanings: ['CATALOG_NAME', 'MARKETING_HEADLINE'],
      status: 'DISTINCT_MEANINGS',
    });

    const older = claim('CATALOG', 'STRUCTURED_PROPERTY', '2026-09-01T08:00:00.000Z', '80 cm');
    const newer = claim('CATALOG', 'STRUCTURED_PROPERTY', '2026-09-17T08:00:00.000Z', '95 cm');
    const external = claim('EXTERNAL_SOURCE', 'STRUCTURED_PROPERTY', '2026-09-18T08:00:00.000Z', '90 cm');
    const decided = assessCatalogFactClaims({ claims: [older, newer] });
    expect(decided).toEqual({ owner: 'CATALOG', resolution: 'FACT_OWNER', status: 'OWNER_DECIDES', suppressed: [] });
    expect(assessCatalogFactClaims({ claims: [older, external] })).toEqual({
      owner: 'CATALOG',
      resolution: 'EXTERNAL_SOURCE_ASSERTION_AND_LOCAL_OVERRIDE_481',
      status: 'OWNER_DECIDES',
      suppressed: ['EXTERNAL_SOURCE'],
    });
    expect(assessCatalogFactClaims({ claims: [external] }).status).toBe('UNVERIFIABLE');
    expect(assessCatalogFactClaims({ claims: [] }).status).toBe('UNVERIFIABLE');

    const contentCopy = claim('CONTENT', 'CATALOG_NAME', '2026-09-18T08:00:00.000Z', 'A private copy');
    expect(assessCatalogFactClaims({ claims: [contentCopy] }).status).toBe('UNVERIFIABLE');
    expect(assessCatalogFactClaims({ claims: [name, contentCopy] })).toEqual({
      owner: 'CATALOG',
      resolution: 'FACT_OWNER',
      status: 'OWNER_DECIDES',
      suppressed: ['CONTENT'],
    });
  });

  it('follows the same Resource Current version live and requires an explicit relation change for another Resource', () => {
    const live = liveReference(documentRef);
    expect(assessCatalogDocumentReference({ currentOwnerResourceRef: documentRef, reference: live })).toEqual({
      perVersionApprovalRequired: false,
      status: 'CURRENT_FROM_OWNER',
    });
    expect(assessCatalogDocumentReference({ currentOwnerResourceRef: otherDocumentRef, reference: live })).toEqual({
      status: 'RELATION_CHANGE_REQUIRED',
    });
    expect(
      assessCatalogDocumentReference({
        currentOwnerResourceRef: { ...documentRef, tenantId: otherTenantId },
        reference: live,
      }),
    ).toEqual({ reason: 'Catalog reference and owner Resource cross the Tenant boundary', status: 'UNVERIFIABLE' });
  });

  it('does not treat a live reference as historical proof and keeps the actually-used accepted version', () => {
    const live = liveReference(documentRef);
    expect(assessLiveDocumentReferenceAsEvidence(live)).toEqual({ status: 'NOT_HISTORICAL_PROOF' });
    const pinned = decodeDocumentReference({
      exact: { resourceRef: documentRef, revision: 1 },
      mode: 'ACCEPTED_PINNED',
      target: productRef,
    });
    expect(assessLiveDocumentReferenceAsEvidence(pinned)).toEqual({
      exact: { resourceRef: documentRef, revision: 1 },
      status: 'EVIDENCE_PINNED',
    });

    const usedV1 = acceptedEvidence(1);
    expect(preserveAcceptedDocumentEvidence({ retained: usedV1, used: acceptedEvidence(1) })).toEqual({
      evidence: usedV1,
      status: 'RETAINED',
    });
    const retainedV2 = acceptedEvidence(2);
    expect(preserveAcceptedDocumentEvidence({ retained: usedV1, used: retainedV2 })).toEqual({
      rejected: retainedV2,
      retained: usedV1,
      status: 'IMMUTABLE',
    });
    expect(preserveAcceptedDocumentEvidence({ retained: usedV1, used: acceptedEvidence(1, 'order-2') })).toEqual({
      reason: 'Evidence belongs to a different accepted result',
      status: 'UNVERIFIABLE',
    });
  });

  it('never merges accepted document evidence whose owner Resource differs only by Tenant', () => {
    const retained = acceptedEvidence(1);
    const crossTenant = acceptedEvidence(1, 'order-1', { ...documentRef, tenantId: otherTenantId });
    const decision = preserveAcceptedDocumentEvidence({ retained, used: crossTenant });
    expect(decision).toEqual({ rejected: crossTenant, retained, status: 'IMMUTABLE' });
    expect(decision).not.toEqual({ evidence: retained, status: 'RETAINED' });
    expect(preserveAcceptedDocumentEvidence({ retained: crossTenant, used: retained })).toEqual({
      rejected: retained,
      retained: crossTenant,
      status: 'IMMUTABLE',
    });
  });

  it('never widens a Variant-only document assignment and keeps Product-level scope explicit', () => {
    expect(assessCatalogDocumentApplicability({ assignmentTarget: variantRef, requestedTarget: variantRef })).toEqual({
      scope: 'VARIANT',
      status: 'DIRECT',
    });
    expect(
      assessCatalogDocumentApplicability({ assignmentTarget: variantRef, requestedTarget: otherVariantRef }),
    ).toEqual({ status: 'NOT_APPLICABLE' });
    expect(assessCatalogDocumentApplicability({ assignmentTarget: variantRef, requestedTarget: productRef })).toEqual({
      status: 'NOT_APPLICABLE',
    });
    expect(assessCatalogDocumentApplicability({ assignmentTarget: productRef, requestedTarget: variantRef })).toEqual({
      scope: 'PRODUCT',
      status: 'PRODUCT_LEVEL',
    });
    expect(assessCatalogDocumentApplicability({ assignmentTarget: productRef, requestedTarget: productRef })).toEqual({
      scope: 'PRODUCT',
      status: 'PRODUCT_LEVEL',
    });
    expect(
      assessCatalogDocumentApplicability({
        assignmentTarget: productRef,
        requestedTarget: { ...productRef, resourceId: otherDocumentId },
      }),
    ).toEqual({ status: 'NOT_APPLICABLE' });
  });

  it('keeps media ordering in Catalog #474 and never derives Color or identity from a fallback', () => {
    expect(assessMediaDepictionIdentity({ claims: [] })).toEqual({
      orderingOwner: 'CATALOG_474',
      status: 'ILLUSTRATIVE_ONLY',
    });
    for (const depiction of ['COLOR', 'CONFIGURATION', 'DIMENSIONS', 'IDENTITY'] as const) {
      expect(assessMediaDepictionIdentity({ claims: [depiction] })).toEqual({
        orderingOwner: 'CATALOG_474',
        status: 'NOT_IDENTITY_EVIDENCE',
      });
    }
  });

  it('never mistakes Storefront routing, a first category, or publication output for a canonical Catalog address', () => {
    expect(assessCatalogCanonicalAddress({ source: 'CATALOG_IDENTITY' })).toEqual({
      canonicalCatalogAddressCreated: true,
      status: 'AUTHORITATIVE',
    });
    expect(assessCatalogCanonicalAddress({ source: 'CHANNEL_PUBLICATION' })).toEqual({
      canonicalCatalogAddressCreated: false,
      status: 'DERIVED_OUTPUT',
    });
    expect(assessCatalogCanonicalAddress({ source: 'FIRST_CATEGORY' })).toEqual({
      canonicalCatalogAddressCreated: false,
      status: 'NOT_CANONICAL',
    });
    expect(assessCatalogCanonicalAddress({ source: 'LOCAL_NAME_COPY' })).toEqual({
      canonicalCatalogAddressCreated: false,
      status: 'NOT_CANONICAL',
    });
    expect(assessCatalogCanonicalAddress({ source: 'STOREFRONT_ROUTE' })).toEqual({
      canonicalCatalogAddressCreated: false,
      status: 'STOREFRONT_OWNED',
    });
  });

  it('grants no Assortment or Permission from public page, media, or published-link existence', () => {
    const existences = Schema.decodeUnknownSync(Schema.Array(CatalogPublicExistenceKindSchema))([
      'MEDIA',
      'PAGE',
      'PUBLISHED_LINK',
    ]);
    const entitlements = Schema.decodeUnknownSync(Schema.Array(CatalogProtectedEntitlementSchema))([
      'ASSORTMENT',
      'PERMISSION',
    ]);
    for (const existence of existences) {
      for (const entitlement of entitlements) {
        expect(assessPublicExistenceEntitlement({ entitlement, existence })).toEqual({
          entitlement,
          existence,
          status: 'NO_GRANT',
        });
      }
    }
  });

  it('rejects unbranded identifiers, unknown meanings, excess fields and unversioned evidence', () => {
    expect(() => decodeFactRef({ factKey: ' ', meaning: 'CATALOG_NAME', target: productRef })).toThrow();
    expect(() => decodeFactRef({ factKey: 'width', meaning: 'NOT_A_MEANING', target: productRef })).toThrow();
    expect(() =>
      decodeFactRef({ factKey: 'width', meaning: 'CATALOG_NAME', owner: 'CONTENT', target: productRef }),
    ).toThrow();
    expect(() =>
      decodeLiveReference({ mode: 'LIVE_CURRENT', resourceRef: documentRef, revision: 1, target: productRef }),
    ).toThrow();
    expect(() =>
      decodeDocumentReference({ mode: 'ACCEPTED_PINNED', resourceRef: documentRef, target: productRef }),
    ).toThrow();
    expect(() =>
      decodeAcceptedEvidence({ acceptedResultRef: 'order-1', exact: { resourceRef: documentRef, revision: 0 } }),
    ).toThrow();
    expect(() =>
      decodeAuthority({ operationOwner: 'CATALOG', origin: 'CONTENT', principalId: 'not-a-uuid' }),
    ).toThrow();
  });
});
