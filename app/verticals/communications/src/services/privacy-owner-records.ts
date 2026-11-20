import { CommunicationResourceRefSchema } from '@app/communications-contracts/communication-request';
import { Option, Schema } from 'effect';

import { communicationsContentRef } from '../../shared/privacy-owner/coverage.ts';
import type { OwnerBackupCoverage } from '../../shared/privacy-owner/coverage.ts';
import type { FoundContentItem } from '../../shared/privacy-owner/contribution.ts';
import type { InventoryCategoryId } from '../../shared/privacy-owner/inventory.ts';
import type {
  attemptRetryLinks,
  communicationDecisions,
  communicationRequestConflicts,
  communicationRequests,
  deliveryAttempts,
  intentDocumentPins,
  intentHandoffStops,
  intentRecoveryEvaluations,
  intentResendLinks,
  messageIntents,
  providerObservationConflictResolutions,
  providerObservationConflicts,
  providerObservations,
} from '../database/schema.ts';

/**
 * Pure reading of what the owner found, for one Privacy lookup: which safe reference belongs to which inventory category,
 * and which of them concern anyone besides the requested subject. No query and no write happens here.
 */

/** The stable public name of each kind of record in a content reference; private table names never reach Privacy. */
export const REF_KIND = {
  attempt: 'attempt',
  conflict: 'request-conflict',
  conflictResolution: 'provider-observation-conflict-resolution',
  decision: 'decision',
  documentPin: 'document-pin',
  handoffStop: 'handoff-stop',
  intent: 'intent',
  observation: 'provider-observation',
  observationConflict: 'provider-observation-conflict',
  originalRecipient: 'original-recipient',
  providerCorrelation: 'provider-correlation',
  recoveryEvaluation: 'recovery-evaluation',
  request: 'request',
  resendLink: 'resend-link',
  retryLink: 'retry-link',
  templatePin: 'template-pin',
} as const;

export interface Gathered {
  readonly attempts: readonly (typeof deliveryAttempts.$inferSelect)[];
  readonly conflictResolutions: readonly (typeof providerObservationConflictResolutions.$inferSelect)[];
  readonly conflicts: readonly (typeof communicationRequestConflicts.$inferSelect)[];
  readonly decisions: readonly (typeof communicationDecisions.$inferSelect)[];
  readonly documentPins: readonly (typeof intentDocumentPins.$inferSelect)[];
  readonly intents: readonly (typeof messageIntents.$inferSelect)[];
  readonly observationConflicts: readonly (typeof providerObservationConflicts.$inferSelect)[];
  readonly observations: readonly (typeof providerObservations.$inferSelect)[];
  /** Requests whose own document names one of the trusted lookups: they are the requester's whatever their intents say. */
  readonly payloadNamedRequestIds: readonly string[];
  readonly recoveryEvaluations: readonly (typeof intentRecoveryEvaluations.$inferSelect)[];
  readonly requests: readonly (typeof communicationRequests.$inferSelect)[];
  readonly resends: readonly (typeof intentResendLinks.$inferSelect)[];
  readonly retries: readonly (typeof attemptRetryLinks.$inferSelect)[];
  readonly stops: readonly (typeof intentHandoffStops.$inferSelect)[];
}

export interface ResourceReference {
  readonly moduleId: string;
  readonly resourceId: string;
  readonly resourceType: string;
}

export interface OwnedRecord {
  readonly category: InventoryCategoryId;
  readonly contentRef: string;
  /** The intent the record belongs to, when it belongs to exactly one. */
  readonly intentId: string | null;
  /** The request the record belongs to, for the records that exist because of a request. */
  readonly requestId: string | null;
}

const RecipientRefsSchema = Schema.Struct({
  originalRecipients: Schema.Array(Schema.Struct({ recipientRef: CommunicationResourceRefSchema })),
});
const readRecipients = Schema.decodeUnknownOption(RecipientRefsSchema);

const sameResource = (left: ResourceReference, right: ResourceReference): boolean =>
  left.moduleId === right.moduleId && left.resourceType === right.resourceType && left.resourceId === right.resourceId;

type AddRecord = (
  category: InventoryCategoryId,
  kind: string,
  id: string,
  link?: { readonly intentId?: string; readonly requestId?: string },
) => void;

