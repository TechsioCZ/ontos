import { Schema } from 'effect';

import { CommunicationResourceRefSchema } from '../catalog/vocabulary.ts';
import {
  DisclosureRecipientScopeSchema,
  DocumentClassificationKeySchema,
  DocumentFormSchema,
} from './document-policy.ts';

/**
 * A document the SOURCE named for a message, as this owner's domain reads it (#1409). It is a safe reference only: the owner
 * module that answers for the document is `document.moduleId`, then the owner's classification key and the recipient scope the
 * source asks for. No byte, URL, file name or permission has a field here, and a reference grants nothing: the owner resolves it
 * to its exact Media Asset and approves the disclosure when the message is handed off.
 */
export const DocumentReferenceSchema = Schema.Struct({
  classification: DocumentClassificationKeySchema,
  document: CommunicationResourceRefSchema,
  /** Absent means a link, the default form. */
  form: Schema.optionalKey(DocumentFormSchema),
  recipientScope: DisclosureRecipientScopeSchema,
});
export type DocumentReference = typeof DocumentReferenceSchema.Type;

/** The form a reference asks for: a link unless the source explicitly asked for the irreversible attachment. */
export const formOfReference = ({ form }: DocumentReference) => form ?? 'LINK';

export const referenceKey = ({ document }: DocumentReference) =>
  `${document.moduleId}|${document.resourceType}|${document.resourceId}`;

/**
 * The position a document keeps in a message: the canonical order of its reference, so a source's list order changes nothing.
 * The order is a code-unit comparison of the reference key, never a locale one: a persisted position must be the same on every
 * runtime, ICU version and collation, or a pin written by one process would be read at another position by the next.
 */
export const orderedReferences = (references: readonly DocumentReference[]) =>
  references.toSorted((left, right) => {
    const [first, second] = [referenceKey(left), referenceKey(right)];
    if (first === second) {
      return 0;
    }
    return first < second ? -1 : 1;
  });
