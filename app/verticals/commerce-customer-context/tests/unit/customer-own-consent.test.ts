import { ConsentSelfServiceRequestSchema, RecordNoticeProvisionPayloadSchema } from '@app/consent-authority-contracts';
import type { ConsentSelfServiceRequest } from '@app/consent-authority-contracts';
import { Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  CustomerConsentReceiptSchema,
  customerNewsletterScope,
  matchesCustomerConsentReceipt,
  noticeProvisionRequest,
  sameCustomerConsentScope,
} from '../../api/portal-auth/consent/model.ts';
import { UpdateCustomerOwnConsentSchema } from '../../shared/portal-auth/consent-api.ts';

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
    privacySubjectRef: `retail-party:${partyId}`,
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
