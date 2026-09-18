import { DateTime, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  ActivatePrincipalBindingPayloadSchema,
  AuthenticationAdmissionObservationSchema,
  AuthenticationNamespaceRegistrationSchema,
  BindingRevisionSchema,
  ChangePrincipalBindingStatusPayloadSchema,
  ExternalAuthenticationSubjectSchema,
  ExternalSubjectAdmissionObservationSchema,
  ReadPrincipalBindingPayloadSchema,
  ReadPrincipalBindingResultSchema,
  ReservePrincipalBindingPayloadSchema,
  ReservePrincipalBindingResultSchema,
} from '../../src/auth/external-identity-contracts.ts';

const bindingId = '70000000-0000-4000-8000-000000000001';
const principalId = '40000000-0000-4000-8000-000000000001';
const tenantId = '30000000-0000-4000-8000-000000000001';
const subject = {
  authenticationNamespaceId: 'test.third-provider.realm',
  providerSubjectId: 'Case-Sensitive/ID_01',
  subjectType: 'user',
};
const decode = <S extends Schema.ConstraintDecoder<unknown>, Value>(schema: S, value: Value): S['Type'] =>
  Schema.decodeUnknownSync(schema)(value);

it('accepts distinct configured namespace shapes without a closed realm vocabulary', () => {
  for (const authenticationNamespaceId of ['test.staff', 'test.customer', 'test.third-provider.realm']) {
    expect(decode(ExternalAuthenticationSubjectSchema, { ...subject, authenticationNamespaceId })).toEqual({
      ...subject,
      authenticationNamespaceId,
    });
    expect(
      decode(AuthenticationNamespaceRegistrationSchema, {
        allowedAudiences: ['test-app'],
        authenticationNamespaceId,
        provider: 'test-provider',
        requiresOperationAdmission: true,
        reservationPrincipalKind: 'human',
        subjectTypes: ['user'],
        trustedAttesterPrincipalIds: [principalId],
      }).authenticationNamespaceId,
    ).toBe(authenticationNamespaceId);
  }
});

it('preserves opaque case-sensitive subjects and existing API-key subject vocabulary', () => {
  expect(decode(ExternalAuthenticationSubjectSchema, subject).providerSubjectId).toBe(subject.providerSubjectId);
  expect(decode(ExternalAuthenticationSubjectSchema, { ...subject, subjectType: 'api_key' }).subjectType).toBe(
    'api_key',
  );
  for (const providerSubjectId of ['', 'x'.repeat(501)]) {
    expect(() => decode(ExternalAuthenticationSubjectSchema, { ...subject, providerSubjectId })).toThrow();
  }
});

it('rejects Commerce policy, caller-selected authority and credentials in neutral mutations', () => {
  const boundaries = [
    [ReservePrincipalBindingPayloadSchema, subject],
    [ActivatePrincipalBindingPayloadSchema, { authBindingId: bindingId, expectedRevision: 1 }],
    [ReadPrincipalBindingPayloadSchema, { authBindingId: bindingId, lookup: 'binding' }],
    [
      ChangePrincipalBindingStatusPayloadSchema,
      { authBindingId: bindingId, expectedRevision: 1, reason: 'Support request', requestedStatus: 'disabled' },
    ],
  ] as const;
  for (const [schema, value] of boundaries) {
    for (const field of ['enrollmentAttemptId', 'emailVerified', 'principalId', 'tenantId', 'sessionToken']) {
      expect(() => decode(schema, { ...value, [field]: 'untrusted' })).toThrow();
    }
  }
});

it('requires pending revision one for a newly reserved identity', () => {
  const reserved = {
    authBindingId: bindingId,
    bindingRevision: 1,
    bindingStatus: 'pending',
    outcome: 'RESERVED',
    principalId,
  };
  expect(decode(ReservePrincipalBindingResultSchema, reserved)).toEqual(reserved);
  expect(() => decode(ReservePrincipalBindingResultSchema, { ...reserved, bindingStatus: 'active' })).toThrow();
  expect(() => decode(ReservePrincipalBindingResultSchema, { ...reserved, bindingRevision: 2 })).toThrow();
  expect(
    decode(ReservePrincipalBindingResultSchema, { ...reserved, bindingStatus: 'revoked', outcome: 'EXISTING' })
      .bindingStatus,
  ).toBe('revoked');
});

