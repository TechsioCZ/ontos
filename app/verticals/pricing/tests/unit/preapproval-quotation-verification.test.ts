import {
  ReadHandlerUnavailable,
  TrustedPrincipalContextSchema,
  trustVerifiedGatewayPrincipalContext,
} from '@app/core-runtime';
import { Effect, Option, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { QuotationVerificationRequestSchema } from '@app/pricing-contracts/quotation-verification';
import {
  validatePreapprovalQuotationReader,
  preapprovalIssuerPrincipalIdFor,
  preapprovalQuotationActorMatches,
  preapprovalQuotationWindowIsCurrent,
} from '../../src/services/preapproval-quotation-verification.service.ts';

const principalId = '11111111-1111-4111-8111-111111111111';
it('admits only the Customer Context preproposal caller as the actor', () => {
  expect(preapprovalQuotationActorMatches({ appId: 'commerce-customer-context' })).toBe(true);
  expect(preapprovalQuotationActorMatches({ appId: 'commerce-order' })).toBe(false);
  expect(preapprovalQuotationActorMatches({ appId: 'commerce-customer-context-other' })).toBe(false);
  expect(preapprovalQuotationActorMatches()).toBe(false);
});
it('records the verified subject, which is the buyer, as the preapproval issuer', () => {
  expect(Option.getOrUndefined(preapprovalIssuerPrincipalIdFor(principalId, principalId))).toBe(principalId);
});
it('denies a preapproval issuer when the buyer is not the subject of the call', () => {
  expect(Option.isNone(preapprovalIssuerPrincipalIdFor('22222222-2222-4222-8222-222222222222', principalId))).toBe(
    true,
  );
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

it.effect('requires the exact verified caller provenance and preserves the subject identity', () =>
  Effect.gen(function* verifiedReader() {
    const subject = {
      ...(yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
        authBindingId: '33333333-3333-4333-8333-333333333333',
        authContextRef: 'session:preapproval-reader',
        authMethod: 'session',
        legalEntityId: '44444444-4444-4444-8444-444444444444',
        principalId,
        tenantId: '55555555-5555-4555-8555-555555555555',
      })),
      correlationId: 'preapproval-reader',
    };
    const assertion = { assertion: Redacted.make('verified-preapproval-test-assertion'), audience: 'pricing' };
    const actor = {
      appId: 'commerce-customer-context',
      buildMarker: 'ccc-preapproval-test',
      principalId: '66666666-6666-4666-8666-666666666666',
    };
    const trusted = trustVerifiedGatewayPrincipalContext(subject, 'a'.repeat(64), assertion, actor);
    yield* validatePreapprovalQuotationReader(trusted);
    expect(trusted.principalId).toBe(principalId);
    for (const refused of [
      { ...trusted },
      trustVerifiedGatewayPrincipalContext({ ...subject }, 'a'.repeat(64), assertion),
      trustVerifiedGatewayPrincipalContext({ ...subject }, 'a'.repeat(64), assertion, {
        ...actor,
        appId: 'commerce-order',
      }),
    ]) {
      const failure = yield* validatePreapprovalQuotationReader(refused).pipe(Effect.flip);
      expect(Schema.is(ReadHandlerUnavailable)(failure)).toBe(true);
    }
  }),
);
