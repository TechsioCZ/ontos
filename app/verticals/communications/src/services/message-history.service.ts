import type { ScopedTransactionExecutor } from '@app/core-runtime';
import {
  CommunicationRequestScopeSchema,
  CommunicationResourceRefSchema,
} from '@app/communications-contracts/communication-request';
import type {
  CommunicationRequestScope,
  CommunicationResourceRef,
} from '@app/communications-contracts/communication-request';
import { and, asc, eq, inArray, or } from 'drizzle-orm';
import { DateTime, Effect, Option, Schema } from 'effect';

import { HistorySlotKeySchema } from '../../shared/communication-history.ts';
import type { CommunicationOutcomeFeed, HistorySlotKey } from '../../shared/communication-history.ts';
import {
  CommunicationDecisionIdSchema,
  CommunicationRequestIdSchema,
  MessageIntentIdSchema,
} from '../../shared/communication-intake.ts';
import { LanguagePolicyRefSchema } from '../../shared/language-policy.ts';
import {
  attemptRetryLinks,
  communicationDecisions,
  communicationRequests,
  deliveryAttempts,
  intentHandoffStops,
  intentResendLinks,
  messageIntents,
  providerObservations,
} from '../database/schema.ts';
import { sourceOutcomeFeedOf } from '../domain/history/source-outcome.ts';
import { historyOfIntent } from '../domain/history/timeline.ts';
import type {
  AttemptFacts,
  IntentHistory,
  IntentTimelineFacts,
  ObservationFacts,
  StopFacts,
} from '../domain/history/timeline.ts';
import { FailureClassSchema } from '../domain/history/vocabulary.ts';
import { safeCauseOf } from '../domain/intake/safe-cause.ts';
import { LanguageDecisionSchema } from '../domain/language/vocabulary.ts';
import { HandoffStoreUnavailable } from '../handoff/process-intent-handoff.ts';

/**
 * The owner-internal, SAFE record of the history of one request (#1402). It is built from the append-only facts of the
 * store, field by field, and carries references, masks, closed codes and times only: no address, no token, no link, no
 * personalised content and no provider payload. Whoever may READ it, and what of it, is the access lane's decision (d21-09);
 * that a record exists grants access to nothing. This module exposes no Action, endpoint or permission.
 */

type LanguagePolicyRef = typeof LanguagePolicyRefSchema.Type;

export interface IntentHistoryRecord {
  readonly decidedAt: DateTime.Utc;
  /** The safe closed reason of the original decision (a suppression or a pinned-not-sent reason), preserved as decided. */
  readonly decisionReason: string | undefined;
  /** The append-only facts the history is projected from: the input of the guard the retry lane calls (`canAttemptAfterUnknownEffect`). */
  readonly facts: IntentTimelineFacts;
  readonly history: IntentHistory;
  readonly intentId: typeof MessageIntentIdSchema.Type;
  /** The language actually used and the Tenant mode it was decided under; a later mode change does not touch them. */
  readonly language:
    | {
        readonly language: 'cs' | 'en';
        readonly mode: 'A' | 'B' | undefined;
        readonly policy: LanguagePolicyRef | undefined;
      }
    | undefined;
  readonly links: {
    readonly resendOf: { readonly intentId: string; readonly reasonCode: string } | undefined;
    readonly resentAs: readonly { readonly intentId: string; readonly reasonCode: string }[];
    readonly retries: readonly {
      readonly attemptId: string;
      readonly basisKind: string;
      readonly previousAttemptId: string;
      readonly reasonCode: string;
    }[];
  };
  /** The ORIGINAL recipient in safe form: references and the owner's mask, never the address. */
  readonly recipient: {
    readonly channel: string | undefined;
    readonly endpointMask: string | undefined;
    readonly ref: CommunicationResourceRef;
    readonly role: string;
  };
  readonly slotKey: HistorySlotKey;
  readonly template:
    | {
        readonly messageType: string;
        readonly revisionId: string;
        readonly revisionNumber: number;
        readonly templateTypeId: string;
      }
    | undefined;
  readonly type: { readonly typeId: string; readonly typeRevision: number };
}