it('rejects unsafe revisions and attempts to return an active binding to pending', () => {
  for (const revision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY]) {
    expect(() => decode(BindingRevisionSchema, revision)).toThrow();
  }
  expect(() =>
    decode(ChangePrincipalBindingStatusPayloadSchema, {
      authBindingId: bindingId,
      expectedRevision: 1,
      reason: 'Reset',
      requestedStatus: 'pending',
    }),
  ).toThrow();
});

it('neutral admission observations bind exact operation identity without provider policy fields', () => {
  const value = {
    audience: 'test-app',
    authBindingId: bindingId,
    authContextRef: 'opaque-reference',
    authenticationNamespaceId: subject.authenticationNamespaceId,
    bindingRevision: 1,
    expiresAt: DateTime.makeUnsafe('2026-09-16T10:00:05Z'),
    nonce: '50000000-0000-4000-8000-000000000001',
    observedAt: DateTime.makeUnsafe('2026-09-16T10:00:00Z'),
    operationRef: 'read:test.operation',
    principalId,
    tenantId,
  };
  expect(decode(AuthenticationAdmissionObservationSchema, value)).toEqual(value);
  for (const field of ['nonce', 'operationRef', 'audience', 'bindingRevision']) {
    const missing = Object.fromEntries(Object.entries(value).filter(([key]) => key !== field));
    expect(() => decode(AuthenticationAdmissionObservationSchema, missing)).toThrow();
  }
  expect(() => decode(AuthenticationAdmissionObservationSchema, { ...value, emailVerified: true })).toThrow();
});

it('represents exact pre-binding subject evidence without inventing canonical IDs', () => {
  const value = {
    ...subject,
    audience: 'test-app',
    authContextRef: 'opaque-reference',
    expiresAt: DateTime.makeUnsafe('2026-09-16T10:00:05Z'),
    nonce: '50000000-0000-4000-8000-000000000001',
    observedAt: DateTime.makeUnsafe('2026-09-16T10:00:00Z'),
    operationRef: 'reserve-binding',
    tenantId,
  };
  expect(decode(ExternalSubjectAdmissionObservationSchema, value)).toEqual(value);
  expect(() => decode(AuthenticationAdmissionObservationSchema, value)).toThrow();
  expect(() => decode(ExternalSubjectAdmissionObservationSchema, { ...value, authBindingId: bindingId })).toThrow();
  for (const field of ['providerSubjectId', 'subjectType', 'authenticationNamespaceId']) {
    const missing = Object.fromEntries(Object.entries(value).filter(([key]) => key !== field));
    expect(() => decode(ExternalSubjectAdmissionObservationSchema, missing)).toThrow();
  }
});

it('round-trips explicit legacy null provenance through Option without changing the wire shape', () => {
  const legacy = {
    authBindingId: bindingId,
    authenticationNamespaceId: subject.authenticationNamespaceId,
    bindingRevision: 1,
    bindingStatus: 'active',
    originalInvocationId: null,
    outcome: 'FOUND',
    principalId,
    principalStatus: 'active',
    tenantStatus: 'active',
  };
  const decoded = decode(ReadPrincipalBindingResultSchema, legacy);
  if (decoded.outcome !== 'FOUND') {
    expect.unreachable('Expected the exact binding result');
  }
  expect(Option.isNone(decoded.originalInvocationId)).toBe(true);
  expect(Schema.encodeSync(ReadPrincipalBindingResultSchema)(decoded)).toEqual(legacy);
  const recorded = { ...legacy, originalInvocationId: '50000000-0000-4000-8000-000000000001' };
  expect(
    Schema.encodeSync(ReadPrincipalBindingResultSchema)(decode(ReadPrincipalBindingResultSchema, recorded)),
  ).toEqual(recorded);
});
