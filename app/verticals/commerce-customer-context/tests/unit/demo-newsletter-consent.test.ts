import { Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  CustomerOwnConsentSchema,
  DEMO_NEWSLETTER_NOTICE,
  UpdateCustomerOwnConsentSchema,
} from '../../shared/portal-auth/consent-api.ts';

const grant = {
  decision: 'GRANTED',
  expectedRevision: 0,
  noticeAcknowledged: true,
  noticeVersionId: 'demo-newsletter.cs.v1',
  requestId: '33333333-3333-4333-8333-333333333333',
};

it('accepts an explicit demo choice without invented Privacy purpose or notice UUIDs', () => {
  expect(Result.isSuccess(Schema.decodeUnknownResult(UpdateCustomerOwnConsentSchema)(grant))).toBe(true);
  expect(DEMO_NEWSLETTER_NOTICE.noticeVersionId).toBe('demo-newsletter.cs.v1');
  expect(DEMO_NEWSLETTER_NOTICE.language).toBe('cs');
  expect(DEMO_NEWSLETTER_NOTICE.wording).toContain('Souhlas je dobrovolný');
});

it('requires acknowledgement for a grant, not acceptance of marketing terms to withdraw', () => {
  const decode = Schema.decodeUnknownResult(UpdateCustomerOwnConsentSchema);
  expect(Result.isFailure(decode({ ...grant, noticeAcknowledged: false }))).toBe(true);
  expect(
    Result.isSuccess(decode({ ...grant, decision: 'WITHDRAWN', expectedRevision: 1, noticeAcknowledged: false })),
  ).toBe(true);
});

it('requires an exact nonnegative revision and strips no authority into the owner contract', () => {
  const decode = Schema.decodeUnknownResult(UpdateCustomerOwnConsentSchema, { onExcessProperty: 'error' });
  for (const expectedRevision of [-1, 0.5, '0', undefined, Number.POSITIVE_INFINITY]) {
    expect(Result.isFailure(decode({ ...grant, expectedRevision }))).toBe(true);
  }
  for (const field of ['tenantId', 'legalEntityId', 'partyId', 'actor', 'sessionRef', 'scope', 'purposeVersionId']) {
    expect(Result.isFailure(decode({ ...grant, [field]: 'browser-selected' }))).toBe(true);
  }
});

it('requires a complete native owner projection rather than defaulting unavailable storage to no consent', () => {
  const decode = Schema.decodeUnknownResult(CustomerOwnConsentSchema);
  expect(Result.isSuccess(decode({ decision: 'ABSENT', notice: DEMO_NEWSLETTER_NOTICE, revision: 0 }))).toBe(true);
  expect(Result.isSuccess(decode({ decision: 'GRANTED', notice: DEMO_NEWSLETTER_NOTICE, revision: 1 }))).toBe(true);
  for (const value of [
    {},
    { decision: 'GRANTED', notice: DEMO_NEWSLETTER_NOTICE },
    { decision: 'GRANTED', notice: DEMO_NEWSLETTER_NOTICE, revision: -1 },
    { decision: 'REFUSED', notice: DEMO_NEWSLETTER_NOTICE, revision: 1 },
  ]) {
    expect(Result.isFailure(decode(value))).toBe(true);
  }
});