const requestRecords = (data: Gathered | undefined, add: AddRecord) => {
  for (const { requestId } of data?.requests ?? []) {
    add('REQUEST_DECISION_INTENT', REF_KIND.request, requestId, { requestId });
  }
  for (const { conflictId, requestId } of data?.conflicts ?? []) {
    add('REQUEST_DECISION_INTENT', REF_KIND.conflict, conflictId, { requestId });
  }
  for (const { decisionId, requestId } of data?.decisions ?? []) {
    add('REQUEST_DECISION_INTENT', REF_KIND.decision, decisionId, { requestId });
  }
  for (const { intentId, requestId } of data?.intents ?? []) {
    add('REQUEST_DECISION_INTENT', REF_KIND.intent, intentId, { intentId, requestId });
    add('ORIGINAL_RECIPIENT_ENDPOINT', REF_KIND.originalRecipient, intentId, { intentId, requestId });
    add('TYPE_LANGUAGE_TEMPLATE_REVISION', REF_KIND.templatePin, intentId, { intentId, requestId });
  }
};

const historyRecords = (data: Gathered | undefined, add: AddRecord) => {
  const history = 'ATTEMPTS_PROVIDER_OBSERVATIONS_SUPPRESSION';
  for (const { attemptId, intentId } of data?.attempts ?? []) {
    add(history, REF_KIND.attempt, attemptId, { intentId });
  }
  for (const { evaluationSeq, intentId } of data?.stops ?? []) {
    add(history, REF_KIND.handoffStop, `${intentId}:${evaluationSeq}`, { intentId });
  }
  for (const { intentId, observationId } of data?.observations ?? []) {
    add(history, REF_KIND.observation, observationId, { intentId });
    add('PROVIDER_COPY_WORKING_COPY_PROTECTION', REF_KIND.providerCorrelation, observationId, { intentId });
  }
  for (const { conflictId, intentId } of data?.observationConflicts ?? []) {
    add(history, REF_KIND.observationConflict, conflictId, { intentId });
  }
  for (const { evaluationSeq, intentId } of data?.recoveryEvaluations ?? []) {
    add(history, REF_KIND.recoveryEvaluation, `${intentId}:${evaluationSeq}`, { intentId });
  }
  for (const { intentId, resolutionId } of data?.conflictResolutions ?? []) {
    add(history, REF_KIND.conflictResolution, resolutionId, { intentId });
  }
  for (const { intentId, position } of data?.documentPins ?? []) {
    add('ATTACHMENT_LINK_REFERENCES', REF_KIND.documentPin, `${intentId}:${position}`, { intentId });
  }
  for (const { attemptId, intentId } of data?.retries ?? []) {
    add(history, REF_KIND.retryLink, attemptId, { intentId });
  }
  for (const { resendIntentId } of data?.resends ?? []) {
    add(history, REF_KIND.resendLink, resendIntentId, { intentId: resendIntentId });
  }
};

/** Every stored record the lookups reached, as a safe reference with its inventory category. */
export const recordsOf = (data: Gathered | undefined, attribution: readonly string[]): readonly OwnedRecord[] => {
  const records: OwnedRecord[] = [];
  const add: AddRecord = (category, kind, id, link) => {
    records.push({
      category,
      contentRef: communicationsContentRef(kind, id),
      intentId: link?.intentId ?? null,
      requestId: link?.requestId ?? null,
    });
  };
  requestRecords(data, add);
  historyRecords(data, add);
  for (const contentRef of attribution) {
    records.push({ category: 'TYPE_LANGUAGE_TEMPLATE_REVISION', contentRef, intentId: null, requestId: null });
  }
  return records;
};

/** The intents whose recipient is not one of the requested subjects: reached through a shared contact reference. */
export const foreignIntentIdsOf = (
  data: Gathered | undefined,
  subjects: readonly ResourceReference[],
): ReadonlySet<string> => {
  const foreign = new Set<string>();
  for (const { intentId, recipientId, recipientModule, recipientType } of data?.intents ?? []) {
    const recipient = { moduleId: recipientModule, resourceId: recipientId, resourceType: recipientType };
    if (!subjects.some((subject) => sameResource(recipient, subject))) {
      foreign.add(intentId);
    }
  }
  return foreign;
};

/** Requests whose own recipient list names someone besides the requested subjects (that list can be redacted). */
const requestsWithOtherRecipients = (
  data: Gathered | undefined,
  subjects: readonly ResourceReference[],
): ReadonlySet<string> => {
  const others = new Set<string>();
  for (const request of data?.requests ?? []) {
    const recipients = Option.match(readRecipients(request.payload), {
      onNone: () => [],
      onSome: (value) => value.originalRecipients.map(({ recipientRef }) => recipientRef),
    });
    if (recipients.some((ref) => !subjects.some((subject) => sameResource(ref, subject)))) {
      others.add(communicationsContentRef(REF_KIND.request, request.requestId));
    }
  }
  return others;
};

