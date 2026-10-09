import { createHash } from 'node:crypto';

import { PricingAcceptedOrderHandoffWireSchema } from '@app/pricing-contracts/domain/accepted-order-handoff';
import type { PricingAcceptedOrderHandoff } from '@app/pricing-contracts/domain/accepted-order-handoff';
import { Effect, Result, Schema } from 'effect';

/** The wire version is independent from the Pricing calculation and evidence contract versions. */
export const PRICING_ACCEPTED_ORDER_HANDOFF_ENVELOPE_VERSION = 'pricing.accepted-order-handoff.v1' as const;

const digestSchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));

/**
 * Transport integrity is deliberately content-addressed rather than secret-bearing. Authenticity
 * remains represented by the owner-verifiable Confirmation and source proof references retained
 * inside the handoff.
 */
export const PricingAcceptedOrderHandoffEnvelopeSchema = Schema.Struct({
  integrity: Schema.Struct({
    algorithm: Schema.Literal('SHA-256'),
    payloadDigest: digestSchema,
  }),
  payload: Schema.String,
  schemaVersion: Schema.String,
});
export type PricingAcceptedOrderHandoffEnvelope = typeof PricingAcceptedOrderHandoffEnvelopeSchema.Type;

const PricingAcceptedOrderHandoffEnvelopeJsonSchema = Schema.fromJsonString(PricingAcceptedOrderHandoffEnvelopeSchema);
const PricingAcceptedOrderHandoffPayloadJsonSchema = Schema.fromJsonString(PricingAcceptedOrderHandoffWireSchema);
const JsonBooleanTextSchema = Schema.fromJsonString(Schema.Boolean);
const JsonNumberTextSchema = Schema.fromJsonString(Schema.Finite);
const JsonStringTextSchema = Schema.fromJsonString(Schema.String);
const encodeJsonBoolean = Schema.encodeResult(JsonBooleanTextSchema);
const encodeJsonNumber = Schema.encodeResult(JsonNumberTextSchema);
const encodeJsonString = Schema.encodeResult(JsonStringTextSchema);

export const PricingAcceptedOrderHandoffSerializationReasonSchema = Schema.Literals([
  'HANDOFF_INVALID',
  'WIRE_INVALID',
  'VERSION_UNSUPPORTED',
  'PAYLOAD_NON_CANONICAL',
  'PAYLOAD_INTEGRITY_MISMATCH',
  'PAYLOAD_INVALID',
]);
export type PricingAcceptedOrderHandoffSerializationReason =
  typeof PricingAcceptedOrderHandoffSerializationReasonSchema.Type;

export class PricingAcceptedOrderHandoffSerializationError extends Schema.TaggedError<PricingAcceptedOrderHandoffSerializationError>()(
  'PricingAcceptedOrderHandoffSerializationError',
  {
    reason: PricingAcceptedOrderHandoffSerializationReasonSchema,
  },
) {}

