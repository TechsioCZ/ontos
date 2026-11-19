import { OntosModuleIdSchema } from '@app/core-runtime/modules/manifest';
import { Schema } from 'effect';

import { ApprovedRuleKeySchema } from '../catalog/vocabulary.ts';

/**
 * The per-message-type document policy (#1409, ACC-06, ACC-07, ACC-13). A message type approves documents EXPLICITLY or it has
 * none: the policy is optional on the type and its absence is the "no documents" default, so every existing type keeps its
 * meaning. Approving one type, one document or one recipient approves nothing else.
 *
 * - LINK is the default form and only for a type that allows documents. The message carries a reference to the exact Media
 *   Asset; the real document owner authorizes every OPEN again, so a URL or a receipt is never a permission.
 * - ATTACHMENT is an IRREVERSIBLE disclosure (the bytes leave with the message and cannot be recalled by any permission
 *   change). It exists only with an explicit approval of that exact type, carried as the key of the approved rule; the
 *   absence of the approval is the only default.
 * The classification is the document owner's own approved key, never a vocabulary invented here, and the recipient scope has
 * one value: the document goes only to the ORIGINAL recipient of the message (ACC-04); a further disclosure is a new request.
 */

/** The document owner's approved classification of the document, as its stable key. Opaque to Communications. */
export const DocumentClassificationKeySchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(120),
  Schema.isPattern(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)*$/u),
).pipe(Schema.brand('CommunicationDocumentClassification'));

export const AttachmentApprovalSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('NOT_ALLOWED') }),
  /** The approval of THIS type: the key of the approved owner rule that allows the irreversible disclosure. */
  Schema.Struct({ approvalKey: ApprovedRuleKeySchema, kind: Schema.Literal('APPROVED') }),
]);

export const DocumentPolicySchema = Schema.Struct({
  attachment: AttachmentApprovalSchema,
  classification: DocumentClassificationKeySchema,
  /** The module that owns the document and answers for its disclosure and its open: the real source or document owner. */
  documentOwner: OntosModuleIdSchema,
  link: Schema.Literals(['ALLOWED', 'NOT_ALLOWED']),
  recipientScope: Schema.Literal('ORIGINAL_RECIPIENT'),
}).check(
  Schema.makeFilter((policy) =>
    policy.link === 'ALLOWED' || policy.attachment.kind === 'APPROVED'
      ? undefined
      : 'a document policy allows a link or an approved attachment; the absence of a policy is the no-document default',
  ),
);
export type DocumentPolicy = typeof DocumentPolicySchema.Type;

export const DocumentFormSchema = Schema.Literals(['ATTACHMENT', 'LINK']);
export type DocumentForm = typeof DocumentFormSchema.Type;

/** What a type allows for a form, from its policy or from the default of having none. */
export const formAllowedByPolicy = (
  policy: DocumentPolicy | undefined,
  form: DocumentForm,
): 'ALLOWED' | 'NOT_ALLOWED' => {
  if (policy === undefined) {
    return 'NOT_ALLOWED';
  }
  if (form === 'LINK') {
    return policy.link;
  }
  return policy.attachment.kind === 'APPROVED' ? 'ALLOWED' : 'NOT_ALLOWED';
};
