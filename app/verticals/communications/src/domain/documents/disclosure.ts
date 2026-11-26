import { Data, Effect, Match, Option, Schema } from 'effect';

import type { CommunicationResourceRef, MessageTypeId, PrivacyEvidence, RecipientRole } from '../catalog/vocabulary.ts';
import type { DocumentOwnerUnavailable } from './document-owner-errors.ts';
import {
  CURRENT_MEDIA_REVISION,
  DocumentLinkOwner,
  DocumentResolution,
  isCoreMediaAssetRef,
} from './document-owner.ts';
import type { DocumentResolutionCase, DocumentResolveQuery, ExactDocumentLink } from './document-owner.ts';
import { formAllowedByPolicy } from './document-policy.ts';
import type { DisclosureRecipientScope, DocumentForm, DocumentPolicy } from './document-policy.ts';

/**
 * The disclosure decision of a document of a message (#1409). It runs before the last stoppable handoff and answers with
 * either the exact pinned link or one TRUTHFUL stop reason; it never sends, stores or deletes anything, and a retry is the
 * same decision asked again with every Current gate asked again, so a retry can never bypass one (ACC-09).
 *
 * Order matters and is part of the contract: the type's own approval is checked first, so an unapproved form never even asks
 * an owner; then the policy is enforced end to end against what is being disclosed (the document owner, the owner's
 * classification and the recipient scope must each equal what the type approved), so a document the type never approved is a
 * proven stop that asks no owner; an ATTACHMENT (irreversible) also needs the Current recipient and Privacy before the owner is asked,
 * and needs them AGAIN after the owner answered, because the owner call takes time and the last reading before a disclosure is the
 * one that counts (ACC-07); only then the owner's approval of the exact Asset discloses. A fact that is PROVEN against the disclosure stops it for good; a
 * fact that could not be established holds it, with its reason, for a new evaluation: nothing is ever delivered on a guess.
 */

export const DocumentStopReasonSchema = Schema.Literals([
  'ATTACHMENT_NOT_APPROVED_FOR_TYPE',
  'DOCUMENT_ASSET_NOT_CORE_MEDIA',
  'DOCUMENT_CLASSIFICATION_MISMATCH',
  'DOCUMENT_MEDIA_UNAVAILABLE',
  'DOCUMENT_NOT_APPROVED_FOR_TYPE',
  'DOCUMENT_OWNER_FORBIDDEN',
  'DOCUMENT_OWNER_MISMATCH',
  'DOCUMENT_OWNER_UNAVAILABLE',
  'DOCUMENT_PIN_NOT_CURRENT',
  'DOCUMENT_PRIVACY_INDETERMINATE',
  'DOCUMENT_PRIVACY_NOT_ALLOWED',
  'DOCUMENT_RECIPIENT_NOT_CURRENT',
  'DOCUMENT_RECIPIENT_SCOPE_MISMATCH',
  'DOCUMENT_RECIPIENT_UNKNOWN',
  'DOCUMENT_REVISION_NOT_CURRENT',
]);
export type DocumentStopReason = typeof DocumentStopReasonSchema.Type;

/** A reason that only could not be established holds the document; every other one is proven and final for this decision. */
const UNPROVEN = new Set<DocumentStopReason>([
  'DOCUMENT_MEDIA_UNAVAILABLE',
  'DOCUMENT_OWNER_UNAVAILABLE',
  'DOCUMENT_PRIVACY_INDETERMINATE',
  'DOCUMENT_RECIPIENT_UNKNOWN',
]);
export const stopIsProven = (reason: DocumentStopReason) => !UNPROVEN.has(reason);

export type DocumentDisclosureCase = Data.TaggedEnum<{
  /** The document may be disclosed in this form, as exactly this pinned link. */
  Disclose: { readonly form: DocumentForm; readonly link: ExactDocumentLink };
  /** Nothing is disclosed. `proven` is false when only an unavailable fact stopped it. */
  Stop: { readonly proven: boolean; readonly reason: DocumentStopReason };
}>;
export const DocumentDisclosure = Data.taggedEnum<DocumentDisclosureCase>();

