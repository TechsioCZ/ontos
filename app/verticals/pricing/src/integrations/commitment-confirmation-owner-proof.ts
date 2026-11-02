import {
  PricingCommitmentConfirmationBindingSchema,
  PricingCommitmentConfirmationAuthenticityProofSchema,
  PricingCommitmentConfirmationSourceSchema,
} from '@app/pricing-contracts/domain/commitment-confirmation';
import type { PricingCommitmentConfirmationIssued } from '@app/pricing-contracts/domain/commitment-confirmation';
import { PricingCommercialTotalReadySchema } from '@app/pricing-contracts/domain/commercial-total';
import { PricingInstantSchema } from '@app/pricing-contracts/domain/currency-support';
import { PricingQuotationIssuedSchema } from '@app/pricing-contracts/domain/quotation';
import type { PricingQuotationIssued } from '@app/pricing-contracts/domain/quotation';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { Config, Effect, Redacted, Schema } from 'effect';
import { Hex } from 'effect/encoding';

const reference = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100), Schema.isTrimmed());
const cryptoTimeoutMs = 5000;
const configuration = Config.all({
  keyRef: Config.schema(reference, 'ONTOS_PRICING_CONFIRMATION_KEY_REF'),
  keyVersion: Config.schema(reference, 'ONTOS_PRICING_CONFIRMATION_KEY_VERSION'),
  lineageRef: Config.schema(reference, 'ONTOS_PRICING_CONFIRMATION_KEY_LINEAGE_REF'),
  secret: Config.Redacted('ONTOS_PRICING_CONFIRMATION_SIGNING_SECRET'),
});
const unsignedSchema = Schema.Struct({
  binding: PricingCommitmentConfirmationBindingSchema,
  expiresAt: PricingInstantSchema,
  issuedAt: PricingInstantSchema,
  source: PricingCommitmentConfirmationSourceSchema,
  terms: Schema.toType(PricingCommercialTotalReadySchema),
});
type UnsignedConfirmation = typeof unsignedSchema.Type;

export class PricingOwnerProofUnavailable extends Schema.TaggedError<PricingOwnerProofUnavailable>()(
  'PricingOwnerProofUnavailable',
  { reason: Schema.String },
) {}
const unavailable = (cause: unknown) =>
  Object.defineProperty(
    new PricingOwnerProofUnavailable({ reason: 'Pricing immutable owner proof could not be verified' }),
    'cause',
    { value: cause },
  );

/** Implements the existing owner-private proof port; secrets never enter a public contract. */
export const pricingCommitmentOwnerProof = Effect.gen(function* pricingCommitmentOwnerProof() {
  const configured = yield* configuration.pipe(Effect.mapError(unavailable));
  const secret = utf8ToBytes(Redacted.value(configured.secret));
  if (secret.length < 32) {
    return yield* unavailable('Owner signing material is insufficient');
  }
  const { subtle } = globalThis.crypto;
  const verificationKey = yield* Effect.tryPromise({
    catch: unavailable,
    try: subtle.importKey.bind(subtle, 'raw', Uint8Array.from(secret), { hash: 'SHA-256', name: 'HMAC' }, false, [
      'verify',
    ]),
  }).pipe(
    Effect.timeoutOrElse({
      duration: cryptoTimeoutMs,
      orElse: () => Effect.fail(unavailable('Owner verification key import timed out')),
    }),
  );
  const metadata = {
    authority: 'EVIDENCE_ONLY' as const,
    issuerRef: 'commerce.pricing',
    keyRef: configured.keyRef,
    keyVersion: configured.keyVersion,
    lineageRef: configured.lineageRef,
    proofVersion: '1',
  };
  const ownsKey = (proof: PricingCommitmentConfirmationIssued['authenticity']) =>
    proof.keyRef === metadata.keyRef &&
    proof.keyVersion === metadata.keyVersion &&
    proof.lineageRef === metadata.lineageRef;
  const sign = (domain: string, canonical: string) =>
    Hex.encode(hmac(sha256, secret, utf8ToBytes(`${domain}\u0000${canonical}`)));
  const issueProof = (input: UnsignedConfirmation) =>
    Schema.encodeEffect(Schema.fromJsonString(unsignedSchema))(input).pipe(
      Effect.mapError(unavailable),
      Effect.map((canonical) => {
        const payloadDigest = Hex.encode(sha256(utf8ToBytes(canonical)));
        return {
          authenticity: {
            ...metadata,
            payloadDigest,
            proofRef: `pricing:confirmation-proof:${sign('commerce.pricing.commitment-confirmation.v1', canonical)}`,
          },
          confirmationRef: `pricing:commitment-confirmation:${payloadDigest}`,
        };
      }),
    );
  const verifyProof = Effect.fn('PricingOwnerProof.verifyConfirmation')(function* verifyProof(
    confirmation: PricingCommitmentConfirmationIssued,
  ) {
    const expected = yield* issueProof(confirmation);
    if (
      confirmation.confirmationRef !== expected.confirmationRef ||
      !Schema.toEquivalence(PricingCommitmentConfirmationAuthenticityProofSchema)(
        { ...confirmation.authenticity, proofRef: expected.authenticity.proofRef },
        expected.authenticity,
      ) ||
      !/^pricing:confirmation-proof:[a-f0-9]{64}$/u.test(confirmation.authenticity.proofRef)
    ) {
      return false;
    }
    const canonical = yield* Schema.encodeEffect(Schema.fromJsonString(unsignedSchema))(confirmation).pipe(
      Effect.mapError(unavailable),
    );
    const signature = yield* Effect.fromResult(
      Hex.decode(confirmation.authenticity.proofRef.slice('pricing:confirmation-proof:'.length)),
    ).pipe(Effect.mapError(unavailable));
    return yield* Effect.tryPromise({
      catch: unavailable,
      try: subtle.verify.bind(
        subtle,
        'HMAC',
        verificationKey,
        Uint8Array.from(signature),
        Uint8Array.from(utf8ToBytes(`commerce.pricing.commitment-confirmation.v1\u0000${canonical}`)),
      ),
    }).pipe(
      Effect.timeoutOrElse({
        duration: cryptoTimeoutMs,
        orElse: () => Effect.fail(unavailable('Owner proof verification timed out')),
      }),
    );
  });
  const quotationEvidence = (quotation: PricingQuotationIssued, verifiedAt: string) =>
    Schema.encodeEffect(Schema.fromJsonString(PricingQuotationIssuedSchema))(quotation).pipe(
      Effect.mapError(unavailable),
      Effect.map((canonical) => ({
        ...metadata,
        authenticityRef: `pricing:quotation-proof:${sign('commerce.pricing.quotation.v1', canonical)}`,
        keyStatus: 'ACTIVE' as const,
        payloadDigest: Hex.encode(sha256(utf8ToBytes(canonical))),
        quotationRef: quotation.quotationRef,
        verifiedAt,
      })),
    );
  return { issueProof, ownsKey, quotationEvidence, verifyProof };
});