/**
 * The records that belong to the REQUESTING subject. A record of an intent addressed to someone else, reached only through a
 * shared contact reference, is another person's data and never a found reference of this subject: the contribution already
 * withholds it as inseparable, and the coverage must not hand its reference over either. A request (and its decision and
 * conflicts) is withheld only when every intent it decided is another recipient's AND its own document names none of the
 * trusted lookups (`payloadNamedRequestIds`, found by the database). The part stays PARTIAL for the shared contact, so
 * withholding never becomes a false NO_DATA.
 */
export const ownRecordsOf = (
  data: Gathered | undefined,
  records: readonly OwnedRecord[],
  subjects: readonly ResourceReference[],
): readonly OwnedRecord[] => {
  const foreignIntents = foreignIntentIdsOf(data, subjects);
  const decidedBy = new Map<string, { foreign: number; own: number }>();
  for (const { intentId, requestId } of data?.intents ?? []) {
    const known = decidedBy.get(requestId) ?? { foreign: 0, own: 0 };
    decidedBy.set(
      requestId,
      foreignIntents.has(intentId) ? { ...known, foreign: known.foreign + 1 } : { ...known, own: known.own + 1 },
    );
  }
  const named = new Set(data?.payloadNamedRequestIds);
  const withheldRequests = new Set<string>();
  for (const { requestId } of data?.requests ?? []) {
    const decided = decidedBy.get(requestId);
    if (decided !== undefined && decided.own === 0 && decided.foreign > 0 && !named.has(requestId)) {
      withheldRequests.add(requestId);
    }
  }
  return records.filter(
    ({ intentId, requestId }) =>
      !(intentId !== null && foreignIntents.has(intentId)) && !(requestId !== null && withheldRequests.has(requestId)),
  );
};

/** What each found reference concerns, for the right-specific contribution. */
export const contributionItemsOf = (
  data: Gathered | undefined,
  records: readonly OwnedRecord[],
  subjects: readonly ResourceReference[],
): readonly FoundContentItem[] => {
  const foreignIntents = foreignIntentIdsOf(data, subjects);
  const otherRecipients = requestsWithOtherRecipients(data, subjects);
  return records.map(({ category, contentRef, intentId }): FoundContentItem => {
    const ofOtherIntent = intentId !== null && foreignIntents.has(intentId);
    return {
      category,
      // a whole intent of another recipient cannot be separated; a request's recipient list can be redacted
      containsOtherDataSubjects: ofOtherIntent || otherRecipients.has(contentRef),
      contentRef,
      separable: !ofOtherIntent,
    };
  });
};

export const NO_APPLICABLE_LOOKUP = 'NO_APPLICABLE_LOOKUP_FOR_THIS_PART';
export const SHARED_CONTACT = 'CONTENT_OF_OTHER_RECIPIENTS_REACHED_THROUGH_A_SHARED_CONTACT_REFERENCE';
export const BACKUP_NOT_OBSERVABLE = 'BACKUP_AND_RECOVERY_COPIES_NOT_OBSERVABLE_BY_OWNER';

export interface ReasonContext {
  readonly backup: OwnerBackupCoverage;
  readonly hasPrincipalLookup: boolean;
  readonly hasResourceLookup: boolean;
  readonly sharedContact: boolean;
}

/** Why a category cannot be complete although it was examined; none when nothing stands in the way. */
export const unresolvedReasonOf = (category: InventoryCategoryId, context: ReasonContext): string | undefined => {
  if (category === 'TEMPORARY_RENDERED_CONTENT') {
    // nothing is persisted by design, and a guard test proves it: there is no table to examine and nothing to resolve
    return undefined;
  }
  const hasLookup =
    category === 'TYPE_LANGUAGE_TEMPLATE_REVISION'
      ? context.hasResourceLookup || context.hasPrincipalLookup
      : context.hasResourceLookup;
  if (category === 'PROVIDER_COPY_WORKING_COPY_PROTECTION' && context.backup.kind === 'UNAVAILABLE') {
    return BACKUP_NOT_OBSERVABLE;
  }
  if (context.sharedContact && context.hasResourceLookup) {
    return SHARED_CONTACT;
  }
  return hasLookup ? undefined : NO_APPLICABLE_LOOKUP;
};

export const recordsOfCategory = (
  records: readonly OwnedRecord[],
  category: InventoryCategoryId,
): readonly string[] => {
  const refs: string[] = [];
  for (const record of records) {
    if (record.category === category) {
      refs.push(record.contentRef);
    }
  }
  return refs;
};
