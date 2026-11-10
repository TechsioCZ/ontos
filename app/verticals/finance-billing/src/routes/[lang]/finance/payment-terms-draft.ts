// Agreed skonto and late-payment interest of one invoice, as the payment terms dialog saves them on Uložit.
import { Option } from 'effect';
import type { Invoice } from '../../../../shared/apis/records.ts';
import { minorToInput, parseAmountMinor } from './finance-ui.tsx';
import type { FinanceCommandDraft } from './finance-ui.tsx';

export interface PaymentTermsDraft {
  readonly lateAmount: string;
  readonly lateText: string;
  readonly skontoAmount: string;
  readonly skontoText: string;
}

export const paymentTermsDraftOf = (invoice: Invoice): PaymentTermsDraft => ({
  lateAmount: minorToInput(invoice.paymentTerms?.lateInterestApprovedMinor),
  lateText: invoice.paymentTerms?.lateInterestText ?? '',
  skontoAmount: minorToInput(invoice.paymentTerms?.skontoApprovedMinor),
  skontoText: invoice.paymentTerms?.skontoText ?? '',
});

/** Drafts that store the same terms: surrounding spaces do not count. */
export const samePaymentTermsDraft = (left: PaymentTermsDraft, right: PaymentTermsDraft): boolean =>
  left.lateAmount.trim() === right.lateAmount.trim() &&
  left.lateText.trim() === right.lateText.trim() &&
  left.skontoAmount.trim() === right.skontoAmount.trim() &&
  left.skontoText.trim() === right.skontoText.trim();

const optionalAmount = (raw: string) => (raw.trim() === '' ? undefined : parseAmountMinor(raw));

export interface PaymentTermsProblems {
  readonly lateAmount: boolean;
  /** A hand-approved interest amount needs its agreed condition as text. */
  readonly lateText: boolean;
  readonly skontoAmount: boolean;
  readonly skontoText: boolean;
}

export const paymentTermsProblems = (draft: PaymentTermsDraft): PaymentTermsProblems => {
  const skonto = optionalAmount(draft.skontoAmount);
  const late = optionalAmount(draft.lateAmount);
  return {
    lateAmount: draft.lateAmount.trim() !== '' && late === undefined,
    lateText: late !== undefined && draft.lateText.trim() === '',
    skontoAmount: draft.skontoAmount.trim() !== '' && skonto === undefined,
    skontoText: skonto !== undefined && draft.skontoText.trim() === '',
  };
};

/** The command a draft sends; None while a field is invalid. Empty fields are not stored. */
export const paymentTermsCommandOf = (
  invoice: Invoice,
  draft: PaymentTermsDraft,
  actorLabel?: string,
): Option.Option<FinanceCommandDraft<'SetPaymentTerms'>> => {
  const problems = paymentTermsProblems(draft);
  if (problems.lateAmount || problems.lateText || problems.skontoAmount || problems.skontoText) {
    return Option.none();
  }
  const command: FinanceCommandDraft<'SetPaymentTerms'> = { _tag: 'SetPaymentTerms', invoiceRef: invoice.ref };
  const skonto = optionalAmount(draft.skontoAmount);
  const late = optionalAmount(draft.lateAmount);
  if (actorLabel !== undefined) {
    command.actorLabel = actorLabel;
  }
  if (late !== undefined) {
    command.lateInterestApprovedMinor = late;
  }
  if (draft.lateText.trim() !== '') {
    command.lateInterestText = draft.lateText.trim();
  }
  if (skonto !== undefined) {
    command.skontoApprovedMinor = skonto;
  }
  if (draft.skontoText.trim() !== '') {
    command.skontoText = draft.skontoText.trim();
  }
  return Option.some(command);
};

/** Whether the ledger still holds the invoice's terms as the draft's base version. */
export const paymentTermsUnchangedSince =
  (resourceId: string, base: PaymentTermsDraft) =>
  (invoices: readonly Invoice[]): boolean => {
    const current = invoices.find((invoice) => invoice.ref.resourceId === resourceId);
    return current !== undefined && samePaymentTermsDraft(paymentTermsDraftOf(current), base);
  };
