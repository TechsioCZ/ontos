import { Context, Data, Effect, Layer, Schema } from 'effect';

import { CommunicationResourceRefSchema } from '../catalog/vocabulary.ts';
import { DocumentOwnerUnavailable } from './document-owner-errors.ts';
import type { CommunicationResourceRef, MessageTypeId, RecipientRole } from '../catalog/vocabulary.ts';
import type { DocumentClassificationKeySchema, DocumentForm } from './document-policy.ts';

/**
 * The Core Media V1 / document owner port (#1409, ACC-06, ACC-08, ACC-09, ADR-0031). Communications never stores, renders or
 * serves a document and has no Media or ACL of its own: the OWNER of a document resolves it to its exact Media Asset and
 * authorizes every disclosure and every open. Core Media V1 availability is open work of other issues (#1443, #1446), so the
 * production composition is the explicit unavailable form and nothing here fakes a published document.
 *
 * A pinned link is the exact Media Asset reference and its one Current revision, `revision = 1` (ADR-0031: one confirmed,
 * usable Media Asset has exactly one logical V1; new bytes are a NEW Asset and an explicit owner assignment). It is neither a
 * URL nor a permission: the URL, if any, is minted by the owner at open time.
 */

/** The only business revision a Core Media V1 Asset has. */
export const CURRENT_MEDIA_REVISION = 1;

export const ExactDocumentLinkSchema = Schema.Struct({
  /** The exact owner-qualified Media Asset reference. Never repointed: new bytes are another Asset. */
  assetRef: CommunicationResourceRefSchema,
  revision: Schema.Literal(CURRENT_MEDIA_REVISION),
});
export type ExactDocumentLink = typeof ExactDocumentLinkSchema.Type;

export interface DocumentResolveQuery {
  readonly classification: typeof DocumentClassificationKeySchema.Type;
  /** The business document the source named; the owner alone resolves it to an Asset. */
  readonly document: CommunicationResourceRef;
  readonly form: DocumentForm;
  readonly legalEntityId?: string;
  /** The ORIGINAL recipient only: a different recipient is a new request with its own assessment (ACC-04). */
  readonly recipient: { readonly recipientRef: CommunicationResourceRef; readonly role: RecipientRole };
  readonly tenantId: string;
  readonly typeId: MessageTypeId;
}

/**
 * What the owner reported now. `revision` is whatever the owner claims: only `1` is a Current Media revision, and the
 * domain refuses anything else instead of trusting the claim.
 */
export type DocumentResolutionCase = Data.TaggedEnum<{
  /** The owner approved this disclosure of this document to this recipient and names the exact Asset. */
  Approved: { readonly asset: { readonly ref: CommunicationResourceRef; readonly revision: number } };
  /** The owner forbids the disclosure now. */
  DisclosureForbidden: object;
  /** The Asset exists but its content is not confirmed and available (corrupt, forbidden, missing, not yet confirmed). */
  MediaUnavailable: object;
}>;
export const DocumentResolution = Data.taggedEnum<DocumentResolutionCase>();

export interface DocumentOpenQuery {
  /** The link as pinned at the message: the owner is never asked about a Current assignment instead. */
  readonly link: ExactDocumentLink;
  readonly opener: { readonly principalId: string; readonly tenantId: string };
}

export type DocumentOpenCase = Data.TaggedEnum<{
  Allowed: object;
  Denied: object;
  /** The Asset behind the pinned link has no available content now. */
  MediaUnavailable: object;
}>;
export const DocumentOpen = Data.taggedEnum<DocumentOpenCase>();

export interface DocumentLinkOwnerService {
  /** The owner's CURRENT authorization of the OPEN of one pinned link, asked at every open, even for a delivered message. */
  readonly authorizeOpen: (query: DocumentOpenQuery) => Effect.Effect<DocumentOpenCase, DocumentOwnerUnavailable>;
  /** The owner's Current resolution of a named document and approval of its disclosure, asked before the handoff. */
  readonly resolve: (query: DocumentResolveQuery) => Effect.Effect<DocumentResolutionCase, DocumentOwnerUnavailable>;
}

export class DocumentLinkOwner extends Context.Service<DocumentLinkOwner, DocumentLinkOwnerService>()(
  '@app/communications/domain/documents/document-owner/DocumentLinkOwner',
) {}

/**
 * The only production composition today: Core Media V1 and the document owners publish no such Read yet (#1443, #1446), so
 * every question fails closed. It is explicit so a document is never disclosed or opened by default or by a missing adapter.
 */
export const unavailableDocumentLinkOwnerLayer = Layer.succeed(DocumentLinkOwner, {
  authorizeOpen: () => Effect.fail(new DocumentOwnerUnavailable({ reason: 'OWNER_UNAVAILABLE' })),
  resolve: () => Effect.fail(new DocumentOwnerUnavailable({ reason: 'OWNER_UNAVAILABLE' })),
});
