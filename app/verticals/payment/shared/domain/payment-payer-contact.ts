import { Match, Option, Schema } from 'effect';

import type { PaymentGatewayProviderFamilySchema } from './payment-vocabulary.ts';

const contactText = (maximumLength: number) =>
  Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(maximumLength));

/**
 * Caller-supplied payer contact for the one COLLECT of a Payment (plan D-P3). It is not operation
 * material: it is never part of the material hash, Reads, views, events or the Outbox message, and it
 * is kept only until the dispatch that uses it is prepared.
 */
export const PaymentPayerContactSchema = Schema.Struct({
  email: Schema.optionalKey(contactText(254)),
  fullName: Schema.optionalKey(contactText(200)),
  phone: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^\+[1-9][0-9]{7,14}$/u))),
});
export type PaymentPayerContact = typeof PaymentPayerContactSchema.Type;

export const PAYER_CONTACT_PROBLEM_CODES = [
  'payment_payer_contact_required',
  'payment_payer_contact_not_applicable',
] as const;
export type PayerContactProblemCode = (typeof PAYER_CONTACT_PROBLEM_CODES)[number];

/** GoPay accepts an e-mail address of at most this length; a longer one does not satisfy the family. */
const GOPAY_EMAIL_MAXIMUM_LENGTH = 128;

type PaymentGatewayProviderFamily = typeof PaymentGatewayProviderFamilySchema.Type;

const requiredProblem = Option.some<PayerContactProblemCode>('payment_payer_contact_required');
const notApplicableProblem = Option.some<PayerContactProblemCode>('payment_payer_contact_not_applicable');

const textLength = (value: string | undefined): number => value?.length ?? 0;

/**
 * The payer contact problem, if any, for a COLLECT on a binding of `family`:
 * - COMGATE requires `fullName` and at least one of `email` or `phone`; all three fields are allowed.
 * - GOPAY requires `email` (at most 128 characters) and accepts nothing else.
 * - STRIPE accepts no contact at all.
 * A missing contact where one is required is `payment_payer_contact_required`; a field the family does
 * not use, or any contact for STRIPE, is `payment_payer_contact_not_applicable`. A contact that is
 * present for a family that requires it but does not satisfy its rules is `payment_payer_contact_required`.
 */
export const payerContactProblemFor = (
  family: PaymentGatewayProviderFamily,
  contact: Option.Option<PaymentPayerContact>,
): Option.Option<PayerContactProblemCode> =>
  Match.value(family).pipe(
    Match.when('COMGATE', () =>
      Option.match(contact, {
        onNone: () => requiredProblem,
        onSome: (given) =>
          textLength(given.fullName) > 0 && (textLength(given.email) > 0 || textLength(given.phone) > 0)
            ? Option.none()
            : requiredProblem,
      }),
    ),
    Match.when('GOPAY', () =>
      Option.match(contact, {
        onNone: () => requiredProblem,
        onSome: (given) => {
          if (textLength(given.fullName) > 0 || textLength(given.phone) > 0) {
            return notApplicableProblem;
          }
          const emailLength = textLength(given.email);
          return emailLength > 0 && emailLength <= GOPAY_EMAIL_MAXIMUM_LENGTH ? Option.none() : requiredProblem;
        },
      }),
    ),
    Match.when('STRIPE', () => (Option.isSome(contact) ? notApplicableProblem : Option.none())),
    Match.exhaustive,
  );
