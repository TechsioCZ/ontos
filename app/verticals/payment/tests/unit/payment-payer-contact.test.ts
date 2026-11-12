import { describe, expect, it } from 'effect-rstest';
import { Option, Result, Schema } from 'effect';

import { PaymentPayerContactSchema, payerContactProblemFor } from '../../shared/domain/payment-payer-contact.ts';
import { toGatewayPayerContact } from '../../src/integrations/psp/psp-request.ts';

const decodeContact = Schema.decodeUnknownResult(PaymentPayerContactSchema);
const fullContact = { email: 'payer@example.test', fullName: 'Test Payer', phone: '+420123456789' };

describe('#1153 operation-specific payer contact dependency', () => {
  it('#1153 Stripe needs no contact and rejects any contact', () => {
    expect(payerContactProblemFor('STRIPE', Option.none())).toEqual(Option.none());
    expect(payerContactProblemFor('STRIPE', Option.some({ email: 'payer@example.test' }))).toEqual(
      Option.some('payment_payer_contact_not_applicable'),
    );
    expect(payerContactProblemFor('STRIPE', Option.some({}))).toEqual(
      Option.some('payment_payer_contact_not_applicable'),
    );
  });

  it('#1153 GoPay needs only an email', () => {
    expect(payerContactProblemFor('GOPAY', Option.some({ email: 'payer@example.test' }))).toEqual(Option.none());
    expect(payerContactProblemFor('GOPAY', Option.none())).toEqual(Option.some('payment_payer_contact_required'));
    expect(payerContactProblemFor('GOPAY', Option.some({ phone: '+420123456789' }))).toEqual(
      Option.some('payment_payer_contact_not_applicable'),
    );
    expect(payerContactProblemFor('GOPAY', Option.some({}))).toEqual(Option.some('payment_payer_contact_required'));
    expect(payerContactProblemFor('GOPAY', Option.some(fullContact))).toEqual(
      Option.some('payment_payer_contact_not_applicable'),
    );
    expect(payerContactProblemFor('GOPAY', Option.some({ fullName: 'Test Payer' }))).toEqual(
      Option.some('payment_payer_contact_not_applicable'),
    );
  });

  it('#1153 GoPay email is limited to 128 characters', () => {
    const exact = `${'a'.repeat(115)}@example.test`;
    const tooLong = `${'a'.repeat(116)}@example.test`;
    expect(exact.length).toBe(128);
    expect(payerContactProblemFor('GOPAY', Option.some({ email: exact }))).toEqual(Option.none());
    expect(payerContactProblemFor('GOPAY', Option.some({ email: tooLong }))).toEqual(
      Option.some('payment_payer_contact_required'),
    );
  });

  it('#1153 Comgate needs fullName and email or phone, and allows all three', () => {
    expect(
      payerContactProblemFor('COMGATE', Option.some({ email: 'payer@example.test', fullName: 'Test Payer' })),
    ).toEqual(Option.none());
    expect(payerContactProblemFor('COMGATE', Option.some({ fullName: 'Test Payer', phone: '+420123456789' }))).toEqual(
      Option.none(),
    );
    expect(payerContactProblemFor('COMGATE', Option.some(fullContact))).toEqual(Option.none());
    expect(payerContactProblemFor('COMGATE', Option.some({ email: 'payer@example.test' }))).toEqual(
      Option.some('payment_payer_contact_required'),
    );
    expect(payerContactProblemFor('COMGATE', Option.some({ fullName: 'Test Payer' }))).toEqual(
      Option.some('payment_payer_contact_required'),
    );
    expect(payerContactProblemFor('COMGATE', Option.none())).toEqual(Option.some('payment_payer_contact_required'));
  });
});

describe('#1154 Comgate create needs the payer contact', () => {
  it('#1154 Comgate without a contact is refused as required', () => {
    expect(payerContactProblemFor('COMGATE', Option.none())).toEqual(Option.some('payment_payer_contact_required'));
  });

  it('#1154 Converted contact carries only the supplied fields', () => {
    expect(toGatewayPayerContact({ email: 'payer@example.test', fullName: 'Test Payer' })).toEqual({
      email: Option.some('payer@example.test'),
      fullName: Option.some('Test Payer'),
      phone: Option.none(),
    });
  });
});

describe('#1154 payer contact field bounds', () => {
  it('#1154 Phone must be E.164-like and rejects invalid lengths', () => {
    expect(Result.isSuccess(decodeContact({ phone: '+420123456789' }))).toBe(true);
    expect(Result.isFailure(decodeContact({ phone: '420123456789' }))).toBe(true);
    expect(Result.isFailure(decodeContact({ phone: '+0123456789' }))).toBe(true);
    expect(Result.isFailure(decodeContact({ phone: '+1234567' }))).toBe(true);
    expect(Result.isFailure(decodeContact({ phone: `+1${'2'.repeat(15)}` }))).toBe(true);
  });

  it('#1154 Email is trimmed and limited to 254 characters', () => {
    expect(Result.isSuccess(decodeContact({ email: 'payer@example.test' }))).toBe(true);
    expect(Result.isFailure(decodeContact({ email: ' payer@example.test' }))).toBe(true);
    expect(Result.isFailure(decodeContact({ email: '' }))).toBe(true);
    expect(Result.isSuccess(decodeContact({ email: `${'a'.repeat(241)}@example.test` }))).toBe(true);
    expect(Result.isFailure(decodeContact({ email: `${'a'.repeat(242)}@example.test` }))).toBe(true);
  });

  it('#1154 Full name is trimmed and limited to 200 characters', () => {
    expect(Result.isSuccess(decodeContact({ fullName: 'Test Payer' }))).toBe(true);
    expect(Result.isFailure(decodeContact({ fullName: 'Test Payer ' }))).toBe(true);
    expect(Result.isFailure(decodeContact({ fullName: 'n'.repeat(201) }))).toBe(true);
  });
});
