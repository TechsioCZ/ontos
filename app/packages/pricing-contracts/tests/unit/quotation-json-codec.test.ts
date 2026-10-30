import { OwnerVerifiableSetCompletenessEvidenceSchema } from '@app/shared-contracts';
import { DateTime, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { PricingInstantSchema } from '../../src/domain/currency-support.ts';

const completenessCodec = Schema.toCodecJson(Schema.toType(OwnerVerifiableSetCompletenessEvidenceSchema));
const encodeCompleteness = Schema.encodeSync(completenessCodec);
const completenessTextCodec = Schema.fromJsonString(completenessCodec);
const decodeCompleteness = Schema.decodeUnknownSync(completenessTextCodec);
const encodeCompletenessText = Schema.encodeSync(completenessTextCodec);

const evidenceJson = {
  nextApplicabilityBoundary: '2026-10-01T00:00:00.000Z',
  observedAt: '2026-09-28T12:00:00.123Z',
  ownerRevision: 'quantity-tier-set:price:codec:r1',
  scope: { kind: 'EXACT_PREDICATE', predicateRef: 'current-tiers:price:codec' },
} as const;

describe('Pricing Quotation JSON codec contract', () => {
  it('round-trips retained Tier completeness DateTime instants through JSON text to the millisecond', () => {
    const decoded = decodeCompleteness(JSON.stringify(evidenceJson));

    expect(DateTime.isDateTime(decoded.observedAt)).toBe(true);
    expect(DateTime.toEpochMillis(decoded.observedAt)).toBe(Date.parse(evidenceJson.observedAt));
    expect(DateTime.toEpochMillis(decoded.observedAt) % 1000).toBe(123);
    expect(decoded.nextApplicabilityBoundary).toBeDefined();
    expect(encodeCompleteness(decoded)).toEqual(evidenceJson);
    expect(encodeCompletenessText(decoded)).toBe(JSON.stringify(evidenceJson));
  });

  it('rejects Date objects, epoch numbers, and malformed instant strings in the JSON representation', () => {
    for (const observedAt of [
      DateTime.toDateUtc(DateTime.makeUnsafe(evidenceJson.observedAt)),
      Date.parse(evidenceJson.observedAt),
      'not-an-instant',
      '2026-13-45T00:00:00.000Z',
      '',
      null,
    ]) {
      expect(Option.isNone(Schema.decodeUnknownOption(completenessCodec)({ ...evidenceJson, observedAt }))).toBe(true);
    }
    expect(
      Option.isNone(
        Schema.decodeUnknownOption(completenessCodec)({
          ...evidenceJson,
          nextApplicabilityBoundary: DateTime.toDateUtc(DateTime.makeUnsafe(evidenceJson.nextApplicabilityBoundary)),
        }),
      ),
    ).toBe(true);
  });

  it('keeps issuance instants canonical UTC milliseconds text on both sides of the codec', () => {
    const issuedAt = '2026-09-28T12:00:01.250Z';
    const codec = Schema.toCodecJson(PricingInstantSchema);

    expect(Schema.decodeUnknownSync(codec)(issuedAt)).toBe(issuedAt);
    expect(Schema.encodeSync(codec)(issuedAt)).toBe(issuedAt);
    for (const instant of [
      DateTime.toDateUtc(DateTime.makeUnsafe(issuedAt)),
      '2026-09-28T12:00:01Z',
      '2026-09-28T12:00:01.250+02:00',
      '2026-09-31T12:00:01.250Z',
      'not-an-instant',
    ]) {
      expect(Option.isNone(Schema.decodeUnknownOption(codec)(instant))).toBe(true);
    }
  });
});
