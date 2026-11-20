import { Data, Effect, Match, Option, Schema } from 'effect';

import type { CommunicationResourceRef, MessageTypeId, PrivacyEvidence, RecipientRole } from '../catalog/vocabulary.ts';
import type { DocumentOwnerUnavailable } from './document-owner-errors.ts';
import {
  CURRENT_MEDIA_REVISION,
  DocumentLinkOwner,
  DocumentOpen,
  DocumentResolution,
  isCoreMediaAssetRef,
} from './document-owner.ts';
import type { DocumentResolveQuery, ExactDocumentLink } from './document-owner.ts';
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
 * proven stop that asks no owner; an ATTACHMENT (irreversible) also needs the Current recipient and Privacy before the owner is asked; only then the
 * owner resolves the exact Asset and approves the disclosure. A fact that is PROVEN against the disclosure stops it for good; a
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

export interface DocumentDisclosureQuery {
  readonly classification: NonNullable<DocumentPolicy>['classification'];
  readonly document: CommunicationResourceRef;
  readonly form: DocumentForm;
  /** The Current gates the handoff has just asked again: required before an irreversible attachment. */
  readonly gates: { readonly privacy: PrivacyEvidence; readonly recipient: RecipientCurrentness };
  readonly legalEntityId?: string;
  readonly policy: DocumentPolicy | undefined;
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

const attachmentGateStop = (gates: DocumentDisclosureQuery['gates']): Option.Option<DocumentStopReason> =>
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

/** The outcome of an open an owner that could not answer yields: nothing is opened. */
const openOutcomeOfOwnerFailure = ({ reason }: DocumentOwnerUnavailable): LinkOpenOutcome =>
  Match.value(reason).pipe(
    Match.when('OWNER_UNAVAILABLE', () => 'OWNER_UNAVAILABLE' as const),
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
    const gateStop = attachmentGateStop(query.gates);
    if (Option.isSome(gateStop)) {
      return stopped(gateStop.value);
    }
  }
  const owner = yield* DocumentLinkOwner;
  return yield* owner.resolve(resolveQueryOf(query)).pipe(
    Effect.match({
      // an owner that could not answer holds the document; it never discloses on a guess
      onFailure: (failure) => failure.pipe(stopReasonOfOwnerFailure, stopped),
      onSuccess: (resolution) =>
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
        }),
    }),
  );
});

/**
 * What the OPEN of a delivered link yields. The owner decides every open, again, with its own Current permission: that a
 * message was delivered, that a link exists or that it was once opened is never an authorization. An owner that cannot
 * answer, or an Asset without available content, opens nothing, and there is no other storage or URL to fall back to
 * (ACC-09, AC-07).
 */
export const LinkOpenOutcomeSchema = Schema.Literals(['DENIED', 'MEDIA_UNAVAILABLE', 'OPENED', 'OWNER_UNAVAILABLE']);
export type LinkOpenOutcome = typeof LinkOpenOutcomeSchema.Type;

export const authorizeLinkOpen = Effect.fn('Communications.authorizeLinkOpen')(function* open(
  link: ExactDocumentLink,
  opener: { readonly principalId: string; readonly tenantId: string },
) {
  const owner = yield* DocumentLinkOwner;
  return yield* owner.authorizeOpen({ link, opener }).pipe(
    Effect.match({
      onFailure: openOutcomeOfOwnerFailure,
      onSuccess: (answer): LinkOpenOutcome =>
        DocumentOpen.$match(answer, {
          Allowed: (): LinkOpenOutcome => 'OPENED',
          Denied: (): LinkOpenOutcome => 'DENIED',
          MediaUnavailable: (): LinkOpenOutcome => 'MEDIA_UNAVAILABLE',
        }),
    }),
  );
});

/**
 * What a later change of the owner's permission can do to a document already disclosed (ACC-07). A LINK is blocked at its NEXT
 * open by the owner; an ATTACHMENT left with the message and no permission change brings it back. Neither one deletes,
 * rewrites or repoints anything: the pinned reference and the history stay exactly as they were.
 */
export const effectOfOwnerRevocation = (form: DocumentForm) =>
  form === 'LINK'
    ? ({ attachmentRecalled: false, nextOpen: 'RE_AUTHORIZED_BY_OWNER' } as const)
    : ({ attachmentRecalled: false, nextOpen: 'NOT_APPLICABLE_BYTES_ALREADY_DELIVERED' } as const);
