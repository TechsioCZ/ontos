import type { useModernI18n } from '@modern-js/plugin-i18n/runtime';

type Translate = ReturnType<typeof useModernI18n>['t'];

/**
 * Whole-number inputs (quantities, thresholds, percent). The format allows decimals on purpose: with
 * `maximumFractionDigits: 0` the kit drops the cs-CZ decimal comma, so "2,5" silently becomes 25. Here "2,5"
 * reads as 2.5 and the field's whole-number check refuses it. Pair it with a string `value` (the text as typed)
 * and keep the number from `valueAsNumber`: a numeric value is re-formatted on every keystroke, which eats a
 * trailing comma and prints "NaN" for an emptied field.
 */
export const WHOLE_NUMBER_FORMAT: Intl.NumberFormatOptions = { maximumFractionDigits: 2 };

/**
 * Kč amounts show two decimals, so a stored 490.50 reads back as 490,50 and not 490,5. Pair it with a string
 * `value` (see moneyInputText): a numeric value is re-formatted on every keystroke and appends ",00" while typing.
 */
export const MONEY_FORMAT: Intl.NumberFormatOptions = { maximumFractionDigits: 2, minimumFractionDigits: 2 };

const moneyInputFormatter = new Intl.NumberFormat('cs-CZ', MONEY_FORMAT);

/** Initial text of a Kč input: 490.5 becomes "490,50". Later keystrokes keep the text the user typed. */
export const moneyInputText = (amount: number): string => moneyInputFormatter.format(amount);

/**
 * Zag fills a missing max with Number.MAX_SAFE_INTEGER and announces it as aria-valuemax. Spread on
 * `NumericInput.Input` of a field whose domain has no upper bound, so no fake range reaches assistive tech.
 */
// oxlint-disable-next-line sonarjs/no-undefined-assignment -- Only an explicit undefined overrides the zag prop spread before it; React's aria types reject null.
export const NO_ARIA_MAX = { 'aria-valuemax': undefined } as const;

/** DataTable pagination labels from the vertical locale, so no kit English default reaches assistive tech. */
export const paginationProps = (t: Translate) => ({
  translations: {
    firstTriggerLabel: t('merchandise.pagination.first'),
    itemLabel: ({ page }: { readonly page: number }) => t('merchandise.pagination.page', { page }),
    lastTriggerLabel: t('merchandise.pagination.last'),
    nextTriggerLabel: t('merchandise.pagination.next'),
    prevTriggerLabel: t('merchandise.pagination.previous'),
    rootLabel: t('merchandise.pagination.root'),
  },
});
