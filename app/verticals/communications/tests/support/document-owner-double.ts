import { Effect, Layer, Schema } from 'effect';

import { CommunicationResourceRefSchema } from '../../src/domain/catalog/vocabulary.ts';
import type { CommunicationResourceRef } from '../../src/domain/catalog/vocabulary.ts';
import { DocumentOwnerUnavailable } from '../../src/domain/documents/document-owner-errors.ts';
import { DocumentLinkOwner, DocumentOpen, DocumentResolution } from '../../src/domain/documents/document-owner.ts';
import type {
  DocumentOpenCase,
  DocumentOpenQuery,
  DocumentResolutionCase,
  DocumentResolveQuery,
} from '../../src/domain/documents/document-owner.ts';

/**
 * TEST-ONLY LABELLED DOUBLE of the Core Media V1 / document owner port (#1409). It stands in for an owner that does not
 * exist yet (Core Media V1 is open work of #1443 and #1446): it proves how Communications ASKS and how it reads an answer,
 * never that a real Media Asset is stored, available or authorized. Nothing here is a published document, an Order document or
 * an invoice, and no byte is stored.
 */

const decodeRef = Schema.decodeUnknownSync(CommunicationResourceRefSchema);
export const assetRef = (id: string): CommunicationResourceRef =>
  decodeRef({ moduleId: 'core.media', resourceId: id, resourceType: 'core.media.asset' });
/** A reference of ANOTHER module's resource: never a Core Media Asset, whatever an owner claims. */
export const foreignAssetRef = (id: string): CommunicationResourceRef =>
  decodeRef({ moduleId: 'fixture.documents', resourceId: id, resourceType: 'fixture.documents.document' });
/** A Core Media reference of a resource type that is not an Asset (for example a derived rendition). */
export const wrongTypeAssetRef = (id: string): CommunicationResourceRef =>
  decodeRef({ moduleId: 'core.media', resourceId: id, resourceType: 'core.media.rendition' });
/** The business document of ANOTHER module than the one the fixture policy approved as document owner. */
export const foreignDocumentRef = (id: string): CommunicationResourceRef =>
  decodeRef({ moduleId: 'fixture.other-module', resourceId: id, resourceType: 'fixture.other-module.document' });
export const documentRef = (id: string): CommunicationResourceRef =>
  decodeRef({ moduleId: 'fixture.documents', resourceId: id, resourceType: 'fixture.documents.document' });

export interface Assignment {
  asset: CommunicationResourceRef;
  /** The revision the owner CLAIMS; only 1 is a Current Media revision. */
  claimedRevision: number;
  disclosure: 'APPROVED' | 'FORBIDDEN';
  media: 'AVAILABLE' | 'UNAVAILABLE';
}

const resolutionOf = (assignment: Assignment | undefined): DocumentResolutionCase => {
  if (assignment === undefined || assignment.disclosure === 'FORBIDDEN') {
    return DocumentResolution.DisclosureForbidden();
  }
  return assignment.media === 'UNAVAILABLE'
    ? DocumentResolution.MediaUnavailable()
    : DocumentResolution.Approved({ asset: { ref: assignment.asset, revision: assignment.claimedRevision } });
};

export const documentOwnerDouble = () => {
  const assignments = new Map<string, Assignment>();
  const openers = new Map<string, Set<string>>();
  const state = { afterResolve: Effect.void, outage: false };
  const asked: { readonly kind: 'authorizeOpen' | 'resolve'; readonly subject: string }[] = [];
  const resolve = (query: DocumentResolveQuery) =>
    Effect.suspend((): Effect.Effect<DocumentResolutionCase, DocumentOwnerUnavailable> => {
      asked.push({ kind: 'resolve', subject: `${query.form}:${query.document.resourceId}` });
      const assignment = assignments.get(query.document.resourceId);
      if (state.outage) {
        return Effect.fail(new DocumentOwnerUnavailable({ reason: 'OWNER_UNAVAILABLE' }));
      }
      // a concurrent evaluation may act between the owner's answer and the caller's next step (the first-write race of a pin)
      return state.afterResolve.pipe(Effect.as(resolutionOf(assignment)));
    });
  const authorizeOpen = (query: DocumentOpenQuery) =>
    Effect.suspend((): Effect.Effect<DocumentOpenCase, DocumentOwnerUnavailable> => {
      asked.push({ kind: 'authorizeOpen', subject: query.link.assetRef.resourceId });
      if (state.outage) {
        return Effect.fail(new DocumentOwnerUnavailable({ reason: 'OWNER_UNAVAILABLE' }));
      }
      const allowed = openers.get(query.link.assetRef.resourceId)?.has(query.opener.principalId) === true;
      return Effect.succeed(allowed ? DocumentOpen.Allowed() : DocumentOpen.Denied());
    });
  return {
    asked,
    clearAsked: () => {
      asked.length = 0;
    },
    /** The owner assigns the business document to an Asset (new bytes are a NEW Asset and an explicit assignment). */
    assign: (
      documentId: string,
      asset: CommunicationResourceRef,
      overrides: Partial<Omit<Assignment, 'asset'>> = {},
    ) => {
      assignments.set(documentId, {
        asset,
        claimedRevision: 1,
        disclosure: 'APPROVED',
        media: 'AVAILABLE',
        ...overrides,
      });
    },
    grantOpen: (asset: CommunicationResourceRef, principalId: string) => {
      openers.set(asset.resourceId, (openers.get(asset.resourceId) ?? new Set()).add(principalId));
    },
    layer: Layer.succeed(DocumentLinkOwner, { authorizeOpen, resolve }),
    revokeOpen: (asset: CommunicationResourceRef, principalId: string) => {
      // rebuilt without the principal: a test double has no reason to use a member the destruction guard reserves
      openers.set(
        asset.resourceId,
        new Set([...(openers.get(asset.resourceId) ?? [])].filter((id) => id !== principalId)),
      );
    },
    /** Runs `action` right after the owner answered a resolve and before the caller goes on, once; the next answers are plain. */
    afterNextResolve: (action: Effect.Effect<void>) => {
      state.afterResolve = action.pipe(
        Effect.andThen(
          Effect.sync(() => {
            state.afterResolve = Effect.void;
          }),
        ),
      );
    },
    setOutage: (outage: boolean) => {
      state.outage = outage;
    },
  };
};
