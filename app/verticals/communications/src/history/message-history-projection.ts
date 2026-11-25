import { OntosModuleIdSchema } from '@app/core-runtime/modules/manifest';
import { Array as EffectArray, Data, DateTime, Effect, Option, Order, Schema } from 'effect';

import {
  EndpointMaskSchema,
  HistoryChannelSchema,
  MessageHistoryItemSchema,
  MessageHistoryRequestItemSchema,
  MessageHistoryTimelineEntrySchema,
  TEMPLATE_PREVIEW_MARKER,
} from '../../shared/message-history-read.ts';
import type {
  MessageHistoryItem,
  MessageHistoryLink,
  MessageHistoryTimelineEntry,
} from '../../shared/message-history-read.ts';
import type { TemplateScope, TemplateUseAudit } from '../../shared/template-revision.ts';
import { MessageIntentIdSchema } from '../../shared/communication-intake.ts';
import { messageHeadlineOf } from '../domain/history/source-outcome.ts';
import type { HistoryEntry } from '../domain/history/timeline.ts';
import type { IntentHistoryRecord, RequestHistoryRecord } from '../services/message-history.service.ts';

/**
 * The typed ALLOW-LIST projection of the message history (#1409, ACC-01, ACC-05). It is the only function that turns the
 * owner-internal history record into something a Read returns, and it builds the result field by field: nothing is copied by
 * spread and nothing is passed through, so a field the allow-list does not name cannot reach a caller, whatever the record
 * grows to hold. The candidate is then validated through the published schema, which carries only references, closed codes,
 * masks and times, so a body, a template text, an address, a link or a secret has no field to travel in.
 *
 * The mask is the one personal-data field: it is projected only when the caller may read it, and only when it still hides the
 * endpoint (a stored value that reads as a whole address is dropped, never shown).
 */

const CLOSED_CODE = /^[A-Za-z][A-Za-z0-9_]{0,79}$/u;
const isMask = Schema.is(EndpointMaskSchema);
const isChannel = Schema.is(HistoryChannelSchema);
const isClosedCode = (code: string) => CLOSED_CODE.test(code);

const uniqueInOrder = (codes: readonly string[]) => EffectArray.dedupe(codes.filter(isClosedCode));

/** The closed reasons in the order they were recorded; the concrete reason recovery left (#1403) is the last one. */
const reasonCodesOf = (intent: IntentHistoryRecord): readonly string[] => {
  const decided = intent.decisionReason === undefined ? [] : [intent.decisionReason];
  const stopped = intent.history.entries.flatMap((entry) =>
    entry.kind === 'INTENT_SUPPRESSED' || entry.kind === 'INTENT_NOT_SENT' || entry.kind === 'HANDOFF_STOPPED'
      ? entry.reasonCodes
      : [],
  );
  const recovery = intent.history.summary.recovery === undefined ? [] : [intent.history.summary.recovery.code];
  return uniqueInOrder([...decided, ...stopped, ...recovery]);
};

const byRecordedAt = Order.mapInput(Order.Number, (entry: HistoryEntry) => entry.recordedAt.epochMilliseconds);

const lastEventAtOf = (intent: IntentHistoryRecord): DateTime.Utc =>
  Option.getOrElse(
    Option.map(
      EffectArray.last(EffectArray.sort(intent.history.entries, byRecordedAt)),
      ({ recordedAt }) => recordedAt,
    ),
    () => intent.decidedAt,
  );

export interface ProjectionOptions {
  /** Whether the caller may read the personal-data field group of the mask. */
  readonly includeEndpointMask: boolean;
  /** The audit of the template the message used, only when the caller may read its own field group (#1398 AC-02). */
  readonly templateUse?: TemplateUseAudit | undefined;
}