const serializationError = (
  reason: PricingAcceptedOrderHandoffSerializationReason,
  cause?: unknown,
): PricingAcceptedOrderHandoffSerializationError => {
  const failure = new PricingAcceptedOrderHandoffSerializationError({ reason });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

const compareKeys = (left: readonly [string, Schema.Json], right: readonly [string, Schema.Json]): number => {
  if (left[0] === right[0]) {
    return 0;
  }
  return left[0] < right[0] ? -1 : 1;
};

/** RFC-8259 JSON with recursive ordinal key ordering and stable array order. */
export const canonicalizePricingAcceptedOrderHandoffJson = (value: Schema.Json): string => {
  if (value === null) {
    return 'null';
  }
  if (Schema.is(Schema.Boolean)(value)) {
    return Result.getOrThrow(encodeJsonBoolean(value));
  }
  if (Schema.is(Schema.Finite)(value)) {
    return Result.getOrThrow(encodeJsonNumber(value));
  }
  if (Schema.is(Schema.String)(value)) {
    return Result.getOrThrow(encodeJsonString(value));
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalizePricingAcceptedOrderHandoffJson).join(',')}]`;
  }
  return `{${Object.entries(value)
    .toSorted(compareKeys)
    .map(
      ([key, nested]) =>
        `${Result.getOrThrow(encodeJsonString(key))}:${canonicalizePricingAcceptedOrderHandoffJson(nested)}`,
    )
    .join(',')}}`;
};

const payloadDigest = (payload: string): string =>
  createHash('sha256')
    .update(PRICING_ACCEPTED_ORDER_HANDOFF_ENVELOPE_VERSION)
    .update('\u0000')
    .update(payload)
    .digest('hex');

/**
 * Encodes the complete internal owner handoff. No customer projection or evidence sanitization is
 * applied: only the provider-safe canonical contract encoding is used.
 */
export const serializePricingAcceptedOrderHandoff = Effect.fn('serializePricingAcceptedOrderHandoff')(
  function* serializePricingAcceptedOrderHandoff(
    handoff: PricingAcceptedOrderHandoff,
  ): Effect.fn.Return<string, PricingAcceptedOrderHandoffSerializationError> {
    const providerPayload = yield* Schema.encodeUnknownEffect(PricingAcceptedOrderHandoffWireSchema)(handoff).pipe(
      Effect.mapError((cause) => serializationError('HANDOFF_INVALID', cause)),
    );
    const payload = canonicalizePricingAcceptedOrderHandoffJson(providerPayload);
    const envelope: PricingAcceptedOrderHandoffEnvelope = {
      integrity: {
        algorithm: 'SHA-256',
        payloadDigest: payloadDigest(payload),
      },
      payload,
      schemaVersion: PRICING_ACCEPTED_ORDER_HANDOFF_ENVELOPE_VERSION,
    };
    return canonicalizePricingAcceptedOrderHandoffJson(envelope);
  },
);

/**
 * Validates the version and content digest before decoding the complete canonical handoff. The
 * contract then rejects missing evidence, numeric amount coercion, broken lineage, and mismatched
 * component/line/total equations without repricing against today's source state.
 */
export const deserializePricingAcceptedOrderHandoff = Effect.fn('deserializePricingAcceptedOrderHandoff')(
  function* deserializePricingAcceptedOrderHandoff(
    wire: string,
  ): Effect.fn.Return<PricingAcceptedOrderHandoff, PricingAcceptedOrderHandoffSerializationError> {
    const envelope = yield* Schema.decodeEffect(PricingAcceptedOrderHandoffEnvelopeJsonSchema, {
      onExcessProperty: 'error',
    })(wire).pipe(Effect.mapError((cause) => serializationError('WIRE_INVALID', cause)));
    if (envelope.schemaVersion !== PRICING_ACCEPTED_ORDER_HANDOFF_ENVELOPE_VERSION) {
      return yield* serializationError('VERSION_UNSUPPORTED');
    }

    const handoff = yield* Schema.decodeEffect(PricingAcceptedOrderHandoffPayloadJsonSchema, {
      onExcessProperty: 'error',
    })(envelope.payload).pipe(Effect.mapError((cause) => serializationError('PAYLOAD_INVALID', cause)));
    const providerPayload = yield* Schema.encodeUnknownEffect(PricingAcceptedOrderHandoffWireSchema)(handoff).pipe(
      Effect.mapError((cause) => serializationError('PAYLOAD_INVALID', cause)),
    );
    const canonicalPayload = canonicalizePricingAcceptedOrderHandoffJson(providerPayload);
    if (canonicalPayload !== envelope.payload) {
      return yield* serializationError('PAYLOAD_NON_CANONICAL');
    }
    if (payloadDigest(canonicalPayload) !== envelope.integrity.payloadDigest) {
      return yield* serializationError('PAYLOAD_INTEGRITY_MISMATCH');
    }
    return handoff;
  },
);