const stopped = (reason: DocumentStopReason) => DocumentDisclosure.Stop({ proven: stopIsProven(reason), reason });

/** What the Current recipient gate (d21-03) reported about the ORIGINAL recipient and endpoint just now. */
export const RecipientCurrentnessSchema = Schema.Literals(['CURRENT', 'NOT_CURRENT', 'UNKNOWN']);
export type RecipientCurrentness = typeof RecipientCurrentnessSchema.Type;

/** What the Current recipient and Privacy gates reported when they were read. */
export interface DocumentGates {
  readonly privacy: PrivacyEvidence;
  readonly recipient: RecipientCurrentness;
}

export interface DocumentDisclosureQuery {
  readonly classification: NonNullable<DocumentPolicy>['classification'];
  readonly document: CommunicationResourceRef;
  readonly form: DocumentForm;
  readonly legalEntityId?: string;
  readonly policy: DocumentPolicy | undefined;
  /**
   * Reads the Current recipient and Privacy gates NOW, never a remembered answer. An irreversible attachment reads them before
   * the owner is asked and again after it answered; a link is reversible at every open and reads none.
   */
  readonly readGates: Effect.Effect<DocumentGates>;
  readonly recipient: { readonly recipientRef: CommunicationResourceRef; readonly role: RecipientRole };
  /** What the handoff is disclosing to: only the ORIGINAL recipient is ever approved (ACC-04, ACC-13). */
  readonly recipientScope: DisclosureRecipientScope;
  readonly tenantId: string;
  readonly typeId: MessageTypeId;
}

/**
 * The policy enforced end to end against what is asked: the document must be the approved owner's own resource, carry the
 * classification the type approved, and go to the scope the type approved. Each mismatch is PROVEN, so it stops for good
 * and no owner is asked about a document the type never approved (ACC-13).
 */
const policyMismatch = (policy: DocumentPolicy, query: DocumentDisclosureQuery): Option.Option<DocumentStopReason> => {
  if (query.document.moduleId !== policy.documentOwner) {
    return Option.some('DOCUMENT_OWNER_MISMATCH');
  }
  if (query.classification !== policy.classification) {
    return Option.some('DOCUMENT_CLASSIFICATION_MISMATCH');
  }
  return query.recipientScope === policy.recipientScope
    ? Option.none()
    : Option.some('DOCUMENT_RECIPIENT_SCOPE_MISMATCH');
};

const attachmentGateStop = (gates: DocumentGates): Option.Option<DocumentStopReason> =>
  Match.value(gates.recipient).pipe(
    Match.when('NOT_CURRENT', () => Option.some<DocumentStopReason>('DOCUMENT_RECIPIENT_NOT_CURRENT')),
    Match.when('UNKNOWN', () => Option.some<DocumentStopReason>('DOCUMENT_RECIPIENT_UNKNOWN')),
    Match.when('CURRENT', () =>
      Match.value(gates.privacy).pipe(
        Match.when('NOT_ALLOWED', () => Option.some<DocumentStopReason>('DOCUMENT_PRIVACY_NOT_ALLOWED')),
        Match.when('INDETERMINATE', () => Option.some<DocumentStopReason>('DOCUMENT_PRIVACY_INDETERMINATE')),
        Match.when('ALLOWED', () => Option.none<DocumentStopReason>()),
        Match.exhaustive,
      ),
    ),
    Match.exhaustive,
  );

/** The reason an owner that could not answer holds the document: what it could not establish, never a guess. */
const stopReasonOfOwnerFailure = ({ reason }: DocumentOwnerUnavailable): DocumentStopReason =>
  Match.value(reason).pipe(
    Match.when('OWNER_UNAVAILABLE', () => 'DOCUMENT_OWNER_UNAVAILABLE' as const),
    Match.exhaustive,
  );

