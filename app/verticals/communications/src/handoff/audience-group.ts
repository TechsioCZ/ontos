import type { ScopedRoutineInvoker } from '@app/core-runtime';
import { Effect, Option, Schema } from 'effect';

import { MessageIntentIdSchema } from '../../shared/communication-intake.ts';
import { isGroupMember } from '../domain/catalog/audience.ts';
import type { MessageIntentIdentity } from '../domain/catalog/decision.ts';
import { recoveryPolicyOf } from '../domain/catalog/message-type.ts';
import type { TransactionalMessageType } from '../domain/catalog/message-type.ts';
import { AudienceSlotKeySchema } from '../domain/catalog/vocabulary.ts';
import { ProcessingScopeSchema } from '../domain/privacy/processing-scope.ts';
import type { ProcessingScope } from '../domain/privacy/processing-scope.ts';
import { HandoffFact, ProviderFact } from '../domain/privacy/suppression.ts';
import type { HandoffFactCase, ProviderFactCase } from '../domain/privacy/suppression.ts';
import { OriginalRecipientBindingSchema } from '../domain/recipient/original-binding.ts';
import type { OriginalRecipientBinding } from '../domain/recipient/original-binding.ts';
import { HandoffPinSchema } from '../domain/recipient/recheck-before-handoff.ts';
import type { HandoffPin } from '../domain/recipient/recheck-before-handoff.ts';
import { assessAttemptHistory } from '../domain/recovery/retry-eligibility.ts';
import { StoredIntentFactsSchema, timelineFactsOfStored } from '../history/stored-intent-facts.ts';
import { workerReadHandoffContextRoutine, workerReadIntentRoutine } from '../persistence/communications-routines.ts';
import { storeUnavailable } from './handoff-errors.ts';

/**
 * What the last stoppable handoff of ONE Message Intent needs to know BESIDE it (#1395 BR-07, #1396 BR-09 BR-10):
 * - the PROVIDER fact about its original endpoint: an earlier permanent bounce that no later proven delivery replaced, from
 *   the stored provider observations; it is a provider fact and never a Privacy one;
 * - the OTHER Message Intents of the same request and type, but only when the intent belongs to an approved indivisible
 *   audience: such a group hands off nothing unless every member is ready, so the worker must see the whole audience. A type
 *   without a group, and a member outside it, never read a sibling.
 *
 * Everything here is read through scoped routines and decided by `decideMessageHandoffs`; nothing is stored or retained.
 */

const ContextSchema = Schema.Struct({
  intents: Schema.Array(
    Schema.Struct({
      intentId: MessageIntentIdSchema,
      providerBlockRef: Schema.optionalKey(Schema.String),
      slotKey: AudienceSlotKeySchema,
    }),
  ),
});

/** The part of a stored sibling intent the audience group needs: its pins and the facts of its history. */
const SiblingDocumentSchema = Schema.Struct({
  ...StoredIntentFactsSchema.fields,
  intent: Schema.Struct({
    handoffPin: HandoffPinSchema,
    originalBinding: Schema.Unknown,
    processingScope: Schema.optionalKey(Schema.Unknown),
    status: Schema.Literals(['NOT_SENT', 'PENDING_HANDOFF', 'SUPPRESSED']),
  }),
});
type SiblingDocument = typeof SiblingDocumentSchema.Type;

const SiblingPinsSchema = Schema.Struct({ binding: OriginalRecipientBindingSchema, scope: ProcessingScopeSchema });

/**
 * One other member of the request: asked again NOW like the worker's own message (`MEMBER`), or known not to be able to proceed
 * (`WITHHELD`: not pending, stopped for good, halted, or unreadable), which keeps an indivisible group from ever completing.
 */
type Sibling =
  | {
      readonly binding: OriginalRecipientBinding;
      readonly handoff: HandoffFactCase;
      readonly kind: 'MEMBER';
      readonly pin: HandoffPin;
      readonly provider: ProviderFactCase;
      readonly scope: ProcessingScope;
      readonly slotKey: MessageIntentIdentity['slotKey'];
    }
  | { readonly kind: 'WITHHELD'; readonly slotKey: MessageIntentIdentity['slotKey'] };

export interface HandoffGroup {
  /** What the provider evidenced about the original endpoint of the worker's own message. */
  readonly provider: ProviderFactCase;
  readonly siblings: readonly Sibling[];
}