export interface RequestHistoryRecord {
  readonly decidedAt: DateTime.Utc;
  readonly decisionId: typeof CommunicationDecisionIdSchema.Type;
  readonly feed: CommunicationOutcomeFeed;
  readonly intents: readonly IntentHistoryRecord[];
  readonly noMessageReason: string | undefined;
  readonly request: {
    readonly occurrenceId: string;
    readonly occurrenceRevision: number;
    readonly purpose: string;
    readonly requestId: typeof CommunicationRequestIdSchema.Type;
    readonly scope: CommunicationRequestScope;
    readonly sourceModule: string;
  };
  readonly tenantMode: { readonly mode: 'A' | 'B'; readonly policy: LanguagePolicyRef } | undefined;
}

const unavailable = (cause?: unknown) =>
  Object.defineProperty(new HandoffStoreUnavailable({ reason: 'The message history is unavailable' }), 'cause', {
    enumerable: false,
    value: cause === undefined ? undefined : safeCauseOf(cause),
  });

const instant = (value: Date) => DateTime.fromDateUnsafe(value);
const PayloadScopeSchema = Schema.Struct({ scope: CommunicationRequestScopeSchema });
const EndpointSchema = Schema.Struct({ channel: Schema.String, mask: Schema.String });
const PolicySchema = Schema.Struct({ mode: Schema.Literals(['A', 'B']), policy: LanguagePolicyRefSchema });
const EvidenceReasonSchema = Schema.Struct({ reason: Schema.optional(Schema.String) });
const ObservationEvidenceFailureSchema = Schema.Struct({ failureClass: Schema.optional(FailureClassSchema) });
const StopReasonsSchema = Schema.Array(Schema.Struct({ category: Schema.String }));
const UnresolvedSlotsSchema = Schema.Array(Schema.Struct({ reason: Schema.String, slotKey: HistorySlotKeySchema }));

/** A stored document the history only decorates with: an unreadable one is left out, never guessed. */
const lenient = <Value>(schema: Schema.Decoder<Value>) => Schema.decodeUnknownOption(schema);
const readEvidenceReason = lenient(EvidenceReasonSchema);
const readFailureClass = lenient(ObservationEvidenceFailureSchema);
const readStopReasons = lenient(StopReasonsSchema);
const readUnresolvedSlots = lenient(UnresolvedSlotsSchema);
const readEndpoint = lenient(EndpointSchema);
const readLanguageDecision = lenient(LanguageDecisionSchema);
const readPolicyRef = lenient(LanguagePolicyRefSchema);
const readTenantMode = lenient(PolicySchema);

type RequestRow = typeof communicationRequests.$inferSelect;
type DecisionRow = typeof communicationDecisions.$inferSelect;
type IntentRow = typeof messageIntents.$inferSelect;
type AttemptRow = typeof deliveryAttempts.$inferSelect;
type StopRow = typeof intentHandoffStops.$inferSelect;
type ObservationRow = typeof providerObservations.$inferSelect;
type RetryRow = typeof attemptRetryLinks.$inferSelect;
type ResendRow = typeof intentResendLinks.$inferSelect;

/** Every stored fact of one request of the installed Tenant, as rows. A request without intents (no-message) has none of the rest. */
interface RequestRows {
  readonly attempts: readonly AttemptRow[];
  readonly decision: DecisionRow;
  readonly intents: readonly IntentRow[];
  readonly observations: readonly ObservationRow[];
  readonly request: RequestRow;
  readonly resends: readonly ResendRow[];
  readonly retries: readonly RetryRow[];
  readonly stops: readonly StopRow[];
}

