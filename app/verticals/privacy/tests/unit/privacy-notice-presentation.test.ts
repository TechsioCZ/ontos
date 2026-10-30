import { NodeCrypto } from '@effect/platform-node';
import { Effect, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { SignJWT, base64url } from 'jose';

import { PrivacyNoticePresentationClaimsSchema } from '../../shared/resources/privacy-notice-acknowledgement.ts';
import { makePrivacyNoticePresentationService } from '../../src/services/privacy-notice-presentation.service.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const keyId = 'notice-unit-key';
const key = new Uint8Array(32).fill(17);
const configuration = { keyId, signingKey: Redacted.make(base64url.encode(key)) };
const claims = Schema.decodeUnknownEffect(PrivacyNoticePresentationClaimsSchema)({
  actorPrincipalId: '10000000-0000-4000-8000-000000000002',
  applicableScopeDigest: 'a'.repeat(64),
  aud: 'privacy.notice-presentation.v1',
  authBindingId: '10000000-0000-4000-8000-000000000003',
  authenticationNamespaceId: 'commerce',
  businessInteractionRef: 'unit-interaction',
  contentIdentity: 'unit-immutable-content',
  controllerRef: 'unit-controller',
  iss: 'privacy.core.notice-presentation',
  language: 'en',
  legalEntityId: '10000000-0000-4000-8000-000000000004',
  noticeVersionId: '10000000-0000-4000-8000-000000000005',
  presentationId: '10000000-0000-4000-8000-000000000006',
  privacySubjectRef: {
    moduleId: 'privacy.core',
    resourceId: '10000000-0000-4000-8000-000000000007',
    resourceType: 'privacy.core.privacy-subject',
    tenantId,
  },
  processingPurposeRef: 'unit-purpose',
  processingScopeRef: { scopeId: 'unit-processing-scope', scopeType: 'privacy.processing-scope' },
  purposeVersionId: '10000000-0000-4000-8000-000000000008',
  retailProfileId: '10000000-0000-4000-8000-000000000009',
  servedAt: '2026-10-20T12:00:00.123456Z',
  sessionContextDigest: 'b'.repeat(64),
  tenantId,
  v: 1,
  wordingDigest: 'c'.repeat(64),
});

it.effect('authenticates the exact Notice receipt and preserves supported timestamp precision', () =>
  Effect.gen(function* validReceipt() {
    const service = yield* makePrivacyNoticePresentationService(configuration);
    const expected = yield* claims;
    const receipt = yield* service.seal(expected);
    expect(yield* service.open(receipt)).toEqual(expected);
    expect(JSON.stringify(receipt)).not.toContain(Redacted.value(receipt));
    expect(yield* service.digest('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  }).pipe(Effect.provide(NodeCrypto.layer)),
);

it.effect('rejects payload substitution and a receipt from another integrity key', () =>
  Effect.gen(function* tamperedReceipt() {
    const service = yield* makePrivacyNoticePresentationService(configuration);
    const receipt = yield* service.seal(yield* claims);
    const pieces = Redacted.value(receipt).split('.');
    const changed = `${pieces[0]}.${base64url.encode(JSON.stringify({ ...(yield* claims), tenantId: '10000000-0000-4000-8000-000000000099' }))}.${pieces[2]}`;
    expect((yield* Effect.flip(service.open(Redacted.make(changed)))).code).toBe(
      'privacy_notice_acknowledgement_invalid',
    );
    const other = yield* makePrivacyNoticePresentationService({
      keyId,
      signingKey: Redacted.make(base64url.encode(new Uint8Array(32).fill(18))),
    });
    expect((yield* Effect.flip(other.open(receipt))).code).toBe('privacy_notice_acknowledgement_invalid');
  }).pipe(Effect.provide(NodeCrypto.layer)),
);

it.effect('rejects extra signed authority claims, remote key headers, wrong purpose and key identity', () =>
  Effect.gen(function* closedReceiptProtocol() {
    const service = yield* makePrivacyNoticePresentationService(configuration);
    const payload = yield* claims;
    const invalidEnvelopes = [
      new SignJWT({ ...payload, currentAuthority: 'ALLOWED' }).setProtectedHeader({
        alg: 'HS256',
        kid: keyId,
        typ: 'ontos-privacy-notice-presentation+jwt',
      }),
      new SignJWT(payload).setProtectedHeader({
        alg: 'HS256',
        jku: 'https://invalid.test/keys',
        kid: keyId,
        typ: 'ontos-privacy-notice-presentation+jwt',
      }),
      new SignJWT(payload).setProtectedHeader({ alg: 'HS256', kid: keyId, typ: 'JWT' }),
      new SignJWT(payload).setProtectedHeader({
        alg: 'HS256',
        kid: 'other-key',
        typ: 'ontos-privacy-notice-presentation+jwt',
      }),
      new SignJWT({ ...payload, aud: 'another-channel' }).setProtectedHeader({
        alg: 'HS256',
        kid: keyId,
        typ: 'ontos-privacy-notice-presentation+jwt',
      }),
    ];
    for (const envelope of invalidEnvelopes) {
      const signed = yield* Effect.promise(() => envelope.sign(key));
      expect((yield* Effect.flip(service.open(Redacted.make(signed)))).code).toBe(
        'privacy_notice_acknowledgement_invalid',
      );
    }
    expect((yield* Effect.flip(service.open(Redacted.make('x'.repeat(32_769))))).code).toBe(
      'privacy_notice_acknowledgement_invalid',
    );
  }).pipe(Effect.provide(NodeCrypto.layer)),
);

it.effect('keeps missing or invalid integrity configuration unavailable', () =>
  Effect.gen(function* invalidConfiguration() {
    for (const invalidConfig of [
      { keyId: '', signingKey: configuration.signingKey },
      { keyId, signingKey: Redacted.make(base64url.encode(new Uint8Array(31))) },
      { keyId, signingKey: Redacted.make('not a base64url key') },
    ]) {
      expect((yield* Effect.flip(makePrivacyNoticePresentationService(invalidConfig))).code).toBe(
        'privacy_notice_acknowledgement_unavailable',
      );
    }
  }).pipe(Effect.provide(NodeCrypto.layer)),
);