/** Drafts: the candidate of each part, assembled field by field and validated against the schema before it leaves. */
interface RecipientDraft {
  channel?: string;
  endpointMask?: string;
  readonly ref: IntentHistoryRecord['recipient']['ref'];
  readonly role: string;
}
interface ScopeDraft {
  counterpartyRef?: MessageHistoryItem['source']['scope']['counterpartyRef'];
  legalEntityId?: string;
  profileRef?: MessageHistoryItem['source']['scope']['profileRef'];
  storefrontRef?: MessageHistoryItem['source']['scope']['storefrontRef'];
}
interface TemplateDraft {
  contentDigest?: string;
  readonly language: string;
  readonly messageType: string;
  mode?: string;
  readonly notice: typeof TEMPLATE_PREVIEW_MARKER;
  readonly revisionNumber: number;
  readonly source: string;
}
interface HeadlineDraft {
  readonly attention: string;
  readonly contradictory: boolean;
  readonly deliveryProven: boolean;
  readonly needsReconciliation: boolean;
  readonly providerAccepted: boolean;
  readonly reasonCodes: readonly string[];
  readonly status: string;
}
interface SourceDraft {
  readonly moduleId: string;
  readonly occurrence: { readonly occurrenceId: string; readonly revision: number };
  readonly purpose: string;
  readonly scope: ScopeDraft;
}
interface TemplateUseDraft {
  activation?: {
    readonly activatedAt: DateTime.Utc;
    readonly activatedByPrincipalId: string;
    readonly reason: string;
    readonly scope: TemplateScope;
  };
  readonly activeAtDecisionTime: boolean;
  readonly contentDigest: string;
  readonly lifecycleState: string;
  readonly revisionId: string;
  readonly revisionNumber: number;
  readonly scope: TemplateScope;
  readonly source: string;
}
interface ItemDraft {
  readonly decidedAt: DateTime.Utc;
  readonly documents: IntentHistoryRecord['documents'];
  readonly headline: HeadlineDraft;
  readonly intentId: string;
  readonly lastEventAt: DateTime.Utc;
  readonly links: readonly MessageHistoryLink[];
  readonly recipient: RecipientDraft;
  readonly requestId: string;
  readonly slotKey: string;
  readonly source: SourceDraft;
  template?: TemplateDraft;
  templateUse?: TemplateUseDraft;
  readonly type: { readonly typeId: string; readonly typeRevision: number };
}
interface EntryDraft {
  attemptNumber?: number;
  kind: string;
  links?: readonly MessageHistoryLink[];
  observationKind?: string;
  occurredAt: HistoryEntry['occurredAt'];
  outOfOrder: boolean;
  reasonCodes: readonly string[];
  recordedAt: HistoryEntry['recordedAt'];
  status: string;
  technical?: string;
}

/** The ORIGINAL recipient: references and role always, the channel when known, the mask only when allowed and safe. */
const recipientOf = (intent: IntentHistoryRecord, options: ProjectionOptions) => {
  const { channel, endpointMask, ref, role } = intent.recipient;
  const recipient: RecipientDraft = { ref, role };
  if (channel !== undefined && isChannel(channel)) {
    recipient.channel = channel;
  }
  if (options.includeEndpointMask && endpointMask !== undefined && isMask(endpointMask)) {
    // a mask that does not hide the endpoint is dropped here, never shown
    recipient.endpointMask = endpointMask;
  }
  return recipient;
};

/** The scope of the request as references only, each present only when the request had it. */
const scopeOf = ({ request }: RequestHistoryRecord) => {
  const { counterpartyRef, legalEntityId, profileRef, storefrontRef } = request.scope;
  const scope: ScopeDraft = {};
  if (counterpartyRef !== undefined) {
    scope.counterpartyRef = counterpartyRef;
  }
  if (legalEntityId !== undefined) {
    scope.legalEntityId = legalEntityId;
  }
  if (profileRef !== undefined) {
    scope.profileRef = profileRef;
  }
  if (storefrontRef !== undefined) {
    scope.storefrontRef = storefrontRef;
  }
  return scope;
};

const pinOf = (
  language: NonNullable<IntentHistoryRecord['language']>,
  template: NonNullable<IntentHistoryRecord['template']>,
) => {
  const pin: TemplateDraft = {
    language: language.language,
    messageType: template.messageType,
    notice: TEMPLATE_PREVIEW_MARKER,
    revisionNumber: template.revisionNumber,
    source: template.source,
  };
  if (language.mode !== undefined) {
    pin.mode = language.mode;
  }
  if (template.contentDigest !== undefined) {
    pin.contentDigest = template.contentDigest;
  }
  return pin;
};

/** The template pin as a PREVIEW marker, or none when the message was stopped before any template was pinned. */
const templateOf = ({ language, template }: IntentHistoryRecord) =>
  language === undefined || template === undefined
    ? Option.none<TemplateDraft>()
    : Option.some(pinOf(language, template));

const decodeItem = Schema.decodeUnknownEffect(Schema.toType(MessageHistoryItemSchema));
const decodeRequestItem = Schema.decodeUnknownEffect(Schema.toType(MessageHistoryRequestItemSchema));
const decodeEntry = Schema.decodeUnknownEffect(Schema.toType(MessageHistoryTimelineEntrySchema));

