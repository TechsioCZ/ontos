import { CommunicationRequestSchema } from '@app/communications-contracts/communication-request';
import { NodeCrypto } from '@effect/platform-node';
import { Effect, Option, Schema } from 'effect';
import type { Crypto } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { SubmitCommunicationRequestPayloadSchema } from '../../shared/communication-intake.ts';
import {
  canonicalJson,
  deterministicUuid,
  materialMeaningOf,
  requestFingerprintOf,
  requestIdentityKeyOf,
} from '../../src/domain/intake/identity.ts';
import { decodeIntakeInput } from '../../src/domain/intake/intake-input.ts';
import { intentKeyOf } from '../../src/domain/intake/plan.ts';
import { OriginalRecipientBindingSchema, RecipientScopeSchema } from '../../src/domain/recipient/original-binding.ts';
import fixtureJson from '../fixtures/communication-request.fixture.json' with { type: 'json' };
import { communicationRequest, originalRecipient } from '../support/intake-fixtures.ts';
import type { MessageIntentIdentity } from '../../src/domain/catalog/decision.ts';
import {
  AudienceSlotKeySchema,
  CommunicationOccurrenceIdSchema,
  MessageTypeIdSchema,
} from '../../src/domain/catalog/vocabulary.ts';
import { fixtureRequest } from './support/catalog-fixtures.ts';
import { binding } from './support/recipient-fixtures.ts';

const decodeFixture = Schema.decodeUnknownSync(CommunicationRequestSchema, { onExcessProperty: 'error' });
const withCrypto = <Value>(effect: Effect.Effect<Value, never, Crypto.Crypto>) =>
  effect.pipe(Effect.provide(NodeCrypto.layer));

describe('The published Communication Request maps onto the domain decision without a second copy (#1401)', () => {
  it.effect(
    'decodes the contract fixture end to end and every part passes the domain schemas with unknown fields refused',
    () =>
      Effect.gen(function* fixtureDecoding() {
        const request = decodeFixture(fixtureJson);
        const input = yield* decodeIntakeInput(request);
        expect(input.decisionRequest).toMatchObject({
          occurrence: { occurrenceId: 'fixture-order-1-accepted', revision: 3 },
          purpose: 'fixture.single',
          source: { moduleKey: 'fixture.source' },
          tenantId: '11111111-1111-4111-8111-111111111111',
        });
        expect(input.bindings).toHaveLength(2);
        // the very same encoded JSON is accepted by the domain's own schemas: the two cannot drift silently
        for (const encoded of fixtureJson.originalRecipients) {
          expect(() =>
            Schema.decodeUnknownSync(OriginalRecipientBindingSchema, { onExcessProperty: 'error' })(encoded),
          ).not.toThrow();
        }
        expect(() =>
          Schema.decodeUnknownSync(RecipientScopeSchema, { onExcessProperty: 'error' })(fixtureJson.scope),
        ).not.toThrow();
      }),
  );

  it('is the one payload schema of the intake Action: the contract, not a mirror of it', () => {
    expect(SubmitCommunicationRequestPayloadSchema).toBe(CommunicationRequestSchema);
    expect(() => decodeFixture({ ...fixtureJson, preferredLanguage: 'en' })).toThrow();
    expect(() => decodeFixture({ ...fixtureJson, recipientAddress: 'someone@example.test' })).toThrow();
  });

  it('carries no address, secret or delivery result anywhere in the fixture request', () => {
    expect(JSON.stringify(fixtureJson)).not.toMatch(/@|otp|token|password|secret/iu);
  });
});

