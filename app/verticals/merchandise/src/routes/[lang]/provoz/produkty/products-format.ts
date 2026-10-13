import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import type { DataTableTranslations } from '@techsio/ui-kit/organisms/data-table';
import { DateTime } from 'effect';

/** Money is stored as integer CZK minor units (haléře). The Intl locale follows the active UI language. */
export const makeProductFormat = (locale: string) => {
  const czk = new Intl.NumberFormat(locale, { currency: 'CZK', maximumFractionDigits: 0, style: 'currency' });
  const count = new Intl.NumberFormat(locale);
  const signed = new Intl.NumberFormat(locale, { signDisplay: 'exceptZero' });
  const percent = new Intl.NumberFormat(locale, { maximumFractionDigits: 0, style: 'percent' });
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });
  const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  return {
    count: (value: number) => count.format(value),
    date: (value: DateTime.Utc) => date.format(DateTime.toDateUtc(value)),
    dateTime: (value: DateTime.Utc) => dateTime.format(DateTime.toDateUtc(value)),
    money: (minor: number) => czk.format(minor / 100),
    signed: (value: number) => signed.format(value),
    vat: (rate: number) => percent.format(rate / 100),
  };
};

export type ProductFormat = ReturnType<typeof makeProductFormat>;

export const useProductFormat = (): ProductFormat => {
  const { language } = useModernI18n();
  return makeProductFormat(language);
};

/** DataTable strings from the vertical locale, so no kit English default reaches the screen. */
export const useTableTranslations = (): DataTableTranslations => {
  const { t } = useModernI18n();
  const k = (name: string) => t(`merchandise.pages.products.table.${name}`);
  return {
    actionsLabel: k('actionsLabel'),
    clearSearchLabel: k('clearSearchLabel'),
    columnsLabel: k('columnsLabel'),
    editingLabel: k('editingLabel'),
    emptyDescription: k('emptyDescription'),
    emptyTitle: k('emptyTitle'),
    filtersLabel: k('filtersLabel'),
    loadingLabel: k('loadingLabel'),
    pageSizeLabel: k('pageSizeLabel'),
    rangeLabel: ({ end, start, total }) => t('merchandise.pages.products.table.rangeLabel', { end, start, total }),
    reorderLabel: k('reorderLabel'),
    requiredLabel: k('requiredLabel'),
    searchButtonLabel: k('searchButtonLabel'),
    searchLabel: k('searchLabel'),
    searchPlaceholder: k('searchPlaceholder'),
    selectAllLabel: k('selectAllLabel'),
    selectionLabel: k('selectionLabel'),
  };
};
