import { expect, it } from 'effect-rstest';
import { Option, Schema } from 'effect';
import { QuotationVerificationRequestSchema } from '@app/pricing-contracts/quotation-verification';
import {
  preapprovalQuotationScopeMatches,
  preapprovalQuotationWindowIsCurrent,
} from '../../src/services/preapproval-quotation-verification.service.ts';

const principalId = '11111111-1111-4111-8111-111111111111';
it('uses the configured issuer actor and namespace without treating the buyer as that service', () => {
  const service = {
    authenticationNamespaceId: 'service:preapproval',
    authMethod: 'api_key' as const,
    legalEntityId: '22222222-2222-4222-8222-222222222222',
    principalId,
  };
  const config = {
    namespace: service.authenticationNamespaceId,
    principalId,
  };
  expect(preapprovalQuotationScopeMatches(service, config)).toBe(true);
  expect(preapprovalQuotationScopeMatches({ ...service, principalId: 'buyer' }, config)).toBe(false);
  expect(preapprovalQuotationScopeMatches({ ...service, authenticationNamespaceId: 'foreign' }, config)).toBe(false);
  expect(preapprovalQuotationScopeMatches({ ...service, authMethod: 'session' }, config)).toBe(false);
  expect(preapprovalQuotationScopeMatches({ ...service, impersonatedByPrincipalId: 'operator' }, config)).toBe(false);
});
it('preserves the original quotation half-open window and actual issuance time', () => {
  const quote = {
    issuedAt: '2026-10-23T00:00:00.000Z',
    operationTime: '2026-10-23T00:00:00.000Z',
    validFrom: '2026-10-23T00:00:00.000Z',
    validUntil: '2026-10-23T00:05:00.000Z',
  };
  expect(preapprovalQuotationWindowIsCurrent(quote, quote.validFrom)).toBe(true);
  expect(preapprovalQuotationWindowIsCurrent(quote, quote.validUntil)).toBe(false);
  expect(preapprovalQuotationWindowIsCurrent({ ...quote, validUntil: 'malformed' }, quote.validFrom)).toBe(false);
  expect(preapprovalQuotationWindowIsCurrent(quote, '2026-10-22T23:59:59.999Z')).toBe(false);
  expect(preapprovalQuotationWindowIsCurrent({ ...quote, issuedAt: '2026-10-23T00:00:01.000Z' }, quote.validFrom)).toBe(
    false,
  );
});
it('requires an exact preapproval basis and original invocation instead of claimed money', () => {
  const input = {
    issuanceInvocationId: principalId,
    purpose: 'PRE_APPROVAL',
    sourceRef: principalId,
    sourceRevision: '1',
  };
  expect(Option.isSome(Schema.decodeUnknownOption(QuotationVerificationRequestSchema)(input))).toBe(true);
  expect(
    Option.isNone(Schema.decodeUnknownOption(QuotationVerificationRequestSchema)({ ...input, sourceRevision: '2' })),
  ).toBe(true);
  expect(
    Option.isNone(
      Schema.decodeUnknownOption(QuotationVerificationRequestSchema)({ ...input, issuanceInvocationId: '' }),
    ),
  ).toBe(true);
});
