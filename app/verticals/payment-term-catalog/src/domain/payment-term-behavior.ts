import { DateTime } from 'effect';

import { PaymentTermCompatibilityIdSchema } from '../../shared/domain/payment-term.ts';
import type {
  PaymentTermDefinition,
  PaymentTermDueDateInput,
  PaymentTermDueDateResult,
  PaymentTermSemantics,
} from '../../shared/domain/payment-term.ts';

export const canonicalPaymentTermSemantics = (semantics: PaymentTermSemantics): string =>
  semantics.kind === 'IMMEDIATE'
    ? 'IMMEDIATE/NONE/1'
    : `NET_DAYS/${semantics.days}/${semantics.dueDateAnchor}/${semantics.calendarRule}/${semantics.calculationRuleVersion}`;

export const paymentTermCompatibilityId = (
  semantics: PaymentTermSemantics,
): typeof PaymentTermCompatibilityIdSchema.Type =>
  PaymentTermCompatibilityIdSchema.make(
    semantics.kind === 'IMMEDIATE' ? 'immediate.v1' : 'net_days.invoice_issued_at.calendar_days_utc.v1',
  );

export const paymentTermIsCurrentAt = (
  definition: Pick<PaymentTermDefinition, 'lifecycle'>,
  instant: string,
): boolean =>
  definition.lifecycle.effectiveFrom <= instant &&
  (definition.lifecycle.effectiveTo === null || instant < definition.lifecycle.effectiveTo);

const maximumJavascriptInstant = 8_640_000_000_000_000n;
const millisecondsPerDay = 86_400_000n;

const addUtcCalendarDays = (instant: string, days: number): PaymentTermDueDateResult => {
  const dueMilliseconds =
    BigInt(DateTime.toEpochMillis(DateTime.makeUnsafe(instant))) + BigInt(days) * millisecondsPerDay;
  if (dueMilliseconds > maximumJavascriptInstant || dueMilliseconds < -maximumJavascriptInstant) {
    return { kind: 'OUT_OF_RANGE', reason: 'DUE_DATE_OUTSIDE_SUPPORTED_INSTANT_RANGE' };
  }
  return {
    dueAt: DateTime.formatIso(DateTime.makeUnsafe(Number(dueMilliseconds))),
    kind: 'CALCULATED',
  };
};

export const calculatePaymentTermDueDate = (
  semantics: PaymentTermSemantics,
  input: PaymentTermDueDateInput,
): PaymentTermDueDateResult => {
  if (semantics.kind === 'IMMEDIATE') {
    return { dueAt: input.acceptedAt, kind: 'CALCULATED' };
  }
  if (input.invoiceIssuedAt === undefined) {
    return { anchor: 'INVOICE_ISSUED_AT', kind: 'MISSING_ANCHOR' };
  }
  return addUtcCalendarDays(input.invoiceIssuedAt, semantics.days);
};

export const paymentTermSemanticsAreEquivalent = (left: PaymentTermSemantics, right: PaymentTermSemantics): boolean =>
  canonicalPaymentTermSemantics(left) === canonicalPaymentTermSemantics(right);