/** The source of a request as a safe draft: the module, the exact occurrence, the purpose and the scope as references only. */
const sourceOf = Effect.fn('Communications.projectHistorySource')(function* source(request: RequestHistoryRecord) {
  const moduleId = yield* Schema.decodeUnknownEffect(OntosModuleIdSchema)(request.request.sourceModule);
  return {
    moduleId,
    occurrence: { occurrenceId: request.request.occurrenceId, revision: request.request.occurrenceRevision },
    purpose: request.request.purpose,
    scope: scopeOf(request),
  } satisfies SourceDraft;
});

const retryAttemptOf = (link: MessageHistoryLink) => (link.kind === 'TECHNICAL_RETRY' ? link.attemptNumber : 0);
const byRetryAttempt = Order.mapInput(Order.Number, retryAttemptOf);

const resendLink = (
  direction: 'RESEND_OF' | 'RESENT_AS',
  { intentId, reasonCode }: { readonly intentId: string; readonly reasonCode: string },
): MessageHistoryLink => ({
  direction,
  intentId: MessageIntentIdSchema.make(intentId),
  kind: 'EXPLICIT_RESEND',
  reasonCode,
});

/**
 * The links of one message, from either end (#1402 D9, AC-09): the original it resends, the resends of it, and each Technical
 * Retry with BOTH attempt numbers. A retry whose attempt is not among the intent's own attempts cannot be explained and is
 * left out, never guessed (the store's composite keys make that impossible).
 */
const linksOf = ({ facts, links }: IntentHistoryRecord): readonly MessageHistoryLink[] => {
  const numbers = new Map(facts.attempts.map(({ attemptId, attemptNumber }) => [attemptId, attemptNumber]));
  const resends: MessageHistoryLink[] = links.resentAs.map((entry) => resendLink('RESENT_AS', entry));
  if (links.resendOf !== undefined) {
    resends.unshift(resendLink('RESEND_OF', links.resendOf));
  }
  const retries = links.retries.flatMap(
    ({ attemptId, basisKind, previousAttemptId, reasonCode }): MessageHistoryLink[] => {
      const attemptNumber = numbers.get(attemptId);
      const previousAttemptNumber = numbers.get(previousAttemptId);
      return attemptNumber === undefined || previousAttemptNumber === undefined
        ? []
        : [{ attemptNumber, basisKind, kind: 'TECHNICAL_RETRY', previousAttemptNumber, reasonCode }];
    },
  );
  return [...resends, ...retries.toSorted(byRetryAttempt)];
};

const isCovering = (decisionTime: DateTime.Utc) => (activation: TemplateUseAudit['activations'][number]) =>
  DateTime.isLessThanOrEqualTo(activation.activatedAt, decisionTime) &&
  (activation.endedAt === undefined || DateTime.isGreaterThan(activation.endedAt, decisionTime));

/**
 * The template use of one message from the owner's audit (`describeTemplateUse`): the revision, whether it was in force at the
 * decision, and the activation that was in force THEN (who, when, which scope, why), never a later or earlier activation of the
 * same revision. A built-in default has no activation: nobody activated it. Digests, identities and the administrator's reason
 * only; no subject, body or placeholder value exists in the audit to copy.
 */
const templateUseOf = (audit: TemplateUseAudit) => {
  const use: TemplateUseDraft = {
    activeAtDecisionTime: audit.activeAtDecisionTime,
    contentDigest: audit.contentDigest,
    lifecycleState: audit.lifecycleState,
    revisionId: audit.revisionId,
    revisionNumber: audit.revisionNumber,
    scope: audit.identity.scope,
    source: audit.source,
  };
  const activation = audit.activations.findLast(isCovering(audit.decisionTime));
  if (activation !== undefined) {
    use.activation = {
      activatedAt: activation.activatedAt,
      activatedByPrincipalId: activation.activatedByPrincipalId,
      reason: activation.activationReason,
      scope: audit.identity.scope,
    };
  }
  return use;
};

/**
 * One message of a request as a safe item. The candidate is validated against the published schema before it is returned, so
 * a value that is not representable (a mask that reads as an address, a reason that is not a closed code) fails the
 * projection instead of travelling; a failure is a typed schema error the Read maps to an unavailable answer.
 */