const readRows = Effect.fn('Communications.readHistoryRows')(function* read(
  transaction: ScopedTransactionExecutor,
  tenantId: string,
  requestId: string,
) {
  const [[request], [decision], intents] = yield* Effect.all(
    [
      transaction
        .select()
        .from(communicationRequests)
        .where(and(eq(communicationRequests.tenantId, tenantId), eq(communicationRequests.requestId, requestId))),
      transaction
        .select()
        .from(communicationDecisions)
        .where(and(eq(communicationDecisions.tenantId, tenantId), eq(communicationDecisions.requestId, requestId))),
      transaction
        .select()
        .from(messageIntents)
        .where(and(eq(messageIntents.tenantId, tenantId), eq(messageIntents.requestId, requestId)))
        .orderBy(asc(messageIntents.intentKey)),
    ],
    { concurrency: 1 },
  ).pipe(Effect.mapError(unavailable));
  if (request === undefined || decision === undefined) {
    return Option.none<RequestRows>();
  }
  const ids = intents.map(({ intentId }) => intentId);
  if (ids.length === 0) {
    return Option.some<RequestRows>({
      attempts: [],
      decision,
      intents,
      observations: [],
      request,
      resends: [],
      retries: [],
      stops: [],
    });
  }
  const { attempts, observations, resends, retries, stops } = yield* Effect.all(
    {
      attempts: transaction
        .select()
        .from(deliveryAttempts)
        .where(and(eq(deliveryAttempts.tenantId, tenantId), inArray(deliveryAttempts.intentId, ids))),
      observations: transaction
        .select()
        .from(providerObservations)
        .where(and(eq(providerObservations.tenantId, tenantId), inArray(providerObservations.intentId, ids))),
      resends: transaction
        .select()
        .from(intentResendLinks)
        .where(
          and(
            eq(intentResendLinks.tenantId, tenantId),
            or(inArray(intentResendLinks.originalIntentId, ids), inArray(intentResendLinks.resendIntentId, ids)),
          ),
        ),
      retries: transaction
        .select()
        .from(attemptRetryLinks)
        .where(and(eq(attemptRetryLinks.tenantId, tenantId), inArray(attemptRetryLinks.intentId, ids))),
      stops: transaction
        .select()
        .from(intentHandoffStops)
        .where(and(eq(intentHandoffStops.tenantId, tenantId), inArray(intentHandoffStops.intentId, ids))),
    },
    { concurrency: 1 },
  ).pipe(Effect.mapError(unavailable));
  return Option.some<RequestRows>({ attempts, decision, intents, observations, request, resends, retries, stops });
});

const attemptFactOf = (row: AttemptRow): AttemptFacts => ({
  attemptId: row.attemptId,
  attemptNumber: row.attemptNumber,
  finishedAt: row.finishedAt === null ? undefined : instant(row.finishedAt),
  preparedAt: instant(row.preparedAt),
  reason: Option.getOrUndefined(readEvidenceReason(row.evidence))?.reason,
  state: row.state,
});

const observationFactOf = (row: ObservationRow): ObservationFacts => ({
  attemptId: row.attemptId,
  failureClass: Option.getOrUndefined(readFailureClass(row.evidence))?.failureClass,
  kind: row.kind,
  observationId: row.observationId,
  observedAt: instant(row.observedAt),
  recordedAt: instant(row.recordedAt),
  recordedSeq: row.recordedSeq,
});

const stopFactOf = (row: StopRow): StopFacts => ({
  categories: Option.getOrElse(readStopReasons(row.reasons), () => []).map(({ category }) => category),
  evaluationSeq: row.evaluationSeq,
  proven: row.proven,
  recordedAt: instant(row.recordedAt),
});

/** The append-only facts of ONE intent, in a stable order. */
const timelineFactsOf = (rows: RequestRows, intent: IntentRow): IntentTimelineFacts => ({
  attempts: rows.attempts
    .flatMap((row) => (row.intentId === intent.intentId ? [attemptFactOf(row)] : []))
    .toSorted((left, right) => left.attemptNumber - right.attemptNumber),
  intent: {
    createdAt: instant(intent.createdAt),
    intentId: intent.intentId,
    reason: intent.reason ?? undefined,
    status: intent.status,
  },
  observations: rows.observations.flatMap((row) => (row.intentId === intent.intentId ? [observationFactOf(row)] : [])),
  stops: rows.stops.flatMap((row) => (row.intentId === intent.intentId ? [stopFactOf(row)] : [])),
});

const linksOf = (rows: RequestRows, intentId: string): IntentHistoryRecord['links'] => {
  const origin = rows.resends.find(({ resendIntentId }) => resendIntentId === intentId);
  return {
    resendOf: origin === undefined ? undefined : { intentId: origin.originalIntentId, reasonCode: origin.reasonCode },
    resentAs: rows.resends.flatMap(({ originalIntentId, reasonCode, resendIntentId }) =>
      originalIntentId === intentId ? [{ intentId: resendIntentId, reasonCode }] : [],
    ),
    retries: rows.retries.flatMap(({ attemptId, basisKind, intentId: owner, previousAttemptId, reasonCode }) =>
      owner === intentId ? [{ attemptId, basisKind, previousAttemptId, reasonCode }] : [],
    ),
  };
};

