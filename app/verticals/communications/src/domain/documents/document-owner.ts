import { Context, Data, Effect, Layer, Schema } from 'effect';

import { CommunicationResourceRefSchema } from '../catalog/vocabulary.ts';
import { DocumentOwnerUnavailable } from './document-owner-errors.ts';
import type { CommunicationResourceRef, MessageTypeId, RecipientRole } from '../catalog/vocabulary.ts';
import type { DocumentClassificationKeySchema, DocumentForm } from './document-policy.ts';

/**
 * The Core Media V1 / document owner port (#1409, ACC-06, ACC-08, ACC-09, ADR-0031). Communications never stores, renders or
 * serves a document, has no Media or ACL of its own and never opens a link: the OWNER of a document resolves it to its exact
 * Media Asset and approves its disclosure, and the owner and Core Media authorize every OPEN of a delivered link afresh, outside
 * Communications (ACC-06). Core Media now publishes Current and download Reads (`asset-current`, `asset-download`), but they
 * answer only to the allow-listed caller `catalog`, for a person requester, about a Media Asset reference the caller already
 * holds; no owner publishes the resolution of a business document to an Asset or the approval of its disclosure. A production
 * adapter is therefore not buildable from Communications, so the production composition is the explicit unavailable form and
 * nothing here fakes a published document.
 *
 * A pinned link is the exact Media Asset reference and its one Current revision, `revision = 1` (ADR-0031: one confirmed,
 * usable Media Asset has exactly one logical V1; new bytes are a NEW Asset and an explicit owner assignment). It is neither a
 * URL nor a permission: the URL, if any, is minted by the owner at open time.
 */

/** The only business revision a Core Media V1 Asset has. */
export const CURRENT_MEDIA_REVISION = 1;

/**
 * The owner and resource type of a Core Media Asset reference, the same strings Core Media publishes (`docs/architecture/CORE_MEDIA.md`):
 * a pinned link points at a Media Asset only, never at a business document, an Order, an invoice or another module's
 * resource, whatever an owner answers.
 */
export const CORE_MEDIA_MODULE_ID = 'core.media';
export const CORE_MEDIA_ASSET_RESOURCE_TYPE = 'core.media.asset';
export const isCoreMediaAssetRef = (ref: CommunicationResourceRef) =>
  ref.moduleId === CORE_MEDIA_MODULE_ID && ref.resourceType === CORE_MEDIA_ASSET_RESOURCE_TYPE;

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

export interface DocumentLinkOwnerService {
  /** The owner's Current resolution of a named document and approval of its disclosure, asked before the handoff. */
  readonly resolve: (query: DocumentResolveQuery) => Effect.Effect<DocumentResolutionCase, DocumentOwnerUnavailable>;
}

export class DocumentLinkOwner extends Context.Service<DocumentLinkOwner, DocumentLinkOwnerService>()(
  '@app/communications/domain/documents/document-owner/DocumentLinkOwner',
) {}

/**
 * The only production composition today: no document owner publishes a Read that resolves its document to a Media Asset and
 * approves its disclosure, and Core Media's Reads admit no Communications caller, so every question fails closed. It is explicit
 * so a document is never disclosed by default or by a missing adapter.
 */
export const unavailableDocumentLinkOwnerLayer = Layer.succeed(DocumentLinkOwner, {
  resolve: () => Effect.fail(new DocumentOwnerUnavailable({ reason: 'OWNER_UNAVAILABLE' })),
});