export const projectMessageHistoryItem = Effect.fn('Communications.projectMessageHistoryItem')(function* project(
  request: RequestHistoryRecord,
  intent: IntentHistoryRecord,
  options: ProjectionOptions,
) {
  const { summary } = intent.history;
  const item: ItemDraft = {
    decidedAt: intent.decidedAt,
    documents: intent.documents,
    headline: {
      // the same derivation as the source outcome feed: a Read never says anything else than the feed does
      attention: messageHeadlineOf(summary, intent.decisionReason).attention,
      contradictory: summary.contradictory,
      deliveryProven: summary.deliveryProven,
      needsReconciliation: summary.needsReconciliation,
      providerAccepted: summary.providerAccepted,
      reasonCodes: reasonCodesOf(intent),
      status: summary.status,
    },
    intentId: intent.intentId,
    lastEventAt: lastEventAtOf(intent),
    links: linksOf(intent),
    recipient: recipientOf(intent, options),
    requestId: request.request.requestId,
    slotKey: intent.slotKey,
    source: yield* sourceOf(request),
    type: { typeId: intent.type.typeId, typeRevision: intent.type.typeRevision },
  };
  const template = templateOf(intent);
  if (Option.isSome(template)) {
    item.template = template.value;
  }
  if (options.templateUse !== undefined) {
    item.templateUse = templateUseOf(options.templateUse);
  }
  return yield* decodeItem(item);
});

/** The request is neither a no-message decision nor one with an unresolved slot: it has no request-level row to read. */
export class NotARequestLevelRow extends Data.TaggedError('NotARequestLevelRow') {}

/** True when a request has a request-level row: the catalog decided no message, or a slot stayed unresolved. */
export const hasRequestLevelRow = ({ feed, noMessageReason }: RequestHistoryRecord) =>
  noMessageReason !== undefined || feed.unresolvedSlots.length > 0;

/**
 * The request-level row of a request (#1402 H-01, #1401 I-07): `NO_MESSAGE` when the catalog decided that no message exists,
 * else `NOT_SENT` for the slots no legal recipient could be found for. Closed reasons and references only; a reason that is not
 * a closed code is dropped, never shown.
 */
export const projectRequestHistoryItem = Effect.fn('Communications.projectRequestHistoryItem')(function* project(
  request: RequestHistoryRecord,
) {
  if (!hasRequestLevelRow(request)) {
    return yield* new NotARequestLevelRow();
  }
  return yield* decodeRequestItem({
    decidedAt: request.decidedAt,
    decisionId: request.decisionId,
    headline: {
      reasonCodes: uniqueInOrder(request.noMessageReason === undefined ? [] : [request.noMessageReason]),
      status: request.noMessageReason === undefined ? 'NOT_SENT' : 'NO_MESSAGE',
    },
    requestId: request.request.requestId,
    source: yield* sourceOf(request),
    unresolvedSlots: request.feed.unresolvedSlots.filter(({ reason }) => isClosedCode(reason)),
  });
});

/** The decision fact of an intent carries its Explicit Resend links; an attempt fact carries the Technical Retry it belongs to. */
const linksOfEntry = (entry: HistoryEntry, links: readonly MessageHistoryLink[]): readonly MessageHistoryLink[] => {
  if (entry.kind === 'ATTEMPT_PREPARED') {
    return links.filter(
      (link) =>
        link.kind === 'TECHNICAL_RETRY' &&
        (link.attemptNumber === entry.attemptNumber || link.previousAttemptNumber === entry.attemptNumber),
    );
  }
  return entry.kind === 'INTENT_PREPARED' || entry.kind === 'INTENT_SUPPRESSED' || entry.kind === 'INTENT_NOT_SENT'
    ? links.filter(({ kind }) => kind === 'EXPLICIT_RESEND')
    : [];
};

const entryOf = (entry: HistoryEntry, links: readonly MessageHistoryLink[]) => {
  const projected: EntryDraft = {
    kind: entry.kind,
    occurredAt: entry.occurredAt,
    outOfOrder: entry.outOfOrder,
    reasonCodes: uniqueInOrder(entry.reasonCodes),
    recordedAt: entry.recordedAt,
    status: entry.status,
  };
  if (entry.attemptNumber !== null) {
    projected.attemptNumber = entry.attemptNumber;
  }
  if (entry.observationKind !== null) {
    projected.observationKind = entry.observationKind;
  }
  if (entry.technical !== null) {
    projected.technical = entry.technical;
  }
  const entryLinks = linksOfEntry(entry, links);
  if (entryLinks.length > 0) {
    projected.links = entryLinks;
  }
  return projected;
};

/** The facts of one message in the owner's own order, as safe entries: what was proven and when, never who or what text. */
export const projectTimeline = (
  intent: IntentHistoryRecord,
): Effect.Effect<readonly MessageHistoryTimelineEntry[], Schema.SchemaError> => {
  const links = linksOf(intent);
  return Effect.forEach(intent.history.entries, (entry) => decodeEntry(entryOf(entry, links)), { concurrency: 1 });
};
