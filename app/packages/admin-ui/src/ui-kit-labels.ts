/**
 * Czech accessible names for @techsio/ui-kit components whose defaults are English. The props they
 * feed come from the local ui-kit patch (`patches/@techsio__ui-kit@0.56.0.patch`) or from zag.
 * Every value is a module constant, so passing one keeps DataTable column memos stable.
 */
import type { ComboboxProps } from '@techsio/ui-kit/molecules/combobox';
import type { DatePickerTranslations } from '@techsio/ui-kit/molecules/date-picker';
import type { PaginationProps } from '@techsio/ui-kit/molecules/pagination';
import type { ToasterProps } from '@techsio/ui-kit/molecules/toast';
import type { DataTableTranslations } from '@techsio/ui-kit/organisms/data-table';

type DayCellState = Parameters<NonNullable<DatePickerTranslations['dayCell']>>[0];
type DateView = Parameters<NonNullable<DatePickerTranslations['prevTrigger']>>[0];

/** `<Toaster {...toasterLabels} />`: region name, close button and loading title. */
export const toasterLabels = {
  closeLabel: 'Zavřít oznámení',
  label: 'Oznámení',
  loadingLabel: 'Probíhá…',
} as const satisfies ToasterProps;

/** `<Combobox translations={comboboxTranslations} />`: chevron and clear buttons. */
export const comboboxTranslations = {
  clearTriggerLabel: 'Vymazat',
  triggerLabel: 'Zobrazit návrhy',
} as const satisfies NonNullable<ComboboxProps['translations']>;

/** Built-in close button of a centred ui-kit `Dialog`. */
export const dialogCloseLabel = 'Zavřít dialog';

const viewName = (view: DateView): string => {
  if (view === 'year') {
    return 'zobrazení let';
  }
  return view === 'month' ? 'zobrazení měsíců' : 'zobrazení dnů';
};

const dayCellLabel = (state: DayCellState): string => {
  if (state.unavailable) {
    return `Nedostupné. ${state.valueText}`;
  }
  if (state.firstInRange) {
    return `Začátek rozsahu ${state.valueText}`;
  }
  if (state.lastInRange) {
    return `Konec rozsahu ${state.valueText}`;
  }
  if (state.inRange) {
    return `V rozsahu. ${state.valueText}`;
  }
  return state.selected ? `Vybrané datum. ${state.valueText}` : `Vybrat ${state.valueText}`;
};

/** `<DatePicker.Root translations={datePickerTranslations} />`: calendar buttons, day cells, segments. */
export const datePickerTranslations: DatePickerTranslations = {
  clearTrigger: 'Vymazat datum',
  content: 'Kalendář',
  dayCell: dayCellLabel,
  emptySegment: 'Prázdné',
  monthSelect: 'Vybrat měsíc',
  nextTrigger: (view) => {
    if (view === 'year') {
      return 'Další desetiletí';
    }
    return view === 'month' ? 'Další rok' : 'Další měsíc';
  },
  presetTrigger: ([start = '', end = '']) => `Vybrat ${start} až ${end}`,
  prevTrigger: (view) => {
    if (view === 'year') {
      return 'Předchozí desetiletí';
    }
    return view === 'month' ? 'Předchozí rok' : 'Předchozí měsíc';
  },
  segmentLabels: {
    day: 'Den',
    dayPeriod: 'Část dne',
    era: 'Letopočet',
    hour: 'Hodina',
    minute: 'Minuta',
    month: 'Měsíc',
    second: 'Sekunda',
    timeZoneName: 'Časové pásmo',
    year: 'Rok',
  },
  trigger: (open) => (open ? 'Zavřít kalendář' : 'Otevřít kalendář'),
  viewTrigger: (view, nextView) => (nextView === undefined ? viewName(view) : `Přepnout na ${viewName(nextView)}`),
  weekColumnHeader: 'Týd.',
  weekNumberCell: (weekNumber) => `Týden ${weekNumber}`,
  yearSelect: 'Vybrat rok',
};

/** Spread into DataTable `translations`: row checkbox and inline-edit button names. */
export const dataTableRowLabels = {
  editRowLabel: (rowLabel: string) => `Upravit ${rowLabel}`,
  selectRowLabel: (rowLabel: string) => `Vybrat ${rowLabel}`,
} as const satisfies DataTableTranslations;

/** DataTable `paginationProps.translations` for pages without their own locale keys. */
export const paginationTranslations = {
  firstTriggerLabel: 'První stránka',
  itemLabel: ({ page }: { readonly page: number }) => `Strana ${page}`,
  lastTriggerLabel: 'Poslední stránka',
  nextTriggerLabel: 'Další stránka',
  prevTriggerLabel: 'Předchozí stránka',
  rootLabel: 'Stránkování',
} as const satisfies NonNullable<PaginationProps['translations']>;