/** A permanent bounce is the one provider block this owner can read from its own evidence (the observation names it). */
const providerFactOf = (blockRef: string | undefined): ProviderFactCase =>
  blockRef === undefined ? ProviderFact.Clear() : ProviderFact.Suppressed({ evidenceRef: blockRef, kind: 'BOUNCED' });

const hasProvenStop = (document: SiblingDocument) =>
  document.stops.some(({ proven }) => proven) ||
  document.recoveries.some(({ outcome, proven }) => outcome === 'STOPPED' && proven);

/**
 * What the history of a sibling says about its handoff: proven handed off, unknown, or still stoppable. None when it can never
 * be handed off any more: a proven stop is final, and a halt or a permanent refusal ends automatic action.
 */
const handoffFactOf = (document: SiblingDocument, type: TransactionalMessageType): Option.Option<HandoffFactCase> => {
  const assessment = assessAttemptHistory(timelineFactsOfStored(document), recoveryPolicyOf(type));
  if (assessment.kind === 'SKIP') {
    return Option.some(
      assessment.reason === 'ALREADY_FINISHED' ? HandoffFact.ProvenHandedOff() : HandoffFact.EffectUnknown(),
    );
  }
  if (assessment.kind === 'FIRST_ATTEMPT' || assessment.kind === 'CONTINUE') {
    return hasProvenStop(document) ? Option.none() : Option.some(HandoffFact.NotAttempted());
  }
  return Option.none();
};

const siblingOf = (
  document: Option.Option<SiblingDocument>,
  entry: { readonly providerBlockRef?: string | undefined; readonly slotKey: MessageIntentIdentity['slotKey'] },
  type: TransactionalMessageType,
): Sibling => {
  const withheld = { kind: 'WITHHELD', slotKey: entry.slotKey } satisfies Sibling;
  if (Option.isNone(document) || document.value.intent.status !== 'PENDING_HANDOFF') {
    return withheld;
  }
  const handoff = handoffFactOf(document.value, type);
  const pins = Schema.decodeUnknownOption(SiblingPinsSchema)({
    binding: document.value.intent.originalBinding,
    scope: document.value.intent.processingScope,
  });
  if (Option.isNone(handoff) || Option.isNone(pins)) {
    return withheld;
  }
  return {
    binding: pins.value.binding,
    handoff: handoff.value,
    kind: 'MEMBER',
    pin: document.value.intent.handoffPin,
    provider: providerFactOf(entry.providerBlockRef),
    scope: pins.value.scope,
    slotKey: entry.slotKey,
  };
};

/**
 * Reads the provider fact of one intent and, for a member of an approved indivisible group, every other intent of its request
 * and type. Scoped and short: it only reads this owner's store.
 */
export const readHandoffGroup = Effect.fn('Communications.readHandoffGroup')(function* read(
  invoker: ScopedRoutineInvoker,
  intentId: typeof MessageIntentIdSchema.Type,
  type: TransactionalMessageType,
  slotKey: MessageIntentIdentity['slotKey'],
) {
  const rows = yield* invoker
    .invoke(workerReadHandoffContextRoutine, [intentId])
    .pipe(Effect.mapError((cause) => storeUnavailable('The handoff context could not be read', cause)));
  const context = yield* Schema.decodeUnknownEffect(ContextSchema)(rows[0]?.result).pipe(
    Effect.mapError((cause) => storeUnavailable('The handoff context was unreadable', cause)),
  );
  const own = context.intents.find((entry) => entry.intentId === intentId);
  if (own === undefined) {
    return yield* storeUnavailable('The handoff context did not name the intent');
  }
  const provider = providerFactOf(own.providerBlockRef);
  if (!isGroupMember(type.audience, slotKey)) {
    return { provider, siblings: [] } satisfies HandoffGroup;
  }
  const siblings = yield* Effect.forEach(
    context.intents.filter((entry) => entry.intentId !== intentId),
    (entry) =>
      invoker.invoke(workerReadIntentRoutine, [entry.intentId]).pipe(
        Effect.mapError((cause) => storeUnavailable('A sibling Message Intent could not be read', cause)),
        // an unreadable sibling is a member that cannot be shown ready: it is never skipped, so the group fails closed
        Effect.map((siblingRows) =>
          siblingOf(Schema.decodeUnknownOption(SiblingDocumentSchema)(siblingRows[0]?.result), entry, type),
        ),
      ),
    { concurrency: 1 },
  );
  return { provider, siblings } satisfies HandoffGroup;
});
