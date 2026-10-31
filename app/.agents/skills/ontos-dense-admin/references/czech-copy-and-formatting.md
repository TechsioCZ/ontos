# Czech copy, Intl formatting, DataTable translations

All user-visible strings go through the vertical's `t()` (`useModernI18n()` from
`@modern-js/plugin-i18n/runtime`), with keys in `locales/cs/<vertical>.json` (Czech, full
diacritics, primary) and `locales/en/<vertical>.json` (English). Recipes in this skill inline
the Czech text so they stay readable. When you copy one, move each string into the locale files.

## 1. Formatters: one file per vertical, `src/ui/format.ts`

```ts
// src/ui/format.ts. Create formatters once per locale, never per render or per cell.
export const intlLocale = (lang: string | undefined) => (lang === 'en' ? 'en-GB' : 'cs-CZ');

export const makeFormat = (locale = 'cs-CZ') => {
  const czk0 = new Intl.NumberFormat(locale, { style: 'currency', currency: 'CZK', maximumFractionDigits: 0 });
  const czk2 = new Intl.NumberFormat(locale, { style: 'currency', currency: 'CZK', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const count = new Intl.NumberFormat(locale);
  const percent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 });
  const delta = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1, signDisplay: 'exceptZero' });
  const compactCzk = new Intl.NumberFormat(locale, { style: 'currency', currency: 'CZK', notation: 'compact', maximumFractionDigits: 1 });
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });            // 4. 9. 2026
  const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }); // 4. 9. 2026 14:05
  const month = new Intl.DateTimeFormat(locale, { month: 'short', year: 'numeric' }); // zář 2026
  const day = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'numeric' });   // 4. 9.
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const plural = new Intl.PluralRules(locale);
  return {
    /** Money is stored as integer minor units (haléře). Lists, KPIs, totals: whole CZK. */
    money: (minor: number) => czk0.format(minor / 100),
    /** Invoice/order lines and unit prices: always 2 decimals. Use one precision per column. */
    moneyExact: (minor: number) => czk2.format(minor / 100),
    moneyCompact: (minor: number) => compactCzk.format(minor / 100), // only KPI tiles / chart ticks
    count: (n: number) => count.format(n),
    percent: (ratio: number) => percent.format(ratio),          // 0.277 → 27,7 %
    delta: (ratio: number) => delta.format(ratio),               // +8,2 % / −3 %
    date: (iso: string) => date.format(new Date(iso)),
    dateTime: (iso: string) => dateTime.format(new Date(iso)),
    month: (d: Date) => month.format(d),
    day: (d: Date) => day.format(d),
    relativeDays: (days: number) => relative.format(days, 'day'), // před 2 dny, only for < 7 days
    /** n + correctly inflected noun: forms for cs plural categories. */
    plural: (n: number, forms: { one: string; few: string; many: string; other: string }) =>
      `${count.format(n)} ${forms[plural.select(n) as keyof typeof forms] ?? forms.other}`,
    dash: (value: string | number | null | undefined) =>
      value === null || value === undefined || value === '' ? '—' : String(value),
  };
};
export type Format = ReturnType<typeof makeFormat>;
```

Use it in a page: `const { language, t } = useModernI18n();` then
`const fmt = useMemo(() => makeFormat(intlLocale(language)), [language]);`

Rules:
- Never render ISO strings (`2026-09-04`), `Date.toString()`, `toFixed()` or `"Kč"` concatenation.
- Missing value → `—` (`fmt.dash`). A real zero stays `0 Kč`.
- Identifiers (IČO, DIČ, invoice number, SKU, phone) are text: start-aligned, no thousands separators.
- Czech plural forms: `{ one: 'zákazník', few: 'zákazníci', many: 'zákazníku', other: 'zákazníků' }`
  → `1 zákazník`, `3 zákazníci`, `12 zákazníků`. When unsure of forms, use the counter form `Vybráno: 12`.
- Pass `locale="cs-CZ"` explicitly to `DatePicker` (defaults to en-US), `NumericInput` / `FormNumericInput`.

## 2. DataTable Czech translations: `src/ui/table-cs.ts`

```ts
import type { DataTableTranslations } from '@techsio/ui-kit/organisms/data-table';

export const tableCs = (searchPlaceholder: string): DataTableTranslations => ({
  searchPlaceholder,                        // e.g. 'Hledat zákazníky…'
  searchLabel: 'Hledat',
  clearSearchLabel: 'Vymazat hledání',
  searchButtonLabel: 'Hledat',
  columnsLabel: 'Nastavení sloupců',
  emptyTitle: 'Žádné záznamy',
  emptyDescription: 'Nejsou k dispozici žádná data.',
  pageSizeLabel: 'Řádků na stránku',
  actionsLabel: 'Akce',
  filtersLabel: 'Filtry sloupců',
  selectAllLabel: 'Vybrat všechny řádky',
  selectionLabel: 'Vybrat řádky',
  reorderLabel: 'Změnit pořadí řádků',
  loadingLabel: 'Načítání dat',
  editingLabel: 'Upravujete řádek, ostatní ovládání tabulky je zamčené',
  rangeLabel: ({ start, end, total }) => `${start}–${end} z ${total}`,
  requiredLabel: 'Povinné',
});
```

