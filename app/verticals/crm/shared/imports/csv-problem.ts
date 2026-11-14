// AREA: imports (C03) — owned by the crm-imports lane.
// Turns a language-free CSV problem into a sentence. Screens pass their i18n `t` (keys under crm.imports.csv);
// the server renders the Czech sentence it has always stored in ImportBatch.errors / results `message`.
import { Match } from 'effect';
import type { CsvColumnKey, CsvProblem } from '../domain/imports.ts';

/** Looks up `column.<key>` and `problem.<Tag>` (relative to crm.imports.csv) and fills `{{name}}` placeholders. */
export type CsvProblemTranslate = (key: string, values?: Readonly<Record<string, string>>) => string;

const rowValues = ({ row }: { readonly row: number }) => ({ row: String(row) });

const problemValues = (translate: CsvProblemTranslate, problem: CsvProblem): Readonly<Record<string, string>> => {
  const column = (key: CsvColumnKey) => translate(`column.${key}`);
  return Match.value(problem).pipe(
    Match.tagsExhaustive({
      AmountWithoutCurrency: rowValues,
      DuplicateHeader: (value) => ({ column: column(value.column) }),
      EmptyFile: () => ({}),
      InvalidAmount: ({ row, value }) => ({ row: String(row), value }),
      InvalidCurrency: ({ row, value }) => ({ row: String(row), value }),
      InvalidHeaderCell: ({ maxLength, position }) => ({ maxLength: String(maxLength), position: String(position) }),
      InvalidLine: ({ item, maxLength, row }) => ({
        item: String(item),
        maxLength: String(maxLength),
        row: String(row),
      }),
      InvalidText: (value) => ({
        column: column(value.column),
        maxLength: String(value.maxLength),
        row: String(value.row),
      }),
      InvalidTime: (value) => ({ column: column(value.column), row: String(value.row) }),
      LineAmountWithoutCurrency: rowValues,
      MissingColumns: ({ columns }) => ({ columns: columns.map(column).join(', ') }),
      MissingValue: (value) => ({ column: column(value.column), row: String(value.row) }),
      SurplusCells: ({ position, row }) => ({ position: String(position), row: String(row) }),
      UnterminatedQuote: ({ position, row }) => ({ position: String(position), row: String(row) }),
    }),
  );
};

/** One sentence naming the row and the column by its human label. */
export const renderCsvProblem = (translate: CsvProblemTranslate, problem: CsvProblem): string =>
  translate(`problem.${problem._tag}`, problemValues(translate, problem));

/**
 * The Czech wording stored in the existing `message` fields of import history. It must stay identical to
 * locales/cs/crm-imports.json `imports.csv` (a unit test compares them); screens render through i18n instead.
 */
export const czechCsvProblemCopy = {
  column: {
    cas_udalosti: 'Čas události',
    castka: 'Částka',
    cislo_objednavky: 'Číslo objednávky',
    datum_objednavky: 'Datum objednávky',
    email_zakaznika: 'E-mail zákazníka',
    ico_zakaznika: 'IČO zákazníka',
    id_objednavky: 'ID objednávky',
    id_udalosti: 'ID události',
    id_zakaznika: 'ID zákazníka',
    mena: 'Měna',
    nazev_zakaznika: 'Název zákazníka',
    polozky: 'Položky',
    stav: 'Stav',
    zdroj: 'Zdroj',
  },
  problem: {
    AmountWithoutCurrency: 'Řádek {{row}}: částka nemá měnu. Doplňte sloupec „Měna“.',
    DuplicateHeader: 'Řádek 1, sloupec „{{column}}“ je uveden vícekrát (i pod jiným názvem). Ponechte jej jen jednou.',
    EmptyFile: 'Soubor je prázdný.',
    InvalidAmount: 'Řádek {{row}}, sloupec „Částka“: „{{value}}“ není platné desetinné číslo.',
    InvalidCurrency: 'Řádek {{row}}, sloupec „Měna“: „{{value}}“ není kód ISO 4217 (např. CZK, EUR).',
    InvalidHeaderCell: 'Řádek 1, sloupec {{position}}: text musí mít 1 až {{maxLength}} znaků.',
    InvalidLine:
      'Řádek {{row}}, sloupec „Položky“, položka {{item}}: zkontrolujte název a SKU (nejvýše {{maxLength}} znaků) a desetinné množství a částku.',
    InvalidText: 'Řádek {{row}}, sloupec „{{column}}“: text musí mít 1 až {{maxLength}} znaků.',
    InvalidTime:
      'Řádek {{row}}, sloupec „{{column}}“: zadejte platné datum nebo čas, nejvýše se třemi desetinnými místy sekundy. Čas bez pásma se vykládá v pásmu Europe/Prague.',
    LineAmountWithoutCurrency: 'Řádek {{row}}: částka položky nemá měnu. Doplňte sloupec „Měna“.',
    MissingColumns: 'Řádek 1: v hlavičce chybí povinné sloupce {{columns}}.',
    MissingValue: 'Řádek {{row}}, sloupec „{{column}}“: chybí hodnota.',
    SurplusCells:
      'Řádek {{row}}: za posledním sloupcem {{position}} jsou další hodnoty. Opravte oddělovače nebo uvozovky.',
    UnterminatedQuote: 'Řádek {{row}}, sloupec {{position}}: chybí uzavírací uvozovka. Opravte CSV a import opakujte.',
  },
} as const;

const czechTemplates: ReadonlyMap<string, string> = new Map([
  ...Object.entries(czechCsvProblemCopy.column).map(([key, text]) => [`column.${key}`, text] as const),
  ...Object.entries(czechCsvProblemCopy.problem).map(([key, text]) => [`problem.${key}`, text] as const),
]);

const translateCzech: CsvProblemTranslate = (key, values = {}) => {
  const named = new Map(Object.entries(values));
  return (czechTemplates.get(key) ?? key).replaceAll(
    /\{\{(?<name>\w+)\}\}/gu,
    (placeholder, name: string) => named.get(name) ?? placeholder,
  );
};

/** The Czech sentence the server stores beside the problem code. */
export const czechCsvProblemMessage = (problem: CsvProblem): string => renderCsvProblem(translateCzech, problem);
