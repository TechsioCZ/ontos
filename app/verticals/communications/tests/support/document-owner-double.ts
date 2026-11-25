import { Effect, Layer, Schema } from 'effect';

import { CommunicationResourceRefSchema } from '../../src/domain/catalog/vocabulary.ts';
import type { CommunicationResourceRef } from '../../src/domain/catalog/vocabulary.ts';
import { DocumentOwnerUnavailable } from '../../src/domain/documents/document-owner-errors.ts';
import { DocumentLinkOwner, DocumentResolution } from '../../src/domain/documents/document-owner.ts';
import type { DocumentResolutionCase, DocumentResolveQuery } from '../../src/domain/documents/document-owner.ts';

/**
 * TEST-ONLY LABELLED DOUBLE of the document owner port (#1409). It stands in for an owner that does not exist: no document
 * owner publishes the resolution of its document to a Media Asset or the approval of its disclosure, and Core Media's Reads
 * admit no Communications caller. It proves how Communications ASKS and how it reads an answer, never that a real Media Asset
 * is stored, available or authorized, and #1409 AC-05, AC-06, AC-07 and AC-10 are proven only against it. Nothing here is a published document, an Order document or
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
  const state = { afterResolve: Effect.void, outage: false };
  const asked: { readonly kind: 'resolve'; readonly subject: string }[] = [];
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
  return {
    asked,
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
    layer: Layer.succeed(DocumentLinkOwner, { resolve }),
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