interface ResolveQueryDraft {
  classification: DocumentResolveQuery['classification'];
  document: DocumentResolveQuery['document'];
  form: DocumentResolveQuery['form'];
  legalEntityId?: string;
  recipient: DocumentResolveQuery['recipient'];
  tenantId: string;
  typeId: DocumentResolveQuery['typeId'];
}

const resolveQueryOf = (query: DocumentDisclosureQuery): DocumentResolveQuery => {
  const resolve: ResolveQueryDraft = {
    classification: query.classification,
    document: query.document,
    form: query.form,
    recipient: query.recipient,
    tenantId: query.tenantId,
    typeId: query.typeId,
  };
  if (query.legalEntityId !== undefined) {
    resolve.legalEntityId = query.legalEntityId;
  }
  return resolve;
};

/** The disclosure an owner's answer allows, or the truthful stop it forces. */
const disclosureOfResolution = (query: DocumentDisclosureQuery, resolution: DocumentResolutionCase) =>
  DocumentResolution.$match(resolution, {
    Approved: ({ asset }) => {
      // a pinned link names a Core Media Asset and nothing else: no business document, Order or foreign resource
      if (!isCoreMediaAssetRef(asset.ref)) {
        return stopped('DOCUMENT_ASSET_NOT_CORE_MEDIA');
      }
      // only V1 is Current: another claimed revision is never trusted or substituted
      return asset.revision === CURRENT_MEDIA_REVISION
        ? DocumentDisclosure.Disclose({
            form: query.form,
            link: { assetRef: asset.ref, revision: CURRENT_MEDIA_REVISION },
          })
        : stopped('DOCUMENT_REVISION_NOT_CURRENT');
    },
    DisclosureForbidden: () => stopped('DOCUMENT_OWNER_FORBIDDEN'),
    MediaUnavailable: () => stopped('DOCUMENT_MEDIA_UNAVAILABLE'),
  });

/** Decides whether ONE document may be disclosed in ONE form. The owner is asked only when the type's own approval allows it. */
export const assessDocumentDisclosure = Effect.fn('Communications.assessDocumentDisclosure')(function* assess(
  query: DocumentDisclosureQuery,
) {
  const { policy } = query;
  if (policy === undefined || formAllowedByPolicy(policy, query.form) === 'NOT_ALLOWED') {
    // an approved link says nothing about an attachment, and neither says anything about another type (ACC-13)
    return stopped(query.form === 'ATTACHMENT' ? 'ATTACHMENT_NOT_APPROVED_FOR_TYPE' : 'DOCUMENT_NOT_APPROVED_FOR_TYPE');
  }
  const mismatch = policyMismatch(policy, query);
  if (Option.isSome(mismatch)) {
    return stopped(mismatch.value);
  }
  if (query.form === 'ATTACHMENT') {
    const gateStop = attachmentGateStop(yield* query.readGates);
    if (Option.isSome(gateStop)) {
      return stopped(gateStop.value);
    }
  }
  const owner = yield* DocumentLinkOwner;
  const resolved = yield* owner.resolve(resolveQueryOf(query)).pipe(
    Effect.match({
      // an owner that could not answer holds the document; it never discloses on a guess
      onFailure: (failure) => failure.pipe(stopReasonOfOwnerFailure, stopped),
      onSuccess: (resolution) => disclosureOfResolution(query, resolution),
    }),
  );
  if (query.form !== 'ATTACHMENT' || DocumentDisclosure.$is('Stop')(resolved)) {
    return resolved;
  }
  // the owner call took time and an attachment cannot be recalled: the gates are read again and the LAST reading decides
  const lateStop = attachmentGateStop(yield* query.readGates);
  return Option.isSome(lateStop) ? stopped(lateStop.value) : resolved;
});
