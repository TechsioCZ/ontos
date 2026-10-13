import { dataTableRowLabels } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import type { DataTableTranslations } from '@techsio/ui-kit/organisms/data-table';

const signed = new Intl.NumberFormat('cs-CZ', { signDisplay: 'exceptZero' });

/** Stock movement quantity with an explicit sign: `+5`, `-2`. Money, counts and dates use `@app/admin-ui`. */
export const formatDelta = (value: number): string => signed.format(value);

/** DataTable strings from the vertical locale, so no kit English default reaches the screen. */
export const useTableTranslations = (): DataTableTranslations => {
  const { t } = useModernI18n();
  const k = (name: string) => t(`merchandise.pages.products.table.${name}`);
  return {
    ...dataTableRowLabels,
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
