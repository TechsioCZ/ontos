import { privacySubjectRefForParty } from '@app/privacy/domain/privacy-subject-identity';
import { CreatePrivacySubjectPayloadSchema } from '@app/privacy/api';
import { ConsentSelfServiceRequestSchema, RecordNoticeProvisionPayloadSchema } from '@app/consent-authority-contracts';
import type { ConsentSelfServiceRequest } from '@app/consent-authority-contracts';
import { PrivacyNoticeVersionSchema } from '@app/privacy/domain/privacy-notice-version';
import type { PrivacyNoticeVersion } from '@app/privacy/domain/privacy-notice-version';
import { Array as Arr, Effect, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  CustomerConsentReceiptSchema,
  customerNewsletterScope,
  matchesCustomerConsentReceipt,
  noticeProvisionRequest,
  sameCustomerConsentScope,
} from '../../api/portal-auth/consent/model.ts';
import { selectCustomerNewsletterNotice } from '../../api/portal-auth/consent/privacy-owner.ts';
import type { CustomerNewsletterCatalog } from '../../api/portal-auth/consent/privacy-owner.ts';
import { ConsentConflictProblemSchema, UpdateCustomerOwnConsentSchema } from '../../shared/portal-auth/consent-api.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const partyId = '22222222-2222-4222-8222-222222222222';
const controllerRef = '33333333-3333-4333-8333-333333333333';
const purposeId = '44444444-4444-4444-8444-444444444444';
const purposeVersionId = '55555555-5555-4555-8555-555555555555';
const requestId = '66666666-6666-4666-8666-666666666666';
const noticeVersionId = '77777777-7777-4777-8777-777777777777';
const otherId = '88888888-8888-4888-8888-888888888888';
const scopeInput = {
  controllerRef,
  partyId,
  purposeId,
  purposeMeaning: 'Voluntary email newsletter',
  purposeVersionId,
  tenantId,
};
const scope = customerNewsletterScope(scopeInput);
const receipt = Schema.decodeUnknownSync(CustomerConsentReceiptSchema)({
  acknowledgedAt: '2026-10-23T12:00:00.000Z',
  decision: 'GRANTED',
  noticeVersionId,
  partyId,
  providedLanguage: 'cs',
  providerSubjectId: 'real-provider-subject-reference',
  requestId,
  scope,
  sessionRef: 'commerce-session-reference',
});
const request = Schema.decodeUnknownSync(ConsentSelfServiceRequestSchema)({
  decision: receipt.decision,
  noticeEvidenceRefs: [`commerce-notice:${requestId}`],
  path: {
    credentialRef: receipt.sessionRef,
    kind: 'OPERATION_SCOPED',
    operation: 'CONSENT_WRITE',
    operationRef: requestId,
    requestRef: requestId,
    scopeRef: scope.scopeRef,
    subjectRef: scope.privacySubjectRef,
  },
  scope,
});

it('keeps a stable subject-specific newsletter scope across immutable purpose versions', () => {
  const revised = customerNewsletterScope({ ...scopeInput, purposeVersionId: otherId });
  expect(scope.scopeRef).toBe(`retail-email:${controllerRef}:${partyId}:${purposeId}`);
  expect(revised.scopeRef).toBe(scope.scopeRef);
  expect(sameCustomerConsentScope(scope, revised)).toBe(false);
  expect(scope.materialDimensions).toEqual([{ kind: 'COMMUNICATION_CHANNEL', value: 'EMAIL' }]);
  for (const change of [{ partyId: otherId }, { controllerRef: otherId }, { purposeId: otherId }]) {
    expect(customerNewsletterScope({ ...scopeInput, ...change }).scopeRef).not.toBe(scope.scopeRef);
  }
});

it('binds consent authority to every exact invocation and receipt field', () => {
  const matches = (candidate: ConsentSelfServiceRequest) =>
    matchesCustomerConsentReceipt(receipt.sessionRef, candidate, receipt);
  expect(matches(request)).toBe(true);
  expect(matchesCustomerConsentReceipt('another-session', request, receipt)).toBe(false);
  expect(request.path.kind).toBe('OPERATION_SCOPED');
  if (request.path.kind !== 'OPERATION_SCOPED') {
    throw new Error('Unexpected schema result');
  }
  for (const change of [
    { credentialRef: 'another-session' },
    { requestRef: otherId },
    { operationRef: otherId },
    { scopeRef: 'another-scope' },
    { operation: 'CONSENT_WITHDRAW' as const },
    { subjectRef: { ...scope.privacySubjectRef, resourceId: `retail-party:${otherId}` } },
    { subjectRef: { ...scope.privacySubjectRef, tenantId: otherId } },
  ]) {
    expect(matches({ ...request, path: { ...request.path, ...change } })).toBe(false);
  }
  for (const change of [
    { decision: 'WITHDRAWN' as const },
    { noticeEvidenceRefs: [] },
    { noticeEvidenceRefs: [`commerce-notice:${otherId}`] },
    { noticeEvidenceRefs: [`commerce-notice:${requestId}`, 'additional-proof'] },
    { scope: { ...scope, controllerRef: otherId } },
    { scope: { ...scope, purposeVersionRef: otherId } },
    { scope: { ...scope, purposeMeaning: 'Different purpose' } },
    { scope: { ...scope, privacySubjectRef: { ...scope.privacySubjectRef, tenantId: otherId } } },
    {
      scope: {
        ...scope,
        materialDimensions: [
          { kind: 'COMMUNICATION_CHANNEL' as const, value: 'EMAIL' as const },
          { kind: 'COMMUNICATION_CHANNEL' as const, value: 'EMAIL' as const },
        ],
      },
    },
  ]) {
    expect(matches({ ...request, ...change })).toBe(false);
  }
});

