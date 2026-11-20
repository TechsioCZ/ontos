import { Schema } from 'effect';

import { CommunicationResourceRefSchema } from '../catalog/vocabulary.ts';
import { CURRENT_MEDIA_REVISION, isCoreMediaAssetRef } from './document-owner.ts';
import type { ExactDocumentLink } from './document-owner.ts';
import { DocumentClassificationKeySchema, DocumentFormSchema } from './document-policy.ts';
import type { DocumentForm } from './document-policy.ts';

/**
 * The persisted pin of ONE document of ONE Message Intent (#1409, ACC-09). The owner resolved the named document to an exact
 * Core Media Asset (and its one logical V1) before the first handoff, and that answer is stored once, append-only: history never
 * repoints (new bytes are a NEW Asset and a NEW request), and a Technical Retry hands off the SAME pinned Asset, never a document
 * the owner would resolve to today. The pin is a reference and a form only: no byte, URL, file name or permission.
 */
export const DocumentPinSchema = Schema.Struct({
  assetRef: CommunicationResourceRefSchema.check(
    Schema.makeFilter((ref) => (isCoreMediaAssetRef(ref) ? undefined : 'a pin names a Core Media Asset')),
  ),
  classification: DocumentClassificationKeySchema,
  /** The business document the source named; the owner resolved it to `assetRef`. */
  document: CommunicationResourceRefSchema,
  form: DocumentFormSchema,
  /** The place of the document in the message: the canonical order of its reference. */
  position: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(9)),
  revision: Schema.Literal(CURRENT_MEDIA_REVISION),
});
export type DocumentPin = typeof DocumentPinSchema.Type;

/** What the handoff port is told about a pinned document: the form and the exact link, never a URL or bytes. */
export interface PinnedDocument {
  readonly document: DocumentPin['document'];
  readonly form: DocumentForm;
  readonly link: ExactDocumentLink;
}

export const pinnedDocumentOf = (pin: DocumentPin): PinnedDocument => ({
  document: pin.document,
  form: pin.form,
  link: { assetRef: pin.assetRef, revision: pin.revision },
});

const sameRef = (left: DocumentPin['assetRef'], right: DocumentPin['assetRef']) =>
  left.moduleId === right.moduleId && left.resourceType === right.resourceType && left.resourceId === right.resourceId;

/**
 * Whether the owner's answer of today still names the pinned Asset in the pinned form FOR THE DOCUMENT the source named at that
 * position: the only way a retry may continue. A pin whose document is not the one the reference names (a position that changed
 * meaning) never holds, whatever Asset the owner answers.
 */
export const pinStillHolds = (
  pin: DocumentPin,
  current: {
    readonly document: DocumentPin['document'];
    readonly form: DocumentForm;
    readonly link: ExactDocumentLink;
  },
) =>
  sameRef(pin.document, current.document) &&
  pin.form === current.form &&
  pin.revision === current.link.revision &&
  sameRef(pin.assetRef, current.link.assetRef);

/** Whether two pins of one position are the same pin: the first writer's pin and the one this evaluation would store. */
export const samePin = (stored: DocumentPin, candidate: DocumentPin) =>
  stored.position === candidate.position &&
  stored.classification === candidate.classification &&
  pinStillHolds(stored, { document: candidate.document, form: candidate.form, link: pinnedDocumentOf(candidate).link });