/** The language and template pins the intent was decided under, as stored; nothing is re-derived from Current policy. */
const pinsOf = (intent: IntentRow): Pick<IntentHistoryRecord, 'language' | 'template'> => {
  const decided = Option.getOrUndefined(readLanguageDecision(intent.languageDecision));
  const pin = decided?.outcome === 'selected' ? decided.pin : undefined;
  return {
    language:
      intent.language === null
        ? undefined
        : {
            language: intent.language,
            mode: intent.tenantMode ?? undefined,
            policy: Option.getOrUndefined(readPolicyRef(intent.policyRef)),
          },
    template:
      pin === undefined
        ? undefined
        : {
            messageType: pin.messageType,
            revisionId: pin.revisionId,
            revisionNumber: pin.revisionNumber,
            templateTypeId: pin.templateTypeId,
          },
  };
};

const intentRecordOf = Effect.fn('Communications.intentHistoryRecord')(function* record(
  rows: RequestRows,
  intent: IntentRow,
) {
  const facts = timelineFactsOf(rows, intent);
  const ref = yield* Schema.decodeUnknownEffect(CommunicationResourceRefSchema)({
    moduleId: intent.recipientModule,
    resourceId: intent.recipientId,
    resourceType: intent.recipientType,
  }).pipe(Effect.mapError(unavailable));
  const endpoint = Option.getOrUndefined(readEndpoint(intent.endpointPin));
  return {
    decidedAt: instant(intent.createdAt),
    decisionReason: intent.reason ?? undefined,
    facts,
    history: historyOfIntent(facts),
    intentId: MessageIntentIdSchema.make(intent.intentId),
    links: linksOf(rows, intent.intentId),
    recipient: { channel: endpoint?.channel, endpointMask: endpoint?.mask, ref, role: intent.recipientRole },
    slotKey: HistorySlotKeySchema.make(intent.slotKey),
    type: { typeId: intent.typeId, typeRevision: intent.typeRevision },
    ...pinsOf(intent),
  } satisfies IntentHistoryRecord;
});

/** Loads the safe history record of one request of the installed Tenant, or none when the request does not exist there. */
export const loadRequestHistory = Effect.fn('Communications.loadRequestHistory')(function* load(
  transaction: ScopedTransactionExecutor,
  tenantId: string,
  requestId: typeof CommunicationRequestIdSchema.Type,
) {
  const rows = yield* readRows(transaction, tenantId, requestId);
  if (Option.isNone(rows)) {
    return Option.none<RequestHistoryRecord>();
  }
  const { decision, intents, request } = rows.value;
  const { scope } = yield* Schema.decodeUnknownEffect(PayloadScopeSchema)(request.payload).pipe(
    Effect.mapError(unavailable),
  );
  const records = yield* Effect.forEach(intents, (intent) => intentRecordOf(rows.value, intent), { concurrency: 1 });
  const decisionId = CommunicationDecisionIdSchema.make(decision.decisionId);
  const feed = sourceOutcomeFeedOf({
    decision: {
      decisionId,
      noMessageReason: decision.noMessageReason ?? undefined,
      outcome: decision.outcome,
      requiredness: decision.requiredness ?? undefined,
      unresolvedSlots: Option.getOrElse(readUnresolvedSlots(decision.unresolvedSlots), () => []),
    },
    intents: records.map((entry) => ({
      intentId: entry.intentId,
      reason: entry.decisionReason,
      recipientRef: entry.recipient.ref,
      slotKey: entry.slotKey,
      summary: entry.history.summary,
    })),
    requestId: CommunicationRequestIdSchema.make(request.requestId),
  });
  return Option.some({
    decidedAt: instant(decision.decidedAt),
    decisionId,
    feed,
    intents: records,
    noMessageReason: decision.noMessageReason ?? undefined,
    request: {
      occurrenceId: request.occurrenceId,
      occurrenceRevision: request.occurrenceRevision,
      purpose: request.purpose,
      requestId: CommunicationRequestIdSchema.make(request.requestId),
      scope,
      sourceModule: request.sourceModule,
    },
    tenantMode: Option.getOrUndefined(readTenantMode(decision.languagePolicy)),
  } satisfies RequestHistoryRecord);
});
