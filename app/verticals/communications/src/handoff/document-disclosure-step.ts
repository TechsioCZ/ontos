import { Effect } from 'effect';

import type { CommunicationResourceRef, MessageTypeId, RecipientRole } from '../domain/catalog/vocabulary.ts';
import { assessDocumentDisclosure, DocumentDisclosure, stopIsProven } from '../domain/documents/disclosure.ts';
import type { DocumentDisclosureQuery, DocumentStopReason } from '../domain/documents/disclosure.ts';
import { pinStillHolds } from '../domain/documents/document-pin.ts';
import type { DocumentPin } from '../domain/documents/document-pin.ts';
import type { DocumentPolicy } from '../domain/documents/document-policy.ts';
import { formOfReference } from '../domain/documents/document-reference.ts';
import type { DocumentReference } from '../domain/documents/document-reference.ts';
import type { RecoveryStopReason } from '../domain/recovery/vocabulary.ts';

/**
 * The document disclosure of the pre-handoff step (#1409). It runs AFTER the recipient and Privacy gates cleared and BEFORE the
 * handoff is submitted, and only for a message whose request names documents; a request that names none never reaches it, so a
 * message type without documents behaves exactly as it always did.
 *
 * Every Current question is asked again at every evaluation (a retry is the same decision, so it can never bypass one), but a
 * document that was already PINNED keeps its Asset: the owner's answer of today may confirm the pinned Asset or stop the
 * message, never repoint it. An answer that names another Asset or form is a proven stop (`DOCUMENT_PIN_NOT_CURRENT`): new bytes
 * are a new Asset and a new source request, and an already sent attachment is never recalled by anything here.
 */

export interface DocumentStepInput {
  readonly documents: readonly DocumentReference[];
  readonly legalEntityId?: string | undefined;
  /** The pins stored by an earlier evaluation of this intent, by position. */
  readonly pinned: readonly DocumentPin[];
  readonly policy: DocumentPolicy | undefined;
  readonly recipient: { readonly recipientRef: CommunicationResourceRef; readonly role: RecipientRole };
  readonly tenantId: string;
  readonly typeId: MessageTypeId;
}

export type DocumentVerdict =
  /** Every document may travel: `existing` keep their stored pin and `toPin` are the owner's first answer, to store before the handoff. */
  | { readonly existing: readonly DocumentPin[]; readonly kind: 'CLEARED'; readonly toPin: readonly DocumentPin[] }
  | { readonly kind: 'STOPPED'; readonly reasons: readonly RecoveryStopReason[] };

const stopOf = (reason: DocumentStopReason): RecoveryStopReason => ({
  category: reason,
  cause: reason,
  proven: stopIsProven(reason),
});

type OneDocument =
  | { readonly kind: 'EXISTING'; readonly pin: DocumentPin }
  | { readonly kind: 'NEW'; readonly pin: DocumentPin }
  | { readonly kind: 'STOP'; readonly reason: DocumentStopReason };

const assessOne = Effect.fn('Communications.assessOneDocument')(function* assess(
  input: DocumentStepInput,
  reference: DocumentReference,
  position: number,
) {
  const form = formOfReference(reference);
  const query = {
    classification: reference.classification,
    document: reference.document,
    form,
    // this step runs after the Current recipient and Privacy gates cleared this very evaluation: an attachment needs both
    gates: { privacy: 'ALLOWED', recipient: 'CURRENT' },
    policy: input.policy,
    recipient: input.recipient,
    recipientScope: reference.recipientScope,
    tenantId: input.tenantId,
    typeId: input.typeId,
  } satisfies DocumentDisclosureQuery;
  const disclosure = yield* assessDocumentDisclosure(
    input.legalEntityId === undefined ? query : { ...query, legalEntityId: input.legalEntityId },
  );
  if (DocumentDisclosure.$is('Stop')(disclosure)) {
    return { kind: 'STOP', reason: disclosure.reason } satisfies OneDocument;
  }
  const stored = input.pinned.find((pin) => pin.position === position);
  if (stored !== undefined) {
    return pinStillHolds(stored, disclosure)
      ? ({ kind: 'EXISTING', pin: stored } satisfies OneDocument)
      : ({ kind: 'STOP', reason: 'DOCUMENT_PIN_NOT_CURRENT' } satisfies OneDocument);
  }
  return {
    kind: 'NEW',
    pin: {
      assetRef: disclosure.link.assetRef,
      classification: reference.classification,
      document: reference.document,
      form: disclosure.form,
      position,
      revision: disclosure.link.revision,
    },
  } satisfies OneDocument;
});

/** Asks the owner about every named document, in their canonical order, and answers with the pins to use or every stop reason. */
export const discloseDocuments = Effect.fn('Communications.discloseDocuments')(function* disclose(
  input: DocumentStepInput,
) {
  const answers = yield* Effect.forEach(
    input.documents,
    (reference, position) => assessOne(input, reference, position),
    {
      concurrency: 1,
    },
  );
  const stops = answers.flatMap((answer) => (answer.kind === 'STOP' ? [stopOf(answer.reason)] : []));
  if (stops.length > 0) {
    // proven reasons first, so the stop that is final is the one the history names first
    return {
      kind: 'STOPPED',
      reasons: stops.toSorted((left, right) => Number(right.proven) - Number(left.proven)),
    } satisfies DocumentVerdict;
  }
  return {
    existing: answers.flatMap((answer) => (answer.kind === 'EXISTING' ? [answer.pin] : [])),
    kind: 'CLEARED',
    toPin: answers.flatMap((answer) => (answer.kind === 'NEW' ? [answer.pin] : [])),
  } satisfies DocumentVerdict;
});
