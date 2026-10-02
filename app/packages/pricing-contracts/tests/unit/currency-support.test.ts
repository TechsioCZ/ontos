import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  CurrencySupportCurrentnessEvidenceSchema,
  PricingCurrencyCodeSchema,
  SetSupportedCurrenciesV2PayloadSchema,
  SetSupportedCurrenciesV2ResultSchema,
} from '../../src/index.ts';

const tenantId = '22222222-2222-4222-8222-222222222222';
const supportRootId = '33333333-3333-4333-8333-333333333333';
const supportRootRef = {
  moduleId: 'commerce.pricing' as const,
  resourceId: supportRootId,
  resourceType: 'commerce.pricing.currency-support' as const,
  tenantId,
};
const revisionRef = (resourceId: string) => ({
  moduleId: 'commerce.pricing' as const,
  resourceId,
  resourceType: 'commerce.pricing.currency-support-revision' as const,
  supportRootId,
  tenantId,
});
const current = {
  effectivePeriod: {
    effectiveFrom: '2026-09-01T00:00:00.000Z',
    effectiveTo: '2026-10-01T00:00:00.000Z',
  },
  generation: 4,
  supportedCurrencies: ['CZK'],
  supportRevisionRef: revisionRef('44444444-4444-4444-8444-444444444444'),
};
const future = {
  effectivePeriod: {
    effectiveFrom: '2026-11-01T00:00:00.000Z',
    effectiveTo: null,
  },
  generation: 5,
  supportedCurrencies: ['CZK'],
  supportRevisionRef: revisionRef('55555555-5555-4555-8555-555555555555'),
};
const expectedState = {
  current,
  future: [future],
  observedAt: '2026-09-27T10:00:00.000Z',
  scheduleRevision: 7,
  state: 'PRESENT' as const,
  supportRootRef,
};
const intendedEffectivePeriod = {
  effectiveFrom: '2026-09-27T10:05:00.000Z',
  effectiveTo: current.effectivePeriod.effectiveTo,
};
const acknowledgement = {
  actingPrincipalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  expectedScheduleRevision: expectedState.scheduleRevision,
  fingerprint: 'a'.repeat(64),
  intendedEffectivePeriod,
  intendedSupportedCurrencies: ['CZK'],
  presentedFuture: expectedState.future,
  supportRootRef,
  targetEffectivePeriod: current.effectivePeriod,
  targetRevisionRef: current.supportRevisionRef,
};

const decodePayload = Schema.decodeUnknownSync(SetSupportedCurrenciesV2PayloadSchema, {
  onExcessProperty: 'error',
});

describe('Pricing Currency Support contracts', () => {
  it('accepts recognized generalized currency codes without activating them', () => {
    for (const code of ['CZK', 'EUR', 'USD']) {
      expect(Schema.decodeSync(PricingCurrencyCodeSchema)(code)).toBe(code);
    }
    for (const code of ['ZZZ', 'czk', 'EURO']) {
      expect(() => Schema.decodeSync(PricingCurrencyCodeSchema)(code)).toThrow();
    }
  });

  it('defines a closed Tenant-free v2 establish payload', () => {
    const payload = {
      expectedState: { state: 'ABSENT' as const },
      intendedEffectivePeriod: {
        effectiveFrom: '2026-09-27T10:00:00.000Z',
        effectiveTo: null,
      },
      intent: 'ESTABLISH_CURRENT' as const,
      reason: 'Establish Launch support',
      schemaVersion: '2' as const,
      supportedCurrencies: ['CZK'],
    };
    expect(decodePayload(payload)).toEqual(payload);
    for (const forbidden of [
      'tenantId',
      'legalEntityId',
      'cartId',
      'contextRevision',
      'storefrontId',
      'marketId',
      'channelId',
      'subject',
    ]) {
      expect(() => decodePayload({ ...payload, [forbidden]: 'forbidden' })).toThrow();
    }
  });

  it('permits the Action to issue a blocking warning before acknowledgement', () => {
    const payload = {
      expectedState,
      intendedEffectivePeriod,
      intent: 'VALUE_ONLY_CURRENT' as const,
      reason: 'Refresh Launch support',
      schemaVersion: '2' as const,
      supportedCurrencies: ['CZK'],
    };
    expect(decodePayload(payload)).toEqual(payload);
    expect(decodePayload({ ...payload, acknowledgement })).toMatchObject({ acknowledgement });
  });

  it('rejects acknowledgement drift and value-only interval extension', () => {
    const payload = {
      acknowledgement,
      expectedState,
      intendedEffectivePeriod,
      intent: 'VALUE_ONLY_CURRENT' as const,
      reason: 'Refresh Launch support',
      schemaVersion: '2' as const,
      supportedCurrencies: ['CZK'],
    };
    expect(() =>
      decodePayload({
        ...payload,
        acknowledgement: { ...acknowledgement, expectedScheduleRevision: 8 },
      }),
    ).toThrow();
    expect(() =>
      decodePayload({
        ...payload,
        intendedEffectivePeriod: { ...intendedEffectivePeriod, effectiveTo: null },
      }),
    ).toThrow();
  });

  it('binds Currentness evidence to one Tenant-qualified root and Revision', () => {
    const evidence = {
      evaluatedAt: '2026-09-27T10:00:00.000Z',
      evaluationMode: 'CURRENT_WITH_REVALIDATION' as const,
      observedAt: '2026-09-27T10:00:01.000Z',
      revalidatedAt: '2026-09-27T10:00:02.000Z',
      scheduleRevision: 7,
      supportRevisionRef: current.supportRevisionRef,
      supportRootRef,
    };
    expect(Schema.decodeSync(CurrencySupportCurrentnessEvidenceSchema)(evidence)).toEqual(evidence);
    expect(() =>
      Schema.decodeSync(CurrencySupportCurrentnessEvidenceSchema)({
        ...evidence,
        supportRevisionRef: {
          ...evidence.supportRevisionRef,
          supportRootId: '44444444-4444-4444-8444-444444444444',
        },
      }),
    ).toThrow();
  });

  it('returns the canonical root, current Revision, schedule evidence, and interval', () => {
    const result = {
      changed: true,
      current,
      scheduleRevision: 8,
      supportRootRef,
    };
    expect(Schema.decodeSync(SetSupportedCurrenciesV2ResultSchema)(result)).toEqual(result);
  });
});