## 3. UX writing vocabulary (cs → en)

Sentence case. Buttons are verb + object. Never use `OK`, `Ano`, `Potvrdit`, `Odeslat` alone.

| Situation | Czech | English |
|---|---|---|
| Page primary (list) | `Nový zákazník` / `Nová faktura` / `Nová příležitost` / `Nový úkol` / `Nový produkt` / `Nový zaměstnanec` | `New customer` … |
| Drawer submit (create) | `Vytvořit zákazníka` / `Vytvořit fakturu` / `Vytvořit příležitost` / `Vytvořit úkol` / `Vytvořit produkt` | `Create customer` … |
| Drawer title (edit) / submit | `Upravit zákazníka` / `Uložit změny` | `Edit customer` / `Save changes` |
| Cancel / close | `Zrušit` / `Zavřít` | `Cancel` / `Close` |
| Delete (alertdialog) | title `Smazat zákazníka Alfa s.r.o.?`, button `Smazat zákazníka` | `Delete customer …?` |
| Stock movement | `Naskladnit` (receipt), `Vyskladnit` (issue), `Upravit stav` (adjustment) | `Receive stock`, `Issue stock`, `Adjust stock` |
| Opportunity stage | `Změnit fázi`, `Označit jako vyhranou`, `Označit jako prohranou` | `Change stage`, `Mark as won`, `Mark as lost` |
| Bulk bar | `Vybráno: 12`, `Zrušit výběr`, `Přiřadit štítek`, `Odebrat štítek`, `Změnit fázi`, `Přiřadit obchodníkovi`, `Upravit hromadně` | `12 selected` … |
| Toast success | `Zákazník vytvořen`, `Faktura vytvořena`, `Příležitost vytvořena`, `Úkol vytvořen`, `Změny uloženy`, `Štítek přiřazen 12 zákazníkům`, `Sklad aktualizován` | `Customer created` … |
| Toast automation | `Příležitost vyhrána, faktura FV-2026-0042 vytvořena` | `Opportunity won, invoice … created` |
| Search placeholder | `Hledat zákazníky…`, `Hledat podle čísla faktury nebo zákazníka…` | `Search customers…` |
| Empty, first use | title `Zatím tu nejsou žádní zákazníci.` description `Vytvořte prvního zákazníka a začněte evidovat obchody.` | |
| Empty, no results | `Filtrům neodpovídá žádný záznam.` + button `Zrušit filtry` | `No records match the filters.` / `Clear filters` |
| Load error | `Data se nepodařilo načíst.` + description `Zkontrolujte připojení a zkuste to znovu.` + button `Zkusit znovu` | `Couldn't load data.` / `Try again` |
| Forbidden | `K této sekci nemáte oprávnění.` description `Požádejte vedoucího obchodu o přístup.` | |
| Revision conflict | `Záznam mezitím upravil někdo jiný. Načtěte ho znovu a změnu zopakujte.` | |
| Field errors | `Vyplňte název zákazníka.`, `IČO má 8 číslic.`, `Zadejte částku větší než 0 Kč.`, `Vyberte zákazníka.` | |
| Not assigned | `Nepřiřazeno` | `Unassigned` |
| Period presets | `Posledních 7 dní`, `Posledních 30 dní`, `Tento měsíc`, `Minulý měsíc`, `Tento rok`, `Vlastní rozsah` | |

Punctuation: full sentences (descriptions, empty-state text, errors) end with a period; button
labels, column headers, badge labels and titles do not. Use `…` (U+2026) in placeholders and `–` (en
dash) in ranges. No emojis anywhere.

## 4. Column header nouns (sentence case, unit in header when shared)

`Zákazník`, `IČO`, `Štítky`, `Obchodník`, `Fáze`, `Hodnota (Kč)`, `Pravděpodobnost`, `Očekávané uzavření`,
`Číslo faktury`, `Vystaveno`, `Splatnost`, `Stav`, `Úhrada`, `Celkem (Kč)`, `Úkol`, `Řešitel`, `Priorita`,
`Termín`, `Produkt`, `Kód`, `Cena (Kč)`, `Skladem (ks)`, `Pohyb`, `Množství (ks)`, `Datum`, `Vytvořeno`.
When the unit is in the header, cells use `fmt.count()` instead of the currency formatter, or keep the
currency formatter and drop `(Kč)` from the header. Pick one per column and keep it.
