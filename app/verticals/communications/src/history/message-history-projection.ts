import { OntosModuleIdSchema } from '@app/core-runtime/modules/manifest';
import { Array as EffectArray, Effect, Option, Order, Schema } from 'effect';
import type { DateTime } from 'effect';

import {
  EndpointMaskSchema,
  HistoryChannelSchema,
  MessageHistoryItemSchema,
  MessageHistoryTimelineEntrySchema,
  TEMPLATE_PREVIEW_MARKER,
} from '../../shared/message-history-read.ts';
import type { MessageHistoryItem, MessageHistoryTimelineEntry } from '../../shared/message-history-read.ts';
import { attentionOf } from '../domain/history/source-outcome.ts';
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

const reasonCodesOf = (intent: IntentHistoryRecord): readonly string[] => {
  const decided = intent.decisionReason === undefined ? [] : [intent.decisionReason];
  const stopped = intent.history.entries.flatMap((entry) =>
    entry.kind === 'INTENT_SUPPRESSED' || entry.kind === 'HANDOFF_STOPPED' ? entry.reasonCodes : [],
  );
  return uniqueInOrder([...decided, ...stopped]);
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
  readonly language: string;
  readonly messageType: string;
  mode?: string;
  readonly notice: typeof TEMPLATE_PREVIEW_MARKER;
  readonly revisionNumber: number;
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
interface ItemDraft {
  readonly decidedAt: DateTime.Utc;
  readonly headline: HeadlineDraft;
  readonly intentId: string;
  readonly lastEventAt: DateTime.Utc;
  readonly recipient: RecipientDraft;
  readonly requestId: string;
  readonly slotKey: string;
  readonly source: SourceDraft;
  template?: TemplateDraft;
  readonly type: { readonly typeId: string; readonly typeRevision: number };
}
interface EntryDraft {
  attemptNumber?: number;
  kind: string;
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
  };
  if (language.mode !== undefined) {
    pin.mode = language.mode;
  }
  return pin;
};

/** The template pin as a PREVIEW marker, or none when the message was stopped before any template was pinned. */
const templateOf = ({ language, template }: IntentHistoryRecord) =>
  language === undefined || template === undefined
    ? Option.none<TemplateDraft>()
    : Option.some(pinOf(language, template));

const decodeItem = Schema.decodeUnknownEffect(Schema.toType(MessageHistoryItemSchema));
const decodeEntry = Schema.decodeUnknownEffect(Schema.toType(MessageHistoryTimelineEntrySchema));

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
  const sourceModule = yield* Schema.decodeUnknownEffect(OntosModuleIdSchema)(request.request.sourceModule);
  const item: ItemDraft = {
    decidedAt: intent.decidedAt,
    headline: {
      attention: attentionOf(summary.status, summary.needsReconciliation),
      contradictory: summary.contradictory,
      deliveryProven: summary.deliveryProven,
      needsReconciliation: summary.needsReconciliation,
      providerAccepted: summary.providerAccepted,
      reasonCodes: reasonCodesOf(intent),
      status: summary.status,
    },
    intentId: intent.intentId,
    lastEventAt: lastEventAtOf(intent),
    recipient: recipientOf(intent, options),
    requestId: request.request.requestId,
    slotKey: intent.slotKey,
    source: {
      moduleId: sourceModule,
      occurrence: { occurrenceId: request.request.occurrenceId, revision: request.request.occurrenceRevision },
      purpose: request.request.purpose,
      scope: scopeOf(request),
    },
    type: { typeId: intent.type.typeId, typeRevision: intent.type.typeRevision },
  };
  const template = templateOf(intent);
  if (Option.isSome(template)) {
    item.template = template.value;
  }
  return yield* decodeItem(item);
});

const entryOf = (entry: HistoryEntry) => {
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
  return projected;
};

/** The facts of one message in the owner's own order, as safe entries: what was proven and when, never who or what text. */
export const projectTimeline = (
  intent: IntentHistoryRecord,
): Effect.Effect<readonly MessageHistoryTimelineEntry[], Schema.SchemaError> =>
  Effect.forEach(intent.history.entries, (entry) => decodeEntry(entryOf(entry)), { concurrency: 1 });
