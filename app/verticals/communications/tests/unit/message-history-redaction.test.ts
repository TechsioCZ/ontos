import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { ProviderObservationInputSchema } from '../../src/domain/history/provider-observation.ts';
import { ObservationEvidenceSchema } from '../../src/domain/history/vocabulary.ts';

/**
 * [#1402 H-12 AC-08] What can be put into a provider observation is closed by TYPE: it has no field for a provider payload,
 * an address, markup, a link or a secret, and the identity texts cannot hold one either.
 */
const valid = {
  attemptId: '22222222-2222-4222-8222-222222222221',
  evidence: { basis: 'PROVIDER_EVENT', kind: 'DELIVERY_PROVEN' },
  intentId: '11111111-1111-4111-8111-111111111111',
  observationKey: 'evt_fixture-0001',
  observedAt: '2026-11-19T12:30:00.000Z',
  providerKey: 'fixture-provider',
  providerRef: 'fixture-receipt-1',
  tenantId: '33333333-3333-4333-8333-333333333333',
};
const decode = Schema.decodeUnknownSync(ProviderObservationInputSchema, { onExcessProperty: 'error' });

describe('Provider observation input is closed by type', () => {
  it('accepts the step 22 shaped evidence and nothing else', () => {
    expect(decode(valid).observationKey).toBe('evt_fixture-0001');
    for (const extra of ['payload', 'html', 'to', 'recipient', 'token', 'url', 'headers', 'rawEvent']) {
      expect(() => decode({ ...valid, [extra]: 'x' })).toThrow();
    }
  });

  it('refuses identity texts that could carry an address, a link, markup or whitespace', () => {
    for (const unsafe of [
      'someone@example.test',
      'https://example.test/a?token=1',
      '<b>x</b>',
      'two words',
      'a/b',
      '',
    ]) {
      expect(() => decode({ ...valid, observationKey: unsafe })).toThrow();
      expect(() => decode({ ...valid, providerKey: unsafe })).toThrow();
      expect(() => decode({ ...valid, providerRef: unsafe })).toThrow();
    }
  });

  it('refuses an evidence whose basis does not fit the claim: a delivery or a failure needs a provider event', () => {
    const evidence = Schema.decodeUnknownSync(ObservationEvidenceSchema, { onExcessProperty: 'error' });
    expect(() => evidence({ basis: 'RECONCILIATION', kind: 'DELIVERY_PROVEN' })).toThrow();
    expect(() =>
      evidence({ basis: 'RECONCILIATION', failureClass: 'BOUNCED_PERMANENT', kind: 'DELIVERY_FAILED' }),
    ).toThrow();
    expect(() => evidence({ basis: 'PROVIDER_EVENT', kind: 'NON_ACCEPTANCE_PROVEN' })).toThrow();
    expect(() => evidence({ basis: 'PROVIDER_EVENT', failureClass: 'free text', kind: 'DELIVERY_FAILED' })).toThrow();
    expect(() => evidence({ basis: 'PROVIDER_EVENT', body: '<p>hello</p>', kind: 'DELIVERY_PROVEN' })).toThrow();
  });
});