it('requires the withdrawal operation for a withdrawn receipt', () => {
  const withdrawn = { ...receipt, decision: 'WITHDRAWN' as const };
  expect(matchesCustomerConsentReceipt(receipt.sessionRef, request, withdrawn)).toBe(false);
  if (request.path.kind !== 'OPERATION_SCOPED') {
    throw new Error('Unexpected schema result');
  }
  expect(
    matchesCustomerConsentReceipt(
      receipt.sessionRef,
      { ...request, decision: 'WITHDRAWN', path: { ...request.path, operation: 'CONSENT_WITHDRAW' } },
      withdrawn,
    ),
  ).toBe(true);
});

it('projects native notice proof only from the durable interactive acknowledgement', () => {
  const provision = noticeProvisionRequest(receipt);
  expect(Result.isSuccess(Schema.decodeUnknownResult(RecordNoticeProvisionPayloadSchema)(provision))).toBe(true);
  expect(provision).toEqual({
    actionRef: null,
    anonymousContextRef: null,
    businessInteractionRef: requestId,
    channel: 'COMMERCE_PORTAL',
    claimRef: requestId,
    controllerRef,
    noticeVersionRef: noticeVersionId,
    privacySubjectRef: scope.privacySubjectRef.resourceId,
    processingPurposeRef: purposeId,
    processingScopeRef: scope.scopeRef,
    providedLanguage: 'cs',
  });
});

it('rejects browser authority, missing acknowledgement and invented consent choices', () => {
  const input = { decision: 'GRANTED', noticeAcknowledged: true, noticeVersionId, purposeVersionId, requestId };
  const decode = Schema.decodeUnknownResult(UpdateCustomerOwnConsentSchema, { onExcessProperty: 'error' });
  expect(Result.isSuccess(decode(input))).toBe(true);
  for (const key of [
    'partyId',
    'tenantId',
    'scope',
    'actor',
    'sessionRef',
    'providerSubjectId',
    'proof',
    'credentialRef',
  ]) {
    expect(Result.isFailure(decode({ ...input, [key]: 'forged' }))).toBe(true);
  }
  for (const change of [
    { noticeAcknowledged: false },
    { decision: 'ABSENT' },
    { decision: 'REFUSED' },
    { noticeVersionId: '' },
    { purposeVersionId: 'not-a-version' },
    { requestId: 'not-an-id' },
  ]) {
    expect(Result.isFailure(decode({ ...input, ...change }))).toBe(true);
  }
});

it('uses the Privacy-owned UUID contract while keeping Party identity a typed external reference', () => {
  const partyRef = {
    moduleId: 'party.registry',
    resourceId: partyId,
    resourceType: 'party.registry.party',
    tenantId,
  } as const;
  const expected = privacySubjectRefForParty(partyRef);
  expect(scope.privacySubjectRef).toEqual(expected);
  expect(scope.privacySubjectRef.resourceId).not.toBe(partyId);
  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(CreatePrivacySubjectPayloadSchema)({
        subject: { kind: 'DATA_SUBJECT', partyRef },
        subjectRef: scope.privacySubjectRef,
      }),
    ),
  ).toBe(true);
  expect(customerNewsletterScope({ ...scopeInput, tenantId: otherId }).privacySubjectRef).not.toEqual(expected);
  expect(customerNewsletterScope({ ...scopeInput, partyId: otherId }).privacySubjectRef).not.toEqual(expected);
});

