// The issue date picker and the totals summary of the create invoice form.
import {
  DetailList,
  datePickerSegmentsClassName,
  datePickerTranslations,
  formatMoney,
  requiredLabelFor,
} from '@app/admin-ui';
import { CalendarDate as IntlCalendarDate } from '@internationalized/date';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { isPlausibleIssueDate } from '../../../../shared/domain/invoice-draft.ts';
import type { draftTotals } from '../../../../shared/domain/invoice-draft.ts';
import type { InvoiceDocumentKind } from '../../../../shared/apis/records.ts';

const ns = 'finance-billing.faktury';

/** Wraps the issue-date picker so it can be found by its id. */
export const ISSUE_DATE_FIELD_ID = 'invoice-issue-date';

/** The draft keeps the issue date as an ISO `YYYY-MM-DD` string; anything else shows an empty picker. */
const toIssueCalendarDate = (isoDate: string): IntlCalendarDate | null =>
  /^\d{4}-\d{2}-\d{2}$/u.test(isoDate)
    ? new IntlCalendarDate(Number(isoDate.slice(0, 4)), Number(isoDate.slice(5, 7)), Number(isoDate.slice(8, 10)))
    : null;

/** S07.R2: document kinds offered when a draft is created. */
export const DOCUMENT_KINDS: readonly (readonly [InvoiceDocumentKind, string])[] = [
  ['STANDARD', 'Běžná faktura'],
  ['ADVANCE', 'Zálohová faktura'],
  ['PARTIAL', 'Dílčí faktura'],
  ['FINAL', 'Konečná faktura'],
  ['RECURRING', 'Opakovaná faktura'],
];

/** An empty date is flagged after submit; a complete date with an implausible year is flagged as soon as it is typed. */
export const issueDateProblem = (issueDate: string, submitted: boolean): 'missing' | 'year' | undefined => {
  if (issueDate === '') {
    return submitted ? 'missing' : undefined;
  }
  return isPlausibleIssueDate(issueDate) ? undefined : 'year';
};

/** A sum past the money range shows a dash and an error instead of 0 Kč. */
const optionalMoney = (minor: number | undefined) => (minor === undefined ? '—' : formatMoney(minor));

/**
 * The props of a required Czech date picker bound to a date field (an issue date, a valid-from date) and its inline
 * error. The wrapper id lets a failed submit focus it. The field holds ISO `YYYY-MM-DD`, or '' while the date is
 * incomplete.
 */
export const useIssueDateProps = ({
  error,
  id = ISSUE_DATE_FIELD_ID,
  label,
}: {
  readonly error: string | undefined;
  readonly id?: string;
  readonly label: string;
}) => {
  const { language } = useModernI18n();
  const props = {
    className: 'flex flex-col gap-50',
    contentClassName: 'z-(--z-popup) bg-(--color-popup-bg)',
    id,
    label,
    locale: 'cs-CZ',
    name: 'issueDate',
    required: true,
    requiredLabel: requiredLabelFor(language),
    segmentsClassName: datePickerSegmentsClassName,
    size: 'md',
    toDateValue: toIssueCalendarDate,
    translations: datePickerTranslations,
  } as const;
  return error === undefined ? props : { ...props, error };
};

interface DraftTotalsSummaryProps {
  /** Undefined when the sum passes the money range. */
  readonly totals: ReturnType<typeof draftTotals>;
  readonly zeroPriceWarning: boolean;
}

/** Subtotal, VAT and total of the valid lines, with the out-of-range and 0 Kč messages under them. */
export const DraftTotalsSummary = ({ totals, zeroPriceWarning }: DraftTotalsSummaryProps) => {
  const { t } = useModernI18n();
  return (
    <>
      <DetailList
        items={[
          {
            label: t(`${ns}.subtotal`),
            value: <span className="tabular-nums">{optionalMoney(totals?.subtotalMinor)}</span>,
          },
          {
            label: t(`${ns}.vatTotal`),
            value: <span className="tabular-nums">{optionalMoney(totals?.vatMinor)}</span>,
          },
          {
            label: t(`${ns}.total`),
            value: <span className="font-semibold tabular-nums">{optionalMoney(totals?.totalMinor)}</span>,
          },
        ]}
      />
      {totals === undefined && (
        <StatusText showIcon size="sm" status="error">
          {t(`${ns}.form.errorTotal`)}
        </StatusText>
      )}
      {zeroPriceWarning && (
        <StatusText showIcon size="sm" status="warning">
          {t(`${ns}.form.zeroPriceConfirm`)}
        </StatusText>
      )}
    </>
  );
};
