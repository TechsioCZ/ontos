import { Result, Schema, flow } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  MessageHandoffOutcomeSchema,
  MessageHandoffResultSchema,
  ProviderObservationInputSchema,
} from '../../src/message-handoff.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const intentId = '22222222-2222-4222-8222-222222222222';
const attemptId = '33333333-3333-4333-8333-333333333333';
const identity = { attemptId, intentId, tenantId };

const accepts = (schema: Schema.Decoder<unknown>) => flow(Schema.decodeUnknownResult(schema), Result.isSuccess);

describe('the handoff result the Messaging Adapter returns (step 21 contract, #1402 #1403 #1411)', () => {
  it('names every answer the adapter can give, each bound to its own tenant, intent and attempt', () => {
    const outcomes = [
      { kind: 'ACCEPTED', providerKey: 'fixture-provider', providerRef: 'ref-1' },
      { kind: 'INDETERMINATE', reason: 'timeout' },
      { kind: 'NOT_ATTEMPTED', reason: 'NO_ADAPTER_CONFIGURED' },
      { kind: 'REJECTED', reason: 'rate_limited' },
      { kind: 'UNAVAILABLE', reason: 'configuration' },
      { field: 'to', kind: 'MESSAGE_INVALID', proof: 'PROVIDER_NOT_ASKED', reason: 'invalid_format' },
    ];
    for (const outcome of outcomes) {
      expect(accepts(MessageHandoffOutcomeSchema)(outcome)).toBe(true);
      expect(accepts(MessageHandoffResultSchema)({ ...identity, outcome })).toBe(true);
    }
    expect(accepts(MessageHandoffResultSchema)({ attemptId, outcome: outcomes[0] })).toBe(false);
  });

  it('refuses a message-invalid answer without the proof that the provider was never asked', () => {
    const guess = { field: 'to', kind: 'MESSAGE_INVALID', reason: 'invalid_format' };
    expect(accepts(MessageHandoffOutcomeSchema)(guess)).toBe(false);
    expect(accepts(MessageHandoffOutcomeSchema)({ ...guess, proof: 'PROVIDER_ASKED' })).toBe(false);
    expect(accepts(MessageHandoffOutcomeSchema)({ ...guess, proof: 'PROVIDER_NOT_ASKED' })).toBe(true);
  });

  it('has no field for a provider payload, an address, markup or a secret', () => {
    const outcome = { kind: 'ACCEPTED', providerKey: 'fixture-provider', providerRef: 'ref-1' };
    expect(accepts(MessageHandoffOutcomeSchema)({ ...outcome, providerRef: 'person@example.test' })).toBe(false);
    expect(accepts(MessageHandoffOutcomeSchema)({ ...outcome, providerRef: '<b>x</b>' })).toBe(false);
    const decoded = Schema.decodeUnknownSync(MessageHandoffOutcomeSchema)({ ...outcome, payload: 'secret' });
    expect(Object.keys(decoded)).not.toContain('payload');
  });
});

describe('the provider observation input (step 22 hands evidence to Communications)', () => {
  const base = {
    ...identity,
    observationKey: 'event-1',
    observedAt: '2026-11-25T10:00:00.000Z',
    providerKey: 'fixture-provider',
  };

  it('accepts exactly the four proofs, each with the basis that can prove it', () => {
    const valid = [
      { basis: 'PROVIDER_EVENT', kind: 'ACCEPTANCE_PROVEN' },
      { basis: 'RECONCILIATION', kind: 'ACCEPTANCE_PROVEN' },
      { basis: 'RECONCILIATION', kind: 'NON_ACCEPTANCE_PROVEN' },
      { basis: 'PROVIDER_EVENT', kind: 'DELIVERY_PROVEN' },
      { basis: 'PROVIDER_EVENT', failureClass: 'BOUNCED_PERMANENT', kind: 'DELIVERY_FAILED' },
    ];
    for (const evidence of valid) {
      expect(accepts(ProviderObservationInputSchema)({ ...base, evidence })).toBe(true);
    }
    const invalid = [
      { basis: 'PROVIDER_EVENT', kind: 'NON_ACCEPTANCE_PROVEN' },
      { basis: 'RECONCILIATION', kind: 'DELIVERY_PROVEN' },
      { basis: 'PROVIDER_EVENT', kind: 'DELIVERY_FAILED' },
    ];
    for (const evidence of invalid) {
      expect(accepts(ProviderObservationInputSchema)({ ...base, evidence })).toBe(false);
    }
  });

  it('keeps a Tenant claim a claim and carries no provider payload', () => {
    const decoded = Schema.decodeUnknownSync(ProviderObservationInputSchema)({
      ...base,
      evidence: { basis: 'PROVIDER_EVENT', kind: 'DELIVERY_PROVEN' },
      payload: { to: 'person@example.test' },
    });
    expect(Object.keys(decoded).toSorted()).toEqual([
      'attemptId',
      'evidence',
      'intentId',
      'observationKey',
      'observedAt',
      'providerKey',
      'tenantId',
    ]);
  });
});