const customerScope = {
  compositionRevision: 'a'.repeat(64),
  legalEntityId: controllerRef,
  partyId,
  requestCorrelation: requestId,
  tenantId,
};
const customerNotice = Schema.decodeUnknownSync(PrivacyNoticeVersionSchema)({
  applicableScope: {
    facts: [
      { dimension: 'PRIVACY_SUBJECT', value: scope.privacySubjectRef.resourceId },
      { dimension: 'CONTROLLER_SCOPE', value: controllerRef },
      { dimension: 'PROCESSING_PURPOSE', value: purposeId },
      { dimension: 'PROCESSING_PURPOSE_VERSION', value: purposeVersionId },
      { dimension: 'CHANNEL', value: 'EMAIL' },
    ],
    operation: 'NEWSLETTER_CONSENT',
    processingScopeRef: { scopeId: scope.scopeRef, scopeType: 'privacy.processing-scope' },
  },
  contentIdentity: 'sha256:newsletter-cs-v1',
  effectiveFrom: '2026-10-01T00:00:00.000Z',
  effectiveTo: null,
  evidenceArtifactRef: 'privacy:newsletter-cs-v1',
  language: 'cs',
  noticeRef: {
    moduleId: 'privacy.core',
    resourceId: partyId,
    resourceType: 'privacy.core.privacy-notice-version',
    tenantId,
  },
  recordedAt: '2026-10-24T00:00:00.000Z',
  versionId: noticeVersionId,
  versionNumber: 1,
  wording: 'Souhlasím se zasíláním novinek e-mailem. Souhlas mohu kdykoli odvolat.',
});
const catalog: CustomerNewsletterCatalog = {
  configured: {
    actorPrincipalId: otherId,
    controllerRef,
    noticeId: otherId,
    noticeVersionId: otherId,
    purposeId,
    purposeVersionId,
  },
  consentScope: scope,
  template: {
    ...customerNotice,
    noticeRef: { ...customerNotice.noticeRef, resourceId: otherId },
    versionId: otherId,
  },
};

it.effect('reuses the same exact native notice on repeated reads instead of requiring another create', () =>
  Effect.gen(function* retainedNotice() {
    expect(yield* selectCustomerNewsletterNotice(customerScope, catalog, [])).toBeUndefined();
    for (let read = 0; read < 3; read += 1) {
      expect(yield* selectCustomerNewsletterNotice(customerScope, catalog, [customerNotice])).toBe(customerNotice);
    }
    // Retained older versions and the template collection are not the customer's current notice.
    const older = { ...customerNotice, contentIdentity: 'sha256:old', versionId: requestId };
    expect(
      yield* selectCustomerNewsletterNotice(customerScope, catalog, [older, catalog.template, customerNotice]),
    ).toBe(customerNotice);
  }),
);

it.effect('rejects ambiguous owner versions instead of choosing one or creating another', () =>
  Effect.gen(function* ambiguousNotice() {
    const failure = yield* Effect.flip(
      selectCustomerNewsletterNotice(customerScope, catalog, [
        customerNotice,
        { ...customerNotice, versionId: requestId, versionNumber: 2 },
      ]),
    );
    expect(Schema.is(ConsentConflictProblemSchema)(failure)).toBe(true);
  }),
);

it.effect('never reuses notices with different identity, content, period or exact consent scope', () =>
  Effect.gen(function* exactNoticeIdentity() {
    const changedNotices: readonly PrivacyNoticeVersion[] = [
      { ...customerNotice, noticeRef: { ...customerNotice.noticeRef, tenantId: otherId } },
      { ...customerNotice, noticeRef: { ...customerNotice.noticeRef, resourceId: otherId } },
      { ...customerNotice, wording: 'Jiné znění' },
      { ...customerNotice, contentIdentity: 'sha256:other' },
      { ...customerNotice, language: 'en' },
      { ...customerNotice, evidenceArtifactRef: 'other-evidence' },
      { ...customerNotice, effectiveFrom: '2026-10-02T00:00:00.000Z' },
      { ...customerNotice, effectiveTo: '2026-11-01T00:00:00.000Z' },
      { ...customerNotice, applicableScope: { ...customerNotice.applicableScope, operation: 'OTHER_OPERATION' } },
      {
        ...customerNotice,
        applicableScope: {
          ...customerNotice.applicableScope,
          processingScopeRef: { scopeId: 'other-scope', scopeType: 'privacy.processing-scope' },
        },
      },
      ...customerNotice.applicableScope.facts.map((fact) => ({
        ...customerNotice,
        applicableScope: {
          ...customerNotice.applicableScope,
          facts: customerNotice.applicableScope.facts.map((current) =>
            current.dimension === fact.dimension ? { ...current, value: 'other-value' } : current,
          ),
        },
      })),
      {
        ...customerNotice,
        applicableScope: {
          ...customerNotice.applicableScope,
          facts: [...customerNotice.applicableScope.facts, { dimension: 'CHANNEL', value: 'SMS' }],
        },
      },
    ];
    for (const changed of changedNotices) {
      expect(yield* selectCustomerNewsletterNotice(customerScope, catalog, [changed])).toBeUndefined();
    }
    expect(
      yield* selectCustomerNewsletterNotice(customerScope, catalog, [
        {
          ...customerNotice,
          applicableScope: {
            ...customerNotice.applicableScope,
            facts: Arr.reverse(customerNotice.applicableScope.facts),
          },
        },
      ]),
    ).toEqual({
      ...customerNotice,
      applicableScope: {
        ...customerNotice.applicableScope,
        facts: Arr.reverse(customerNotice.applicableScope.facts),
      },
    });
  }),
);
