import { describe, expect, it } from 'effect-rstest';
import { Result, Schema } from 'effect';

import { PaymentGatewayAccountBindingSchema } from '../../shared/domain/payment-execution-binding.ts';
import {
  GatewayCredentialSecretRefSchema,
  GatewayHttpsUrlSchema,
  GatewayMerchantIdentitySchema,
  GatewayProviderAccountRefSchema,
  GatewayReconciliationDebtRowSchema,
  GatewayReturnTokenSchema,
} from '../../shared/domain/psp-configuration.ts';

const accountRef = 'pab_0123456789abcdef0123456789abcdef';

describe('#1155 PSP configuration contracts', () => {
  it('#1155 Provider account ref decodes into the C16 binding ref', () => {
    const ref = Schema.decodeUnknownSync(GatewayProviderAccountRefSchema)(accountRef);
    const binding = Schema.decodeUnknownSync(PaymentGatewayAccountBindingSchema)({
      _tag: 'GATEWAY_ACCOUNT',
      environment: 'LIVE',
      providerAccountRef: ref,
      providerFamily: 'STRIPE',
    });

    expect(binding.providerAccountRef).toBe(accountRef);
    const decodeRef = Schema.decodeUnknownResult(GatewayProviderAccountRefSchema);
    expect(Result.isFailure(decodeRef('pab_XYZ'))).toBe(true);
    expect(Result.isFailure(decodeRef('acc_0123456789abcdef0123456789abcdef'))).toBe(true);
  });

  it('#1155 Merchant identity rejects a wrong family shape', () => {
    const isIdentity = Schema.is(GatewayMerchantIdentitySchema);

    expect(isIdentity({ _tag: 'GOPAY', goid: '8123456789' })).toBe(true);
    expect(isIdentity({ _tag: 'STRIPE', accountId: 'acct_1Ab2Cd3' })).toBe(true);
    expect(isIdentity({ _tag: 'COMGATE', merchantId: '123456' })).toBe(true);

    expect(isIdentity({ _tag: 'GOPAY', accountId: 'acct_1Ab2Cd3' })).toBe(false);
    expect(isIdentity({ _tag: 'STRIPE', goid: '8123456789' })).toBe(false);
    expect(isIdentity({ _tag: 'COMGATE', merchantId: 'abc' })).toBe(false);
    expect(isIdentity({ _tag: 'GOPAY', goid: '123456789012345678901' })).toBe(false);
  });

  it('#1155 An http URL is rejected while an https URL within the limit is accepted', () => {
    expect(Schema.is(GatewayHttpsUrlSchema)('https://shop.example.test/return?x=1')).toBe(true);
    expect(Schema.is(GatewayHttpsUrlSchema)('http://shop.example.test/return')).toBe(false);
    expect(Schema.is(GatewayHttpsUrlSchema)(`https://shop.example.test/${'a'.repeat(2000)}`)).toBe(false);
  });

  it('#1157 The return token pattern is bounded to 22 base64url characters', () => {
    expect(Schema.is(GatewayReturnTokenSchema)('abcdefghijKLMNOPQRST_-')).toBe(true);
    expect(Schema.is(GatewayReturnTokenSchema)('abcdefghijKLMNOPQRS')).toBe(false);
    expect(Schema.is(GatewayReturnTokenSchema)('abcdefghijKLMNOPQRSTUVW')).toBe(false);
    expect(Schema.is(GatewayReturnTokenSchema)('abcdefghijKLMNOPQRS+/=')).toBe(false);
  });

  it('#1155 The credential secret ref names material without accepting values with separators or spaces', () => {
    expect(Schema.is(GatewayCredentialSecretRefSchema)('stripe.live-key_v2')).toBe(true);
    expect(Schema.is(GatewayCredentialSecretRefSchema)('has space')).toBe(false);
    expect(Schema.is(GatewayCredentialSecretRefSchema)('')).toBe(false);
  });

  it('#1158 Reconciliation debt recommends only the two gateway recovery triggers', () => {
    const decodeRow = Schema.decodeUnknownResult(GatewayReconciliationDebtRowSchema);
    const row = {
      ledgerState: 'OUTCOME_UNKNOWN',
      operationId: '0190d6a4-5b6c-7d8e-9f01-23456789abcd',
      operationKind: 'COLLECT',
      paymentId: '0190d6a4-5b6c-7d8e-9f01-23456789abce',
      pendingEvidenceCount: 0,
      recommendedTrigger: 'EXECUTION_OUTCOME_UNKNOWN',
    };

    expect(Result.isSuccess(decodeRow(row))).toBe(true);
    expect(Result.isSuccess(decodeRow({ ...row, recommendedTrigger: 'OUTCOME_OVERDUE' }))).toBe(true);
    expect(Result.isFailure(decodeRow({ ...row, recommendedTrigger: 'OPERATOR_REQUEST' }))).toBe(true);
    // A resolved operation's still pending evidence needs a person: no trigger at all.
    const resolved = {
      ledgerState: 'ACKNOWLEDGED',
      operationId: row.operationId,
      operationKind: row.operationKind,
      paymentId: row.paymentId,
      pendingEvidenceCount: 1,
    };
    expect(Result.isSuccess(decodeRow(resolved))).toBe(true);
    expect(Result.isFailure(decodeRow({ ...row, pendingEvidenceCount: -1 }))).toBe(true);
  });
});
