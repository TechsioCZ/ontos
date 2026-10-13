import type { useModernI18n } from '@modern-js/plugin-i18n/runtime';

type Translate = ReturnType<typeof useModernI18n>['t'];

/**
 * Whole-number inputs (quantities, thresholds, percent). With format options the kit parses the
 * cs-CZ text and refuses a decimal comma while typing; without them it falls back to parseFloat,
 * which turns "2,5" into 2 silently.
 */
export const WHOLE_NUMBER_FORMAT: Intl.NumberFormatOptions = { maximumFractionDigits: 0 };

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
