import { PaymentTermCompatibilityIdSchema } from '../../shared/domain/payment-term.ts';
import type { PaymentTermDefinition, PaymentTermSemantics } from '../../shared/domain/payment-term.ts';

export const canonicalPaymentTermSemantics = (semantics: PaymentTermSemantics): string =>
  semantics.kind === 'IMMEDIATE'
    ? `IMMEDIATE/NONE/${semantics.calculationRuleVersion}`
    : `NET_DAYS/${semantics.days}/${semantics.dueDateAnchor}/${semantics.calendarRule}/${semantics.calculationRuleVersion}`;

export const paymentTermCompatibilityId = (
  semantics: PaymentTermSemantics,
): typeof PaymentTermCompatibilityIdSchema.Type => {
  if (semantics.kind === 'IMMEDIATE') {
    return PaymentTermCompatibilityIdSchema.make(`immediate.v${semantics.calculationRuleVersion}`);
  }
  return PaymentTermCompatibilityIdSchema.make(
    semantics.calculationRuleVersion === 2
      ? 'net_days.invoice_issue_date.calendar_days.v2'
      : 'net_days.invoice_issued_at.calendar_days_utc.v1',
  );
};

export const paymentTermIsCurrentAt = (
  definition: Pick<PaymentTermDefinition, 'lifecycle'>,
  instant: string,
): boolean =>
  definition.lifecycle.effectiveFrom <= instant &&
  (definition.lifecycle.effectiveTo === null || instant < definition.lifecycle.effectiveTo);

export const paymentTermSemanticsAreEquivalent = (left: PaymentTermSemantics, right: PaymentTermSemantics): boolean =>
  canonicalPaymentTermSemantics(left) === canonicalPaymentTermSemantics(right);