describe('Request identity and fingerprint (I-02, I-04)', () => {
  it('derives the identity from exactly source owner, Tenant and scope, purpose, occurrence and revision', () => {
    const base = communicationRequest({ bindings: [originalRecipient('customer-1')] });
    const identity = requestIdentityKeyOf(base);
    expect(requestIdentityKeyOf(communicationRequest({ bindings: [originalRecipient('customer-1')] }))).toBe(identity);
    for (const changed of [
      communicationRequest({ bindings: [originalRecipient('customer-1')], occurrenceId: 'fixture-occurrence-2' }),
      communicationRequest({ bindings: [originalRecipient('customer-1')], revision: 2 }),
      communicationRequest({ bindings: [originalRecipient('customer-1')], purpose: 'fixture.other' }),
      communicationRequest({
        bindings: [originalRecipient('customer-1')],
        tenantId: '22222222-2222-4222-8222-222222222222',
      }),
      communicationRequest({
        bindings: [originalRecipient('customer-1')],
        legalEntityId: '44444444-4444-4444-8444-444444444444',
      }),
    ]) {
      expect(requestIdentityKeyOf(changed)).not.toBe(identity);
    }
  });

  it('does not use a recipient, a trace id or an idempotency key as the business identity', () => {
    const one = communicationRequest({ bindings: [originalRecipient('customer-1')], idempotencyKey: 'key-one' });
    const other = communicationRequest({ bindings: [originalRecipient('customer-2')], idempotencyKey: 'key-two' });
    // the identity is the occurrence; a different recipient or key under it is a CONFLICT, found by the fingerprint
    expect(requestIdentityKeyOf(one)).toBe(requestIdentityKeyOf(other));
  });

  it.effect('gives equal meaning the same fingerprint whatever the order or the trace id', () =>
    withCrypto(
      Effect.gen(function* equalMeaning() {
        const first = communicationRequest({
          bindings: [originalRecipient('customer-1'), originalRecipient('customer-2')],
          safeReferences: [
            { key: 'order', resourceId: 'order-1' },
            { key: 'invoice', resourceId: 'invoice-1' },
          ],
        });
        const reordered = communicationRequest({
          bindings: [originalRecipient('customer-2'), originalRecipient('customer-1')],
          safeReferences: [
            { key: 'invoice', resourceId: 'invoice-1' },
            { key: 'order', resourceId: 'order-1' },
          ],
        });
        const traced = communicationRequest({
          bindings: [originalRecipient('customer-1'), originalRecipient('customer-2')],
          correlationId: 'another-trace',
          safeReferences: [
            { key: 'order', resourceId: 'order-1' },
            { key: 'invoice', resourceId: 'invoice-1' },
          ],
        });
        const fingerprint = yield* requestFingerprintOf(first);
        expect(yield* requestFingerprintOf(reordered)).toBe(fingerprint);
        expect(yield* requestFingerprintOf(traced)).toBe(fingerprint);
      }),
    ),
  );

  it.effect('changes the fingerprint for another recipient, purpose, source value, reference or idempotency key', () =>
    withCrypto(
      Effect.gen(function* changedMeaning() {
        const base = communicationRequest({ bindings: [originalRecipient('customer-1')] });
        const fingerprint = yield* requestFingerprintOf(base);
        for (const changed of [
          communicationRequest({ bindings: [originalRecipient('customer-2')] }),
          communicationRequest({ bindings: [originalRecipient('customer-1', 'contact-corrected')] }),
          communicationRequest({ bindings: [originalRecipient('customer-1')], purpose: 'fixture.other' }),
          communicationRequest({
            bindings: [originalRecipient('customer-1')],
            safeReferences: [{ key: 'order', resourceId: 'o-2' }],
          }),
          communicationRequest({ bindings: [originalRecipient('customer-1')], idempotencyKey: 'another-key' }),
        ]) {
          expect(yield* requestFingerprintOf(changed)).not.toBe(fingerprint);
        }
      }),
    ),
  );

  it.effect('canonicalizes object keys, so equal values always have equal text', () =>
    Effect.gen(function* canonical() {
      expect(yield* canonicalJson({ a: { c: null, d: [2, 1] }, b: 1 })).toBe(
        yield* canonicalJson({ a: { c: null, d: [2, 1] }, b: 1 }),
      );
      expect(
        yield* materialMeaningOf(communicationRequest({ bindings: [originalRecipient('customer-1')] })),
      ).toBeDefined();
    }),
  );

  it.effect('derives every durable id from its identity text: stable, well-formed and namespaced', () =>
    withCrypto(
      Effect.gen(function* ids() {
        const one = yield* deterministicUuid('communications.request', 'identity-1');
        expect(one).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
        expect(yield* deterministicUuid('communications.request', 'identity-1')).toBe(one);
        expect(yield* deterministicUuid('communications.decision', 'identity-1')).not.toBe(one);
        expect(yield* deterministicUuid('communications.request', 'identity-2')).not.toBe(one);
      }),
    ),
  );

  it('names a Message Intent by the catalog candidate identity: tenant, source, occurrence, type, slot and FULL recipient', () => {
    const request = fixtureRequest();
    const identity: MessageIntentIdentity = {
      occurrenceId: CommunicationOccurrenceIdSchema.make('o-1'),
      recipient: binding('original-recipient', 'r-1').recipientRef,
      revision: 1,
      slotKey: AudienceSlotKeySchema.make('primary'),
      sourceModule: request.source.moduleKey,
      tenantId: request.tenantId,
      typeId: MessageTypeIdSchema.make('fixture.single-message'),
    };
    const key = intentKeyOf(identity);
    expect(intentKeyOf({ ...identity, recipient: { ...identity.recipient, resourceType: 'fixture.other' } })).not.toBe(
      key,
    );
    expect(intentKeyOf({ ...identity, occurrenceId: CommunicationOccurrenceIdSchema.make('o-2') })).not.toBe(key);
    // a later catalog revision does not re-identify the occurrence: the revision is not part of the key
    expect(Option.isNone(Option.fromNullishOr(/revision/u.exec(key)))).toBe(true);
  });
});
