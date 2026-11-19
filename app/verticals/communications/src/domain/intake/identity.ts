import { CommunicationRequestSchema } from '@app/communications-contracts/communication-request';
import type { CommunicationRequest } from '@app/communications-contracts/communication-request';
import { Array as EffectArray, Crypto, Effect, Order, Predicate, Schema } from 'effect';
import { Hex } from 'effect/encoding';

import {
  CommunicationDecisionIdSchema,
  CommunicationRequestIdSchema,
  DeliveryAttemptIdSchema,
  MessageIntentIdSchema,
} from '../../../shared/communication-intake.ts';
import { scopeKey } from '../recipient/original-binding.ts';

/**
 * The four durable identities of one communication (#1401) and the material meaning of a source request.
 *
 * - SOURCE REQUEST: unique inside exactly source owner x Tenant/scope x purpose x occurrence/revision (I-02). A
 *   transport id, an Action invocation id or a worker attempt is never part of it.
 * - COMMUNICATION DECISION: exactly one per request, so its id derives from the request id.
 * - MESSAGE INTENT: the identity the catalog already gives a candidate (tenant, issuing module, occurrence and
 *   revision, approved type, audience slot and the FULL recipient reference). It deliberately omits the catalog
 *   revision, so a later catalog revision never re-identifies an occurrence already decided.
 * - DELIVERY ATTEMPT: one intent and a number; created only by the pre-handoff worker.
 *
 * Every id is derived from its identity text, so a restart, a duplicate or a second instance that recomputes it
 * lands on the same row and a persisted id never depends on a random draw.
 */

const lengthPrefixed = (parts: readonly string[]) => parts.map((part) => `${String(part.length)}:${part}`).join('|');

/** The request identity text. The Tenant is part of `scopeKey`, so two Tenants can never collide. */
export const requestIdentityKeyOf = (request: CommunicationRequest) =>
  lengthPrefixed([
    request.source.moduleKey,
    scopeKey(request.scope),
    request.purpose,
    request.occurrence.occurrenceId,
    String(request.occurrence.revision),
  ]);

/** A value that survives a JSON round trip: no instant object, no `undefined`, no function. */
export type CanonicalValue =
  | boolean
  | number
  | string
  | null
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

const textOrder = Order.mapInput(Order.String, (entry: readonly [string, CanonicalValue]) => entry[0]);

/** The same value with every object's keys in sorted order, so equal values give equal JSON text. */
const sortedKeys = (value: CanonicalValue): CanonicalValue => {
  if (Array.isArray(value)) {
    return value.map((item: CanonicalValue) => sortedKeys(item));
  }
  return Predicate.isObject(value)
    ? Object.fromEntries(
        EffectArray.sort(Object.entries(value), textOrder).map(([key, item]) => [key, sortedKeys(item)] as const),
      )
    : value;
};

const JsonTextCodec = Schema.fromJsonString(Schema.Json);

/** Canonical JSON text: object keys sorted recursively, so equal values always have equal text. */
export const canonicalJson = (value: CanonicalValue) =>
  Schema.encodeEffect(JsonTextCodec)(sortedKeys(value)).pipe(Effect.orDie);

/** The request exactly as it is stored: encoded, so every instant has one canonical text. */
export const encodedRequestOf = (request: CommunicationRequest) =>
  Schema.encodeEffect(CommunicationRequestSchema)(request).pipe(Effect.orDie);

const textSorted = (items: readonly CanonicalValue[]) =>
  Effect.forEach(items, (item) => Effect.map(canonicalJson(item), (text) => [text, item] as const), {
    concurrency: 1,
  }).pipe(
    Effect.map((pairs) =>
      EffectArray.sort(
        pairs,
        Order.mapInput(Order.String, ([text]: readonly [string, CanonicalValue]) => text),
      ).map(([, item]) => item),
    ),
  );

/**
 * What the source bound itself to, without transport. The optional `correlationId` is a trace aid and never meaning.
 * Recipient bindings and safe references are sets: the order a source listed them in does not change the meaning.
 */
export const materialMeaningOf = Effect.fn('Communications.materialMeaning')(function* meaning(
  request: CommunicationRequest,
) {
  const { idempotency, originalRecipients, safeReferences, ...rest } = yield* encodedRequestOf(request);
  return {
    ...rest,
    idempotencyKey: idempotency.key,
    originalRecipients: yield* textSorted(originalRecipients),
    safeReferences: yield* textSorted(safeReferences),
  } satisfies CanonicalValue;
});

const sha256Hex = (text: string) =>
  Crypto.Crypto.use((crypto) => crypto.digest('SHA-256', new TextEncoder().encode(text))).pipe(
    Effect.map((digest) => Hex.encode(digest)),
    Effect.orDie,
  );

/** Fingerprint of the material meaning: the same identity with another fingerprint is a conflict (I-04). */
export const requestFingerprintOf = Effect.fn('Communications.requestFingerprint')(function* fingerprint(
  request: CommunicationRequest,
) {
  return yield* sha256Hex(yield* canonicalJson(yield* materialMeaningOf(request)));
});

const HEX_DIGITS_PER_UUID = 32;
const VARIANT_BASE = 8;
const VARIANT_SPAN = 4;
const HEX_RADIX = 16;

/** A deterministic, well-formed UUID of one identity text in one namespace. */
export const deterministicUuid = Effect.fn('Communications.deterministicUuid')(function* derive(
  namespace: string,
  identityText: string,
) {
  const hex = (yield* sha256Hex(lengthPrefixed([namespace, identityText]))).slice(0, HEX_DIGITS_PER_UUID);
  const version = `5${hex.slice(13, 16)}`;
  const variant = `${((Number.parseInt(hex.slice(16, 17), HEX_RADIX) % VARIANT_SPAN) + VARIANT_BASE).toString(HEX_RADIX)}${hex.slice(17, 20)}`;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${version}-${variant}-${hex.slice(20, 32)}`;
});

/** The id of the one stored request of a request identity. */
export const requestIdOf = (request: CommunicationRequest) =>
  deterministicUuid('communications.request', requestIdentityKeyOf(request)).pipe(
    Effect.map((id) => CommunicationRequestIdSchema.make(id)),
  );

/** The id of the one decision of a request: derived from the request, so a request can never have two. */
export const decisionIdOf = (requestId: typeof CommunicationRequestIdSchema.Type) =>
  deterministicUuid('communications.decision', requestId).pipe(
    Effect.map((id) => CommunicationDecisionIdSchema.make(id)),
  );

/** The id of one Message Intent: derived from its catalog candidate identity text. */
export const intentIdOf = (intentKey: string) =>
  deterministicUuid('communications.message-intent', intentKey).pipe(
    Effect.map((id) => MessageIntentIdSchema.make(id)),
  );

/**
 * The id of delivery attempt number `attemptNumber` of an intent. Number 1 is the only one a provider answer can ever
 * finish; a next number begins only after a NOT_ATTEMPTED attempt, which proves that nothing was submitted.
 */
export const attemptIdOf = (intentId: typeof MessageIntentIdSchema.Type, attemptNumber: number) =>
  deterministicUuid('communications.delivery-attempt', `${intentId}:${String(attemptNumber)}`).pipe(
    Effect.map((id) => DeliveryAttemptIdSchema.make(id)),
  );
