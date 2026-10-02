import { PricingAcceptedOrderHandoffSchema } from '@app/pricing-contracts/domain/accepted-order-handoff';
import type { PricingAcceptedOrderHandoff } from '@app/pricing-contracts/domain/accepted-order-handoff';
import { PricingCommitmentConfirmationVerifiedSchema } from '@app/pricing-contracts/domain/commitment-confirmation';
import type { PricingCommitmentConfirmationIssued } from '@app/pricing-contracts/domain/commitment-confirmation';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  canonicalizePricingAcceptedOrderHandoffJson,
  deserializePricingAcceptedOrderHandoff,
  PRICING_ACCEPTED_ORDER_HANDOFF_ENVELOPE_VERSION,
  PricingAcceptedOrderHandoffEnvelopeSchema,
  serializePricingAcceptedOrderHandoff,
} from '../../src/services/accepted-order-handoff-serializer.service.ts';
import {
  makeIssue788CommercialTotal,
  makeIssue788CurrentConfirmation,
} from './support/issue-788-confirmation.fixture.ts';

const acceptedAt = '2026-09-28T12:00:10.000Z';
const decodeHandoff = Schema.decodeUnknownSync(PricingAcceptedOrderHandoffSchema, {
  onExcessProperty: 'error',
});
const decodeVerification = Schema.decodeUnknownSync(PricingCommitmentConfirmationVerifiedSchema, {
  onExcessProperty: 'error',
});
const decodeEnvelope = Schema.decodeEffect(Schema.fromJsonString(PricingAcceptedOrderHandoffEnvelopeSchema), {
  onExcessProperty: 'error',
});

const verificationFor = (confirmation: PricingCommitmentConfirmationIssued) =>
  decodeVerification({
    _tag: 'VERIFIED',
    authenticityEvidence: {
      authenticityRef: 'pricing-confirmation-authenticity:789:serializer',
      confirmationRef: confirmation.confirmationRef,
      issuerRef: confirmation.authenticity.issuerRef,
      keyRef: confirmation.authenticity.keyRef,
      keyStatus: 'ACTIVE',
      keyVersion: confirmation.authenticity.keyVersion,
      lineageRef: confirmation.authenticity.lineageRef,
      payloadDigest: confirmation.authenticity.payloadDigest,
      proofRef: confirmation.authenticity.proofRef,
      proofVersion: confirmation.authenticity.proofVersion,
      verifiedAt: acceptedAt,
    },
    confirmation,
    verifiedAt: acceptedAt,
  });

const makeHandoff = Effect.fn('test.issue789SerializerHandoff')(function* issue789SerializerHandoff() {
  const terms = yield* makeIssue788CommercialTotal('900');
  const confirmation = makeIssue788CurrentConfirmation(terms);
  if (confirmation.source.kind !== 'CURRENT_BACKED') {
    return yield* Effect.die('Current-backed #789 serializer fixture produced the wrong source kind');
  }
  return decodeHandoff({
    acceptedAt,
    commitmentVerification: verificationFor(confirmation),
    handoffRef: 'pricing-accepted-order-handoff:789:serializer',
    kind: 'PRICING_ACCEPTED_ORDER_HANDOFF',
    lineage: {
      attemptRef: confirmation.binding.attemptRef,
      confirmationRef: confirmation.confirmationRef,
      decisionBundleHash: confirmation.binding.decisionBundleHash,
      decisionBundleRef: confirmation.binding.decisionBundleRef,
      decisionBundleVersion: confirmation.binding.decisionBundleVersion,
      kind: 'CURRENT_TO_CONFIRMATION',
      materialEvidenceValidatedAt: confirmation.source.materialEvidence.validatedAt,
    },
    materialEvidence: confirmation.source.materialEvidence,
    owner: { moduleId: 'commerce.pricing', scopeRef: 'pricing-owner-scope:789:serializer' },
    qualifiedLegacyCurrencySupportReferences: [],
    terms,
  });
});

const rewriteEnvelope = (
  envelope: typeof PricingAcceptedOrderHandoffEnvelopeSchema.Type,
  changes: Partial<typeof PricingAcceptedOrderHandoffEnvelopeSchema.Type>,
): string =>
  canonicalizePricingAcceptedOrderHandoffJson({
    ...envelope,
    ...changes,
  });

describe('Pricing Accepted Order handoff serializer', () => {
  it.effect('round-trips the complete owner handoff as deterministic versioned canonical JSON', () =>
    Effect.gen(function* roundTripsCanonicalHandoff() {
      const handoff = yield* makeHandoff();
      const first = yield* serializePricingAcceptedOrderHandoff(handoff);
      const second = yield* serializePricingAcceptedOrderHandoff(handoff);
      const envelope = yield* decodeEnvelope(first);
      const decoded = yield* deserializePricingAcceptedOrderHandoff(first);

      expect(second).toBe(first);
      expect(decoded).toEqual(handoff);
      expect(envelope.schemaVersion).toBe(PRICING_ACCEPTED_ORDER_HANDOFF_ENVELOPE_VERSION);
      expect(envelope.integrity).toMatchObject({ algorithm: 'SHA-256' });
      expect(envelope.payload).toContain('"amount":"900"');
      expect(envelope.payload).toContain('"verifiedAt":"2026-09-28T12:00:10.000Z"');
      expect(envelope.payload).toContain('"materialEvidence"');
    }),
  );

  it.effect('rejects unsupported versions, non-canonical payloads, and altered exact amounts', () =>
    Effect.gen(function* rejectsInvalidWire() {
      const handoff: PricingAcceptedOrderHandoff = yield* makeHandoff();
      const wire = yield* serializePricingAcceptedOrderHandoff(handoff);
      const envelope = yield* decodeEnvelope(wire);

      const unsupported = yield* deserializePricingAcceptedOrderHandoff(
        rewriteEnvelope(envelope, { schemaVersion: 'pricing.accepted-order-handoff.v2' }),
      ).pipe(Effect.flip);
      expect(unsupported.reason).toBe('VERSION_UNSUPPORTED');

      const nonCanonical = yield* deserializePricingAcceptedOrderHandoff(
        rewriteEnvelope(envelope, { payload: `{ ${envelope.payload.slice(1)}` }),
      ).pipe(Effect.flip);
      expect(nonCanonical.reason).toBe('PAYLOAD_NON_CANONICAL');

      const amountTamper = yield* deserializePricingAcceptedOrderHandoff(
        rewriteEnvelope(envelope, {
          payload: envelope.payload.replace(
            'pricing-accepted-order-handoff:789:serializer',
            'pricing-accepted-order-handoff:789:tampered',
          ),
        }),
      ).pipe(Effect.flip);
      expect(amountTamper.reason).toBe('PAYLOAD_INTEGRITY_MISMATCH');
    }),
  );
});
